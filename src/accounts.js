import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db, audit } from './db.js';
import { config, DATA_DIR } from './config.js';
import { logger } from './log.js';
import { encrypt, decrypt, decryptOfficial, randomUuid } from './crypto.js';
import { fetchBalance } from './zcodeApi.js';
import { CookieJar } from './httpclient.js';
import { listGroups, markAccountRecovered } from './scheduler.js';

const log = logger('accounts');

export function cookiesDir() { return path.join(DATA_DIR, 'cookies'); }

export function cookieJarPath(accountId) {
  return path.join(cookiesDir(), `${accountId}.json`);
}

export function newAccountId() { return 'acc_' + randomUuid().slice(0, 8); }

/** family 推断：bigmodel | zai */
export function normalizeFamily(f) {
  const v = String(f || '').toLowerCase();
  if (v === 'zai' || v === 'z.ai' || v.includes('zai')) return 'zai';
  return 'bigmodel';
}

/** JWT payload 解析（不验签，仅看声明） */
export function jwtPayload(jwt) {
  try {
    const part = jwt.split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch { return null; }
}

function isClientJwt(payload) {
  // 客户端 zcodejwttoken：{user_id, token_version, sub, iat}；网页 JWT 带 user_channel/user_type
  return !!payload && payload.user_id !== undefined && payload.user_channel === undefined;
}

export function insertAccount({ label, family, tokens, deviceMid, source, customerId = null, webCookieExpiresAt = null, status = 'unverified', groupId = undefined }) {
  const id = newAccountId();
  const enc = {};
  for (const [k, v] of Object.entries(tokens)) if (v) enc[k] = encrypt(v);
  const cfg = config();
  // 默认按族自动归类（杜绝混组）；调用方可显式覆盖
  let gid = groupId;
  if (gid === undefined) {
    try {
      const groups = listGroups();
      const primary = groups.find((g) => g.enabled && g.role === 'primary' && (g.family_filter === family || !g.family_filter));
      gid = primary?.id || null;
    } catch { gid = null; }
  }
  db().prepare(`INSERT INTO accounts(id,label,family,customer_id,group_id,status,enc_tokens,device_mid,app_version,web_cookie_expires_at,source,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, label || `${family}-账号`, family, customerId, gid, status, JSON.stringify(enc), deviceMid, cfg.app_version, webCookieExpiresAt, source, Date.now());
  return getAccount(id);
}

export function getAccount(id) {
  const row = db().prepare('SELECT * FROM accounts WHERE id=?').get(id);
  return row ? shapeAccount(row) : null;
}

export function shapeAccount(row) {
  let tokens = {};
  try { tokens = JSON.parse(row.enc_tokens); } catch { /* 忽略 */ }
  return {
    id: row.id,
    label: row.label,
    family: row.family,
    customer_id: row.customer_id,
    group_id: row.group_id,
    status: row.status,
    tokens,
    device_mid: row.device_mid,
    app_version: row.app_version,
    card_started_at: row.card_started_at,
    card_expires_at: row.card_expires_at,
    web_cookie_expires_at: row.web_cookie_expires_at,
    business_token_expires_at: row.business_token_expires_at,
    zcode_jwt_last_ok_at: row.zcode_jwt_last_ok_at,
    fail_streak: row.fail_streak,
    cooldown_until: row.cooldown_until,
    capabilities: safeParse(row.capabilities, []),
    last_balance: safeParse(row.last_balance, null),
    last_error: row.last_error,
    proxy_url: row.proxy_url || null,
    source: row.source,
    created_at: row.created_at,
    last_ok_at: row.last_ok_at,
    last_used_at: row.last_used_at,
  };
}

function safeParse(s, dflt) {
  try { return s ? JSON.parse(s) : dflt; } catch { return dflt; }
}

export function listAccounts() {
  return db().prepare('SELECT * FROM accounts ORDER BY created_at').all().map(shapeAccount);
}

/** 对外展示视图：不泄露 token 本体 */
export function publicAccount(a) {
  const { tokens, ...rest } = a;
  return {
    ...rest,
    has_zcode_jwt: !!tokens.zcode_jwt,
    has_web_jwt: !!tokens.web_jwt,
    has_business_token: !!tokens.business_token,
    token_kinds: Object.keys(tokens),
  };
}

export function updateAccount(id, fields) {
  const allowed = ['label', 'family', 'customer_id', 'group_id', 'status', 'enc_tokens', 'device_mid', 'app_version',
    'card_started_at', 'card_expires_at', 'web_cookie_expires_at', 'business_token_expires_at', 'zcode_jwt_last_ok_at',
    'fail_streak', 'cooldown_until', 'capabilities', 'last_balance', 'last_error', 'proxy_url', 'last_ok_at', 'last_used_at'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k}=?`);
    vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  }
  if (!sets.length) return;
  vals.push(id);
  db().prepare(`UPDATE accounts SET ${sets.join(',')} WHERE id=?`).run(...vals);
}

