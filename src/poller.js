import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { logger } from './log.js';
import { listAccounts, getAccount, getTokens, updateAccount, cookieJarPath, accountDispatcher } from './accounts.js';
import { markAccountRecovered } from './scheduler.js';
import { fetchBalance } from './zcodeApi.js';
import { CookieJar } from './httpclient.js';

const log = logger('poller');
const notified = new Set(); // 通知去重（键含日期/阶段）

const timers = new Map();      // accountId -> NodeJS.Timeout
let running = false;
let cycleInFlight = 0;

export function startPoller() {
  if (running) return;
  running = true;
  // 启动即全量轮一轮（错峰）
  const accounts = listAccounts().filter((a) => a.tokens.zcode_jwt || a.tokens.web_jwt);
  accounts.forEach((a, i) => setTimeout(() => pollAccount(a.id).catch((e) => log.error('启动轮询失败', a.id, e)), 300 * i));
  log.info('QuotaPoller 已启动，账号数', accounts.length);
}

export function stopPoller() {
  running = false;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

export function scheduleNext(accountId, delayMs) {
  const old = timers.get(accountId);
  if (old) clearTimeout(old);
  if (!running) return;
  timers.set(accountId, setTimeout(async () => {
    timers.delete(accountId);
    try { await pollAccount(accountId); } catch (e) { log.error('轮询异常', accountId, e); }
  }, delayMs));
}

/** 单账号一次轮询：balance（或 web_only 的 touch ping）+ 快照 + 状态机 + 排下一次 */
export async function pollAccount(accountId) {
  const a = getAccount(accountId);
  if (!a || !running) return null;
  const cfg = config();
  checkCookieExpiry(a);
  if (a.status === 'web_only') {
    const { pingWebOnly } = await import('./accounts.js');
    try { await pingWebOnly(a); }
    catch (e) { log.warn('网页会话检查失败', a.id, e.message); }
    finally { scheduleNext(accountId, (cfg.web_only_ping_min * 60 + jitter(cfg.web_only_ping_min * 12)) * 1000); }
    return null;
  }
  const tokens = getTokens(a.id);
  if (!tokens.zcode_jwt) { scheduleNext(accountId, cfg.poll_interval_sec * 1000); return null; }

  // 全局并发上限
  while (cycleInFlight >= cfg.poll_concurrency) await sleep(300);
  cycleInFlight++;
  let bal = null;
  try {
    // 每账号持久化 cookie jar：WAF acw_tc 每响应轮换，必须回放（无 cookie 历史会被当可疑流量）
    const jar = new CookieJar(cookieJarPath(a.id));
    bal = await fetchBalance(tokens.zcode_jwt, a.device_mid, { jar, dispatcher: await accountDispatcher(a) });
    if (bal.ok) {
      applyBalanceSnapshot(a, bal);
    } else if (bal.authFailed) {
      updateAccount(a.id, { status: 'needs_relogin', fail_streak: a.fail_streak + 1, last_error: 'balance 401' });
      log.warn('账号 401 → needs_relogin', a.id, a.label);
      notifyThrottled(`auth:${a.id}:${new Date().toISOString().slice(0, 10)}`, `账号 ${a.label} 凭证失效（balance 401），需要重新授权`);
      // 401 自动再授权：自动生成授权链接并 webhook 推送（24h 节流），完成登录即恢复，无需进控制台找续期入口
      import('./admin/api.js').then((m) => m.ensureReauthFlow(a.id, '凭证失效（balance 401）'))
        .catch((e) => log.warn('自动再授权发起失败', a.id, e.message));
    } else {
      const streak = a.fail_streak + 1;
      // 429/5xx 指数退避
      const backoffSec = Math.min(3600, Math.max(cfg.poll_interval_sec, cfg.poll_interval_sec * 2 ** Math.min(streak, 6)));
      updateAccount(a.id, { fail_streak: streak, last_error: `balance HTTP ${bal.httpStatus}` });
      log.warn('轮询失败', a.id, `HTTP ${bal.httpStatus}`, `下次 ${backoffSec}s`);
      scheduleNext(accountId, backoffSec * 1000);
      return bal;
    }
  } catch (e) {
    updateAccount(a.id, { fail_streak: a.fail_streak + 1, last_error: `balance 异常: ${e.message}` });
    log.error('轮询异常', a.id, e.message);
    scheduleNext(accountId, (cfg.poll_interval_sec * 3) * 1000);
    return null;
  } finally {
    cycleInFlight--;
  }
  scheduleNext(accountId, (cfg.poll_interval_sec + jitter(cfg.poll_jitter_sec)) * 1000);
  return bal;
}

function applyBalanceSnapshot(a, bal) {
  const now = Date.now();
  const fields = {
    status: 'active',
    zcode_jwt_last_ok_at: now,
    last_ok_at: now,
    fail_streak: 0,
    last_error: null,
    capabilities: bal.capabilities,
    last_balance: bal.raw,
  };
  if (bal.card) {
    fields.card_started_at = bal.card.startedAt;
    fields.card_expires_at = bal.card.endsAt;
  } else {
    fields.card_expires_at = null;
  }
  updateAccount(a.id, fields);
  markAccountRecovered(a.id); // 账号恢复：清调度器内存冷却/熔断（否则 401 熔断后即使 relogin 成功也选不中）

  // 快照落库（每 bucket 一行）
  const ins = db().prepare(`INSERT INTO quota_snapshots(account_id,ts,bucket_id,entitlement_id,meter,total_units,used_units,remaining_units,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const b of bal.balances) {
    ins.run(a.id, now, b.bucket_id || null, b.entitlement_id || null, b.meter || null,
      b.total_units ?? null, b.used_units ?? null, b.remaining_units ?? null, b.expires_at ? b.expires_at * 1000 : null);
  }
  pruneSnapshots(a.id);
  checkThresholds(a, bal);
}

/** 额度/到期阈值通知（每卡每阶段一次） */
function checkThresholds(a, bal) {
  const total = bal.balances.reduce((s, b) => s + (b.total_units ?? 0), 0);
  const remaining = bal.balances.reduce((s, b) => s + (b.remaining_units ?? 0), 0);
  if (total > 0 && remaining / total < 0.2) {
    notifyThrottled(`low:${a.id}:${bal.card?.userPlanId || 'card'}`, `账号 ${a.label} 额度不足 20%（剩 ${Math.round(remaining / 10000)} 万）`);
  }
  if (bal.card?.endsAt) {
    const leftMin = (bal.card.endsAt - Date.now()) / 60000;
    if (leftMin > 0 && leftMin <= 60) {
      notifyThrottled(`expire1h:${a.id}:${bal.card.endsAt}`, `账号 ${a.label} 的卡将在 ${Math.round(leftMin)} 分钟后到期，记得领新卡`);
    }
  }
}

/** 每个有效期的 7 天、1 天与过期阶段各提醒一次，记录跨重启保留。 */
export function checkCookieExpiry(a, now = Date.now()) {
  const expiry = Number(a.web_cookie_expires_at);
  if (!a.tokens?.web_jwt || !Number.isFinite(expiry) || expiry <= 0) return null;
  const left = expiry - now;
  const stage = left <= 0 ? 'expired' : left <= 86400000 ? 'day' : left <= 7 * 86400000 ? 'week' : null;
  if (!stage) return null;
  const key = `cookie_notice:${a.id}`;
  const state = getSetting(key, {});
  if (state.expiry !== expiry || !state[stage]) {
    const current = state.expiry === expiry ? state : { expiry };
    current[stage] = now; setSetting(key, current);
    const message = stage === 'expired' ? '已到期' : stage === 'day' ? '将在 24 小时内到期' : '将在 7 天内到期';
    import('./claims.js').then(({ notify }) => notify(`账号 ${a.label} 的网页 Cookie ${message}，请更新会话`)).catch(() => {});
  }
  return stage;
}

function notifyThrottled(key, text) {
  if (notified.has(key)) return;
  notified.add(key);
  if (notified.size > 500) notified.clear(); // 简单防膨胀
  import('./claims.js').then(({ notify }) => notify(text)).catch(() => {});
}

function pruneSnapshots(accountId) {
  // 只保留 48h 内的快照，避免无限膨胀
  const cutoff = Date.now() - 48 * 3600 * 1000;
  db().prepare('DELETE FROM quota_snapshots WHERE account_id=? AND ts < ?').run(accountId, cutoff);
}

function jitter(sec) {
  return sec > 0 ? Math.floor(Math.random() * sec) : 0;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 用量聚合：服务端累计值 delta（重启不丢，按 bucket 记 delta） */
export function usageDelta(accountId, hours = 24) {
  const since = Date.now() - hours * 3600 * 1000;
  const rows = db().prepare(`SELECT bucket_id, ts, used_units FROM quota_snapshots WHERE account_id=? AND ts>=? ORDER BY ts`).all(accountId, since);
  const first = {}, last = {};
  for (const r of rows) {
    if (r.used_units === null) continue;
    if (!(r.bucket_id in first)) first[r.bucket_id] = r.used_units;
    last[r.bucket_id] = r.used_units;
  }
  let delta = 0;
  for (const k of Object.keys(last)) delta += Math.max(0, (last[k] - first[k]) || 0);
  return delta;
}

/** 全池汇总（看板用） */
export function poolSummary() {
  const accounts = listAccounts();
  const now = Date.now();
  let totalRemaining = 0, totalUsed = 0, totalGranted = 0, activeCount = 0;
  const perAccount = accounts.map((a) => {
    const bal = a.last_balance?.balances || a.last_balance?.data?.balances || [];
    let remaining = 0, used = 0, total = 0;
    for (const b of bal) {
      remaining += b.remaining_units ?? 0;
      used += b.used_units ?? 0;
      total += b.total_units ?? 0;
    }
    if (a.status === 'active') activeCount++;
    totalRemaining += remaining; totalUsed += used; totalGranted += total;
    return {
      id: a.id, label: a.label, family: a.family, status: a.status, group_id: a.group_id,
      capabilities: a.capabilities, card_expires_at: a.card_expires_at,
      remaining, used, total,
      expiring_in_min: a.card_expires_at ? Math.round((a.card_expires_at - now) / 60000) : null,
      last_ok_at: a.last_ok_at, last_error: a.last_error,
      delta24h: usageDelta(a.id, 24),
    };
  });
  return { accounts: perAccount, totalRemaining, totalUsed, totalGranted, activeCount, count: accounts.length };
}
