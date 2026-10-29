import { getSetting } from './db.js';
import { config } from './config.js';

/** 忙碌排队窗口的兜底下限（配置缺失/非法时使用） */
export const BUSY_RETRY_WINDOW_MS = 10000;

/** 忙碌排队窗口（可配 busy_wait_sec，默认 60s）：全部账号忙碌时排队等待换号，而不是快速 529 */
export function busyWaitMs() {
  const sec = Number(retryParams().busy_wait_sec);
  if (!Number.isFinite(sec) || sec <= 0) return BUSY_RETRY_WINDOW_MS;
  return Math.min(600, sec) * 1000;
}

/**
 * 官方错误分类表（来源：设计文档《网关API与重试设计》§1.2，取自官方客户端
 * failure-provider-business-codes / failure-classifier / retry-policy 语义）。
 * kind: server|network|rate_limit|overload|busy|invalid|quota|context|terminal|auth|risk
 */
const CODE_TABLE = {
  500: { kind: 'server', retryable: true },
  2007: { kind: 'server', retryable: true },
  1120: { kind: 'server', retryable: true },
  1230: { kind: 'server', retryable: true },
  1234: { kind: 'network', retryable: true },
  1302: { kind: 'rate_limit', retryable: true },
  1303: { kind: 'rate_limit', retryable: true },
  1305: { kind: 'rate_limit', retryable: true },
  3002: { kind: 'rate_limit', retryable: true },
  1312: { kind: 'overload', retryable: true },
  engine_overloaded_error: { kind: 'overload', retryable: true },
  overloaded_error: { kind: 'overload', retryable: true },
  3008: { kind: 'busy', retryable: true, rotate: true },   // 并发上限（免费网关"系统繁忙"）
  3009: { kind: 'busy', retryable: true, rotate: true },
  3010: { kind: 'busy', retryable: true, rotate: true },
  3001: { kind: 'invalid', retryable: false, rotateMaybe: true },
  3006: { kind: 'invalid', retryable: false, rotateMaybe: true },  // 模型不存在
  3007: { kind: 'auth', retryable: false, rotateMaybe: true },
  1005: { kind: 'quota', retryable: false, rotate: true },
  1006: { kind: 'quota', retryable: false, rotate: true },
  1261: { kind: 'context', retryable: false },
  1113: { kind: 'terminal', retryable: false },
  1309: { kind: 'terminal', retryable: false },
  1311: { kind: 'terminal', retryable: false },
  1304: { kind: 'terminal', retryable: false },
  1308: { kind: 'terminal', retryable: false },
  1310: { kind: 'terminal', retryable: false },
  1313: { kind: 'terminal', retryable: false },
  3103: { kind: 'quota', retryable: false, rotate: true },   // 免费额度耗尽
  3012: { kind: 'risk', retryable: false },                   // 风控拦截（走桥不应出现→重启桥）
  1008: { kind: 'terminal', retryable: false },
  1314: { kind: 'terminal', retryable: false },
  1315: { kind: 'terminal', retryable: false },
  2056: { kind: 'quota', retryable: false, rotate: true },
  20097: { kind: 'quota', retryable: false, rotate: true },
  1316: { kind: 'quota', retryable: false, rotate: true },
  1317: { kind: 'quota', retryable: false, rotate: true },
  1318: { kind: 'quota', retryable: false, rotate: true },
  1319: { kind: 'quota', retryable: false, rotate: true },
  1320: { kind: 'quota', retryable: false, rotate: true },
  1321: { kind: 'quota', retryable: false, rotate: true },
  insufficient_quota: { kind: 'quota', retryable: false, rotate: true },
};

export function defaultRetryParams() {
  return { ...config().retry };
}

export function retryParams() {
  return { ...defaultRetryParams(), ...(getSetting('retry', {}) || {}) };
}

/**
 * 分类一次失败。
 * err: { code?:string|number, status?:number, message?:string, network?:bool }
 * 返回 { kind, retryable, rotate, retryAfterMs? }
 */
export function classifyFailure(err) {
  const code = err?.code;
  const entry = code !== undefined && code !== null ? CODE_TABLE[String(code)] : null;
  if (entry) {
    return { kind: entry.kind, retryable: entry.retryable, rotate: !!entry.rotate, rotateMaybe: !!entry.rotateMaybe };
  }
  if (code === 'engine_overloaded_error' || code === 'overloaded_error') return { kind: 'overload', retryable: true, rotate: false };
  if (code === 'insufficient_quota') return { kind: 'quota', retryable: false, rotate: true };
  if (code === 'timeout' || err?.timeout) return { kind: 'timeout', retryable: true, rotate: false };
  if (err?.status === 429) {
    return { kind: 'rate_limit', retryable: true, rotate: false, retryAfterMs: err.retryAfterMs };
  }
  if (err?.status === 401 || err?.status === 403) return { kind: 'auth', retryable: false, rotate: true, relogin: err.status === 401 };
  if ((err?.status || 0) >= 500) return { kind: 'server', retryable: true, rotate: false };
  if (err?.network || err?.timeout) return { kind: 'network', retryable: true, rotate: false };
  if (err?.status === 400) return { kind: 'invalid', retryable: false };
  return { kind: 'unknown', retryable: false };
}

/** 同账号退避延迟（2s×2 封顶 60s + jitter）；attempt 从 1 计 */
export function backoffDelayMs(attempt, p = retryParams()) {
  let d = Math.min(p.max_delay_ms, p.base_delay_ms * p.backoff_factor ** Math.max(0, attempt - 1));
  if (p.jitter) d = Math.round(d * (0.8 + Math.random() * 0.4));
  return d;
}

/** busy 冷却（1s ± 500ms） */
export function busyCooldownMs(p = retryParams()) {
  const j = p.busy_jitter_ms || 500;
  return Math.max(0, Math.round(p.busy_cooldown_ms + (Math.random() * 2 - 1) * j));
}

/** 零 inflight 连续 3008 的升级冷却（1s→5s→15s） */
export function busyEscalationMs(streak, p = retryParams()) {
  const arr = Array.isArray(p.busy_escalation_ms) ? p.busy_escalation_ms : [1000, 5000, 15000];
  return arr[Math.min(streak - 1, arr.length - 1)] ?? arr[arr.length - 1];
}

/** 流式重试边界：首 token（非空 delta）前返回 true 表示可以整体重放 */
export const SAFE_PRELUDE = new Set(['start', 'text_start', 'text_end', 'reasoning_start', 'reasoning_end',
  'tool_input_start', 'tool_input_delta', 'tool_input_end', 'message_start', 'ping', 'content_block_start', 'content_block_stop']);

export function isVisibleToken(event) {
  return event.type === 'tool_call' || ((event.type === 'text_delta' || event.type === 'reasoning_delta') && !!event.text && event.text.length > 0);
}