export function setTokens(id, tokens) {
  const a = getAccount(id);
  if (!a) return;
  const merged = { ...a.tokens };
  for (const [k, v] of Object.entries(tokens)) {
    if (v === null || v === undefined) delete merged[k];
    else merged[k] = encrypt(v);
  }
  updateAccount(id, { enc_tokens: merged });
}

export function getTokens(id) {
  const a = getAccount(id);
  if (!a) return {};
  const out = {};
  for (const [k, v] of Object.entries(a.tokens)) {
    try { out[k] = decrypt(v); } catch { out[k] = null; }
  }
  return out;
}

export function deleteAccount(id) {
  db().prepare('DELETE FROM accounts WHERE id=?').run(id);
  db().prepare('DELETE FROM quota_snapshots WHERE account_id=?').run(id);
  try { fs.rmSync(cookieJarPath(id), { force: true }); } catch { /* 忽略 */ }
}

/**
 * balance 加验 + 建档快照。
 * 返回 { ok, status, reason, balance }
 */
export async function verifyAndMark(a) {
  const tokens = getTokens(a.id);
  if (!tokens.zcode_jwt) {
    // 仅网页 cookie：能力受限账号
    if (tokens.web_jwt) {
      updateAccount(a.id, { status: 'web_only', last_error: null });
      return { ok: true, status: 'web_only', reason: '无 zcode_jwt，按 web_only 建档（不可 balance/推理）' };
    }
    updateAccount(a.id, { status: 'unverified', last_error: '缺少任何可用凭据' });
    return { ok: false, status: 'unverified', reason: '缺少任何可用凭据' };
  }
  const bal = await fetchBalance(tokens.zcode_jwt, a.device_mid, { jar: new CookieJar(cookieJarPath(a.id)), dispatcher: await accountDispatcher(a) });
  if (bal.ok) {
    const fields = {
      status: 'active',
      zcode_jwt_last_ok_at: Date.now(),
      last_ok_at: Date.now(),
      fail_streak: 0,
      last_error: null,
      capabilities: bal.capabilities,
      last_balance: bal.raw,
    };
    if (bal.card) {
      fields.card_started_at = bal.card.startedAt;
      fields.card_expires_at = bal.card.endsAt;
    }
    updateAccount(a.id, fields);
    markAccountRecovered(a.id); // 手动 verify 成功 → 清调度器内存冷却/熔断
    return { ok: true, status: 'active', balance: bal };
  }
  if (bal.authFailed) {
    updateAccount(a.id, { status: 'needs_relogin', fail_streak: a.fail_streak + 1, last_error: 'balance 401：ZCode JWT 失效或渠道不符' });
    return { ok: false, status: 'needs_relogin', reason: 'balance 401：ZCode JWT 失效（网页 JWT 不可用于 balance）' };
  }
  updateAccount(a.id, { status: a.status === 'unverified' ? 'unverified' : 'cooldown', fail_streak: a.fail_streak + 1, last_error: `balance HTTP ${bal.httpStatus}` });
  return { ok: false, status: a.status === 'unverified' ? 'unverified' : 'cooldown', reason: `balance HTTP ${bal.httpStatus}` };
}

export function localCredentialCandidates() {
  const credFile = path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');
  if (!fs.existsSync(credFile)) return [];
  let raw;
  try { raw = JSON.parse(fs.readFileSync(credFile, 'utf8')); } catch { return []; }
  return [raw]; // 目前单客户端单账号；结构上预留数组
}

