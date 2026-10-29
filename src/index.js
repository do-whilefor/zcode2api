import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, config, saveRuntimeInfo } from './config.js';
import { db, audit, setSetting, getSetting } from './db.js';
import { logger } from './log.js';
import { registerAdminRoutes } from './admin/api.js';
import { registerOpenAIRoutes } from './gateway/openai.js';
import { registerAnthropicRoutes } from './gateway/anthropic.js';
import { registerResponsesRoutes } from './gateway/responses.js';
import { startPoller, stopPoller } from './poller.js';
import { startClaimScheduler, stopClaimScheduler } from './claims.js';
import { reapIdleSlots, prewarmSlots } from './bridge/pool.js';
import { listGroups } from './scheduler.js';
import { startBackupScheduler } from './ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = logger('main');

function buildApp(scope, { cors = true } = {}) {
  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024 * 1024,
    // 反代部署时信任 X-Forwarded-For，req.ip 才是真实客户端（IP 白名单/审计日志依赖）
    trustProxy: config().trust_proxy || false,
  });
  // 空 body + application/json 头不判 400（DELETE/无体 POST 的常见形态）
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '' || body === undefined || body === null) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e, undefined); }
  });
  // CORS：网关对浏览器/桌面客户端全开；管理面默认同源使用（admin_bind_public 公网部署时也不放跨域）
  if (cors) {
    app.addHook('onRequest', async (req, reply) => {
      reply.header('access-control-allow-origin', '*');
      reply.header('access-control-allow-headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta');
      reply.header('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') {
        reply.code(204);
        return reply;
      }
    });
  }
  app.get('/healthz', async () => ({ ok: true, scope, ts: Date.now() }));
  return app;
}

function ensureDefaultGroups() {
  const LEGACY = ['g_domestic', 'g_intl', 'g_backup'];
  const hasMain = !!db().prepare('SELECT 1 FROM groups WHERE id=?').get('g_main');
  const legacyPresent = LEGACY.filter((id) => db().prepare('SELECT 1 FROM groups WHERE id=?').get(id));
  // 旧版默认分组（国内池/国际池/备用池，可能被手动删得只剩部分）→ 一次性合并为单个「默认池」，账号随迁
  if (!hasMain && legacyPresent.length) {
    const now = Date.now();
    const ins = db().prepare(`INSERT INTO groups(id,name,role,family_filter,policy,urgent_window_min,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)`);
    ins.run('g_main', '默认池', 'primary', null, 'balanced', 180, 1, now);
    db().prepare(`UPDATE accounts SET group_id='g_main' WHERE group_id IN (${legacyPresent.map(() => '?').join(',')})`).run(...legacyPresent);
    db().prepare(`DELETE FROM groups WHERE id IN (${legacyPresent.map(() => '?').join(',')})`).run(...legacyPresent);
    log.info('已迁移旧默认分组 → 默认池（单分组）');
  }
  if (listGroups().length) return;
  const ins = db().prepare(`INSERT INTO groups(id,name,role,family_filter,policy,urgent_window_min,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)`);
  ins.run('g_main', '默认池', 'primary', null, 'balanced', 180, 1, Date.now());
  log.info('已创建默认分组：默认池');
}

