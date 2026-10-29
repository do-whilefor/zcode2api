import { db } from '../db.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { openSession, runOnce } from '../bridge/session.js';
import { waitForAvailableAccount, releaseInflight, markBusy, markBusyResolved, markAuthDead, markAuthAlive, logSchedule, accountRuntime, recordSticky } from '../scheduler.js';
import { keyChain, addKeyUsage } from './auth.js';
import { classifyFailure, backoffDelayMs, retryParams, busyWaitMs, isVisibleToken } from '../retry.js';
import { updateAccount, getAccount, getTokens, cookieJarPath, accountDispatcher } from '../accounts.js';
import { CookieJar } from '../httpclient.js';
import { sha256Hex } from '../crypto.js';
import { fetchBalance } from '../zcodeApi.js';

const log = logger('inference');

export function resolveAlias(model) {
  const aliases = config().aliases || {};
  const m = String(model || '').trim();
  if (!m) return 'GLM-5.3-Flash';
  if (aliases[m]) return aliases[m];
  // 大小写归一：glm-5.3-flash → GLM-5.3-Flash
  for (const [alias, target] of Object.entries(aliases)) {
    if (alias.toLowerCase() === m.toLowerCase()) return target;
  }
  return m;
}

/** 思考档位解析：请求显式指定 > 密钥默认 > 全局默认（low 响应最快） */
export function effectiveReasoningLevel(requested, keyRow = null) {
  const valid = (v) => (['low', 'high', 'max'].includes(v) ? v : null);
  if (requested) return valid(requested) || requested;
  if (keyRow?.default_level) return valid(keyRow.default_level);
  return valid(String(config().default_reasoning_level || '')) || null;
}

/**
 * 推理编排：调度 → 桥执行 → 失败分类 → 重试/换号。
 * opts: {
 *   key: 密钥行, model, reasoningLevel, prompt | messages, maxOutputTokens,
 *   stream: bool, onEvent(ev), signal: AbortSignal, requestId, clientIp
 * }
 * 返回 { ok, text, reasoning, usage, finishReason, attempts, rotated, sessionId, queued }
 * 失败抛出 { kind, code, message, attempts, candidates }（Error 附加字段）
 */
