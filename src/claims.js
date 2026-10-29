import { db, audit } from './db.js';
import { config } from './config.js';
import { logger } from './log.js';
import { listAccounts, getAccount, getTokens, updateAccount, cookieJarPath, accountDispatcher } from './accounts.js';
import { getClientConfigs, getPreview, claimPlan } from './zcodeApi.js';
import { fetchBalance } from './zcodeApi.js';
import { markAccountRecovered } from './scheduler.js';
import { CookieJar } from './httpclient.js';

const log = logger('claims');

let claimTimer = null;

export function startClaimScheduler() {
  const cfg = config();
  if (!cfg.claim_auto_enabled) return;
  if (claimTimer) clearInterval(claimTimer);
  claimTimer = setInterval(async () => {
    try { await runAutoClaim(); } catch (e) { log.error('自动领卡巡检失败', e); }
  }, cfg.claim_auto_min * 60 * 1000);
  log.info('ClaimService 定时巡检已启动，周期(分)', cfg.claim_auto_min);
}

export function stopClaimScheduler() {
  if (claimTimer) clearInterval(claimTimer);
  claimTimer = null;
}

/** 领卡发现：configs 投放模板 + 账号可领清单（preview） */
export async function discover({ accountId = null } = {}) {
  const out = { configs: null, previews: [] };
  try {
    const configs = await getClientConfigs();
    out.configs = {
      startPlanPreview: configs.startPlanPreview || null,
      captcha: configs.captcha || null,
      forceUpdate: configs.forceUpdate ?? null,
    };
  } catch (e) {
    out.configsError = e.message;
  }
  const accounts = accountId ? [getAccount(accountId)].filter(Boolean) : listAccounts();
  for (const a of accounts) {
    const tokens = getTokens(a.id);
    if (!tokens.zcode_jwt) continue;
    const jar = new CookieJar(cookieJarPath(a.id));
    try {
      const pv = await getPreview(tokens.zcode_jwt, a.device_mid, { jar, dispatcher: await accountDispatcher(a) });
      // 成功也登记（plans 可能为空：当前无可领 ≠ 无账号）
      out.previews.push({ account_id: a.id, label: a.label, plans: pv.plans });
    } catch (e) {
      out.previews.push({ account_id: a.id, label: a.label, error: e.message });
    }
  }
  return out;
}

/** 领取：plan_id 来自 preview；成功判定 code===0 且 data.plan 存在 */
export async function claim(accountId, planId, trigger = 'manual') {
  const a = getAccount(accountId);
  if (!a) throw new Error('账号不存在');
  const tokens = getTokens(a.id);
  if (!tokens.zcode_jwt) throw new Error('该账号无 zcode_jwt（web_only 受限账号不可领取）');
  const jar = new CookieJar(cookieJarPath(a.id));
  const dispatcher = await accountDispatcher(a);
  const result = await claimPlan(tokens.zcode_jwt, a.device_mid, planId, { jar, dispatcher });
  db().prepare(`INSERT INTO claim_log(account_id,ts,plan_id,ok,code,message,user_plan_id,ends_at,trigger)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(a.id, Date.now(), planId, result.ok ? 1 : 0, result.code, result.message,
      result.plan?.user_plan_id || null, result.endsAt || null, trigger);
  audit(trigger === 'manual' ? 'admin' : 'system', 'claim', { account: a.id, plan_id: planId, ok: result.ok, code: result.code });
  if (result.ok) {
    // 领取后立刻强制刷新 balance（官方同款缓存失效语义）
    try {
      const bal = await fetchBalance(tokens.zcode_jwt, a.device_mid, { jar, dispatcher });
      if (bal.ok) {
        const fields = { status: 'active', zcode_jwt_last_ok_at: Date.now(), last_ok_at: Date.now(), fail_streak: 0, capabilities: bal.capabilities, last_balance: bal.raw };
        if (bal.card) { fields.card_started_at = bal.card.startedAt; fields.card_expires_at = bal.card.endsAt; }
        updateAccount(a.id, fields);
        markAccountRecovered(a.id); // 领卡恢复 → 清调度器内存冷却/熔断
      }
    } catch (e) { log.warn('领取后刷新 balance 失败', a.id, e.message); }
  }
  return result;
}

/** 自动巡检：每个 active/unverified 账号 preview → 有可领即领 → 记录 */
export async function runAutoClaim({ dryRun = false } = {}) {
  const summary = { checked: 0, claimed: 0, results: [] };
  const accounts = listAccounts().filter((a) => ['active', 'unverified', 'cooldown'].includes(a.status));
  for (const a of accounts) {
    const tokens = getTokens(a.id);
    if (!tokens.zcode_jwt) continue;
    summary.checked++;
    const jar = new CookieJar(cookieJarPath(a.id));
    try {
      const pv = await getPreview(tokens.zcode_jwt, a.device_mid, { jar, dispatcher: await accountDispatcher(a) });
      for (const plan of pv.plans) {
        const planId = plan.plan_id;
        if (!planId) continue;
        if (dryRun) { summary.results.push({ account: a.id, plan_id: planId, would_claim: true }); continue; }
        const r = await claim(a.id, planId, 'auto');
        summary.results.push({ account: a.id, plan_id: planId, ok: r.ok, code: r.code, message: r.message });
        if (r.ok) summary.claimed++;
      }
    } catch (e) {
      summary.results.push({ account: a.id, error: e.message });
    }
  }
  if (summary.claimed > 0) notify(`自动领卡：本次领取 ${summary.claimed} 张（巡检 ${summary.checked} 账号）`);
  return summary;
}

export function claimHistory(limit = 100) {
  return db().prepare(`SELECT c.*, a.label AS account_label FROM claim_log c LEFT JOIN accounts a ON a.id=c.account_id
    ORDER BY c.ts DESC LIMIT ?`).all(limit);
}

/** 通知（webhook；空则只记日志） */
export function notify(text) {
  const cfg = config();
  log.info('[通知]', text);
  if (!cfg.notify_webhook) return;
  const url = cfg.notify_webhook;
  const body = url.includes('feishu') || url.includes('larksuite')
    ? { msg_type: 'text', content: { text } }
    : url.includes('qyapi.weixin')
      ? { msgtype: 'text', text: { content: text } }
      : { text }; // Telegram bot API / 通用
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch((e) => log.warn('通知推送失败', e.message));
}
