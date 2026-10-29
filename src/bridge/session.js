import { acquireSlot } from './pool.js';
import { config } from '../config.js';
import { logger } from '../log.js';

const log = logger('bridge-session');

/**
 * SessionDriver：流式推理（session/create → session/send → session/event）。
 * 归一化事件：{ type, text?, toolCall?, usage?, finishReason?, error?, sessionId? }
 * 返回 { events: AsyncIterable, close(), sessionId }
 * event.type ∈ start|text_delta|text_start|text_end|reasoning_delta|reasoning_start|reasoning_end|
 *              tool_input_start|tool_input_delta|tool_input_end|tool_call|finish|error
 */
export async function openSession(accountId, { model = 'GLM-5.3-Flash', reasoningLevel = 'high', mode, mcpServers, toolAllowlist } = {}) {
  const slot = await acquireSlot(accountId);
  const providerId = `account:${slot.family}-start-plan`;
  const level = ['low', 'high', 'max'].includes(reasoningLevel) ? reasoningLevel : 'high';
  // 未声明工具时禁用运行时内置工具，避免未经客户端授权的调用。
  const allow = Array.isArray(toolAllowlist) ? toolAllowlist : (mcpServers ? undefined : []);
  const params = {
    workspace: { workspacePath: slot.workspaceDir, workspaceKey: `${accountId}-bridge` },
    model: {
      providerId,
      modelId: model,
      options: { reasoningLevel: level },
    },
    thoughtLevel: level,
    ...(mcpServers ? { mcpServers } : {}),
    ...(allow !== undefined ? { toolAllowlist: allow } : {}),
    // 官方仅记载 yolo；session_mode 允许收紧（其余值未验证，出问题回退 yolo）
    mode: ['yolo', 'ask', 'chat'].includes(mode) ? mode : (config().session_mode || 'yolo'),
  };
  // 运行时拒绝 maxOutputTokens，网关接受该参数但无法强制输出上限。
  const created = await slot.request('session/create', params, { timeoutMs: 60000 });
  const sessionId = created?.sessionId || created?.session?.sessionId || created?.id;
  if (!sessionId) throw new Error(`session/create 未返回 sessionId: ${JSON.stringify(created).slice(0, 200)}`);
  // 订阅会话事件流（desktop-continuous 为官方宿主使用的投递模式；不订阅收不到 session/event）
  try {
    await slot.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, { timeoutMs: 15000 });
  } catch (e) {
    log.warn(`session/subscribe 失败（事件流可能缺失）slot=${accountId}`, e.message);
  }

  const queue = [];
  let wakeup = null;
  let finished = false;
  let error = null;
  let lastSummary = null;
  const push = (ev) => {
    if (finished) return;
    queue.push(ev);
    if (wakeup) { const w = wakeup; wakeup = null; w(); }
  };
  const off = slot.onNotification((msg) => {
    if (msg.method !== 'session/event') return;
    const p = msg.params || {};
    if (p.sessionId && p.sessionId !== sessionId) return;
    const type = p.type || '';
    const payload = p.payload || {};
    // 真实事件分类学：params.type 为判别字段；model.streaming 的增量再按 payload.kind 细分
    if (type === 'model.streaming') {
      switch (payload.kind) {
        case 'text_delta': push({ type: 'text_delta', text: payload.delta || '' }); break;
        case 'text_start': push({ type: 'text_start' }); break;
        case 'text_end': push({ type: 'text_end' }); break;
        case 'reasoning_delta': push({ type: 'reasoning_delta', text: payload.delta || '' }); break;
        case 'reasoning_start': push({ type: 'reasoning_start' }); break;
        case 'reasoning_end': push({ type: 'reasoning_end' }); break;
        case 'tool_input_start': push({ type: 'tool_input_start', toolName: payload.toolName, toolCallId: payload.toolCallId }); break;
        case 'tool_input_delta': push({ type: 'tool_input_delta', delta: payload.delta || '' }); break;
        case 'tool_input_end': push({ type: 'tool_input_end' }); break;
        case 'tool_call': push({ type: 'tool_call', toolName: payload.toolName, toolCallId: payload.toolCallId, input: payload.input }); break;
        case 'error':
          error = payload;
          push({ type: 'error', code: payload.code ?? null, message: payload.message || '运行时错误' });
          finished = true;
          break;
        default: break; // start/finish 等模型请求级事件不外发（回合级终态由 turn.completed/failed 表达）
      }
      return;
    }
    switch (type) {
      case 'session.updated':
        if (payload.stopReason && payload.usage) { lastSummary = payload; }
        break;
      case 'turn.completed':
        push({ type: 'finish', usage: payload.usage || lastSummary?.usage || null, finishReason: payload.stopReason || lastSummary?.stopReason || null, content: payload.content || lastSummary?.content });
        finished = true;
        break;
      case 'turn.failed': {
        const e = payload.error || payload;
        error = e;
        push({ type: 'error', code: e.code ?? null, message: e.message || '回合失败' });
        finished = true;
        break;
      }
      default: break; // session.updated / titleUpdated / permission.* 等不外发
    }
  });

  const next = () => new Promise((resolve) => {
    if (queue.length) return resolve(queue.shift());
    wakeup = () => resolve(queue.shift());
  });

  async function* eventsGen() {
    try {
      while (true) {
        while (queue.length) yield queue.shift();
        if (finished) break;
        const ev = await next();
        if (ev) yield ev;
      }
    } finally {
      off();
    }
  }
  const events = eventsGen();

  function abort(reason) {
    push({ type: 'error', code: 'timeout', message: reason || '已中止' });
    finished = true;
  }

  async function send(content, { timeoutMs = 600000 } = {}) {
    await slot.request('session/send', { sessionId, content: String(content) }, { timeoutMs });
  }

  async function close() {
    off();
    try { await slot.request('session/close', { sessionId }, { timeoutMs: 10000 }); } catch { /* 会话可能已结束 */ }
  }

  return { sessionId, events, send, close, abort, slot };
}

/**
 * 帮手：跑一个完整单轮会话收集全部文本（非流式路径）。
 * turnTimeoutMs：整回合兜底超时（防止运行时事件流停滞导致挂死）。
 */
export async function runOnce(accountId, { prompt, model, reasoningLevel, maxOutputTokens, onEvent, turnTimeoutMs = 300000, signal = null } = {}) {
  const session = await openSession(accountId, { model, reasoningLevel, maxOutputTokens });
  let text = '', reasoning = '', usage = null, finishReason = null, err = null;
  const onAbort = () => { err = { message: '客户端断开', code: 'canceled' }; try { session.close(); } catch { /* 忽略 */ } };
  signal?.addEventListener('abort', onAbort, { once: true });
  const pump = (async () => {
    const deadline = Date.now() + turnTimeoutMs;
    for await (const ev of session.events) {
      if (signal?.aborted) break;
      if (Date.now() > deadline) { err = { message: `推理回合超时（${turnTimeoutMs}ms 无完成事件）`, code: 'timeout' }; break; }
      if (ev.type === 'text_delta') text += ev.text;
      else if (ev.type === 'reasoning_delta') reasoning += ev.text;
      else if (ev.type === 'finish') { usage = ev.usage; finishReason = ev.finishReason; }
      else if (ev.type === 'error') err = ev;
      if (onEvent) try { onEvent(ev); } catch { /* 回调异常不阻断 */ }
    }
  })();
  try {
    await session.send(prompt);
    await pump;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await session.close().catch(() => {});
  }
  if (err) throw Object.assign(new Error(err.message || '推理失败'), { code: err.code });
  return { text, reasoning, usage, finishReason, sessionId: session.sessionId };
}

