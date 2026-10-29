import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.ZCODE2API_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-test-'));
const { default: Fastify } = await import('fastify');
const { registerAdminRoutes } = await import('../src/admin/api.js');
const { createSession } = await import('../src/admin/auth.js');
const { listAccounts, getTokens } = await import('../src/accounts.js');
let app = Fastify(); registerAdminRoutes(app);
const auth = { authorization: `Bearer ${createSession()}` };
const jwt = (payload) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
let identity = '42', count = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  let data;
  if (u.includes('/cli/init')) data = { code: 0, data: { flow_id: `flow${++count}`, authorize_url: 'https://example.com/authorize', expires_at: Math.floor(Date.now()/1000)+60, poll_interval_sec: 2 } };
  else if (u.includes('/cli/poll/')) data = { code: 0, data: { status: 'ready', token: jwt({ user_id: identity }), user: { user_id: identity }, bigmodel: { access_token: 'business' } } };
  else if (u.includes('/billing/balance')) data = { code: 0, data: { plans: [], balances: [] } };
  else if (u.includes('/getCustomerInfo')) data = { code: 200 };
  else throw new Error(`unexpected request ${u}`);
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
};
async function start(target) {
  const r = await app.inject({ method: 'POST', url: '/api/accounts/oauth/start', headers: auth, payload: { provider: 'bigmodel', ...(target ? { account_id: target } : {}) } });
  assert.equal(r.statusCode, 200); const id = r.json().flow_id;
  await new Promise(resolve => setTimeout(resolve, 2200));
  return (await app.inject({ method: 'GET', url: `/api/accounts/oauth/status/${id}`, headers: auth })).json();
}
test('轮询令牌建档、重复授权更新及身份不匹配拒绝', async () => {
  let r = await start(); assert.equal(r.status, 'done'); assert.equal(r.result.verified, true);
  const id = r.account_id; assert.equal(listAccounts().length, 1);
  r = await start(); assert.equal(r.account_id, id); assert.equal(r.result.updated, true); assert.equal(listAccounts().length, 1);
  identity = 'other'; r = await start(id); assert.equal(r.status, 'failed'); assert.match(r.error, /不一致/); assert.equal(listAccounts().length, 1);
  identity = '42';
});
test('网页会话更新校验身份并保留原凭据', async () => {
  const id = listAccounts()[0].id;
  const call = (token) => app.inject({ method: 'POST', url: `/api/accounts/${id}/refresh-cookie`, headers: auth, payload: { webJwt: token } });
  const valid = jwt({ user_id: '42', user_channel: 'web', exp: Math.floor(Date.now()/1000)+3600 });
  assert.equal((await call(valid)).json().ok, true); assert.equal(getTokens(id).web_jwt, valid);
  assert.equal((await call(jwt({ user_id: 'different', user_channel: 'web' }))).json().ok, false);
  assert.equal(getTokens(id).web_jwt, valid);
});
test('待授权流程在服务关闭后恢复并完成', async () => {
  const startResult = await app.inject({ method: 'POST', url: '/api/accounts/oauth/start', headers: auth, payload: { provider: 'bigmodel' } });
  const flowId = startResult.json().flow_id;
  await app.close();
  app = Fastify(); registerAdminRoutes(app);
  const pending = (await app.inject({ method: 'GET', url: '/api/accounts/oauth/pending', headers: auth })).json();
  assert.ok(pending.some((f) => f.flow_id === flowId));
  await new Promise(resolve => setTimeout(resolve, 2200));
  const result = (await app.inject({ method: 'GET', url: `/api/accounts/oauth/status/${flowId}`, headers: auth })).json();
  assert.equal(result.status, 'done'); assert.equal(result.result.verified, true);
});
test('Cookie 到期提醒按有效期和阶段去重', async () => {
  const { checkCookieExpiry } = await import('../src/poller.js');
  const { getSetting } = await import('../src/db.js');
  const now = Date.now(), expiry = now + 2 * 86400000;
  const account = { id: 'reminder-test', label: 'test', tokens: { web_jwt: true }, web_cookie_expires_at: expiry };
  assert.equal(checkCookieExpiry(account, now), 'week');
  const saved = getSetting('cookie_notice:reminder-test');
  assert.equal(saved.week, now);
  checkCookieExpiry(account, now + 1); assert.deepEqual(getSetting('cookie_notice:reminder-test'), saved);
  assert.equal(checkCookieExpiry(account, expiry - 1000), 'day');
  assert.equal(checkCookieExpiry(account, expiry), 'expired');
});
test('三个网关拒绝格式无效的工具调用', async () => {
  const { createKey } = await import('../src/gateway/auth.js');
  const { registerOpenAIRoutes } = await import('../src/gateway/openai.js');
  const { registerAnthropicRoutes } = await import('../src/gateway/anthropic.js');
  const { registerResponsesRoutes } = await import('../src/gateway/responses.js');
  const gateway = Fastify(); registerOpenAIRoutes(gateway); registerAnthropicRoutes(gateway); registerResponsesRoutes(gateway);
  const headers = { authorization: `Bearer ${createKey({name:'test'}).secret}` };
  for (const url of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
    const r = await gateway.inject({ method: 'POST', url, headers, payload: { model: 'test', tools: [{ type: 'function', name: 'bad name', function: { name: 'bad name' } }] } });
    assert.equal(r.statusCode, 400); assert.match(r.body, /工具/);
  }
  await gateway.close();
});
test.after(async () => { await app.close(); });
