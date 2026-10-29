// 仅用于用户参与的真实上游授权验证；使用临时数据库，不读取或修改现有账号库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-live-oauth-'));
process.env.ZCODE2API_DATA_DIR = tempDir;
const { default: Fastify } = await import('fastify');
const { registerAdminRoutes } = await import('../src/admin/api.js');
const { createSession } = await import('../src/admin/auth.js');
const app = Fastify(); registerAdminRoutes(app);
const headers = { authorization: `Bearer ${createSession()}` };
const start = await app.inject({ method: 'POST', url: '/api/accounts/oauth/start', headers, payload: { provider: 'bigmodel' } });
const flow = start.json();
if (!flow.ok) { console.error('启动失败：', flow.error); process.exitCode = 1; await app.close(); }
else {
  console.log(`AUTHORIZE_URL ${flow.authorize_url}`);
  console.log(`FLOW_ID ${flow.flow_id}`);
  while (Date.now() < flow.expires_at) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const r = (await app.inject({ method: 'GET', url: `/api/accounts/oauth/status/${encodeURIComponent(flow.flow_id)}`, headers })).json();
    if (['done', 'failed', 'expired'].includes(r.status)) { console.log('RESULT', JSON.stringify({status:r.status, error:r.error, result:r.result})); break; }
  }
  await app.close();
}

const { db } = await import('../src/db.js');
db().close();
fs.rmSync(tempDir, { recursive: true, force: true });
