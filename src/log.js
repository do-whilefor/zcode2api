import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const LOG_DIR = path.join(DATA_DIR, 'logs');
let stream = null;

function ensureStream() {
  if (!stream) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(path.join(LOG_DIR, 'app.log'), { flags: 'a' });
  }
  return stream;
}

function fmt(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function emit(level, scope, args) {
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${args.map(fmt).join(' ')}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try { ensureStream().write(line + '\n'); } catch { /* 日志盘满不阻断业务 */ }
}

export function logger(scope) {
  return {
    debug: (...a) => { if (process.env.ZCODE2API_DEBUG) emit('debug', scope, a); },
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
  };
}
