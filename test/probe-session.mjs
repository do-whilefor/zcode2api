// 会话流活体探测：观察 session/send 前后运行时向宿主发起的全部交互
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function enc(v, secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return 'enc:v1:' + iv.toString('base64url') + '.' + c.getAuthTag().toString('base64url') + '.' + ct.toString('base64url');
}

const MASTER = 'test-master-secret';
const base = 'D:/tmp-zc-probe-slot';
const BUILTIN = 'D:/Users/Acer/AppData/Local/Programs/ZCode/resources/config/provider/zcode-builtin.json';
const builtin = JSON.parse(fs.readFileSync(BUILTIN, 'utf8'));
const pathHash = crypto.createHash('sha256').update(path.resolve(BUILTIN)).digest('hex');
const basedOn = 'zcode-builtin:' + builtin.revision + ':' + pathHash;

const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode/v2/credentials.json'), 'utf8'));
const fb = 'zcode-credential-fallback:' + process.platform + ':' + os.homedir() + ':' + os.userInfo().username;
const okey = crypto.createHash('sha256').update(fb).digest();
const parts = raw['zcodejwttoken'].slice(7).split('.');
const d2 = crypto.createDecipheriv('aes-256-gcm', okey, Buffer.from(parts[0], 'base64url'));
d2.setAuthTag(Buffer.from(parts[1], 'base64url'));
const jwt = Buffer.concat([d2.update(Buffer.from(parts[2], 'base64url')), d2.final()]).toString('utf8');

fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base + '/.zcode/v2', { recursive: true });
fs.writeFileSync(base + '/.zcode/v2/credentials.json', JSON.stringify({
  zcodejwttoken: enc(jwt, MASTER),
  'oauth:active_provider': enc('bigmodel', MASTER),
  'account-provider:account:bigmodel-start-plan:identity': enc('85291792743088907', MASTER),
  'account-provider:account:bigmodel-start-plan:auth-source': enc('oauth', MASTER),
}));
fs.writeFileSync(base + '/.zcode/v2/provider_config.json', JSON.stringify({ schemaVersion: 1, config: { providerOrder: [], providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [] } } }));
fs.mkdirSync(base + '/workspace', { recursive: true });

const p = spawn('node', ['D:/Users/Acer/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs', 'app-server', '--surface', 'terminal'], {
  cwd: base + '/workspace',
  env: {
    ...process.env,
    ZCODE_DATA_BASE_DIR: base, ZCODE_STORAGE_DIR: base + '/.zcode', ZCODE_CREDENTIAL_SECRET: MASTER,
    ZCODE_TELEMETRY_DEVICE_MID: '30dec1a8-ee37-4d3e-beac-d3420b184bcc',
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: BUILTIN,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: base + '/.zcode/v2/provider_config.json',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
let sessionId = null;
let mainTurnSeen = false;
p.stdout.setEncoding('utf8');
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.method) {
      const m = o.method;
      if (m.startsWith('startup/') || m.startsWith('process/')) continue;
      if (m === 'session/event') { const p = o.params || {}; const pk = Object.keys(p); console.log('[EVT]', 'paramsKeys=' + pk.join(','), 'type=' + p.type, 'kind=' + p.payload?.kind, 'event=' + p.event, 'seq=' + p.seq); }
      console.log(`[HOST-REQ] ${m} id=${o.id} ${JSON.stringify(o.params || {}).slice(0, 260)}`);
      let result = {};
      if (m === 'session/requestRuntimePreferences') result = { nativeSearchEnhancementsEnabled: false, toolSearchMode: 'off', memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' };
      else if (m === 'interaction/requestProviderRuntimeHeaders') result = { headersApplied: true, requestAuth: { apiKey: jwt, headers: { authorization: 'Bearer ' + jwt } } };
      else if (m === 'interaction/requestOfficialMcpAuthHeaders') result = { ok: true, headers: {} };
      else if (m === 'interaction/requestPermission') result = { decision: 'allow' };
      else if (m === 'workspace/readPresentation') result = {};
      if (o.id !== undefined) p.stdin.write(JSON.stringify({ id: o.id, result }) + '\n');
      continue;
    }
    if (o.id === 2 && o.result) {
      sessionId = o.result.sessionId || o.result.session?.sessionId || o.result.id;
      send({ id: 9, method: 'session/subscribe', params: { sessionId, deliveryKind: 'desktop-continuous' } });
      console.log('[SESSION]', sessionId, JSON.stringify(o.result).slice(0, 200));
    }
    if (o.id === 3) {
      console.log('[SEND-RESP]', o.error ? 'ERROR ' + JSON.stringify(o.error).slice(0, 260) : 'OK ' + JSON.stringify(o.result).slice(0, 200));
      mainTurnSeen = true;
    }
    if (o.id !== undefined && o.id > 3) console.log(`[RESP ${o.id}]`, o.error ? 'ERROR ' + JSON.stringify(o.error).slice(0, 260) : 'OK ' + JSON.stringify(o.result).slice(0, 200));
  }
});
p.stderr.setEncoding('utf8');
p.stderr.on('data', (d) => console.log('[STDERR]', d.trim().slice(0, 200)));

function send(o) { p.stdin.write(JSON.stringify(o) + '\n'); }

setTimeout(() => send({ id: 1, method: 'provider/updateAccountConfig', params: { revision: '1', basedOnZCodeBuiltinRevision: basedOn, providers: { 'account:bigmodel-start-plan': { builtinModelIds: ['GLM-5.3-Flash'], access: { type: 'zhipu-account', entitled: true } } }, states: { 'account:bigmodel-start-plan': { availability: 'available', entitled: true, current: true } } } }), 1200);
setTimeout(() => send({ id: 2, method: 'session/create', params: { workspace: { workspacePath: base + '/workspace', workspaceKey: 'probe' }, model: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } }, thoughtLevel: 'low', mode: 'yolo' } }), 3000);
const sendTimer = setInterval(() => {
  if (sessionId) {
    clearInterval(sendTimer);
    console.log('--- session/send ---');
    send({ id: 3, method: 'session/send', params: { sessionId, content: '用五个字回复：你好' } });
    setTimeout(() => { console.log('--- done (120s) ---'); p.kill(); process.exit(0); }, 120000);
  }
}, 300);
