import { shouldUseToolRoute, handleToolRoute } from './tools-api.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { authenticateGateway, keyModelAllowed, listKeys } from './auth.js';
import { infer, resolveAlias, effectiveReasoningLevel } from './inference.js';
import { openaiError } from './errors.js';
import { busyWaitMs } from '../retry.js';
import { listAccounts } from '../accounts.js';
import { randomUuid } from '../crypto.js';

const log = logger('gateway-openai');

/** thinking.budget_tokens → 档位（Claude Code think=4000/megathink=10000/ultrathink=31999 均落此映射） */
export function budgetToLevel(budget) {
  const n = Number(budget || 0);
  if (n >= 24000) return 'max';
  if (n >= 8000) return 'high';
  return 'low';
}

/**
 * 思考强度归一：客户端 UI 背后发什么参数都能接住。
 * 兼容形态：
 *  - reasoning_effort（OpenAI 标准；Cherry Studio 思考强度下拉）
 *  - reasoning: "high" 或 reasoning: { effort }（Responses/新版 SDK 风格）
 *  - thinking_level / reasoningLevel（早期客户端）
 *  - thinking: { type, budget_tokens }（Anthropic/Claude Code/ZCode 系，think/megathink/ultrathink）
 *  - thinking: "high" 字符串形态
 * 未识别/未传 → null（交给密钥默认或全局默认）。
 */
export function mapEffort(body) {
  let raw = body.reasoning_effort ?? body.thinking_level ?? body.reasoningLevel;
  if (raw === undefined && body.reasoning !== undefined) {
    raw = typeof body.reasoning === 'string' ? body.reasoning : body.reasoning?.effort;
  }
  if (raw === undefined && body.thinking !== undefined) {
    if (typeof body.thinking === 'string') {
      raw = body.thinking;
    } else if (typeof body.thinking === 'object' && body.thinking) {
      if (body.thinking.type === 'disabled') return 'low';
      if (body.thinking.budget_tokens) return budgetToLevel(body.thinking.budget_tokens);
      if (body.thinking.type === 'enabled') return 'high'; // 开了思考但没给预算
    }
  }
  if (raw === undefined || raw === null) return null;
  const v = String(raw).toLowerCase();
  if (['low', 'high', 'max'].includes(v)) return v;
  if (v === 'medium' || v === 'default' || v === 'enabled') return 'high'; // 三档以下的中档归 high
  if (v === 'minimal' || v === 'off' || v === 'disabled' || v === 'none') return 'low';
  return null;
}

function clampMaxTokens(body) {
  const raw = body.max_completion_tokens ?? body.max_tokens;
  if (!raw || typeof raw !== 'number' || raw <= 0) return null;
  return Math.min(128000, Math.floor(raw));
}

/** OpenAI messages → 桥 messages/prompt。工具消息/多模态文本部分拍平为文本。 */
export function flattenMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter((c) => c && (c.type === 'text' || typeof c === 'string'))
        .map((c) => (typeof c === 'string' ? c : c.text)).join('\n');
    } else if (m.content === null && m.tool_calls) {
      text = m.tool_calls.map((tc) => `[调用工具 ${tc.function?.name}] ${tc.function?.arguments || ''}`).join('\n');
    }
    if (m.role === 'tool') out.push({ role: 'user', content: `[工具结果] ${text}` });
    else out.push({ role, content: text });
  }
  return out;
}