async function main() {
  const cfg = loadConfig();
  db();
  ensureDefaultGroups();
  // 应用持久化的设置覆盖
  const overrides = getSetting('config_overrides', {});
  for (const [k, v] of Object.entries(overrides)) {
    if (k in cfg) cfg[k] = v;
    if (k === 'retry') Object.assign(cfg.retry, v || {});
  }

  const webApp = buildApp('web', { cors: false });
  await webApp.register(fastifyStatic, {
    root: path.join(__dirname, 'web'),
    prefix: '/',
    index: 'index.html',
  });
  registerAdminRoutes(webApp);

  const gwApp = buildApp('gateway');
  registerOpenAIRoutes(gwApp);
  registerAnthropicRoutes(gwApp);
  registerResponsesRoutes(gwApp);
  gwApp.setNotFoundHandler(async (req, reply) => {
    reply.code(404).send({ error: { message: `未知路径 ${req.method} ${req.url}`, type: 'invalid_request_error', code: 'not_found' } });
  });

  // 绑定分离：网关随 bind_public 公开；管理面默认只绑 host（127.0.0.1），
  // admin_bind_public:true 才随网关公开（收紧性变更：原先 bind_public 会连带公开管理面）
  const gwHost = cfg.bind_public ? '0.0.0.0' : cfg.host;
  const webHost = (cfg.bind_public && cfg.admin_bind_public) ? '0.0.0.0' : cfg.host;
  if (!fs.existsSync(cfg.runtime_bin)) {
    console.error('==============================================');
    console.error(' ZCode 运行时入口未找到：', cfg.runtime_bin);
    console.error(' 推理依赖本机 ZCode 桌面应用的 zcode.cjs。解决方法（任选其一）：');
    console.error('  1. 确认已安装 ZCode 桌面版（默认安装位会自动探测）');
    console.error('  2. config.json 配置 {"runtime_bin": "<zcode.cjs 绝对路径>"}');
    console.error('  3. 环境变量 ZCODE2API_RUNTIME_BIN=<zcode.cjs 绝对路径>');
    console.error('==============================================');
    process.exit(1);
  }
  await webApp.listen({ port: cfg.web_port || 0, host: webHost });
  await gwApp.listen({ port: cfg.gateway_port || 0, host: gwHost });
  const webPort = webApp.server.address().port;
  const gwPort = gwApp.server.address().port;
  webApp.webPort = webPort;
  webApp.gatewayPort = gwPort;
  saveRuntimeInfo({ web_port: webPort, gateway_port: gwPort, pid: process.pid });

  console.log('==============================================');
  console.log(' zcode2api 已启动');
  console.log(`  Web 控制台 : http://${webHost === '0.0.0.0' ? '127.0.0.1' : webHost}:${webPort}`);
  console.log(`  出口网关   : http://${gwHost === '0.0.0.0' ? '127.0.0.1' : gwHost}:${gwPort}/v1`);
  console.log(`  管理密码   : ${cfg.admin_password}  （已写入 data/admin-password.txt）`);
  console.log('  端口固定方法：项目根目录 config.json 配置 {"web_port":N,"gateway_port":N}（0=随机）');
  console.log('==============================================');
  log.info(`zcode2api 启动完成 web=${webPort} gateway=${gwPort}`);
  audit('system', 'startup', { web_port: webPort, gateway_port: gwPort });

  startPoller();
  startClaimScheduler();
  startBackupScheduler();
  // 运行时预热（可关）：后台拉起活跃账号槽位，首个推理请求不再吃冷启动
  if (cfg.runtime_prewarm) {
    prewarmSlots().then((n) => { if (n) log.info(`已预热 ${n} 个运行时槽位`); }).catch((e) => log.warn('预热失败', e.message));
  }
  // 全局出站代理（可选）
  if (cfg.proxy_url) {
    try {
      const { ProxyAgent, setGlobalDispatcher } = await import('undici');
      setGlobalDispatcher(new ProxyAgent(cfg.proxy_url));
      log.info('出站代理已启用', cfg.proxy_url);
    } catch (e) { log.warn('出站代理配置失败', e.message); }
  }
  const reaper = setInterval(() => { reapIdleSlots().catch((e) => log.warn('空闲回收失败', e)); }, 60 * 1000);

  const shutdown = async (sig) => {
    log.info(`收到 ${sig}，正在退出…`);
    clearInterval(reaper);
    stopPoller();
    stopClaimScheduler();
    await Promise.allSettled([webApp.close(), gwApp.close()]);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => log.error('uncaughtException', e));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
}

main().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});
