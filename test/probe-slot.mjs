// 直接用 RuntimeSlot 复现 openSession 的调用序列，验证事件是否到达通知处理器
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { RuntimeSlot } from '../src/bridge/runtime.js';

function enc(v, secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return 'enc:v1:' + iv.toString('base64url') + '.' + c.getAuthTag().toString('base64url') + '.' + ct.toString('base64url');
}

const MASTER = 'test-master-secret';
process.env.ZCODE2API_DATA_DIR = 'D:/tmp-zc-slot-test';
fs.rmSync('D:/tmp-zc-slot-test', { recursive: true, force: true });
fs.mkdirSync(path.join(process.env.ZCODE2API_DATA_DIR, 'logs'), { recursive: true });
fs.writeFileSync(path.join(process.env.ZCODE2API_DATA_DIR, 'secret.key'), MASTER);

const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode/v2/credentials.json'), 'utf8'));
const fb = 'zcode-credential-fallback:' + process.platform + ':' + os.homedir() + ':' + os.userInfo().username;
const okey = crypto.createHash('sha256').update(fb).digest();
const parts = raw['zcodejwttoken'].slice(7).split('.');
const d2 = crypto.createDecipheriv('aes-256-gcm', okey, Buffer.from(parts[0], 'base64url'));
d2.setAuthTag(Buffer.from(parts[1], 'base64url'));
const jwt = Buffer.concat([d2.update(Buffer.from(parts[2], 'base64url')), d2.final()]).toString('utf8');

const slot = new RuntimeSlot({
  id: 'acc_test',
  family: 'bigmodel',
  device_mid: '30dec1a8-ee37-4d3e-beac-d3420b184bcc',
  customer_id: '85291792743088907',
  tokens: { zcode_jwt: jwt },
});

const seen = [];
slot.onNotification((msg) => {
  const m = String(msg.method);
  if (m.startsWith('startup/') || m.startsWith('process/')) return;
  seen.push(m);
  if (m === 'session/event') {
    console.log('[EVT]', msg.params?.type, 'kind=' + msg.params?.payload?.kind, JSON.stringify(msg.params?.payload).slice(0, 130));
  } else if (!m.startsWith('v4/') && m !== 'computer-use/operation-event') {
    console.log('[NOTIF]', m, msg.id ?? '');
  }
});

await slot.start();
console.log('--- slot ready ---');
const created = await slot.request('session/create', {
  workspace: { workspacePath: slot.workspaceDir, workspaceKey: 'acc_test-bridge' },
  model: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } },
  thoughtLevel: 'low',
  mode: 'yolo',
}, { timeoutMs: 60000 });
console.log('CREATE RESP keys:', Object.keys(created)); console.log('sessionId field:', created.sessionId, '| session?.sessionId:', created.session?.sessionId, '| id:', created.id); const sessionId = created?.sessionId || created?.session?.sessionId || created?.id;
console.log('--- session', sessionId);
await slot.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, { timeoutMs: 15000 });
console.log('--- subscribed ---');
const t0 = Date.now();
await slot.request('session/send', { sessionId, content: '用五个字回复：你好' }, { timeoutMs: 120000 });
console.log(`--- send accepted (${Date.now() - t0}ms)，等待事件… ---`);
setTimeout(() => {
  console.log(`--- ${Date.now() - t0}ms 后结束；session/event 收到 ${seen.filter((m) => m === 'session/event').length} 条 ---`);
  slot.stop().catch(() => {});
  process.exit(0);
}, 30000);
