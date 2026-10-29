import { EventEmitter } from 'node:events';
import { ClientToolBroker } from './client-tools.js';
import { openSession } from './session.js';
import { waitForAvailableAccount, releaseInflight, markBusy } from '../scheduler.js';
import { classifyFailure, busyWaitMs } from '../retry.js';
import { keyChain } from '../gateway/auth.js';
import { config } from '../config.js';

const sessions = new Map();
const RESULT_TIMEOUT = 600000;
const ROUND_TIMEOUT = 300000;
function problem(message, code = 'invalid_tool_session') { return Object.assign(new Error(message), { code, status: 400 }); }

/** Holds one runtime turn across HTTP requests while client-side tools execute. */
export class ToolRound {
  constructor({ broker, session, keyId, accountId, model, onClose, resultTimeout = RESULT_TIMEOUT }) {
    this.broker = broker; this.session = session; this.keyId = keyId; this.accountId = accountId; this.model = model;
    this.onClose = onClose; this.resultTimeout = resultTimeout;
    this.signal = new EventEmitter(); this.calls = []; this.text = ''; this.reasoning = ''; this.usage = null;
    this.finished = false; this.failure = null; this.closed = false; this.busy = false; this.awaiting = new Set();
    this.broker.on('call', call => { this.calls.push(call); this.signal.emit('change'); });
    this.pump = this.readEvents();
  }
  async readEvents() {
    try {
      for await (const event of this.session.events) {
        if (event.type === 'text_delta') this.text += event.text || '';
        else if (event.type === 'reasoning_delta') this.reasoning += event.text || '';
        else if (event.type === 'finish') { this.usage = event.usage || null; this.finished = true; }
        else if (event.type === 'error') { this.failure = event.message || '运行时失败'; this.failureCode = event.code; this.finished = true; }
        this.signal.emit('change');
      }
      if (!this.finished && !this.closed) { this.failure = '运行时会话意外结束'; this.finished = true; this.signal.emit('change'); }
    } catch (e) { this.failure = e.message; this.finished = true; this.signal.emit('change'); }
  }
  async start(prompt) { await this.session.send(prompt); return this.next(); }
  async next() {
    const deadline = Date.now() + ROUND_TIMEOUT;
    while (!this.calls.length && !this.finished) {
      const left = deadline - Date.now(); if (left <= 0) { await this.close(); throw problem('等待模型响应超时', 'tool_timeout'); }
      await new Promise(resolve => { const timer = setTimeout(() => { this.signal.off('change', done); resolve(); }, Math.min(left, 1000)); const done = () => { clearTimeout(timer); resolve(); }; this.signal.once('change', done); });
    }
    if (this.failure) { const message = this.failure; const code = this.failureCode || 'tool_runtime_error'; await this.close(); throw problem(message, code); }
    // Give concurrently dispatched MCP calls a chance to arrive in the same response.
    if (this.calls.length && !this.finished) await new Promise(resolve => setTimeout(resolve, 100));
    const calls = this.calls.splice(0); const result = { calls, text: this.text, reasoning: this.reasoning, usage: this.usage, finished: this.finished, accountId: this.accountId };
    this.text = ''; this.reasoning = '';
    if (calls.length) {
      this.awaiting = new Set(calls.map(c => c.id));
      for (const call of calls) sessions.set(call.id, this);
      this.expiry = setTimeout(() => this.close().catch(() => {}), this.resultTimeout); this.expiry.unref();
    } else if (this.finished) await this.close();
    return result;
  }
  async resume(keyId, results) {
    if (this.closed || keyId !== this.keyId) throw problem('工具会话不存在或已过期');
    if (this.busy) throw problem('工具会话正在处理另一请求');
    const ids = results.map(r => r.id);
    if (ids.length !== this.awaiting.size || new Set(ids).size !== ids.length || ids.some(id => !this.awaiting.has(id))) throw problem('工具结果必须与本轮调用一一对应');
    this.busy = true; clearTimeout(this.expiry);
    try {
      for (const result of results) {
        sessions.delete(result.id);
        if (!this.broker.resolve(result.id, result.output, result.isError)) { await this.close(); throw problem('工具调用已超时'); }
      }
      this.awaiting.clear(); return await this.next();
    } finally { this.busy = false; }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.expiry);
    if (!this.finished) { this.failure = '工具会话已关闭'; this.finished = true; this.signal.emit('change'); }
    for (const [id, owner] of sessions) if (owner === this) sessions.delete(id);
    await this.broker.close().catch(() => {});
    await this.session.close().catch(() => {});
    this.onClose?.();
  }
}

