import Fastify from 'fastify';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createKey, deleteKey } from '../src/gateway/auth.js';
import { registerAnthropicRoutes } from '../src/gateway/anthropic.js';
import { releaseSlot } from '../src/bridge/pool.js';
import { listAccounts } from '../src/accounts.js';
const accountIds = listAccounts().filter(a=>a.status==='active').map(a=>a.id);
const dir = path.resolve('test/claude-fixture'); fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'marker.txt'),'Z2A_MARKER_72831\n');
fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}\n');
fs.writeFileSync(path.join(dir,'calculator.js'),'export function add(a, b) { return a - b; }\n');
fs.writeFileSync(path.join(dir,'calculator.test.js'),"import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from './calculator.js'; test('add', () => assert.equal(add(2,3),5));\n");
const app=Fastify(); let gatewayRequests=0; const seenTools=new Set();
app.addHook('onRequest', async req=>{gatewayRequests++; console.log('REQUEST',req.method,req.url)});
app.addHook('onResponse', async (req,reply)=>console.log('STATUS',reply.statusCode));
app.addHook('preHandler', async req => { for (const m of req.body?.messages || []) if (m.role === 'assistant' && Array.isArray(m.content)) for (const c of m.content) if (c.type === 'tool_use') seenTools.add(c.name); });
registerAnthropicRoutes(app);
await app.listen({port:0,host:'127.0.0.1'});
const key=createKey({name:'temporary-claude-code-test'});
const cli=process.env.Z2A_CLAUDE_BIN || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const env={...process.env,CLAUDE_CONFIG_DIR:path.join(dir,'isolated-config'),ANTHROPIC_BASE_URL:`http://127.0.0.1:${app.server.address().port}`,ANTHROPIC_API_KEY:key.secret,ANTHROPIC_AUTH_TOKEN:key.secret,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
async function runClaude(args) {
 const child=spawn(cli,args,{cwd:dir,env,stdio:['ignore','pipe','pipe']});
 let out='',err=''; child.stdout.on('data',x=>out+=x); child.stderr.on('data',x=>err+=x);
 const timer=setTimeout(()=>child.kill(),180000);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)}); clearTimeout(timer);
 let result; try { result=JSON.parse(out); } catch { throw Error(`CLI 输出无法解析，exit=${code}, stderr=${err.slice(0,500)}`); }
 if (code!==0 || result.is_error) throw Error(`CLI 失败，exit=${code}, result=${result.result}, stderr=${err.slice(0,500)}`);
 return result;
}
try {
 const common=['--bare','--print','--model','glm-5.3-flash','--tools','Read','--allowedTools','Read','--output-format','json'];
 const first=await runClaude([...common,'Read marker.txt using the Read tool and reply only with its exact contents.']);
 if (!first.result?.includes('Z2A_MARKER_72831') || gatewayRequests<2) throw Error('第一轮未通过工具回环');
 console.log('第一轮真实 Claude Code 工具读取通过');
 const before=gatewayRequests;
 const second=await runClaude([...common,'--resume',first.session_id,'What marker did you just read? Reply with the marker only.']);
 if (!second.result?.includes('Z2A_MARKER_72831') || gatewayRequests<=before) throw Error(`第二轮历史上下文失败: ${second.result}`);
 console.log('第二轮真实 Claude Code 历史上下文通过');
 const editArgs=['--bare','--print','--model','glm-5.3-flash','--tools','Read,Edit','--allowedTools','Read,Edit','--permission-mode','acceptEdits','--output-format','json','--resume',first.session_id,'Use the Edit tool to change marker.txt from Z2A_MARKER_72831 to Z2A_MARKER_72832. Only edit that file.'];
 await runClaude(editArgs);
 if (fs.readFileSync(path.join(dir,'marker.txt'),'utf8').trim() !== 'Z2A_MARKER_72832') throw Error('第三轮没有正确编辑测试文件');
 console.log('第三轮真实 Claude Code 文件编辑通过');
 const taskArgs=['--bare','--print','--model','glm-5.3-flash','--tools','Read,Edit,Bash,PowerShell','--allowedTools','Read,Edit,Bash,PowerShell','--permission-mode','bypassPermissions','--output-format','json','--resume',first.session_id,'In this test directory, read calculator.js and calculator.test.js, fix add so the test passes, then run node --test calculator.test.js. Only modify calculator.js.'];
 const task=await runClaude(taskArgs);
 const checked=spawnSync(process.execPath,['--test','calculator.test.js'],{cwd:dir,encoding:'utf8'});
 if (checked.status!==0) throw Error(`第四轮代码测试失败: ${checked.stdout} ${checked.stderr}`);
 // Claude Code 2.1.308 在 Windows 上 shell 工具名为 PowerShell（Bash 名保留给 macOS/Linux），任一出现即算通过
 if (!seenTools.has('Read') || !seenTools.has('Edit') || (!seenTools.has('Bash') && !seenTools.has('PowerShell'))) throw Error(`缺少真实客户端工具调用: ${[...seenTools]}`);
 console.log('第四轮真实 Claude Code 读取、编辑、执行测试通过');

} finally {deleteKey(key.id);await app.close();await Promise.all(accountIds.map(id=>releaseSlot(id)));}
