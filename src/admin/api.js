import { db, getSetting, setSetting, audit } from '../db.js';
import { config, saveRuntimeInfo } from '../config.js';
import { logger } from '../log.js';
import { verifyPassword, createSession, revokeSession, adminAuthHook } from './auth.js';
import {
  listAccounts, publicAccount, getAccount, deleteAccount, importFromLocal, importFromCookie,
  healthCheck, updateAccount, verifyAndMark, jwtPayload, insertAccount, normalizeFamily, setTokens, refreshWebCookie,
} from '../accounts.js';
import { poolSummary, pollAccount, startPoller, scheduleNext } from '../poller.js';
import { discover, claim, claimHistory, runAutoClaim } from '../claims.js';
import { listGroups, defaultChain, recentScheduleLogs } from '../scheduler.js';
import { createKey, listKeys, deleteKey, updateKey } from '../gateway/auth.js';
import { poolStatus, releaseSlot, bridgeSmoke } from '../bridge/pool.js';
import { oauthCliInit, oauthCliPoll, oauthTokenExchange, zaiBusinessLogin } from '../zcodeApi.js';
import { randomHex, encrypt, decrypt } from '../crypto.js';

const log = logger('admin-api');

// poll_token 加密保存在本机数据库；重启后恢复未过期的轮询。
const oauthFlows = new Map();
const flowPollTimers = new Map();
function persistFlow(id, f) {
  db().prepare(`INSERT INTO oauth_flows(flow_id,account_rowid,provider,poll_token_enc,authorize_url,status,error,created_at,expires_at,account_id,poll_interval_sec,result_json,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(flow_id) DO UPDATE SET status=excluded.status,error=excluded.error,account_id=excluded.account_id,result_json=excluded.result_json,updated_at=excluded.updated_at`)
    .run(id, f.targetId || null, f.provider, encrypt(f.pollToken), f.authorizeUrl, f.status, f.error || null, f.createdAt, f.expiresAt, f.accountId || null, f.intervalSec, f.result ? JSON.stringify(f.result) : null, Date.now());
}
function startFlowTimer(id, flow) {
  if (flowPollTimers.has(id)) return;
  const timer = setInterval(async () => {
    if (flow.polling || flow.status !== 'pending') return;
    if (Date.now() >= flow.expiresAt) {
      flow.status = 'expired'; flow.error = '授权流程已过期'; persistFlow(id, flow);
      // 保留节流窗口，避免失效账号反复发起授权。
      if (flow.targetId) {
        db().prepare('UPDATE oauth_flows SET noticed_at=? WHERE flow_id=? AND noticed_at IS NULL').run(Date.now(), id);
      }
      clearInterval(timer); flowPollTimers.delete(id); return;
    }
    flow.polling = true;
    try {
      const r = await oauthCliPoll(id, flow.pollToken);
      if (!oauthFlows.has(id)) return;
      if (r.terminal) { flow.status = 'failed'; flow.error = `授权失败：${r.status} code=${r.code}`; }
      else if (r.ready) {
        flow.status = 'exchanging'; persistFlow(id, flow);
        try {
          const result = await completeOAuth(flow.provider, r, flow);
          flow.result = result; flow.accountId = result.id; flow.status = 'done'; flow.error = null;
          reauthAttempts.delete(flow.targetId || result.id); reauthNotified.delete(flow.targetId || result.id);
        } catch (e) { flow.status = 'failed'; flow.error = e.message; log.error('OAuth 完成失败', e); }
      } else flow.error = null;
    } catch (e) { flow.error = `轮询暂时失败：${e.message}`; }
    finally {
      flow.polling = false;
      if (oauthFlows.has(id)) persistFlow(id, flow);
      if (flow.status !== 'pending') { clearInterval(timer); flowPollTimers.delete(id); }
    }
  }, Math.max(2, flow.intervalSec) * 1000);
  timer.unref();
  flowPollTimers.set(id, timer);
}
function restoreFlows() {
  const rows = db().prepare("SELECT * FROM oauth_flows WHERE status IN ('pending','exchanging')").all();
  for (const row of rows) {
    try {
      const flow = { provider: row.provider, pollToken: decrypt(row.poll_token_enc), targetId: row.account_rowid,
        authorizeUrl: row.authorize_url, expiresAt: row.expires_at, createdAt: row.created_at,
        intervalSec: row.poll_interval_sec, status: row.status, error: row.error };
      if (flow.status === 'exchanging') { flow.status = 'failed'; flow.error = '服务在令牌处理中断，请重新授权'; persistFlow(row.flow_id, flow); }
      else if (Date.now() >= flow.expiresAt) { flow.status = 'expired'; flow.error = '授权流程已过期'; persistFlow(row.flow_id, flow); }
      else { oauthFlows.set(row.flow_id, flow); startFlowTimer(row.flow_id, flow); }
    } catch (e) { db().prepare("UPDATE oauth_flows SET status='failed', error=?, updated_at=? WHERE flow_id=?").run('无法恢复授权流程', Date.now(), row.flow_id); }
  }
}
function publicFlow(row) {
  let result = null; try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch {}
  return { ok: true, flow_id: row.flow_id, status: row.status, error: row.error, account_id: row.account_id, result, authorize_url: row.authorize_url, expires_at: row.expires_at, provider: row.provider, target_id: row.account_rowid };
}