export function registerOpenAIRoutes(app) {
  app.get('/v1/models', async (req, reply) => {
    const auth = authenticateGateway(req);
    if (!auth.ok) return openaiError(reply, auth.status, 'authentication_error', 'invalid_api_key', auth.error);
    const accounts = listAccounts().filter((a) => a.status === 'active');
    const byLower = new Map(); // 大小写归一去重
    for (const a of accounts) for (const c of a.capabilities || []) {
      const key = String(c).toLowerCase();
      if (!byLower.has(key)) byLower.set(key, c);
    }
    const cfg = config();
    for (const t of new Set(Object.values(cfg.aliases || {}))) {
      const key = String(t).toLowerCase();
      if (!byLower.has(key)) byLower.set(key, t);
    }
    const data = [...byLower.values()].sort().map((id) => ({
      id, object: 'model', created: 0, owned_by: 'zcode-start-plan',
      aliases: Object.entries(cfg.aliases || {}).filter(([, v]) => v.toLowerCase() === id.toLowerCase()).map(([k]) => k),
    }));
    return { object: 'list', data };
  });

  app.get('/v1/usage', async (req, reply) => {
    const auth = authenticateGateway(req);
    if (!auth.ok) return openaiError(reply, auth.status, 'authentication_error', 'invalid_api_key', auth.error);
    const k = db().prepare('SELECT * FROM keys WHERE id=?').get(auth.key.id);
    const now = Date.now();
    return {
      key: { id: k.id, name: k.name, created_at: k.created_at },
      used_units: k.used_units,
      quota_limit: k.quota_limit,
      remaining: k.quota_limit === null ? null : Math.max(0, k.quota_limit - k.used_units),
      expires_at: k.expires_at,
      last_used_at: k.last_used_at,
      server_time: now,
    };
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    const auth = authenticateGateway(req);
    if (!auth.ok) return openaiError(reply, auth.status, 'authentication_error', 'invalid_api_key', auth.error);
    const body = req.body || {};
    if (body.functions?.length || body.function_call != null) return openaiError(reply, 400, 'invalid_request_error', 'unsupported_tools', '不支持旧版 functions，请使用 tools');
    const model = resolveAlias(body.model);
    if (!keyModelAllowed(auth.key, model)) {
      return openaiError(reply, 403, 'permission_error', 'model_not_allowed', `模型 ${model} 不在该密钥白名单`);
    }
    const reasoningLevel = effectiveReasoningLevel(mapEffort(body), auth.key);
    const maxOutputTokens = clampMaxTokens(body);
    if (shouldUseToolRoute(auth.key, body, 'chat', model)) return handleToolRoute({ req, reply, body, protocol: 'chat', key: auth.key, model, reasoningLevel, maxOutputTokens });
    const messages = flattenMessages(body.messages);
    if (!messages.length) return openaiError(reply, 400, 'invalid_request_error', 'empty_messages', 'messages 不能为空');
    const stream = !!body.stream;
    const requestId = 'req_' + randomUuid().slice(0, 12);

    if (!stream) {
      try {
        const r = await infer({
          key: auth.key, model, reasoningLevel, messages, maxOutputTokens,
          stream: false, requestId, clientIp: req.ip,
        });
        const created = Math.floor(Date.now() / 1000);
        const usage = {
          prompt_tokens: r.usage?.inputTokens ?? 0,
          completion_tokens: r.usage?.outputTokens ?? 0,
          total_tokens: r.usage?.totalTokens ?? ((r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0)),
          prompt_tokens_details: { cached_tokens: r.usage?.cacheReadTokens ?? 0 },
          completion_tokens_details: { reasoning_tokens: r.usage?.reasoningTokens ?? 0 },
        };
        const resp = {
          id: 'chatcmpl-' + requestId, object: 'chat.completion', created, model,
          system: { reasoning_level: reasoningLevel, attempts: r.attempts, rotated_accounts: r.rotated.length, queued: r.queued },
          choices: [{
            index: 0, message: { role: 'assistant', content: r.text },
            finish_reason: mapFinishReason(r.finishReason),
          }],
          usage,
        };
        reply.header('x-retry-attempts', String(r.attempts));
        return resp;
      } catch (e) {
        log.warn('推理失败', requestId, e.kind, e.code, e.message);
        const shape = errShape(e);
        const headers = { 'x-retry-attempts': String(e.attempts || 0) };
        // 529/503 带标准 Retry-After：下游（Claude Code SDK 等）按此退避，而不是立即放弃
        if (shape.status === 529 || shape.status === 503) headers['retry-after'] = String(Math.max(1, Math.ceil(busyWaitMs() / 1000)));
        return openaiError(reply, shape.status, shape.type, shape.code, shape.message, headers);
      }
    }

    // 流式
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const id = 'chatcmpl-' + requestId;
    const created = Math.floor(Date.now() / 1000);
    let started = false;
    let firstToken = false;
    let usage = null;
    let finish = 'stop';
    const sendChunk = (obj) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    // SSE 心跳：换号重试/排队可能静默数十秒，注释行防止中间层掐连接（OpenAI SDK 解析器忽略注释行）
    const pingTimer = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
    }, 15000);
    reply.raw.on('close', () => clearInterval(pingTimer));
    const startOnce = () => {
      if (started) return;
      started = true;
      sendChunk({ id, object: 'chat.completion.chunk', created, model, system: { reasoning_level: reasoningLevel }, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    };
    const onEvent = (ev) => {
      switch (ev.type) {
        case 'text_delta':
          if (ev.text) { startOnce(); firstToken = true; sendChunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }] }); }
          break;
        case 'reasoning_delta':
          if (ev.text) { startOnce(); sendChunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: ev.text }, finish_reason: null }] }); }
          break;
        case 'tool_call':
          startOnce();
          sendChunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: ev.toolCallId || 'call_' + randomUuid().slice(0, 8), type: 'function', function: { name: ev.toolName, arguments: JSON.stringify(ev.input ?? {}) } }] }, finish_reason: null }] });
          break;
        case 'finish':
          usage = ev.usage;
          finish = mapFinishReason(ev.finishReason);
          break;
        case 'error':
          // 首 token 后错误：按 OpenAI 流式惯例发 error 数据块收尾
          sendChunk({ id, object: 'chat.completion.chunk', created, model, error: { message: ev.message, type: 'server_error', code: String(ev.code ?? '') } });
          break;
        default: break;
      }
    };
    // 客户端断连 → 取消运行时会话（不白烧额度）
    const abortCtrl = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableEnded) abortCtrl.abort(new Error('客户端断开')); });
    const inferPromise = infer({
      key: auth.key, model, reasoningLevel, messages, maxOutputTokens,
      stream: true, onEvent, requestId, clientIp: req.ip,
      signal: abortCtrl.signal,
    });
    let result = null, err = null;
    try { result = await inferPromise; } catch (e) { err = e; }
    if (err) {
      const shape = errShape(err);
      if (!firstToken && !started) {
        reply.raw.write(`data: ${JSON.stringify({ error: { message: shape.message, type: shape.type, code: shape.code } })}\n\n`);
      } else if (!firstToken) {
        // 起始块已发但无内容：补发 finish（首 token 前的失败已在 infer 内整体重试过）
        sendChunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sendChunk({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(usage) });
      }
    } else {
      sendChunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
      sendChunk({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(result?.usage) });
    }
    reply.raw.write('data: [DONE]\n\n');
    clearInterval(pingTimer);
    reply.raw.end();
  });
}

