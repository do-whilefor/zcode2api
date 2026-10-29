import { shouldUseToolRoute, handleToolRoute } from './tools-api.js';
import { logger } from '../log.js';
import { openaiError } from './errors.js';
import { authenticateGateway, keyModelAllowed } from './auth.js';
import { infer, resolveAlias, effectiveReasoningLevel } from './inference.js';
import { mapEffort } from './openai.js';
import { randomUuid } from '../crypto.js';

const log = logger('gateway-responses');

/**
 * OpenAI Responses API 兼容层（/v1/responses）。
 * 工具请求由会话 MCP 桥处理；普通文本请求沿用文本路径。
 * retrieve：内存 LRU 保存最近 100 个响应对象；进程重启即失（无状态语义，404 说明）。
 */
const store = new Map(); // responseId -> response object（插入序即访问序，Map 可做 LRU）

function storePut(id, obj, keyId) {
  store.delete(id);
  store.set(id, { obj, keyId });
  if (store.size > 100) store.delete(store.keys().next().value);
}

/** Responses input → 桥 messages。支持 string 与 content 数组（input_text/output_text/拒答摘要等取文本）。 */
export function parseResponsesInput(input) {
  const out = [];
  const pushText = (role, text) => { if (text) out.push({ role, content: text }); };
  if (typeof input === 'string') {
    pushText('user', input);
    return out;
  }
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' || item.role === 'developer' ? 'system' : 'user';
    if (typeof item.content === 'string') { pushText(role, item.content); continue; }
    if (Array.isArray(item.content)) {
      const text = item.content
        .map((c) => {
          if (typeof c === 'string') return c;
          if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') return c.text || '';
          if (c.type === 'refusal') return `[拒答] ${c.refusal || ''}`;
          if (c.type === 'input_image') return '[图片]';
          return '';
        })
        .filter(Boolean)
        .join('\n');
      pushText(role, text);
    }
    // 工具请求在路由入口已交给会话工具桥。
    if (item.type === 'function_call') pushText('assistant', `[调用工具 ${item.name}] ${item.arguments || ''}`);
    if (item.type === 'function_call_output') pushText('user', `[工具结果] ${typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')}`);
  }
  return out;
}

function clampMaxOutput(body) {
  const raw = body.max_output_tokens;
  if (!raw || typeof raw !== 'number' || raw <= 0) return null;
  return Math.min(128000, Math.floor(raw));
}

function usageOf(u, approxInput) {
  return {
    input_tokens: u?.inputTokens ?? approxInput ?? 0,
    input_tokens_details: { cached_tokens: u?.cacheReadTokens ?? 0 },
    output_tokens: u?.outputTokens ?? 0,
    output_tokens_details: { reasoning_tokens: u?.reasoningTokens ?? 0 },
    total_tokens: (u?.inputTokens ?? approxInput ?? 0) + (u?.outputTokens ?? 0),
  };
}

export function buildResponseObject({ id, model, reasoningLevel, text, reasoning, usage, approxInput, finishReason, status = 'completed' }) {
  const output = [];
  if (reasoning) {
    output.push({ type: 'reasoning', id: 'rs_' + randomUuid().slice(0, 12), summary: [{ type: 'summary_text', text: reasoning }] });
  }
  output.push({
    type: 'message', id: 'msg_' + randomUuid().slice(0, 12), role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: text || '', annotations: [] }],
  });
  return {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), status,
    model, reasoning: { effort: reasoningLevel || 'low', summary: 'auto' },
    output, output_text: text || '',
    incomplete_details: status === 'incomplete' ? { reason: String(finishReason || 'max_output_tokens') } : null,
    usage: usageOf(usage, approxInput),
  };
}