export async function importFromLocal({ label } = {}) {
  const candidates = localCredentialCandidates();
  if (!candidates.length) {
    return { ok: false, reason: `本机未找到客户端凭据 ${path.join(os.homedir(), '.zcode', 'v2', 'credentials.json')}` };
  }
  let imported = 0, results = [];
  for (const raw of candidates) {
    // 官方凭据按官方回退密钥解密
    const tokens = {};
    let deviceId = null;
    const telFile = path.join(os.homedir(), '.zcode', 'v2', 'telemetry-state.json');
    try { deviceId = JSON.parse(fs.readFileSync(telFile, 'utf8')).deviceMid || null; } catch { /* 忽略 */ }
    // 用官方回退密钥解密每个槽位
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== 'string' || !v.startsWith('enc:v1:')) continue;
      try {
        const plain = decryptOfficial(v);
        if (k === 'zcodejwttoken') tokens.zcode_jwt = plain;
        else if (k === 'oauth:bigmodel:access_token') tokens.business_token = plain;
        else if (k === 'oauth:zai:access_token') tokens.business_token = plain;
        else if (k === 'oauth:active_provider') tokens.active_provider = plain;
      } catch (e) { log.warn('官方凭据解密失败', k, e.message); }
    }
    if (!tokens.zcode_jwt) {
      results.push({ ok: false, reason: '凭据中无 zcodejwttoken' });
      continue;
    }
    const payload = jwtPayload(tokens.zcode_jwt);
    const customerId = payload?.user_id || null;
    const family = normalizeFamily(tokens.active_provider || 'bigmodel');
    // 去重：同 customer_id 已存在则跳过
    const dup = db().prepare('SELECT id FROM accounts WHERE customer_id=?').get(customerId);
    if (dup) {
      results.push({ ok: false, reason: `账号 customer_id=${customerId} 已存在（${dup.id}）`, existing: dup.id });
      continue;
    }
    const acc = insertAccount({
      label: label || `本机-${family}`,
      family,
      tokens,
      deviceMid: deviceId || randomUuid(),
      source: 'local',
      customerId,
    });
    const v = await verifyAndMark(acc);
    audit('system', 'account.import_local', { id: acc.id, family, result: v.status });
    results.push({ ok: v.ok, id: acc.id, status: v.status, reason: v.reason });
    if (v.ok) imported++;
  }
  return { ok: imported > 0, imported, results };
}

export async function importFromCookie({ family = 'bigmodel', webJwt, label, expiresAt = null }) {
  if (expiresAt != null && expiresAt !== '' && (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= Date.now())) return { ok: false, reason: 'Cookie 到期时间无效或已过期' };
  const payload = jwtPayload(webJwt);
  if (!payload) return { ok: false, reason: '不是可解析的 JWT' };
  if (isClientJwt(payload)) return { ok: false, reason: '这是客户端 zcode_jwt（可走完整导入），请用「本机导入/OAuth」，Cookie 导入仅收网页会话 JWT' };
  const customerId = payload.customer_id ? String(payload.customer_id) : (payload.user_id ? String(payload.user_id) : null);
  if (payload.exp && payload.exp * 1000 <= Date.now()) return { ok: false, reason: '网页 JWT 已过期' };
  const { getCustomerInfo } = await import('./zcodeApi.js');
  let check;
  try { check = await getCustomerInfo(webJwt, normalizeFamily(family)); }
  catch (e) { return { ok: false, reason: `网页会话验证失败：${e.message}` }; }
  if (!check.ok) return { ok: false, reason: `网页会话验证失败（HTTP ${check.status}）` };
  if (customerId && db().prepare('SELECT id FROM accounts WHERE family=? AND customer_id=?').get(normalizeFamily(family), customerId)) return { ok: false, reason: '账号已存在，请使用该账号的续期按钮更新 Cookie' };
  const acc = insertAccount({
    label: label || `Cookie-${family}`,
    family: normalizeFamily(family),
    tokens: { web_jwt: webJwt },
    deviceMid: randomUuid(),
    source: 'cookie',
    customerId,
    webCookieExpiresAt: expiresAt ? Number(expiresAt) : (Number.isFinite(payload.exp) ? payload.exp * 1000 : null),
    status: 'web_only',
  });
  audit('admin', 'account.import_cookie', { id: acc.id, family });
  return { ok: true, id: acc.id, status: 'web_only' };
}

