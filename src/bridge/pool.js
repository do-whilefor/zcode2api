import { getAccount, getTokens } from '../accounts.js';
import { logger } from '../log.js';
import { config } from '../config.js';
import { RuntimeSlot } from './runtime.js';

const log = logger('bridge-pool');

const slots = new Map(); // accountId -> RuntimeSlot

export function getSlot(accountId) {
  return slots.get(accountId) || null;
}

/** 取或懒启动账号的运行时槽位（受 max_slots 上限约束；0=不限） */
export async function acquireSlot(accountId) {
  let slot = slots.get(accountId);
  if (slot && slot.exited) {
    await slot.stop().catch(() => {});
    slots.delete(accountId);
    slot = null;
  }
  if (!slot) {
    await evictSlotForCapacity();
    const a = getAccount(accountId);
    if (!a) throw new Error('账号不存在');
    const tokens = getTokens(accountId);
    if (!tokens.zcode_jwt) throw new Error('账号无 zcode_jwt，无法进行推理');
    slot = new RuntimeSlot({ id: accountId, family: a.family, device_mid: a.device_mid, customer_id: a.customer_id, proxy_url: a.proxy_url, tokens });
    slots.set(accountId, slot);
  }
  if (!slot.started) await slot.start();
  return slot;
}

/**
 * 槽位内存上限：每个槽位 ≈ 一个 Node 子进程（约 80-150MB）。
 * 达上限时回收 lastActivity 最老且空闲（pending=0）的槽位；无可回收则软超限放行（log.warn，不死锁）。
 */
async function evictSlotForCapacity() {
  const max = Number(config().max_slots) || 0;
  if (max <= 0 || slots.size < max) return;
  const candidates = [...slots.entries()]
    .filter(([, s]) => !s.exited && s.pending.size === 0 && !s.toolLeases)
    .sort((a, b) => a[1].lastActivity - b[1].lastActivity);
  if (!candidates.length) {
    log.warn(`槽位已达上限 ${max} 且全部忙碌，软超限启动（内存可能瞬时升高）`);
    return;
  }
  const [victimId, victim] = candidates[0];
  log.info(`槽位达上限 ${max}，回收最旧空闲槽位 ${victimId} 给新账号`);
  await victim.stop().catch(() => {});
  slots.delete(victimId);
}

export async function releaseSlot(accountId) {
  const slot = slots.get(accountId);
  if (slot) await slot.stop().catch(() => {});
  slots.delete(accountId);
}

/** 空闲回收 + 崩溃计数（由 index.js 定时调用） */
export async function reapIdleSlots() {
  const cfg = config();
  const idleMs = cfg.runtime_idle_min * 60 * 1000;
  for (const [id, slot] of slots) {
    if (slot.exited) { slots.delete(id); continue; }
    if (!slot.toolLeases && slot.isIdle(idleMs)) {
      log.info('空闲回收运行时', id);
      await slot.stop().catch(() => {});
      slots.delete(id);
    }
  }
}

/** 启动预热：拉起 active 账号的运行时槽位（截断至 max_slots），消除首个请求的冷启动（串行防资源尖峰） */
export async function prewarmSlots() {
  const { listAccounts } = await import('../accounts.js');
  const max = Number(config().max_slots) || 0;
  const actives = listAccounts().filter((a) => a.status === 'active');
  const skipped = max > 0 ? Math.max(0, actives.length - max) : 0;
  if (skipped) log.info(`预热截断：active ${actives.length} 个 > max_slots ${max}，本次预热 ${max} 个（其余按需拉起）`);
  for (const a of actives.slice(0, max > 0 ? max : actives.length)) {
    const t0 = Date.now();
    try {
      await acquireSlot(a.id);
      log.info(`预热完成 slot=${a.id} 耗时 ${Date.now() - t0}ms`);
    } catch (e) {
      log.warn(`预热失败 slot=${a.id}`, e.message);
    }
  }
  return actives.length;
}

/** 桥冒烟：启动/复用槽位并走主路径会话流跑一条最小推理 */
export async function bridgeSmoke(accountId) {
  try {
    const { runOnce } = await import('./session.js');
    const r = await runOnce(accountId, {
      model: 'GLM-5.3-Flash',
      prompt: '只回复两个字：正常',
      reasoningLevel: 'low',
      turnTimeoutMs: 120000,
    });
    return { ok: true, detail: `回复「${String(r.text).slice(0, 30)}」 usage in=${r.usage?.inputTokens ?? '?'} out=${r.usage?.outputTokens ?? '?'}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

/**
 * 一次性文本生成（workspace/generateText）。
 * opts: { model, prompt | messages, maxOutputTokens, reasoningLevel }
 * messages: [{role:'user'|'assistant'|'system', content:string}]
 */
export async function generateText(accountId, opts) {
  const slot = await acquireSlot(accountId);
  const providerId = `account:${slot.family}-start-plan`;
  // 卡片模型强制要求 reasoningLevel（缺省 high；档位支持 low/high/max）
  const reasoningLevel = ['low', 'high', 'max'].includes(opts.reasoningLevel) ? opts.reasoningLevel : 'high';
  const selection = {
    providerId,
    modelId: opts.model || 'GLM-5.3-Flash',
    options: { reasoningLevel },
  };
  const params = {
    workspace: { workspacePath: slot.workspaceDir, workspaceKey: `${accountId}-bridge` },
    selection,
    querySource: 'zcode2api-gateway',
    ...(opts.prompt !== undefined ? { prompt: String(opts.prompt) } : {}),
    ...(opts.messages ? { messages: opts.messages } : {}),
    ...(opts.maxOutputTokens ? { maxOutputTokens: Math.max(1, Math.min(128000, opts.maxOutputTokens)) } : {}),
    ...(opts.operationId ? { operationId: opts.operationId } : {}),
  };
  const result = await slot.request('workspace/generateText', params, { timeoutMs: opts.timeoutMs || 300000 });
  return {
    text: result?.text ?? '',
    finishReason: result?.finishReason ?? null,
    toolCalls: result?.toolCalls ?? [],
    usage: result?.usage ?? null,
    selection: result?.selection ?? selection,
  };
}

export function poolStatus() {
  return [...slots.entries()].map(([id, s]) => ({
    account_id: id,
    started: s.started,
    exited: s.exited,
    last_activity: s.lastActivity,
    pending: s.pending.size,
    crash_streak: s.crashStreak,
    last_stderr: s.lastStderr ? String(s.lastStderr).slice(-400) : null,
  }));
}
