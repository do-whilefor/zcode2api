import { db } from './db.js';
import { logger } from './log.js';
import { retryParams, busyWaitMs, busyCooldownMs, busyEscalationMs } from './retry.js';

const log = logger('scheduler');

/**
 * 账号调度器：分组链 + 策略 + 每账号 inflight=1。
 * 账号运行时状态（inflight/busyStreak/cooldown）存内存，持久状态存 accounts 表。
 */
const runtime = new Map(); // accountId -> { inflight, busyStreak, cooldownUntil, lastUsedAt, queueWaiters }

function rt(accountId) {
  let r = runtime.get(accountId);
  if (!r) {
    r = { inflight: 0, busyStreak: 0, cooldownUntil: 0, lastUsedAt: 0, queueWaiters: 0 };
    runtime.set(accountId, r);
  }
  return r;
}

export function accountRuntime(accountId) { return { ...rt(accountId) }; }

export function markBusy(accountId, { zeroInflight = false } = {}) {
  const p = retryParams();
  const r = rt(accountId);
  r.busyStreak += 1;
  const ms = zeroInflight && r.busyStreak >= 2 ? busyEscalationMs(r.busyStreak, p) : busyCooldownMs(p);
  r.cooldownUntil = Date.now() + ms;
  return ms;
}

export function markBusyResolved(accountId) {
  rt(accountId).busyStreak = 0;
  rt(accountId).cooldownUntil = 0;
}

export function markAuthDead(accountId) {
  const r = rt(accountId);
  r.busyStreak = 0;
  r.cooldownUntil = Date.now() + 24 * 3600 * 1000; // 调度层熔断；needs_relogin 恢复后由轮询重置
}

export function markAuthAlive(accountId) {
  const r = rt(accountId);
  r.busyStreak = 0;
  if (r.cooldownUntil > Date.now() + 3600 * 1000) r.cooldownUntil = 0; // 只解除长熔断
}

/**
 * 账号恢复（balance 成功：轮询/手动 verify/领卡刷新）→ 清空调度器内存的全部冷却与熔断。
 * 否则 401 熔断（24h）的账号即使 relogin 成功也要等冷却自然过期才会被再次选中。
 */
export function markAccountRecovered(accountId) {
  const r = rt(accountId);
  r.busyStreak = 0;
  r.cooldownUntil = 0;
}

const stickyMap = new Map(); // keyId -> { accountId, at }

export function recordSticky(keyId, accountId) {
  stickyMap.set(keyId, { accountId, at: Date.now() });
  if (stickyMap.size > 1000) { // 防膨胀：过期项在选中时本就会被忽略，这里只兜底清理
    const now = Date.now();
    for (const [k, v] of stickyMap) if (now - v.at > 24 * 3600 * 1000) stickyMap.delete(k);
  }
}

export function releaseInflight(accountId) {
  const r = rt(accountId);
  r.inflight = Math.max(0, r.inflight - 1);
  r.lastUsedAt = Date.now();
}

export function groupById(id) {
  return db().prepare('SELECT * FROM groups WHERE id=?').get(id);
}

export function listGroups() {
  return db().prepare('SELECT * FROM groups ORDER BY created_at').all();
}

export function defaultChain() {
  const groups = listGroups().filter((g) => g.enabled);
  const primary = groups.find((g) => g.role === 'primary');
  const backup = groups.find((g) => g.role === 'backup');
  return [primary?.id, backup?.id].filter(Boolean);
}

/** 等待有空闲的可用账号；排队选择只探测，不保留 inflight。 */
export async function waitForAvailableAccount(chain, model, ctx = {}, { timeoutMs = busyWaitMs(), signal, select = selectAccount, release = releaseInflight, undoQueue = id => { const state = rt(id); state.queueWaiters = Math.max(0, state.queueWaiters - 1); }, pauseMs = 300 } = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastBusy = null;
  let busySince = null;
  while (true) {
    if (signal?.aborted) throw Object.assign(new Error('客户端已断开'), { code: 'canceled', kind: 'canceled' });
    if (lastBusy && Date.now() >= deadline) return { ...lastBusy, account: null, busyTimeout: true };
    const sel = select(chain, model, ctx);
    if (!sel.account && !sel.busy) return sel;
    if (sel.account && !sel.queued) return busySince === null ? sel : { ...sel, busySince };
    if (sel.account) { release(sel.account.id); undoQueue(sel.account.id); }
    lastBusy = sel;
    busySince ??= Date.now();
    const left = deadline - Date.now();
    if (left <= 0) return { ...sel, account: null, busyTimeout: true };
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, Math.min(pauseMs, left));
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
  }
}

/**
 * 选账号。返回 { account, runtime, skipNote } 或 { account: null, skipReasons, candidates }
 * ctx: { keyId?, stickyMinutes? } —— stickyMinutes>0 且上次绑定的账号可用时优先黏住
 */
