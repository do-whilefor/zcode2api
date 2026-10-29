// 官方运行时以 stdio 启动此进程；实际调用在主进程中等待客户端提交结果。
import readline from 'node:readline';
const brokerUrl = process.env.Z2A_TOOL_BROKER_URL;
const secret = process.env.Z2A_TOOL_BROKER_SECRET;
async function broker(body) {
  const r = await fetch(brokerUrl, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`工具桥错误 HTTP ${r.status}`);
  return r.json();
}
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let req;
  try {
    req = JSON.parse(line);
    if (req.id === undefined) return;
    let result;
    if (req.method === 'initialize') result = { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'z2a-client-tools', version: '1' } };
    else if (req.method === 'tools/list') result = await broker({ method: 'list' });
    else if (req.method === 'tools/call') result = await broker({ method: 'call', name: req.params.name, arguments: req.params.arguments });
    else if (req.method === 'ping') result = {};
    else return send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
    send({ jsonrpc: '2.0', id: req.id, result });
  } catch (e) { if (req?.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: e.message } }); }
});