export function registerResponsesRoutes(app) {
  app.post('/v1/responses', async (req, reply) => {
    const auth = authenticateGateway(req);
    if (!auth.ok) return openaiError(reply, auth.status, 'authentication_error', 'invalid_api_key', auth.error);
    const body = req.body || {};
    const model = resolveAlias(body.model);
    if (!keyModelAllowed(auth.key, model)) {
      return openaiError(reply, 403, 'permission_error', 'model_not_allowed', `模型 ${model} 不在该密钥白名单`);
    }
    const reasoningLevel = effectiveReasoningLevel(mapEffort(body), auth.key);
    const maxOutputTokens = clampMaxOutput(body);
    if (shouldUseToolRoute(auth.key, body, 'responses', model)) return handleToolRoute({ req, reply, body, protocol: 'responses', key: auth.key, model, reasoningLevel, maxOutputTokens, onResponse: obj => storePut(obj.id, obj, auth.key.id) });
    // instructions → system 前置；input 支持 string / message 数组
    const messages = [];
    if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) });
    messages.push(...parseResponsesInput(body.input));
    if (!messages.length) return openaiError(reply, 400, 'invalid_request_error', 'empty_input', 'input 不能为空');
    const requestId = 'resp_' + randomUuid().slice(0, 12);
    const stream = !!body.stream;

    if (!stream) {
      try {
        const r = await infer({ key: auth.key, model, reasoningLevel, messages, maxOutputTokens, stream: false, requestId, clientIp: req.ip });
        const obj = buildResponseObject({ id: requestId, model, reasoningLevel, text: r.text, reasoning: r.reasoning, usage: r.usage, finishReason: r.finishReason });
        storePut(obj.id, obj, auth.key.id);
        reply.header('x-retry-attempts', String(r.attempts));
        return obj;
      } catch (e) {
        log.warn('推理失败', requestId, e.kind, e.code, e.message);
        return openaiError(reply, e.kind === 'busy' ? 529 : e.kind === 'exhausted' ? 503 : 502, 'server_error', String(e.code || 'internal_error'), e.message, {
          'x-retry-attempts': String(e.attempts || 0),
        });
      }
    }

    // 流式：SSE 事件序列（Responses 规范事件 + 15s 心跳注释行）
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const pingTimer = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
    }, 15000);
    reply.raw.on('close', () => clearInterval(pingTimer));

    const sequence = { v: 0 };
    const seq = () => ++sequence.v;
    const base = { id: requestId, object: 'response' };
    let usage = null, finish = 'stop', text = '', reasoning = '', firstToken = false, msgStarted = false;
    const rsId = 'rs_' + randomUuid().slice(0, 12);
    const msgId = 'msg_' + randomUuid().slice(0, 12);

    write('response.created', { ...base, type: 'response.created', sequence_number: seq(), response: { id: requestId, object: 'response', status: 'in_progress', model, output: [] } });
    const onEvent = (ev) => {
      switch (ev.type) {
        case 'reasoning_delta':
          if (!ev.text) break;
          if (!firstToken) { firstToken = true; write('response.output_item.added', { type: 'response.output_item.added', output_index: 0, sequence_number: seq(), item: { type: 'reasoning', id: rsId, summary: [] } }); write('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: rsId, output_index: 0, summary_index: 0, sequence_number: seq(), part: { type: 'summary_text', text: '' } }); }
          reasoning += ev.text;
          write('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: rsId, output_index: 0, summary_index: 0, sequence_number: seq(), delta: ev.text });
          break;
        case 'text_delta':
          if (!ev.text) break;
          if (!firstToken) { firstToken = true; write('response.output_item.added', { type: 'response.output_item.added', output_index: 0, sequence_number: seq(), item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } }); msgStarted = true; write('response.content_part.added', { type: 'response.content_part.added', item_id: msgId, output_index: 0, content_index: 0, sequence_number: seq(), part: { type: 'output_text', text: '', annotations: [] } }); }
          else if (!msgStarted) {
            // reasoning 块已结束（text_start 缺失的兜底）：闭合并开 message 块
            write('response.output_item.done', { type: 'response.output_item.done', output_index: 0, sequence_number: seq(), item: { type: 'reasoning', id: rsId, summary: [{ type: 'summary_text', text: reasoning }] } });
            write('response.output_item.added', { type: 'response.output_item.added', output_index: 1, sequence_number: seq(), item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } });
            write('response.content_part.added', { type: 'response.content_part.added', item_id: msgId, output_index: 1, content_index: 0, sequence_number: seq(), part: { type: 'output_text', text: '', annotations: [] } });
            msgStarted = true;
          }
          text += ev.text;
          write('response.output_text.delta', { type: 'response.output_text.delta', item_id: msgId, output_index: msgStarted && reasoning ? 1 : 0, content_index: 0, sequence_number: seq(), delta: ev.text });
          break;
        case 'finish':
          usage = ev.usage;
          finish = String(ev.finishReason || 'stop').toLowerCase();
          break;
        case 'error':
          write('response.failed', { type: 'response.failed', sequence_number: seq(), response: { id: requestId, object: 'response', status: 'failed', error: { code: String(ev.code ?? 'server_error'), message: ev.message } } });
          break;
        default: break;
      }
    };
    const abortCtrl = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableEnded) abortCtrl.abort(new Error('客户端断开')); });
    let result = null, err = null;
    try {
      result = await infer({ key: auth.key, model, reasoningLevel, messages, maxOutputTokens, stream: true, onEvent, requestId, clientIp: req.ip, signal: abortCtrl.signal });
    } catch (e) { err = e; }

    if (err) {
      if (!firstToken) {
        // 首 token 前失败：infer 编排层抛出，onEvent 未收到 error → 补发失败事件
        write('response.failed', { type: 'response.failed', sequence_number: seq(), response: { id: requestId, object: 'response', status: 'failed', error: { code: String(err.code || err.kind || 'server_error'), message: err.message } } });
      }
      clearInterval(pingTimer);
      reply.raw.end();
      return reply;
    }
    // 收尾：闭 text 块 → 闭 message/reasoning item → response.completed
    const output = [];
    let outIdx = 0;
    if (reasoning) {
      write('response.output_item.done', { type: 'response.output_item.done', output_index: outIdx, sequence_number: seq(), item: { type: 'reasoning', id: rsId, summary: [{ type: 'summary_text', text: reasoning }] } });
      output.push({ type: 'reasoning', id: rsId, summary: [{ type: 'summary_text', text: reasoning }] });
      outIdx++;
    }
    if (firstToken && !msgStarted) { /* 纯 reasoning 无文本：不补 message 块 */ }
    if (!reasoning || text) {
      if (!firstToken) {
        write('response.output_item.added', { type: 'response.output_item.added', output_index: outIdx, sequence_number: seq(), item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } });
      }
      write('response.output_text.done', { type: 'response.output_text.done', item_id: msgId, output_index: outIdx, content_index: 0, sequence_number: seq(), text: text || '' });
      write('response.content_part.done', { type: 'response.content_part.done', item_id: msgId, output_index: outIdx, content_index: 0, sequence_number: seq(), part: { type: 'output_text', text: text || '', annotations: [] } });
      write('response.output_item.done', { type: 'response.output_item.done', output_index: outIdx, sequence_number: seq(), item: { type: 'message', id: msgId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: text || '', annotations: [] }] } });
      output.push({ type: 'message', id: msgId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: text || '', annotations: [] }] });
    }
    const completed = {
      id: requestId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
      model, reasoning: { effort: reasoningLevel || 'low', summary: 'auto' },
      output, output_text: text || '', usage: usageOf(result?.usage || usage, null),
    };
    write('response.completed', { type: 'response.completed', sequence_number: seq(), response: completed });
    storePut(completed.id, completed, auth.key.id);
    clearInterval(pingTimer);
    reply.raw.end();
  });

  app.get('/v1/responses/:id', async (req, reply) => {
    const auth = authenticateGateway(req);
    if (!auth.ok) return openaiError(reply, auth.status, 'authentication_error', 'invalid_api_key', auth.error);
    const entry = store.get(req.params.id);
    if (!entry || entry.keyId !== auth.key.id) {
      return openaiError(reply, 404, 'invalid_request_error', 'response_not_found',
        `响应 ${req.params.id} 不存在（仅保留最近 100 条，进程重启即失；无持久化检索）`);
    }
    store.delete(req.params.id); store.set(req.params.id, entry); // LRU touch
    return entry.obj;
  });

  app.delete('/v1/responses/:id', async (req, reply) => {
    const auth = authenticateGateway(req);
    if (!auth.ok) return openaiError(reply, auth.status, 'authentication_error', 'invalid_api_key', auth.error);
    const entry = store.get(req.params.id);
    const deleted = entry?.keyId === auth.key.id ? store.delete(req.params.id) : false;
    return { id: req.params.id, object: 'response', deleted };
  });
}
