import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';
import { logger } from './log.js';

const log = logger('http');

// 出站请求体 gzip 阈值（借鉴 workbuddy issue #297：窄出口带宽下 3MB 上下文省 20s+ 首字节；
// 低于 64KB 不压，短请求零开销）
const GZIP_THRESHOLD = 64 * 1024;

export class CookieJar {
  constructor(storePath) {
    this.storePath = storePath;
    this.map = new Map();
    try {
      if (fs.existsSync(storePath)) {
        for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(storePath, 'utf8')))) this.map.set(k, v);
      }
    } catch { /* 损坏则重建 */ }
  }
  /** 从响应头捕获 Set-Cookie */
  capture(response) {
    const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    let changed = false;
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(sc)) { this.map.delete(name); } else { this.map.set(name, value); }
      changed = true;
    }
    if (changed) this.persist();
    return changed;
  }
  header() {
    if (!this.map.size) return undefined;
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  persist() {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(Object.fromEntries(this.map)));
    } catch (e) { log.warn('cookie jar 落盘失败', e.message); }
  }
}

const ZCODE_ORIGIN = 'https://zcode.z.ai';

export function platformKey() { return `${process.platform}-${process.arch}`; }

const dispatcherCache = new Map();
export function proxyDispatcherFor(proxyUrl) {
  const url = String(proxyUrl || '').trim();
  if (!url) return undefined;
  if (dispatcherCache.has(url)) return dispatcherCache.get(url);
  if (!/^https?:\/\//i.test(url)) {
    log.warn('出站代理仅支持 http(s):// 前缀，已忽略:', url);
    return undefined;
  }
  return import('undici').then(({ ProxyAgent }) => {
    const d = new ProxyAgent(url);
    dispatcherCache.set(url, d);
    return d;
  }).catch((e) => {
    log.warn('出站代理初始化失败', url, e.message);
    return undefined;
  });
}

/**
 * 统一出站请求。
 * opts: { url, method, headers, body(JSON obj), jar, timeoutMs, bearer, rawBody, dispatcher }
 * 返回 { status, ok, headers, json, text, dateHeader }
 */
export async function request(opts) {
  const cfg = config();
  const headers = {
    'User-Agent': `ZCode/${cfg.app_version}`,
    'X-ZCode-App-Version': cfg.app_version,
    'X-Platform': platformKey(),
    'X-Client-Language': 'zh-CN',
    ...(opts.headers || {}),
  };
  if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
  if (opts.jar) {
    const ch = opts.jar.header();
    if (ch) headers['Cookie'] = ch;
  }
  let body;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  } else if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  }
  // 大请求体 gzip：省的是本机出口带宽（长上下文场景首字节明显提前）
  if (body !== undefined && Buffer.byteLength(body) > GZIP_THRESHOLD) {
    body = zlib.gzipSync(Buffer.from(body));
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    headers['Content-Encoding'] = 'gzip';
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), opts.timeoutMs || 20000);
  let res;
  const started = Date.now();
  try {
    res = await fetch(opts.url, {
      method: opts.method || 'GET', headers, body, signal: ctrl.signal, redirect: 'manual',
      ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
  if (opts.jar) opts.jar.capture(res);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON（WAF HTML 等） */ }
  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    dateHeader: res.headers.get('date'),
    json,
    text,
    elapsedMs: Date.now() - started,
  };
}

export function zcodeUrl(pathname, query) {
  const u = new URL(ZCODE_ORIGIN + pathname);
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
  return u.toString();
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}
