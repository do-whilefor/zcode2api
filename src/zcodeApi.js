import crypto from 'node:crypto';
import { request, zcodeUrl, platformKey, HttpError } from './httpclient.js';
import { config } from './config.js';
import { logger } from './log.js';

const log = logger('zcode-api');

let configsCache = { at: 0, data: null };
export async function getClientConfigs(force = false) {
  const cfg = config();
  if (!force && configsCache.data && Date.now() - configsCache.at < 3600_000) return configsCache.data;
  const res = await request({
    url: zcodeUrl('/api/v1/client/configs', { app_version: cfg.app_version, platform: platformKey() }),
    timeoutMs: 15000,
  });
  if (res.status !== 200 || !res.json || res.json.code !== 0) {
    throw new HttpError(res.status, 'configs_failed', `client/configs 拉取失败: HTTP ${res.status}`);
  }
  configsCache = { at: Date.now(), data: res.json.data?.configs || {} };
  return configsCache.data;
}

export async function getBuiltinProviderConfig() {
  const configs = await getClientConfigs();
  let url = configs.builtin_provider_config_json;
  if (!url) throw new HttpError(0, 'no_builtin_config', 'client/configs 未投放 builtin_provider_config_json');
  if (typeof url !== 'string') { // 兼容直接内联 JSON 的投放形态
    return typeof url === 'object' ? url : null;
  }
  const res = await request({ url, timeoutMs: 20000 });
  if (res.status !== 200 || !res.json) throw new HttpError(res.status, 'builtin_config_failed', `内置配置拉取失败: HTTP ${res.status}`);
  return res.json; // { schemaVersion, revision, config }
}

export async function getBalanceRaw(bearer, deviceMid, { jar, dispatcher } = {}) {
  const cfg = config();
  return request({
    url: zcodeUrl('/api/v1/zcode-plan/billing/balance', { app_version: cfg.app_version }),
    bearer,
    jar,
    dispatcher,
    headers: {
      'X-Device-Mid': deviceMid,
      'X-Request-Id': crypto.randomUUID(),
    },
    timeoutMs: 20000,
  });
}

function headerTimeMs(res) {
  const d = res.dateHeader ? Date.parse(res.dateHeader) : NaN;
  return Number.isFinite(d) ? d : Date.now();
}

/**
 * 拉取并归一化 balance。
 * 返回 { ok, httpStatus, plans, balances, serverNowMs, capabilities, card:{...}|null, raw }
 * 防旧数据：ends_at 已过期的 active 计划按响应时间改判 expired 并剔除其名下额度桶。
 */
export async function fetchBalance(bearer, deviceMid, { jar, dispatcher } = {}) {
  const res = await getBalanceRaw(bearer, deviceMid, { jar, dispatcher });
  const serverNowMs = res.json?.data?.server_time
    ? res.json.data.server_time * 1000
    : headerTimeMs(res);
  if (res.status === 401) {
    return { ok: false, authFailed: true, httpStatus: 401, plans: [], balances: [], serverNowMs, capabilities: [], card: null, raw: res.json };
  }
  if (res.status !== 200 || !res.json || res.json.code !== 0) {
    return { ok: false, httpStatus: res.status, plans: [], balances: [], serverNowMs, capabilities: [], card: null, raw: res.json };
  }
  const data = res.json.data || {};
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const balances = Array.isArray(data.balances) ? data.balances : [];

  // "已激活的卡"判定：status===active 且 plan_id/name 含 start-plan
  const startPlan = plans.find((p) => {
    const id = String(p.plan_id || '');
    const name = String(p.name || '');
    return p.status === 'active' && (id.toLowerCase().includes('start-plan') || name.toLowerCase().includes('start plan') || name.toLowerCase().includes('start-plan'));
  });
  // 过期改判
  let expiredNow = false;
  for (const p of plans) {
    if (p.status === 'active' && p.ends_at && p.ends_at * 1000 < serverNowMs) {
      expiredNow = true;
      p._staleExpired = true;
    }
  }
  const activePlanIds = new Set(plans.filter((p) => p.status === 'active' && !p._staleExpired).map((p) => p.user_plan_id || p.plan_id));
  const liveBalances = balances.filter((b) => !b.user_plan_id || activePlanIds.has(b.user_plan_id));

  // 可用模型白名单：capabilities 里 model: 前缀，兜底 show_name
  const caps = new Set();
  for (const b of liveBalances) {
    let added = false;
    for (const c of b.capabilities || []) {
      if (typeof c === 'string' && c.startsWith('model:')) { caps.add(c.slice(6)); added = true; }
    }
    if (!added && b.show_name) caps.add(String(b.show_name));
  }
  return {
    ok: true,
    httpStatus: 200,
    plans,
    balances: liveBalances,
    serverNowMs,
    capabilities: [...caps],
    card: startPlan ? {
      userPlanId: startPlan.user_plan_id || null,
      planId: startPlan.plan_id || null,
      name: startPlan.name || null,
      status: startPlan.status,
      startedAt: startPlan.starts_at ? startPlan.starts_at * 1000 : null,
      endsAt: startPlan.ends_at ? startPlan.ends_at * 1000 : null,
    } : null,
    raw: res.json,
  };
}