export async function infer(opts) {
  const p = retryParams();
  const model = resolveAlias(opts.model);
  const chain = keyChain(opts.key);
  const requestId = opts.requestId || 'req_' + sha256Hex(String(Math.random())).slice(0, 12);
  const promptHash = sha256Hex(opts.prompt || JSON.stringify(opts.messages || '')).slice(0, 12);
  const started = Date.now();
  const rotated = [];
  let attempts = 0;
  let consecutiveSameAccountFails = 0;
  let lastAccount = null;
  let ttftMs = null;
  let queuedOnce = false;
  const budgetDeadline = started + p.total_budget_ms;

  const fail = (kind, code, message, extra = {}) => {
    const e = new Error(message);
    e.kind = kind; e.code = code; e.attempts = attempts; e.rotated = rotated;
    e.candidates = extra.candidates; e.chain = chain;
    throw e;
  };

  let lastError = null;
  let busyDeadline = null;
  const busyWaitSec = () => Math.round(busyWaitMs() / 1000);
  while ((attempts < p.max_attempts || (busyDeadline && Date.now() < busyDeadline)) && Date.now() < budgetDeadline) {
    if (busyDeadline && Date.now() >= busyDeadline) fail('busy', 'account_busy', `账号持续忙碌，排队 ${busyWaitSec()} 秒后仍不可用`);
    attempts++;
    const sel = await waitForAvailableAccount(chain, model, { keyId: opts.key.id, stickyMinutes: opts.key.sticky_minutes || 0 }, { timeoutMs: Math.max(0, Math.min(busyWaitMs(), budgetDeadline - Date.now(), busyDeadline ? busyDeadline - Date.now() : busyWaitMs())), signal: opts.signal });
    if (sel.candidates) logSchedule(requestId, sel.chain, sel.candidates, sel.policy, sel.account?.id || null);
    if (!sel.account) {
      fail(sel.busyTimeout ? 'busy' : 'exhausted', sel.busyTimeout ? 'account_busy' : 'no_account', sel.busyTimeout ? '账号忙碌，等待超时' : '所有账号不可用（到期/冷却/额度/模型不符）', { candidates: sel.candidates });
    }
    if (sel.busySince != null) busyDeadline ||= sel.busySince + BUSY_RETRY_WINDOW_MS;
    const acc = sel.account;
    if (sel.queued) queuedOnce = true;
    if (lastAccount && lastAccount !== acc.id) {
      rotated.push(acc.id);
      consecutiveSameAccountFails = 0;
    }
    lastAccount = acc.id;

    try {
      let result;
      if (opts.stream) {
        result = await runStreamed(acc, model, opts, { requestId, onFirstToken: () => { if (ttftMs === null) ttftMs = Date.now() - started; } });
      } else {
        result = await runUnstreamed(acc, model, opts, { requestId });
        if (ttftMs === null) ttftMs = result.totalMs;
      }
      // 成功
      markBusyResolved(acc.id);
      releaseInflight(acc.id);
      markAuthAlive(acc.id);
      if (opts.key.sticky_minutes > 0) recordSticky(opts.key.id, acc.id);
      const usage = result.usage || {};
      const totalUnits = (usage.inputTokens || usage.prompt_tokens || 0) + (usage.outputTokens || usage.completion_tokens || 0) + (usage.reasoningTokens || 0);
      addKeyUsage(opts.key.id, totalUnits);
      logUsage({
        request_id: requestId, key_id: opts.key.id, client_ip: opts.clientIp, account_id: acc.id, family: acc.family,
        model, reasoning_level: opts.reasoningLevel || null, stream: opts.stream ? 1 : 0, attempt_count: attempts,
        rotated_accounts: rotated, status: 'success', error_code: null, error_message: null,
        ttft_ms: ttftMs, total_ms: Date.now() - started, usage, prompt_hash: promptHash,
      });
      return {
        ok: true, text: result.text, reasoning: result.reasoning, usage, finishReason: result.finishReason,
        attempts, rotated, accountId: acc.id, sessionId: result.sessionId || null, queued: queuedOnce,
        totalMs: Date.now() - started, ttftMs,
      };
    } catch (e) {
      const cls = e.__classified || classifyFailure(e);
      lastError = e;
      // 流式首 token 后失败：已在流内收尾，不能再重放
      if (e.postFirstToken) {
        releaseInflight(acc.id);
        logUsage({
          request_id: requestId, key_id: opts.key.id, client_ip: opts.clientIp, account_id: acc.id, family: acc.family,
          model, reasoning_level: opts.reasoningLevel || null, stream: 1, attempt_count: attempts,
          rotated_accounts: rotated, status: 'failed', error_code: String(e.code ?? ''), error_message: e.message,
          ttft_ms: ttftMs, total_ms: Date.now() - started, usage: null, prompt_hash: promptHash,
        });
        fail(cls.kind, e.code, e.message, {});
      }
      if (cls.kind === 'busy') {
        busyDeadline ||= Date.now() + busyWaitMs();
        const r = accountRuntime(acc.id);
        const zeroInflight = r.inflight <= 1; // 本请求占用的那一份即将释放
        const ms = markBusy(acc.id, { zeroInflight });
        releaseInflight(acc.id);
        // 无替补（链上只有一组）时缩短冷却，避免单账号硬拖满重试预算
        const solo = chain.length <= 1;
        const waitMs = solo ? Math.min(ms, 250) : ms;
        log.warn(`busy(${e.code}) 换号重试 account=${acc.id} 冷却 ${ms}ms${solo ? '（单账号链，缩短为 ' + waitMs + 'ms）' : ''} attempts=${attempts}`);
        logUsage({
          request_id: requestId, key_id: opts.key.id, client_ip: opts.clientIp, account_id: acc.id, family: acc.family,
          model, reasoning_level: opts.reasoningLevel || null, stream: opts.stream ? 1 : 0, attempt_count: attempts,
          rotated_accounts: rotated, status: 'busy', error_code: String(e.code ?? '3008'), error_message: e.message,
          ttft_ms: null, total_ms: Date.now() - started, usage: null, prompt_hash: promptHash,
        });
        if (waitMs > 0) await new Promise((res) => setTimeout(res, Math.min(waitMs, Math.max(0, busyDeadline - Date.now()))));
        if (zeroInflight && r.busyStreak >= retryParams().busy_leak_threshold) {
          // 零真实并发却连续 busy：疑似外部占用/泄漏会话 → 重启桥槽位
          log.warn(`零 inflight 连续 busy ×${r.busyStreak} → 重启桥槽位 ${acc.id}`);
          import('../bridge/pool.js').then((pool) => pool.releaseSlot(acc.id).catch(() => {}));
        }
        continue; // 立即换号
      }
      busyDeadline = null;
      if (cls.kind === 'auth') {
        updateAccount(acc.id, { status: 'needs_relogin', fail_streak: (getAccount(acc.id)?.fail_streak || 0) + 1, last_error: '推理 401' });
        markAuthDead(acc.id);
        releaseInflight(acc.id);
        log.warn(`auth 失效换号 account=${acc.id} attempts=${attempts}`);
        // 与轮询 401 同路：自动生成再授权链接并推送（admin/api 内部有节流与 pending 去重）
        import('../admin/api.js').then((m) => m.ensureReauthFlow(acc.id, '凭证失效（推理 401）')).catch(() => {});
        continue;
      }
      if (cls.kind === 'quota') {
        // 额度耗尽：立刻刷新该账号 balance，让调度器摘除
        refreshQuotaAsync(acc.id);
        releaseInflight(acc.id);
        log.warn(`额度耗尽换号 account=${acc.id} code=${e.code}`);
        continue;
      }
      if (!cls.retryable) {
        releaseInflight(acc.id);
        logUsage({
          request_id: requestId, key_id: opts.key.id, client_ip: opts.clientIp, account_id: acc.id, family: acc.family,
          model, reasoning_level: opts.reasoningLevel || null, stream: opts.stream ? 1 : 0, attempt_count: attempts,
          rotated_accounts: rotated, status: 'failed', error_code: String(e.code ?? cls.kind), error_message: e.message,
          ttft_ms: ttftMs, total_ms: Date.now() - started, usage: null, prompt_hash: promptHash,
        });
        fail(cls.kind, e.code, e.message, { candidates: sel.candidates });
      }
      // 可重试（server/rate_limit/overload/network）：同账号退避，连续 3 次换号
      consecutiveSameAccountFails++;
      releaseInflight(acc.id);
      if (consecutiveSameAccountFails >= 3) {
        consecutiveSameAccountFails = 0;
        markBusy(acc.id, { zeroInflight: false });
        log.warn(`同账号连续 3 次失败，换号 account=${acc.id}`);
        continue;
      }
      const delay = cls.retryAfterMs || backoffDelayMs(attempts, p);
      log.warn(`可重试失败(${cls.kind}) account=${acc.id} 退避 ${delay}ms attempts=${attempts}`, e.message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (busyDeadline) fail('busy', 'account_busy', '账号持续忙碌，重试 10 秒后仍不可用');
  fail(lastError?.kind || 'unknown', lastError?.code, `重试预算耗尽（${attempts} 次）：${lastError?.message || ''}`);
}

// 流式首 token 后失败不可整体重放，直接收尾
async function runUnstreamed(acc, model, opts, { requestId }) {
  const started = Date.now();
  if (opts.signal?.aborted) { const e = new Error('客户端断开'); e.__classified = { kind: 'canceled', retryable: false }; throw e; }
  try {
    // 走官方主链路会话流（session/create+send），与桌面 main_turn 行为画像一致
    const r = await runOnce(acc.id, {
      model,
      reasoningLevel: opts.reasoningLevel || effectiveReasoningLevel(null) || 'low',
      prompt: opts.prompt ?? JSON.stringify(opts.messages ?? []),
      maxOutputTokens: opts.maxOutputTokens,
      onEvent: null,
      signal: opts.signal,
    });
    return {
      text: r.text, reasoning: r.reasoning,
      usage: normalizeUsage(r.usage), finishReason: r.finishReason,
      sessionId: r.sessionId, totalMs: Date.now() - started,
    };
  } catch (e) {
    if (opts.signal?.aborted) { e.kind = 'canceled'; e.__classified = { kind: 'canceled', retryable: false }; }
    else if (/超时/.test(e.message)) { e.__classified = { kind: 'timeout', retryable: true }; }
    else if (/未在运行|已退出/.test(e.message)) { e.__classified = { kind: 'server', retryable: true }; }
    throw e;
  }
}

/**
 * 流式执行：把桥事件转发给 opts.onEvent；首 token 前失败可整体重试（不转发给下游即可）。
 * 首 token 后失败 → 发送 error 事件收尾并抛 postFirstToken 错误。
 */
async function runStreamed(acc, model, opts, { requestId, onFirstToken }) {
  const session = await openSession(acc.id, {
    model,
    reasoningLevel: opts.reasoningLevel || effectiveReasoningLevel(null) || 'low',
    maxOutputTokens: opts.maxOutputTokens,
  });
  let firstToken = false;
  let usage = null, finishReason = null, text = '', reasoning = '';
  let sendError = null;
  const forward = (ev) => {
    if (!firstToken && isVisibleToken(ev)) {
      firstToken = true;
      onFirstToken();
    }
    if (ev.type === 'text_delta') text += ev.text || '';
    if (ev.type === 'reasoning_delta') reasoning += ev.text || '';
    try { opts.onEvent && opts.onEvent(ev); } catch { /* 下游断开等 */ }
  };
  try {
    // 订阅要先于 send（事件在 send 返回前就可能开始）
    const deadline = Date.now() + Math.max(120000, retryParams().total_budget_ms);
    const onAbort = () => { session.close().catch(() => {}); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const ftTimer = setTimeout(() => {
      if (!firstToken) { sendError = { code: 'timeout', message: '首字超时（' + (retryParams().first_token_timeout_ms / 1000) + 's 无输出）' }; try { session.abort('首字超时'); } catch { /* 忽略 */ } }
    }, Math.max(15000, retryParams().first_token_timeout_ms || 60000));
    const pump = (async () => {
      for await (const ev of session.events) {
        if (opts.signal?.aborted) {
          sendError = { code: 'canceled', message: '客户端断开' };
          break;
        }
        if (Date.now() > deadline) {
          sendError = { code: 'timeout', message: `推理回合超时（无完成事件）` };
          forward({ type: 'error', code: 'timeout', message: sendError.message });
          break;
        }
        if (ev.type === 'finish') { usage = ev.usage; finishReason = ev.finishReason; forward(ev); }
        else if (ev.type === 'error') { sendError = ev; if (firstToken) forward(ev); }
        else forward(ev);
      }
    })();
    try {
      await session.send(opts.prompt || JSON.stringify(opts.messages || []));
      await pump;
    } finally {
      clearTimeout(ftTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  } catch (e) {
    if (firstToken) {
      // 首 token 后失败：流内错误收尾（error 事件已转发或现在补发）
      if (!sendError) {
        try { opts.onEvent && opts.onEvent({ type: 'error', code: e.code, message: e.message }); } catch { /* 忽略 */ }
      }
      e.postFirstToken = true;
    }
    await session.close().catch(() => {});
    throw e;
  }
  await session.close().catch(() => {});
  if (sendError) {
    const e = Object.assign(new Error(sendError.message || '推理失败'), { code: sendError.code });
    if (firstToken) e.postFirstToken = true;
    else e.__classified = classifyFailure({ code: sendError.code, message: sendError.message });
    throw e;
  }
  // 下游取消
  if (opts.signal?.aborted) {
    const e = new Error('客户端断开');
    e.__classified = { kind: 'canceled', retryable: false };
    throw e;
  }
  return { text, reasoning, usage: normalizeUsage(usage), finishReason, sessionId: session.sessionId };
}

function normalizeUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.inputTokens ?? u.prompt_tokens ?? null,
    outputTokens: u.outputTokens ?? u.completion_tokens ?? null,
    reasoningTokens: u.reasoningTokens ?? null,
    cacheReadTokens: u.cacheReadTokens ?? null,
    cacheWriteTokens: u.cacheWriteTokens ?? null,
    totalTokens: u.totalTokens ?? ((u.inputTokens ?? u.prompt_tokens ?? 0) + (u.outputTokens ?? u.completion_tokens ?? 0)),
  };
}

function logUsage(row) {
  db().prepare(`INSERT INTO usage_log(request_id,ts,key_id,client_ip,account_id,family,model,reasoning_level,stream,attempt_count,
    rotated_accounts,status,error_code,error_message,ttft_ms,total_ms,tokens_in,tokens_out,tokens_reasoning,cache_read,cache_write,prompt_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.request_id, Date.now(), row.key_id, row.client_ip, row.account_id, row.family, row.model, row.reasoning_level,
      row.stream, row.attempt_count, JSON.stringify(row.rotated_accounts || []), row.status, row.error_code, row.error_message,
      row.ttft_ms, row.total_ms, row.usage?.inputTokens ?? null, row.usage?.outputTokens ?? null,
      row.usage?.reasoningTokens ?? null, row.usage?.cacheReadTokens ?? null, row.usage?.cacheWriteTokens ?? null, row.prompt_hash);
}

/** 异步刷新额度（不阻塞请求路径） */
function refreshQuotaAsync(accountId) {
  const a = getAccount(accountId);
  if (!a) return;
  const tokens = getTokens(accountId);
  if (!tokens.zcode_jwt) return;
  const jar = new CookieJar(cookieJarPath(accountId));
  accountDispatcher(a).then((dispatcher) =>
    fetchBalance(tokens.zcode_jwt, a.device_mid, { jar, dispatcher })).then((bal) => {
    if (bal.ok) {
      const fields = { capabilities: bal.capabilities, last_balance: bal.raw, zcode_jwt_last_ok_at: Date.now(), last_ok_at: Date.now() };
      if (bal.card) { fields.card_expires_at = bal.card.endsAt; }
      updateAccount(accountId, fields);
    } else if (bal.authFailed) {
      updateAccount(accountId, { status: 'needs_relogin', last_error: 'balance 401（额度刷新）' });
    }
  }).catch(() => {});
}