function usageOf(u) {
  return {
    prompt_tokens: u?.inputTokens ?? 0, completion_tokens: u?.outputTokens ?? 0,
    total_tokens: u?.totalTokens ?? ((u?.inputTokens ?? 0) + (u?.outputTokens ?? 0)),
  };
}

function mapFinishReason(fr) {
  const v = String(fr || '').toLowerCase();
  if (v.includes('length') || v === 'max_tokens') return 'length';
  if (v.includes('tool')) return 'tool_calls';
  return 'stop';
}

function errShape(e) {
  const kind = e.kind || 'unknown';
  if (kind === 'exhausted') return { status: 503, type: 'server_error', code: 'no_account', message: e.message };
  if (kind === 'canceled') return { status: 499, type: 'canceled', code: 'canceled', message: '客户端已断开' };
  if (kind === 'busy') return { status: 529, type: 'server_error', code: String(e.code || 3008), message: '当前系统繁忙（免费网关并发上限），已尝试全部账号' };
  if (kind === 'quota') return { status: 403, type: 'insufficient_quota', code: String(e.code || 3103), message: '全部账号免费额度已耗尽' };
  if (kind === 'auth') return { status: 401, type: 'authentication_error', code: '401', message: '账号凭证失效且无可用替补' };
  if (kind === 'context') return { status: 400, type: 'context_length_exceeded', code: String(e.code || 1261), message: e.message };
  if (kind === 'invalid') return { status: 400, type: 'invalid_request_error', code: String(e.code || 400), message: e.message };
  if (kind === 'timeout') return { status: 504, type: 'timeout', code: 'timeout', message: '推理超时' };
  return { status: 502, type: 'server_error', code: String(e.code || 500), message: e.message };
}