export function selectAccount(chainIds, model, ctx = {}) {
  const p = retryParams();
  const now = Date.now();
  const minWindowMs = (p.min_request_window_sec || 60) * 1000;
  const candidates = [];
  const groups = chainIds.map((id) => groupById(id)).filter((g) => g && g.enabled);

  // 黏连优先：窗口内且账号可用（空闲、无冷却、状态正常）→ 直接选中，不进入策略排序
  const stickyMin = Number(ctx.stickyMinutes) > 0 ? Number(ctx.stickyMinutes) : 0;
  const stickyEntry = stickyMin ? stickyMap.get(ctx.keyId) : null;
  const stickyId = stickyEntry && now - stickyEntry.at <= stickyMin * 60 * 1000 ? stickyEntry.accountId : null;

  let waiting = null;
  for (const g of groups) {
    const accounts = db().prepare("SELECT * FROM accounts WHERE group_id=? ORDER BY created_at").all(g.id);
    const usable = [];
    for (const row of accounts) {
      const skip = skipReason(row, { model, now, minWindowMs, familyFilter: g.family_filter });
      candidates.push({ account: row.id, label: row.label, skip: skip || null, retry_busy: !!skip?.startsWith('cooldown_until') && rt(row.id).busyStreak > 0, picked: false });
      if (!skip) usable.push(row);
    }
    if (!usable.length) continue;

    let pool;
    if (stickyId) {
      const pinned = usable.find((a) => a.id === stickyId);
      if (pinned && rt(pinned.id).inflight === 0 && rt(pinned.id).cooldownUntil <= now) {
        candidates.forEach((c) => { if (c.account === pinned.id) c.picked = true; });
        const r0 = rt(pinned.id);
        r0.inflight += 1;
        return { account: pinned, runtime: r0, queued: false, candidates, policy: `${g.policy}+sticky`, chain: groups.map((x) => x.name) };
      }
    }
    if (g.policy === 'expiring_first') {
      const urgentWin = (g.urgent_window_min || 180) * 60000;
      const urgent = usable.filter((a) => a.card_expires_at && a.card_expires_at - now < urgentWin)
        .sort((a, b) => a.card_expires_at - b.card_expires_at);
      const rest = usable.filter((a) => !urgent.includes(a)).sort((a, b) => (rt(b.id).lastUsedAt || 0) - (rt(a.id).lastUsedAt || 0));
      pool = [...urgent, ...rest];
    } else if (g.policy === 'remaining_desc') {
      pool = [...usable].sort((a, b) => remainingOf(b) - remainingOf(a));
    } else {
      pool = [...usable].sort((a, b) => (rt(a.id).lastUsedAt || 0) - (rt(b.id).lastUsedAt || 0)); // LRU
    }
    const free = pool.find((a) => rt(a.id).inflight === 0 && rt(a.id).cooldownUntil <= now);
    if (!free) { if (!waiting) waiting = { picked: pool[0], policy: g.policy }; continue; }
    const picked = free;
    candidates.forEach((c) => { if (c.account === picked.id) c.picked = true; });
    const r = rt(picked.id);
    if (!free) r.queueWaiters += 1; // 全忙时排队
    r.inflight += 1;
    return { account: picked, runtime: r, queued: !free, candidates, policy: g.policy, chain: groups.map((x) => x.name) };
  }
  if (waiting) {
    const r = rt(waiting.picked.id); r.queueWaiters += 1; r.inflight += 1;
    candidates.forEach(c => { if (c.account === waiting.picked.id) c.picked = true; });
    return { account: waiting.picked, runtime: r, queued: true, candidates, policy: waiting.policy, chain: groups.map(x => x.name) };
  }
  return { account: null, busy: candidates.some(c => c.retry_busy), candidates, chain: groups.map((x) => x.name) };
}

function remainingOf(row) {
  try {
    const bal = JSON.parse(row.last_balance || 'null');
    const list = bal?.balances || bal?.data?.balances || [];
    return list.reduce((s, b) => s + (b.remaining_units ?? 0), 0);
  } catch { return 0; }
}

function skipReason(row, { model, now, minWindowMs, familyFilter }) {
  const r = rt(row.id);
  if (row.status === 'web_only') return 'web_only 受限账号不参与推理调度';
  if (row.status !== 'active') return `status=${row.status}`;
  if (row.card_expires_at && row.card_expires_at - now < minWindowMs) return `expires_in ${Math.round((row.card_expires_at - now) / 1000)}s < min_window`;
  if (familyFilter && row.family !== familyFilter) return `family=${row.family} 不符分组过滤 ${familyFilter}`;
  const caps = safeCaps(row.capabilities);
  // 官方模型 ID 大小写归一（balance 返回小写，请求用官方驼峰）
  if (model && caps.length && !caps.some((c) => String(c).toLowerCase() === model.toLowerCase())) return `model ${model} 不在 capabilities`;
  const bal = safeParse(row.last_balance);
  const list = bal?.balances || bal?.data?.balances || [];
  if (list.length && !list.some((b) => (b.remaining_units ?? 0) > 0)) return 'quota_remaining=0';
  if (r.cooldownUntil > now) return `cooldown_until+${Math.round((r.cooldownUntil - now) / 1000)}s`;
  return null;
}

function safeCaps(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }
function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

/** 调度解释日志 */
export function logSchedule(requestId, chain, candidates, policy, picked) {
  db().prepare('INSERT INTO schedule_log(ts,request_id,chain,candidates,policy,picked) VALUES(?,?,?,?,?,?)')
    .run(Date.now(), requestId, JSON.stringify(chain), JSON.stringify(candidates), policy || null, picked || null);
}

export function recentScheduleLogs(limit = 50) {
  return db().prepare('SELECT * FROM schedule_log ORDER BY ts DESC LIMIT ?').all(limit);
}