export async function startToolRound({ key, model, reasoningLevel, tools, prompt, maxOutputTokens, signal, dependencies = {} }) {
  const waitFor = dependencies.waitFor || waitForAvailableAccount;
  const getChain = dependencies.getChain || keyChain;
  const makeBroker = dependencies.makeBroker || ((items, opts) => new ClientToolBroker(items, opts));
  const open = dependencies.open || openSession;
  const setBusy = dependencies.setBusy || markBusy;
  const busyWindow = dependencies.busyWindowMs ?? busyWaitMs();
  let busyDeadline = null;
  const busyWaitSec = () => Math.round(busyWindow / 1000);
  while (true) {
    const remaining = busyDeadline ? Math.max(0, busyDeadline - Date.now()) : busyWindow;
    if (busyDeadline && !remaining) throw Object.assign(new Error(`账号持续忙碌，排队 ${busyWaitSec()} 秒后仍不可用`), { code: 'account_busy', kind: 'busy', status: 529 });
    const sel = await waitFor(getChain(key), model, { keyId: key.id, stickyMinutes: key.sticky_minutes || 0 }, { timeoutMs: remaining, signal });
    if (!sel.account) throw Object.assign(new Error(sel.busyTimeout ? `账号忙碌，排队 ${busyWaitSec()} 秒后仍不可用` : '所有账号不可用'), { code: sel.busyTimeout ? 'account_busy' : 'no_account', kind: sel.busyTimeout ? 'busy' : 'exhausted', status: sel.busyTimeout ? 529 : 503 });
    if (sel.busySince != null) busyDeadline ||= sel.busySince + busyWindow;
    const accountId = sel.account.id;
    const configured = Number(dependencies.resultTimeoutSec ?? config().tool_result_timeout_sec);
    const resultTimeout = Number.isFinite(configured) && configured > 0 ? Math.max(60, Math.min(3600, configured)) * 1000 : RESULT_TIMEOUT;
    const broker = makeBroker(tools, { timeoutMs: resultTimeout + 10000 });
    let session;
    try {
      const spec = await broker.start();
      session = await open(accountId, { model, reasoningLevel, maxOutputTokens, mode: 'yolo', mcpServers: [spec], toolAllowlist: tools.map(t => `mcp__clienttools__${t.name}`) });
      session.slot.toolLeases = (session.slot.toolLeases || 0) + 1;
      const round = new ToolRound({ broker, session, keyId: key.id, accountId, model, resultTimeout, onClose: () => { session.slot.toolLeases--; releaseInflight(accountId); } });
      const abort = () => { round.close().catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { await round.close(); throw problem('客户端已断开', 'canceled'); }
      try { return await round.start(prompt); } catch (e) { await round.close(); throw e; } finally { signal?.removeEventListener('abort', abort); }
    } catch (e) {
      if (!session) { await broker.close().catch(() => {}); releaseInflight(accountId); }
      if (signal?.aborted || classifyFailure(e).kind !== 'busy') throw e;
      busyDeadline ||= Date.now() + busyWindow;
      setBusy(accountId, { zeroInflight: true });
      if (Date.now() >= busyDeadline) throw Object.assign(new Error(`账号持续忙碌，排队 ${busyWaitSec()} 秒后仍不可用`), { code: 'account_busy', kind: 'busy', status: 529 });
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, busyDeadline - Date.now()))));
    }
  }
}

export async function resumeToolRound({ key, model, results, signal }) {
  if (!results.length) throw problem('缺少工具结果');
  const round = sessions.get(results[0].id);
  if (!round || round.keyId !== key.id || round.model !== model || results.some(r => sessions.get(r.id) !== round)) throw problem('工具会话不存在、已过期或与密钥不匹配');
  const abort = () => { round.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) { await round.close(); throw problem('客户端已断开', 'canceled'); }
  try { return await round.resume(key.id, results); } finally { signal?.removeEventListener('abort', abort); }
}

/** Release a suspended turn when the client has disconnected before receiving its calls. */
export async function abandonToolRound(keyId, calls) {
  const round = calls?.length ? sessions.get(calls[0].id) : null;
  if (round && round.keyId === keyId) await round.close();
}

/** 供网关在路由前探测回执是否命中活会话（只读，不改状态） */
export function peekRound(callId) {
  return sessions.get(callId) || null;
}
