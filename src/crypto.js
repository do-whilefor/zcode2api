import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from './config.js';

// 与官方 credentialCipherProvider 相同的封装格式：enc:v1: + b64url(IV12) + '.' + b64url(tag16) + '.' + b64url(ct)
const PREFIX = 'enc:v1:';

let masterSecret = null;

export function masterSecretString() {
  if (masterSecret) return masterSecret;
  const f = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(f)) {
    masterSecret = fs.readFileSync(f, 'utf8').trim();
  } else {
    masterSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, masterSecret, { mode: 0o600 });
  }
  return masterSecret;
}

function keyFromSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

export function encrypt(plaintext, secret = masterSecretString()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64url') + '.' + tag.toString('base64url') + '.' + ct.toString('base64url');
}

export function decrypt(enc, secret = masterSecretString()) {
  if (!enc || !enc.startsWith(PREFIX)) return enc; // 明文直通（本机导入前的原始值）
  const [ivB, tagB, ctB] = enc.slice(PREFIX.length).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromSecret(secret), Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
}

export function officialFallbackSecret() {
  let username = 'unknown';
  try { username = os.userInfo().username; } catch { /* 容器等环境取不到 */ }
  return `zcode-credential-fallback:${process.platform}:${os.homedir()}:${username}`;
}

export function decryptOfficial(value) {
  return decrypt(value, officialFallbackSecret());
}

export function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomUuid() {
  return crypto.randomUUID();
}
