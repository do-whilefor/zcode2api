import { shouldUseToolRoute, handleToolRoute } from './tools-api.js';
import { logger } from '../log.js';
import { openaiError } from './errors.js';
import { authenticateGateway, keyModelAllowed } from './auth.js';
import { infer, resolveAlias, effectiveReasoningLevel } from './inference.js';
import { flattenMessages, mapEffort } from './openai.js';
import { busyWaitMs } from '../retry.js';
import { randomUuid } from '../crypto.js';

const log = logger('gateway-anthropic');

export function countTokensApprox(messages, system) {
  let chars = 0;
  if (typeof system === 'string') chars += system.length;
  else if (Array.isArray(system)) chars += system.map((s) => s.text || '').join('').length;
  for (const m of messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text') chars += (c.text || '').length;
        else if (c.type === 'tool_result') chars += JSON.stringify(c.content || '').length;
        else if (c.type === 'tool_use') chars += JSON.stringify(c.input || {}).length;
      }
    }
  }
  // 中文≈1 字/token、英文≈4 字符/token 的粗估折中
  return Math.max(1, Math.ceil(chars / 2.5));
}

export function registerAnthropicRoutes(app) {
  app.post('/v1/messages/count_tokens', async (req, reply) => {
    const auth = authenticateGateway(req);
    if (!auth.ok) return openaiError(reply, auth.status, 'authentication_error', 'invalid_api_key', auth.error);
    const body = req.body || {};
    return { input_tokens: countTokensApprox(body.messages, body.system) };
  });

  app.post('/v1/messages', async (req, reply) => {
    const auth = authenticateGateway(req);
    if (!auth.ok) return anthropicErr(reply, auth.status, 'authentication_error', auth.error);
    const body = req.body || {};
    const model = resolveAlias(body.model);
    if (!keyModelAllowed(auth.key, model)) {
      return anthropicErr(reply, 403, 'invalid_request_error', `模型 ${model} 不在该密钥白名单`);
    }
    const reasoningLevel = effectiveReasoningLevel(mapEffort(body), auth.key);
    const maxTokens = Number(body.max_tokens) > 0 ? Math.min(128000, Number(body.max_tokens)) : null;
    if (shouldUseToolRoute(auth.key, body, 'anthropic', model)) return handleToolRoute({ req, reply, body, protocol: 'anthropic', key: auth.key, model, reasoningLevel, maxOutputTokens: maxTokens });

    // Anthropic → 桥消息：system（string|数组）拆出，tool_use/tool_result 拍平
    const messages = [];
    const sys = body.system;
    if (sys) {
      const sysText = typeof sys === 'string' ? sys : (Array.isArray(sys) ? sys.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');
      if (sysText) messages.push({ role: 'system', content: sysText });
    }
    for (const m of body.messages || []) {
      if (typeof m.content === 'string') {
        messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
        continue;
      }
      const parts = [];
      for (const c of m.content || []) {
        if (c.type === 'text') parts.push(c.text);
        else if (c.type === 'tool_use') parts.push(`[调用工具 ${c.name}] ${JSON.stringify(c.input || {})}`);
        else if (c.type === 'tool_result') {
          const inner = typeof c.content === 'string' ? c.content : (Array.isArray(c.content) ? c.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : JSON.stringify(c.content));
          parts.push(`[工具结果] ${inner}`);
        } else if (c.type === 'image') parts.push('[图片]');
        else if (c.type === 'thinking') parts.push('');
      }
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: parts.join('\n') });
    }
    if (!messages.length) return anthropicErr(reply, 400, 'invalid_request_error', 'messages 不能为空');

    const stream = !!body.stream;
    const requestId = 'req_' + randomUuid().slice(0, 12);

    if (!stream) {
      try {
        const r = await infer({ key: auth.key, model, reasoningLevel, messages, maxOutputTokens: maxTokens, stream: false, requestId, clientIp: req.ip });
        const inputTokens = r.usage?.inputTokens ?? countTokensApprox(body.messages, sys);
        const outputTokens = r.usage?.outputTokens ?? 0;
        return {
          id: 'msg_' + requestId, type: 'message', role: 'assistant', model,
          content: blockContent(r),
          stop_reason: mapStopReason(r.finishReason), stop_sequence: null,
          usage: {
            input_tokens: inputTokens, output_tokens: outputTokens,
            cache_read_input_tokens: r.usage?.cacheReadTokens ?? 0, cache_creation_input_tokens: 0,
          },
        };
      } catch (e) {
        log.warn('推理失败', requestId, e.kind, e.code, e.message);
        const s = errShapeA(e);
        const headers = (s.status === 529 || s.status === 503) ? { 'retry-after': String(Math.max(1, Math.ceil(busyWaitMs() / 1000))) } : {};
        return anthropicErr(reply, s.status, s.type, s.message, headers);
      }
    }

    // 流式（Anthropic 事件流）
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    const msgId = 'msg_' + requestId;
    let blockIndex = -1;      // -1 尚未开块
    let currentType = null;   // text | thinking
    let firstToken = false;
    let usage = null;
    let finish = 'end_turn';
    const write = (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // message_start 连接建立即发（官方顺序语义），input_tokens 先用粗估兜底；
    // 换号重试/排队可能静默数十秒，周期 ping 防止中间层掐连接
    write('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: countTokensApprox(body.messages, sys), output_tokens: 0 } } });
    write('ping', { type: 'ping' });
    const pingTimer = setInterval(() => {
      if (!reply.raw.writableEnded) write('ping', { type: 'ping' });
    }, 15000);
    reply.raw.on('close', () => clearInterval(pingTimer));
    const openBlock = (type) => {
      if (currentType === type) return;
      if (currentType) write('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      blockIndex++;
      currentType = type;
      write('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } });
    };
    const closeBlock = () => {
      if (currentType) { write('content_block_stop', { type: 'content_block_stop', index: blockIndex }); currentType = null; }
    };
    const onEvent = (ev) => {
      switch (ev.type) {
        case 'text_delta':
          openBlock('text');
          if (ev.text) { firstToken = true; write('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: ev.text } }); }
          break;
        case 'reasoning_delta':
          openBlock('thinking');
          if (ev.text) write('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: ev.text } });
          break;
        case 'tool_call': {
          firstToken = true;
          closeBlock();
          blockIndex++;
          write('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: ev.toolCallId || 'toolu_' + randomUuid().slice(0, 10), name: ev.toolName, input: {} } });
          write('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(ev.input ?? {}) } });
          write('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          break;
        }
        case 'finish':
          usage = ev.usage;
          finish = mapStopReason(ev.finishReason);
          break;
        case 'error':
          write('error', { type: 'error', error: { type: 'api_error', message: ev.message } });
          break;
        default: break;
      }
    };
    // 客户端断连 → 取消运行时会话
    const abortCtrl = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableEnded) abortCtrl.abort(new Error('客户端断开')); });
    let result = null, err = null;
    try {
      result = await infer({ key: auth.key, model, reasoningLevel, messages, maxOutputTokens: maxTokens, stream: true, onEvent, requestId, clientIp: req.ip, signal: abortCtrl.signal });
    } catch (e) { err = e; }
    if (err) {
      // 首 token 前失败：infer 编排层抛出（onEvent 未收到 error 事件）→ 显式 error 事件收尾；
      // 首 token 后失败：error 事件已由 onEvent 转发，直接结束
      if (!firstToken && !reply.raw.writableEnded) {
        const s = errShapeA(err);
        write('error', { type: 'error', error: { type: s.type, message: s.message } });
      }
      clearInterval(pingTimer);
      reply.raw.end();
      return reply;
    }
    closeBlock();
    const inputTokens = result?.usage?.inputTokens ?? countTokensApprox(body.messages, sys);
    const outputTokens = result?.usage?.outputTokens ?? 0;
    write('message_delta', { type: 'message_delta', delta: { stop_reason: finish, stop_sequence: null }, usage: { output_tokens: outputTokens } });
    write('message_stop', { type: 'message_stop' });
    clearInterval(pingTimer);
    reply.raw.end();
  });
}

function blockContent(r) {
  const blocks = [];
  if (r.reasoning) blocks.push({ type: 'thinking', thinking: r.reasoning, signature: '' });
  if (r.text) blocks.push({ type: 'text', text: r.text });
  if (!blocks.length) blocks.push({ type: 'text', text: '' });
  return blocks;
}

function mapStopReason(fr) {
  const v = String(fr || '').toLowerCase();
  if (v.includes('length') || v === 'max_tokens') return 'max_tokens';
  if (v.includes('tool')) return 'tool_use';
  return 'end_turn';
}

function anthropicErr(reply, status, type, message, extraHeaders = {}) {
  reply.code(status).header('content-type', 'application/json');
  for (const [k, v] of Object.entries(extraHeaders)) reply.header(k, v);
  return reply.send({ type: 'error', error: { type, message } });
}

function errShapeA(e) {
  const kind = e.kind || 'unknown';
  if (kind === 'exhausted') return { status: 503, type: 'overloaded_error', message: e.message };
  if (kind === 'busy') return { status: 529, type: 'overloaded_error', message: '当前系统繁忙（免费网关并发上限），已尝试全部账号' };
  if (kind === 'quota') return { status: 403, type: 'invalid_request_error', message: '全部账号免费额度已耗尽' };
  if (kind === 'auth') return { status: 401, type: 'authentication_error', message: '账号凭证失效且无可用替补' };
  if (kind === 'context') return { status: 400, type: 'invalid_request_error', message: e.message };
  if (kind === 'invalid') return { status: 400, type: 'invalid_request_error', message: e.message };
  if (kind === 'timeout') return { status: 504, type: 'api_error', message: '推理超时' };
  if (kind === 'canceled') return { status: 499, type: 'api_error', message: '客户端已断开' };
  return { status: 502, type: 'api_error', message: e.message };
}
