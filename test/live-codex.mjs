import Fastify from 'fastify';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createKey, deleteKey } from '../src/gateway/auth.js';
import { registerResponsesRoutes } from '../src/gateway/responses.js';
import { releaseSlot } from '../src/bridge/pool.js';
import { listAccounts } from '../src/accounts.js';

// 真机回归：codex exec 走 /v1/responses 完成一次 shell 工具回环。
// 需要本机安装 @openai/codex（npm），windows 取 vendor 内原生 exe。
const accountIds = listAccounts().filter(a => a.status === 'active').map(a => a.id);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-codex-live-'));
const app = Fastify({ bodyLimit: 32 * 1024 * 1024 });
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (!body) return done(null, {});
  try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
});
const seenCalls = new Set();
app.addHook('preHandler', async (req) => {
  if (req.url !== '/v1/responses') return;
  const b = req.body || {};
  for (const item of (Array.isArray(b.input) ? b.input : [])) if (item?.type === 'function_call') seenCalls.add(item.name);
});
registerResponsesRoutes(app);
await app.listen({ port: 0, host: '127.0.0.1' });
const key = createKey({ name: 'live-codex-test' });
const home = path.join(dir, 'codex-home');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'config.toml'), `
model = "glm-5.3-flash"
model_provider = "z2a"

[model_providers.z2a]
name = "zcode2api"
base_url = "http://127.0.0.1:${app.server.address().port}/v1"
wire_api = "responses"
env_key = "Z2A_API_KEY"
`);
const binCandidates = [
  process.env.Z2A_CODEX_BIN,
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
  'codex',
].filter(Boolean);
const bin = binCandidates.find((b) => { try { return fs.existsSync(b) || !b.includes(path.sep); } catch { return false; } });
if (!bin) { console.error('未找到 codex 可执行文件（Z2A_CODEX_BIN 可指定）'); process.exit(1); }
try {
  const child = spawn(bin, ['exec', '--skip-git-repo-check', '-C', dir, '--sandbox', 'danger-full-access', '--json', 'Use the exec_command tool to run exactly: node -v   Then reply with only the version string.'], { cwd: dir, env: { ...process.env, CODEX_HOME: home, Z2A_API_KEY: key.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', x => out += x);
  child.stderr.on('data', x => err += x);
  const code = await new Promise(res => { const t = setTimeout(() => child.kill(), 300000); child.once('exit', c => { clearTimeout(t); res(c); }); });
  let completed = false, answer = '';
  for (const line of out.split('\n').filter(Boolean)) {
    try {
      const ev = JSON.parse(line);
      const t = ev.type || ev.msg?.type || '';
      if (t === 'turn.completed') completed = true;
      if (t === 'item.completed' && (ev.item?.type === 'agent_message' || ev.item?.item_type === 'agent_message')) answer = ev.item.text || '';
      if (t === 'turn.failed') throw Error(`codex turn 失败: ${JSON.stringify(ev.error || ev.msg || {}).slice(0, 200)}`);
    } catch (e) { if (e.message.startsWith('codex turn 失败')) throw e; }
  }
  if (code !== 0) throw Error(`codex 退出码 ${code}，stderr=${err.slice(0, 300)}`);
  if (!completed) throw Error('turn 未完成');
  if (!seenCalls.has('exec_command')) throw Error(`未见 exec_command 工具回环: ${[...seenCalls]}`);
  if (!/v\d+\.\d+\.\d+/.test(answer)) throw Error(`最终回答不是版本号: ${answer.slice(0, 100)}`);
  console.log('真实 Codex CLI shell 工具回环通过，回答:', answer.trim().slice(0, 40));
} finally {
  await deleteKey(key.id);
  await app.close();
  await Promise.all(accountIds.map(id => releaseSlot(id)));
  fs.rmSync(dir, { recursive: true, force: true });
}
