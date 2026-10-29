import { sha256Hex, randomHex } from '../crypto.js';
import { config } from '../config.js';
import { db, audit } from '../db.js';

const sessions = new Map(); // token -> { expiresAt }
const TTL = 7 * 24 * 3600 * 1000;

export function verifyPassword(password) {
  const cfg = config();
  return typeof password === 'string' && password.length > 0 && sha256Hex(password) === sha256Hex(cfg.admin_password);
}

export function createSession() {
  const token = randomHex(24);
  sessions.set(token, { expiresAt: Date.now() + TTL });
  return token;
}

export function checkSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return false; }
  return true;
}

export function revokeSession(token) { sessions.delete(token); }

export function adminAuthHook(req, reply, done) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.query && req.query.token) || '';
  if (checkSession(token)) return done();
  reply.code(401).send({ ok: false, error: '未登录或会话过期' });
}
