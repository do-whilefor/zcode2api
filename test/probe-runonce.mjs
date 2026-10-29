// 用真实 DB 账号直接测 session.js 的 runOnce（独立进程，WAL 共存）
process.env.ZCODE2API_DATA_DIR = new URL('../data/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { runOnce } = await import('../src/bridge/session.js');
const t0 = Date.now();
try {
  const r = await runOnce('acc_0aef2f99', { prompt: '用五个字回复：你好', model: 'GLM-5.3-Flash', reasoningLevel: 'low', turnTimeoutMs: 90000 });
  console.log(`[OK ${Date.now() - t0}ms] text=${JSON.stringify(r.text)} finish=${r.finishReason} usage=${JSON.stringify(r.usage)}`);
} catch (e) {
  console.log(`[ERR ${Date.now() - t0}ms]`, e.message);
}
process.exit(0);
