import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

/** 一次会话的客户端工具代理。调用请求停在本地，直到网关提交客户端结果。 */
export class ClientToolBroker extends EventEmitter {
  constructor(tools, { timeoutMs = 300000 } = {}) {
    super();
    this.tools = tools;
    this.timeoutMs = timeoutMs;
    this.secret = crypto.randomBytes(32).toString('hex');
    this.pending = new Map();
    this.closed = false;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }
  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    return {
      name: 'clienttools', command: process.execPath,
      args: [fileURLToPath(new URL('./client-tools-stdio.js', import.meta.url))],
      env: [{ name: 'Z2A_TOOL_BROKER_URL', value: `http://127.0.0.1:${this.server.address().port}` }, { name: 'Z2A_TOOL_BROKER_SECRET', value: this.secret }],
      isolation: 'session', alwaysLoad: true, timeoutMs: this.timeoutMs,
    };
  }
  async handle(req, res) {
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${this.secret}`) { res.writeHead(403).end(); return; }
    let chunks = [], size = 0;
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('请求过大'); chunks.push(chunk); }
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.method === 'list') return this.respond(res, 200, { tools: this.tools });
      if (message.method !== 'call' || !this.tools.some(t => t.name === message.name)) return this.respond(res, 400, { error: '未知工具' });
      if (this.closed) return this.respond(res, 410, { error: '会话已关闭' });
      const id = 'call_' + crypto.randomBytes(16).toString('hex');
      const timer = setTimeout(() => this.reject(id, '等待客户端工具结果超时'), this.timeoutMs);
      this.pending.set(id, { res, timer });
      res.on('close', () => { const p = this.pending.get(id); if (p) { clearTimeout(p.timer); this.pending.delete(id); } });
      this.emit('call', { id, name: message.name, arguments: message.arguments || {} });
    } catch { if (!res.headersSent) this.respond(res, 400, { error: '无效请求' }); }
  }
  respond(res, status, data) { if (!res.writableEnded) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data)); }
  resolve(id, output, isError = false) {
    const p = this.pending.get(id); if (!p) return false;
    this.pending.delete(id); clearTimeout(p.timer);
    this.respond(p.res, 200, { content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output ?? null) }], isError: !!isError });
    return true;
  }
  reject(id, message) {
    const p = this.pending.get(id); if (!p) return false;
    this.pending.delete(id); clearTimeout(p.timer); this.respond(p.res, 200, { content: [{ type: 'text', text: message }], isError: true }); return true;
  }
  async close() {
    this.closed = true;
    for (const id of this.pending.keys()) this.reject(id, '工具会话已关闭');
    if (this.server.listening) await new Promise(resolve => this.server.close(resolve));
  }
}