/** 用用户重新取得的网页会话更新现有账号；资料验证不能延长上游签发的有效期。 */
export async function refreshWebCookie(a, webJwt, expiresAt = null) {
  const token = String(webJwt || '').trim();
  const payload = jwtPayload(token);
  if (!payload || isClientJwt(payload)) return { ok: false, error: '请输入有效的网页会话 JWT' };
  const identity = payload.customer_id ?? payload.user_id;
  if (!a.customer_id || identity == null || String(identity) !== String(a.customer_id)) return { ok: false, error: '无法确认 Cookie 与账号身份一致，未更新' };
  const { getCustomerInfo } = await import('./zcodeApi.js');
  let result;
  try { result = await getCustomerInfo(token, a.family, { dispatcher: await accountDispatcher(a) }); }
  catch (e) { return { ok: false, error: `会话验证失败：${e.message}` }; }
  if (!result.ok) return { ok: false, error: `会话验证失败（HTTP ${result.status}）` };
  const expiry = expiresAt == null || expiresAt === '' ? (Number.isFinite(payload.exp) ? payload.exp * 1000 : null) : Number(expiresAt);
  if (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now())) return { ok: false, error: 'Cookie 到期时间无效或已过期' };
  setTokens(a.id, { web_jwt: token });
  updateAccount(a.id, { web_cookie_expires_at: expiry, last_ok_at: Date.now(), last_error: null });
  return { ok: true, expires_at: expiry };
}

/** 账号的出站代理 dispatcher（proxyDispatcherFor 缓存复用；无配置返回 undefined） */
export async function accountDispatcher(a) {
  const { proxyDispatcherFor } = await import('./httpclient.js');
  return proxyDispatcherFor(a?.proxy_url);
}

/** 受限账号低频保活 ping（getCustomerInfo：网页 JWT 裸 token，顺带核验会话有效性） */
export async function pingWebOnly(a) {
  const tokens = getTokens(a.id);
  if (!tokens.web_jwt) return { ok: false, reason: '无 web_jwt' };
  const { getCustomerInfo } = await import('./zcodeApi.js');
  const r = await getCustomerInfo(tokens.web_jwt, a.family, { dispatcher: await accountDispatcher(a) });
  if (r.ok) {
    updateAccount(a.id, { last_ok_at: Date.now(), last_error: null });
    return { ok: true };
  }
  updateAccount(a.id, { last_error: `getCustomerInfo HTTP ${r.status}` });
  return { ok: false, status: r.status };
}

/** 一键体检：balance / preview / 桥冒烟 三连 */
export async function healthCheck(a, { skipBridge = false } = {}) {
  const report = { id: a.id, label: a.label, family: a.family, checks: [] };
  const tokens = getTokens(a.id);
  const { getPreview } = await import('./zcodeApi.js');
  if (tokens.zcode_jwt) {
    const v = await verifyAndMark(a);
    report.checks.push({ name: 'balance', ok: v.ok, detail: v.ok ? `剩余卡：${v.balance?.card?.planId || '无 start-plan 卡'}` : v.reason });
  } else if (tokens.web_jwt) {
    const p = await pingWebOnly(a);
    report.checks.push({ name: 'getCustomerInfo', ok: p.ok, detail: p.ok ? '网页会话有效' : `HTTP ${p.status}` });
  }
  if (tokens.zcode_jwt) {
    try {
      const pv = await getPreview(tokens.zcode_jwt, a.device_mid, { jar: new CookieJar(cookieJarPath(a.id)), dispatcher: await accountDispatcher(a) });
      report.checks.push({ name: 'preview', ok: true, detail: `可领 ${pv.plans.length} 张卡` });
    } catch (e) {
      report.checks.push({ name: 'preview', ok: false, detail: e.message });
    }
  }
  if (!skipBridge && tokens.zcode_jwt) {
    try {
      const { bridgeSmoke } = await import('./bridge/pool.js');
      const r = await bridgeSmoke(a.id);
      report.checks.push({ name: 'bridge', ok: r.ok, detail: r.detail });
    } catch (e) {
      report.checks.push({ name: 'bridge', ok: false, detail: e.message });
    }
  }
  report.ok = report.checks.every((c) => c.ok);
  return report;
}
