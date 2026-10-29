/** 网关错误体（OpenAI / Anthropic 两种格式） */
export function openaiError(res, status, type, code, message, extraHeaders = {}) {
  res.code(status).header('content-type', 'application/json');
  for (const [k, v] of Object.entries(extraHeaders)) res.header(k, v);
  return res.send({ error: { message, type, code } });
}

export function anthropicError(res, status, type, message, extraHeaders = {}) {
  res.code(status).header('content-type', 'application/json');
  for (const [k, v] of Object.entries(extraHeaders)) res.header(k, v);
  return res.send({ type: 'error', error: { type, message } });
}

/** 内部失败分类 → OpenAI 错误类型/状态 */
export function toOpenAIErrorShape(fail) {
  switch (fail.kind) {
    case 'busy': return { status: 529, type: 'server_error', code: String(fail.code || 3008), message: '当前系统繁忙（免费网关并发上限），已尝试全部账号' };
    case 'rate_limit': return { status: 429, type: 'rate_limit_error', code: String(fail.code || 429), message: fail.message || '请求过于频繁' };
    case 'quota': return { status: 403, type: 'insufficient_quota', code: String(fail.code || 3103), message: '全部账号免费额度已耗尽或不可用' };
    case 'auth': return { status: 401, type: 'authentication_error', code: String(fail.code || 401), message: '账号凭证失效且无可用替补' };
    case 'context': return { status: 400, type: 'context_length_exceeded', code: String(fail.code || 1261), message: fail.message || '上下文超限' };
    case 'invalid': return { status: 400, type: 'invalid_request_error', code: String(fail.code || 400), message: fail.message || '请求无效' };
    case 'risk': return { status: 502, type: 'server_error', code: '3012', message: '上游风控拦截（异常），已重启桥进程' };
    case 'timeout': return { status: 504, type: 'timeout', code: 'timeout', message: '推理超时' };
    default: return { status: 502, type: 'server_error', code: String(fail.code || 500), message: fail.message || '上游错误' };
  }
}

export function toAnthropicErrorShape(fail) {
  switch (fail.kind) {
    case 'busy': return { status: 529, type: 'overloaded_error', message: '当前系统繁忙（免费网关并发上限），已尝试全部账号' };
    case 'rate_limit': return { status: 429, type: 'rate_limit_error', message: fail.message || '请求过于频繁' };
    case 'quota': return { status: 403, type: 'invalid_request_error', message: '全部账号免费额度已耗尽或不可用' };
    case 'auth': return { status: 401, type: 'authentication_error', message: '账号凭证失效且无可用替补' };
    case 'context': return { status: 400, type: 'invalid_request_error', message: fail.message || '上下文超限' };
    case 'invalid': return { status: 400, type: 'invalid_request_error', message: fail.message || '请求无效' };
    case 'risk': return { status: 502, type: 'api_error', message: '上游风控拦截（异常）' };
    case 'timeout': return { status: 504, type: 'api_error', message: '推理超时' };
    default: return { status: 502, type: 'api_error', message: fail.message || '上游错误' };
  }
}