export async function getPreview(bearer, deviceMid, { jar, dispatcher } = {}) {
  const cfg = config();
  const res = await request({
    url: zcodeUrl('/api/v1/zcode-plan/billing/preview', { app_version: cfg.app_version, platform: platformKey() }),
    bearer: bearer || undefined,
    jar,
    dispatcher,
    headers: { 'X-Device-Mid': deviceMid },
    timeoutMs: 20000,
  });
  if (res.status === 400 && res.json?.code === 3001) {
    throw new HttpError(400, '3001', 'parameter error：缺少 X-Device-Mid');
  }
  if (res.status !== 200 || !res.json || res.json.code !== 0) {
    throw new HttpError(res.status, String(res.json?.code ?? res.status), `preview 失败: ${res.json?.msg || res.status}`);
  }
  return { plans: res.json.data?.plans || [], serverTimeMs: (res.json.data?.server_time || 0) * 1000 || headerTimeMs(res) };
}

export async function claimPlan(bearer, deviceMid, planId, { jar, dispatcher } = {}) {
  const cfg = config();
  const res = await request({
    url: zcodeUrl('/api/v1/zcode-plan/billing/claim'),
    method: 'POST',
    bearer,
    jar,
    dispatcher,
    headers: { 'X-Device-Mid': deviceMid },
    body: { plan_id: planId },
    timeoutMs: 25000,
  });
  const j = res.json || {};
  // 错误码可能是数字字符串；缺失 code 不推断成功
  const codeOk = j.code === 0;
  const plan = j.data?.plan;
  return {
    httpStatus: res.status,
    ok: codeOk && !!plan,
    code: j.code !== undefined ? String(j.code) : null,
    message: j.data?.message || j.msg || '',
    plan: plan || null,
    endsAt: plan?.ends_at ? plan.ends_at * 1000 : (j.data?.plan?.ends_at ? j.data.plan.ends_at * 1000 : null),
  };
}

export async function getCustomerInfo(webJwt, family = 'bigmodel', { dispatcher } = {}) {
  const host = family === 'zai' ? 'https://api.z.ai' : 'https://bigmodel.cn';
  const res = await request({
    url: `${host}/api/biz/customer/getCustomerInfo`,
    headers: { Authorization: webJwt },
    dispatcher,
    timeoutMs: 15000,
  });
  const ok = res.status === 200 && (res.json?.code === 200 || res.json?.code === 0);
  return { status: res.status, ok, json: res.json };
}

export async function oauthCliInit(provider, pollToken) {
  const res = await request({
    url: zcodeUrl('/api/v1/oauth/cli/init'),
    method: 'POST',
    bearer: pollToken,
    body: { provider },
    timeoutMs: 20000,
  });
  if (res.status !== 200 || !res.json || res.json.code !== 0) {
    throw new HttpError(res.status, String(res.json?.code ?? res.status), `cli/init 失败: ${res.json?.msg || res.status}`);
  }
  const d = res.json.data || {};
  return { flowId: d.flow_id, authorizeUrl: d.authorize_url, expiresAt: (d.expires_at || 0) * 1000, pollIntervalSec: d.poll_interval_sec || 3 };
}

export async function oauthCliPoll(flowId, pollToken) {
  const res = await request({
    url: zcodeUrl(`/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`),
    bearer: pollToken,
    timeoutMs: 15000,
  });
  // 4xx（除 408/429）视为终态失败
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    return { terminal: true, status: res.status, code: res.json?.code, msg: res.json?.msg };
  }
  if (res.status === 200 && res.json?.code === 0) {
    const d = res.json.data || {};
    if (d.status === 'failed' || d.status === 'expired') return { terminal: true, status: d.status, code: res.json?.code };
    // 当前上游 ready 直接返回 token；兼容旧版 code/state。
    return { terminal: false, ready: d.status === 'ready' || !!d.code, status: d.status, code: d.code, state: d.state, data: d };
  }
  return { terminal: false, ready: false, status: res.status, code: res.json?.code };
}

/** 令牌交换：POST /api/v1/oauth/token（双族分支由调用方处理 data.*） */
export async function oauthTokenExchange(provider, code, redirectUri, state) {
  const res = await request({
    url: zcodeUrl('/api/v1/oauth/token'),
    method: 'POST',
    body: { provider, code, redirect_uri: redirectUri, state },
    timeoutMs: 25000,
  });
  const j = res.json || {};
  if (res.status !== 200 || j.code !== 0 || !j.data?.token) {
    throw new HttpError(res.status, String(j.code ?? res.status), `oauth/token 失败: ${j.msg || res.status}`);
  }
  return j.data; // { token, bigmodel?:{access_token,refresh_token}, zai?:{access_token}, expires_in?, user? }
}

/** zai 业务 JWT 铸造（官方 ZaiBusinessTokenResolver 同款） */
export async function zaiBusinessLogin(oauthAccessToken) {
  const res = await request({
    url: 'https://api.z.ai/api/auth/z/login',
    method: 'POST',
    body: { token: oauthAccessToken },
    timeoutMs: 20000,
  });
  const j = res.json || {};
  if ((j.code !== 0 && j.code !== 200) || !j.data?.access_token) {
    throw new HttpError(res.status, String(j.code ?? res.status), `z/login 业务令牌兑换失败: ${j.msg || res.status}`);
  }
  return { businessToken: j.data.access_token, expiresInSec: j.data.expires_in || 0 };
}