export function registerAdminRoutes(app) {
  restoreFlows();
  app.addHook('onClose', async () => { for (const timer of flowPollTimers.values()) clearInterval(timer); flowPollTimers.clear(); oauthFlows.clear(); });

  app.post('/api/auth/login', async (req, reply) => {
    const { password } = req.body || {};
    if (!verifyPassword(password)) {
      audit('anon', 'login.fail', '', req.ip);
      return reply.code(401).send({ ok: false, error: '密码错误' });
    }
    const token = createSession();
    audit('admin', 'login.ok', '', req.ip);
    return { ok: true, token };
  });
  app.post('/api/auth/logout', { preHandler: adminAuthHook }, async (req) => {
    const token = (req.headers['authorization'] || '').slice(7).trim();
    revokeSession(token);
    return { ok: true };
  });

  app.get('/api/runtime-info', { preHandler: adminAuthHook }, async () => {
    const cfg = config();
    return {
      web_port: app.webPort, gateway_port: app.gatewayPort,
      host: cfg.host, app_version: cfg.app_version,
      runtime_bin: cfg.runtime_bin, data_dir: cfg.dataDir || undefined,
      poll_interval_sec: cfg.poll_interval_sec, claim_auto_min: cfg.claim_auto_min,
    };
  });

  app.get('/api/accounts', { preHandler: adminAuthHook }, async () => {
    return listAccounts().map(publicAccount);
  });

  app.post('/api/accounts/import-local', { preHandler: adminAuthHook }, async (req) => {
    const r = await importFromLocal(req.body || {});
    for (const result of r.results || []) if (result.id) scheduleNext(result.id, 1000);
    audit('admin', 'account.import_local', r, req.ip);
    if (!r.ok && r.results?.length === 0) return { ok: false, error: r.reason };
    return r;
  });

  app.post('/api/accounts/import-cookie', { preHandler: adminAuthHook }, async (req) => {
    const { family, webJwt, label, expiresAt } = req.body || {};
    if (!webJwt) return { ok: false, error: '缺少 webJwt（网页会话 JWT）' };
    const r = await importFromCookie({ family, webJwt, label, expiresAt });
    if (r.ok) scheduleNext(r.id, 1000);
    audit('admin', 'account.import_cookie', r, req.ip);
    return r;
  });

  app.post('/api/accounts/oauth/start', { preHandler: adminAuthHook }, async (req, reply) => {
    const provider = String(req.body?.provider || 'bigmodel');
    if (!['bigmodel', 'zai'].includes(provider)) return reply.code(400).send({ ok: false, error: 'provider 须为 bigmodel|zai' });
    const target = req.body?.account_id ? getAccount(req.body.account_id) : null;
    if (req.body?.account_id && (!target || target.family !== provider)) return reply.code(400).send({ ok: false, error: '账号不存在或授权平台不匹配' });
    const pollToken = randomHex(32);
    try {
      const init = await oauthCliInit(provider, pollToken);
      const flowId = init.flowId;
      if (!flowId || !init.authorizeUrl || !/^https:\/\//i.test(init.authorizeUrl)) throw new Error('授权初始化响应无效');
      const flow = { provider, pollToken, targetId: target?.id || null, authorizeUrl: init.authorizeUrl,
        expiresAt: init.expiresAt || Date.now() + 10 * 60 * 1000, createdAt: Date.now(),
        intervalSec: Math.max(2, Number(init.pollIntervalSec) || 3), status: 'pending', error: null };
      persistFlow(flowId, flow); oauthFlows.set(flowId, flow); startFlowTimer(flowId, flow);
      return { ok: true, flow_id: flowId, authorize_url: init.authorizeUrl, expires_at: flow.expiresAt, provider };
    } catch (e) {
      log.error('cli/init 失败', e);
      return reply.code(502).send({ ok: false, error: e.message });
    }
  });

  app.get('/api/accounts/oauth/pending', { preHandler: adminAuthHook }, async () => {
    return db().prepare("SELECT * FROM oauth_flows WHERE status='pending' AND expires_at>? ORDER BY created_at DESC").all(Date.now()).map(publicFlow);
  });
  // 全局授权回执：控制台周期轮询；弹窗关闭后登录完成也能收到提醒。
  // notified 只带「最近 15 分钟内状态落定且未被确认」的结果，避免历史流程刷屏。
  app.get('/api/accounts/oauth/watch', { preHandler: adminAuthHook }, async () => {
    const freshCutoff = Date.now() - 15 * 60 * 1000;
    const pending = db().prepare("SELECT * FROM oauth_flows WHERE status='pending' AND expires_at>? ORDER BY created_at DESC").all(Date.now()).map(publicFlow);
    const notified = db().prepare("SELECT * FROM oauth_flows WHERE status IN ('done','failed','expired') AND noticed_at IS NULL AND updated_at>=? ORDER BY updated_at DESC LIMIT 20").all(freshCutoff).map(publicFlow);
    return { pending, notified };
  });
  app.post('/api/accounts/oauth/ack', { preHandler: adminAuthHook }, async (req) => {
    const ids = Array.isArray(req.body?.flow_ids) ? req.body.flow_ids.filter((x) => typeof x === 'string' && x).slice(0, 50) : [];
    if (ids.length) {
      db().prepare(`UPDATE oauth_flows SET noticed_at=? WHERE flow_id IN (${ids.map(() => '?').join(',')})`).run(Date.now(), ...ids);
    }
    return { ok: true, acked: ids.length };
  });
  app.get('/api/accounts/oauth/status/:flowId', { preHandler: adminAuthHook }, async (req, reply) => {
    const row = db().prepare('SELECT * FROM oauth_flows WHERE flow_id=?').get(req.params.flowId);
    if (!row) return reply.code(404).send({ ok: false, error: '授权流程不存在' });
    return publicFlow(row);
  });
  app.post('/api/accounts/oauth/cancel/:flowId', { preHandler: adminAuthHook }, async (req, reply) => {
    const f = oauthFlows.get(req.params.flowId);
    if (f?.status === 'exchanging') return reply.code(409).send({ ok: false, error: '正在处理授权结果，无法取消' });
    const t = flowPollTimers.get(req.params.flowId); if (t) clearInterval(t);
    flowPollTimers.delete(req.params.flowId); oauthFlows.delete(req.params.flowId);
    db().prepare("UPDATE oauth_flows SET status='cancelled',error='已取消' WHERE flow_id=? AND status='pending'").run(req.params.flowId);
    return { ok: true };
  });

  app.post('/api/accounts/:id/refresh-cookie', { preHandler: adminAuthHook }, async (req, reply) => {
    const a = getAccount(req.params.id);
    if (!a) return reply.code(404).send({ ok: false, error: '账号不存在' });
    const result = await refreshWebCookie(a, req.body?.webJwt, req.body?.expiresAt);
    audit('admin', 'account.refresh_cookie', { id: a.id, ok: result.ok }, req.ip);
    return result;
  });

  app.delete('/api/accounts/:id', { preHandler: adminAuthHook }, async (req) => {
    const a = getAccount(req.params.id);
    if (!a) return { ok: false, error: '账号不存在' };
    await releaseSlot(a.id).catch(() => {});
    deleteAccount(a.id);
    audit('admin', 'account.delete', { id: a.id, label: a.label }, req.ip);
    return { ok: true };
  });

  app.patch('/api/accounts/:id', { preHandler: adminAuthHook }, async (req, reply) => {
    const a = getAccount(req.params.id);
    if (!a) return reply.code(404).send({ ok: false, error: '账号不存在' });
    const { label, group_id, proxy_url } = req.body || {};
    const fields = {};
    if (label !== undefined) fields.label = String(label).slice(0, 60);
    if (group_id !== undefined) fields.group_id = group_id;
    let proxyChanged = false;
    if (proxy_url !== undefined) {
      const p = String(proxy_url || '').trim() || null;
      if (p && !/^https?:\/\//i.test(p)) {
        return reply.code(400).send({ ok: false, error: 'proxy_url 仅支持 http(s)://host:port 形态，留空恢复直连' });
      }
      fields.proxy_url = p;
      proxyChanged = p !== (a.proxy_url || null);
    }
    updateAccount(a.id, fields);
    // 代理变更需重启运行时子进程才生效（spawn env 固化在启动时）
    if (proxyChanged) {
      await releaseSlot(a.id).catch(() => {});
      audit('admin', 'account.proxy_changed', { id: a.id, proxy_url: fields.proxy_url }, req.ip);
    }
    audit('admin', 'account.update', { id: a.id, fields }, req.ip);
    return { ok: true, proxy_restarted: proxyChanged };
  });

  app.post('/api/accounts/:id/verify', { preHandler: adminAuthHook }, async (req) => {
    const a = getAccount(req.params.id);
    if (!a) return { ok: false, error: '账号不存在' };
    const r = await verifyAndMark(a);
    return { ok: r.ok, status: r.status, reason: r.reason };
  });

  // 手动再授权绕过节流。
  app.post('/api/accounts/:id/reauth', { preHandler: adminAuthHook }, async (req, reply) => {
    const a = getAccount(req.params.id);
    if (!a) return reply.code(404).send({ ok: false, error: '账号不存在' });
    try {
      const r = await ensureReauthFlow(a.id, '手动发起再授权', { force: true });
      if (!r) return reply.code(400).send({ ok: false, error: '该账号不支持 OAuth 再授权' });
      return r;
    } catch (e) {
      log.error('手动再授权失败', e);
      return reply.code(502).send({ ok: false, error: e.message });
    }
  });

  app.post('/api/accounts/:id/poll-now', { preHandler: adminAuthHook }, async (req) => {
    const a = getAccount(req.params.id);
    if (!a) return { ok: false, error: '账号不存在' };
    const bal = await pollAccount(a.id);
    return { ok: true, balance: bal?.card || null };
  });

  app.post('/api/accounts/:id/check', { preHandler: adminAuthHook }, async (req) => {
    const a = getAccount(req.params.id);
    if (!a) return { ok: false, error: '账号不存在' };
    return healthCheck(a);
  });

  app.post('/api/accounts/:id/smoke', { preHandler: adminAuthHook }, async (req) => {
    const a = getAccount(req.params.id);
    if (!a) return { ok: false, error: '账号不存在' };
    return bridgeSmoke(a.id);
  });

  app.get('/api/dashboard', { preHandler: adminAuthHook }, async () => {
    const summary = poolSummary();
    const groups = listGroups();
    const busyRate = db().prepare(`SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN status='busy' THEN 1 ELSE 0 END),0) busy FROM usage_log WHERE ts > ?`).get(Date.now() - 24 * 3600 * 1000);
    return {
      summary, groups,
      busy_24h: { total: busyRate?.total || 0, busy: busyRate?.busy || 0 },
      bridge: poolStatus(),
      default_chain: defaultChain(),
    };
  });

  app.get('/api/claims/discover', { preHandler: adminAuthHook }, async (req) => {
    return discover({ accountId: req.query.account_id || null });
  });
  app.post('/api/claims/claim', { preHandler: adminAuthHook }, async (req) => {
    const { account_id, plan_id } = req.body || {};
    if (!account_id || !plan_id) return { ok: false, error: '缺少 account_id / plan_id' };
    try {
      const r = await claim(account_id, plan_id, 'manual');
      return { ok: r.ok, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  app.post('/api/claims/auto-run', { preHandler: adminAuthHook }, async (req) => {
    return runAutoClaim({ dryRun: !!req.body?.dry_run });
  });
  app.get('/api/claims/history', { preHandler: adminAuthHook }, async (req) => {
    return claimHistory(Number(req.query.limit) || 100);
  });

  app.get('/api/usage/stats', { preHandler: adminAuthHook }, async (req) => {
    const hours = Math.min(24 * 30, Number(req.query.hours) || 24);
    const since = Date.now() - hours * 3600 * 1000;
    const byHour = db().prepare(`SELECT strftime('%Y-%m-%dT%H:00:00', ts/1000, 'unixepoch', 'localtime') bucket,
        COUNT(*) reqs, COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) ok,
        COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(tokens_reasoning),0) treason,
        AVG(ttft_ms) avg_ttft
      FROM usage_log WHERE ts>=? GROUP BY bucket ORDER BY bucket`).all(since);
    const byModel = db().prepare(`SELECT model, COUNT(*) reqs, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout,
        COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) ok
      FROM usage_log WHERE ts>=? GROUP BY model ORDER BY reqs DESC`).all(since);
    const byKey = db().prepare(`SELECT k.name, u.key_id, COUNT(*) reqs, SUM(u.tokens_in+u.tokens_out) tokens
      FROM usage_log u LEFT JOIN keys k ON k.id=u.key_id WHERE u.ts>=? GROUP BY u.key_id ORDER BY reqs DESC`).all(since);
    const byAccount = db().prepare(`SELECT a.label, u.account_id, COUNT(*) reqs,
        SUM(CASE WHEN u.status='success' THEN 1 ELSE 0 END) ok, SUM(CASE WHEN u.status='busy' THEN 1 ELSE 0 END) busy
      FROM usage_log u LEFT JOIN accounts a ON a.id=u.account_id WHERE u.ts>=? GROUP BY u.account_id ORDER BY reqs DESC`).all(since);
    const byStatus = db().prepare(`SELECT status, COUNT(*) n FROM usage_log WHERE ts>=? GROUP BY status`).all(since);
    const p = (arr) => {
      const xs = arr.filter((x) => x !== null).sort((a, b) => a - b);
      if (!xs.length) return null;
      return { p50: xs[Math.floor(xs.length * 0.5)], p95: xs[Math.floor(xs.length * 0.95)] };
    };
    const ttfts = db().prepare(`SELECT ttft_ms FROM usage_log WHERE ts>=? AND status='success'`).all(since).map((r) => r.ttft_ms);
    return { hours, byHour, byModel, byKey, byAccount, byStatus, ttft: p(ttfts) };
  });

  app.get('/api/usage/logs', { preHandler: adminAuthHook }, async (req) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    return db().prepare(`SELECT u.*, k.name key_name, a.label account_label FROM usage_log u
      LEFT JOIN keys k ON k.id=u.key_id LEFT JOIN accounts a ON a.id=u.account_id
      ORDER BY u.ts DESC LIMIT ?`).all(limit);
  });

  app.get('/api/schedule-logs', { preHandler: adminAuthHook }, async (req) => {
    return recentScheduleLogs(Math.min(200, Number(req.query.limit) || 50));
  });

  app.get('/api/keys', { preHandler: adminAuthHook }, async () => listKeys());
  app.post('/api/keys', { preHandler: adminAuthHook }, async (req, reply) => {
    const b = req.body || {};
    if (!b.name) return reply.code(400).send({ ok: false, error: '缺少 name' });
    const r = createKey(b);
    audit('admin', 'key.create', { id: r.id, name: b.name }, req.ip);
    return { ok: true, ...r };
  });
  app.patch('/api/keys/:id', { preHandler: adminAuthHook }, async (req) => {
    updateKey(req.params.id, req.body || {});
    audit('admin', 'key.update', { id: req.params.id, fields: Object.keys(req.body || {}) }, req.ip);
    return { ok: true };
  });
  app.delete('/api/keys/:id', { preHandler: adminAuthHook }, async (req) => {
    deleteKey(req.params.id);
    audit('admin', 'key.delete', { id: req.params.id }, req.ip);
    return { ok: true };
  });

  app.get('/api/groups', { preHandler: adminAuthHook }, async () => listGroups());
  app.post('/api/groups', { preHandler: adminAuthHook }, async (req, reply) => {
    const b = req.body || {};
    if (!b.name) return reply.code(400).send({ ok: false, error: '缺少 name' });
    const id = 'g_' + randomHex(4);
    db().prepare(`INSERT INTO groups(id,name,role,family_filter,policy,urgent_window_min,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, b.name, b.role || 'primary', b.family_filter || null, b.policy || 'balanced', b.urgent_window_min || 180, b.enabled === false ? 0 : 1, Date.now());
    audit('admin', 'group.create', { id, name: b.name }, req.ip);
    return { ok: true, id };
  });
  app.patch('/api/groups/:id', { preHandler: adminAuthHook }, async (req) => {
    const allowed = ['name', 'role', 'family_filter', 'policy', 'urgent_window_min', 'enabled'];
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k}=?`); vals.push(v);
    }
    if (sets.length) {
      vals.push(req.params.id);
      db().prepare(`UPDATE groups SET ${sets.join(',')} WHERE id=?`).run(...vals);
    }
    audit('admin', 'group.update', { id: req.params.id, fields: Object.keys(req.body || {}) }, req.ip);
    return { ok: true };
  });
  app.delete('/api/groups/:id', { preHandler: adminAuthHook }, async (req) => {
    const inUse = db().prepare('SELECT COUNT(*) n FROM accounts WHERE group_id=?').get(req.params.id);
    if (inUse.n > 0) return { ok: false, error: `分组下还有 ${inUse.n} 个账号，先移出再删除` };
    db().prepare('DELETE FROM groups WHERE id=?').run(req.params.id);
    audit('admin', 'group.delete', { id: req.params.id }, req.ip);
    return { ok: true };
  });

  app.get('/api/settings', { preHandler: adminAuthHook }, async () => {
    const cfg = config();
    return {
      poll_interval_sec: cfg.poll_interval_sec, poll_jitter_sec: cfg.poll_jitter_sec,
      poll_concurrency: cfg.poll_concurrency, claim_auto_enabled: cfg.claim_auto_enabled,
      claim_auto_min: cfg.claim_auto_min, runtime_idle_min: cfg.runtime_idle_min,
      default_reasoning_level: cfg.default_reasoning_level, runtime_prewarm: !!cfg.runtime_prewarm,
      app_version: cfg.app_version, aliases: cfg.aliases, retry: cfg.retry,
      notify_webhook: cfg.notify_webhook, web_port: cfg.web_port, gateway_port: cfg.gateway_port,
      overrides: getSetting('config_overrides', {}),
    };
  });
  app.put('/api/settings', { preHandler: adminAuthHook }, async (req, reply) => {
    const b = req.body || {};
    const allowed = ['poll_interval_sec', 'poll_jitter_sec', 'poll_concurrency', 'claim_auto_enabled', 'claim_auto_min',
      'runtime_idle_min', 'default_reasoning_level', 'runtime_prewarm', 'app_version', 'aliases', 'retry', 'notify_webhook'];
    const overrides = getSetting('config_overrides', {});
    for (const k of allowed) {
      if (b[k] === undefined) continue;
      overrides[k] = b[k];
      // 热更新（config() 单例的字段写回）
      if (k in config()) config()[k] = b[k];
      if (k === 'retry') Object.assign(config().retry, b.retry || {});
    }
    setSetting('config_overrides', overrides);
    audit('admin', 'settings.update', { fields: Object.keys(b) }, req.ip);
    // 领卡定时器按新周期重建
    const { stopClaimScheduler, startClaimScheduler } = await import('../claims.js');
    stopClaimScheduler();
    startClaimScheduler();
    return { ok: true };
  });

  app.get('/api/backup/export', { preHandler: adminAuthHook }, async (req, reply) => {
    const { exportConfig } = await import('../ops.js');
    const blob = exportConfig();
    audit('admin', 'backup.export', {}, req.ip);
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="zcode2api-backup-${Date.now()}.z2a"`);
    return blob;
  });
  app.post('/api/backup/import', { preHandler: adminAuthHook }, async (req, reply) => {
    const { importConfig } = await import('../ops.js');
    try {
      const body = typeof req.body === 'string' ? req.body : req.body?.blob;
      if (!body) return reply.code(400).send({ ok: false, error: '缺少备份内容（文本或 {blob}）' });
      const r = importConfig(body, { merge: true });
      audit('admin', 'backup.import', r.counts, req.ip);
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  app.get('/api/audit', { preHandler: adminAuthHook }, async (req) => {
    return db().prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?').all(Math.min(300, Number(req.query.limit) || 100));
  });
}

/** OAuth 轮询完成：code → token 交换 → 建档 → balance 加验 */
async function completeOAuth(provider, poll, flow) {
  const data = poll.data?.token ? poll.data : await oauthTokenExchange(provider, poll.code, 'zcode://oauth/callback', poll.state);
  const tokens = { zcode_jwt: data.token, active_provider: provider };
  let businessExpiresAt = null;
  if (provider === 'bigmodel') {
    const access = data.bigmodel?.access_token || data.bigmodel?.accessToken;
    if (!access) throw new Error('授权响应缺少 BigModel 业务令牌');
    tokens.business_token = access;
    if (data.bigmodel?.refresh_token || data.bigmodel?.refreshToken) tokens.refresh_token = data.bigmodel.refresh_token || data.bigmodel.refreshToken;
  } else {
    if (!data.zai?.access_token) throw new Error('授权响应缺少 Z.ai 业务令牌');
    const zl = await zaiBusinessLogin(data.zai.access_token);
    tokens.business_token = zl.businessToken;
    tokens.oauth_access = data.zai.access_token;
    businessExpiresAt = zl.expiresInSec ? Date.now() + zl.expiresInSec * 1000 : null;
  }
  const payload = jwtPayload(data.token);
  const customerId = String(data.user?.user_id || payload?.user_id || '');
  if (!customerId) throw new Error('授权响应缺少账号身份，无法安全入库');
  const family = normalizeFamily(provider);
  let acc = flow.targetId ? getAccount(flow.targetId) : null;
  if (flow.targetId && (!acc || !acc.customer_id || String(acc.customer_id) !== customerId)) throw new Error('授权账号与待续期账号不一致，未更新凭据');
  if (!acc) {
    const existing = db().prepare('SELECT id FROM accounts WHERE family=? AND customer_id=?').get(family, customerId);
    if (existing) acc = getAccount(existing.id);
  }
  const updated = !!acc;
  if (acc) {
    setTokens(acc.id, tokens);
    await releaseSlot(acc.id);
  } else {
    acc = insertAccount({ label: `OAuth-${provider}-${customerId.slice(-4)}`, family, tokens,
      deviceMid: randomHex(16).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'), source: 'oauth', customerId });
  }
  updateAccount(acc.id, { business_token_expires_at: businessExpiresAt });
  let v;
  try { v = await verifyAndMark(getAccount(acc.id)); }
  catch (e) { updateAccount(acc.id, { status: 'unverified', last_error: `验证失败：${e.message}` }); v = { ok: false, status: 'unverified', reason: e.message }; }
  scheduleNext(acc.id, 1000);
  audit('admin', 'account.import_oauth', { id: acc.id, family, status: v.status, updated }, '');
  return { id: acc.id, updated, verified: v.ok, status: v.status, reason: v.reason || null };
}

export function savePorts(app) {
  saveRuntimeInfo({ web_port: app.webPort, gateway_port: app.gatewayPort, pid: process.pid });
}

// 只生成并通知 OAuth 链接；浏览器授权仍需完成。
const reauthAttempts = new Map(); // accountId -> ts（节流，防 401 风暴时反复生成流程）
const reauthNotified = new Map(); // accountId -> ts（webhook 通知 30 分钟节流）
export async function ensureReauthFlow(accountId, reason = '凭证失效', { force = false } = {}) {
  const a = getAccount(accountId);
  if (!a || !['bigmodel', 'zai'].includes(a.family)) return null;
  const existing = db().prepare("SELECT * FROM oauth_flows WHERE account_rowid=? AND status='pending' AND expires_at>?").get(a.id, Date.now());
  if (existing) return { ok: true, reused: true, flow_id: existing.flow_id, authorize_url: existing.authorize_url, expires_at: existing.expires_at };
  const last = reauthAttempts.get(a.id);
  // 失败时保留 30 分钟节流；手动续期可绕过。
  if (!force && last && Date.now() - last < 30 * 60 * 1000) return null;
  reauthAttempts.set(a.id, Date.now());
  const pollToken = randomHex(32);
  const init = await oauthCliInit(a.family, pollToken);
  if (!init.flowId || !init.authorizeUrl || !/^https:\/\//i.test(init.authorizeUrl)) throw new Error('授权初始化响应无效');
  const flow = { provider: a.family, pollToken, targetId: a.id, authorizeUrl: init.authorizeUrl,
    expiresAt: init.expiresAt || Date.now() + 10 * 60 * 1000, createdAt: Date.now(),
    intervalSec: Math.max(2, Number(init.pollIntervalSec) || 3), status: 'pending', error: null };
  persistFlow(init.flowId, flow); oauthFlows.set(init.flowId, flow); startFlowTimer(init.flowId, flow);
  audit('system', 'account.reauth_flow_started', { id: a.id, reason }, '');
  const validMin = Math.max(1, Math.round((flow.expiresAt - Date.now()) / 60000));
  const lastN = reauthNotified.get(a.id);
  if (!lastN || Date.now() - lastN > 30 * 60 * 1000) {
    reauthNotified.set(a.id, Date.now());
    import('../claims.js').then(({ notify }) =>
      notify(`账号 ${a.label} ${reason}，已自动生成再授权链接（${validMin} 分钟内有效），点击完成登录即可恢复：${flow.authorizeUrl}`)
    ).catch(() => {});
  }
  return { ok: true, reused: false, flow_id: init.flowId, authorize_url: flow.authorizeUrl, expires_at: flow.expiresAt };
}
