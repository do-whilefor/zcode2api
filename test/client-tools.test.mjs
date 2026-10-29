import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientToolBroker } from '../src/bridge/client-tools.js';

test('会话工具调用等待结果，隔离密钥，拒绝重复提交', async () => {
  const broker = new ClientToolBroker([{ name: 'lookup', inputSchema: { type: 'object' } }], { timeoutMs: 10000 });
  const spec = await broker.start();
  const env = Object.fromEntries(spec.env.map(e => [e.name, e.value]));
  const send = (secret, body) => fetch(env.Z2A_TOOL_BROKER_URL, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
  try {
    assert.equal((await send('wrong', { method: 'list' })).status, 403);
    assert.equal((await send(env.Z2A_TOOL_BROKER_SECRET, { method: 'call', name: 'other' })).status, 400);
    const call = new Promise(resolve => broker.once('call', resolve));
    const pending = send(env.Z2A_TOOL_BROKER_SECRET, { method: 'call', name: 'lookup', arguments: { query: 'abc' } });
    const event = await call;
    assert.deepEqual(event.arguments, { query: 'abc' });
    assert.equal(broker.resolve(event.id, 'found'), true);
    assert.equal(broker.resolve(event.id, 'again'), false);
    assert.equal((await (await pending).json()).content[0].text, 'found');
  } finally { await broker.close(); }
});

test('关闭会话使等待中的工具调用失败', async () => {
  const broker = new ClientToolBroker([{ name: 'lookup', inputSchema: { type: 'object' } }]);
  const spec = await broker.start(); const env = Object.fromEntries(spec.env.map(e => [e.name, e.value]));
  const event = new Promise(resolve => broker.once('call', resolve));
  const result = fetch(env.Z2A_TOOL_BROKER_URL, { method: 'POST', headers: { authorization: `Bearer ${env.Z2A_TOOL_BROKER_SECRET}` }, body: JSON.stringify({ method: 'call', name: 'lookup' }) });
  await event; await broker.close();
  assert.equal((await (await result).json()).isError, true);
});
import { spawn } from 'node:child_process';
import readline from 'node:readline';

test('MCP 子进程发现工具并把结果交回运行时', async () => {
  const broker = new ClientToolBroker([{ name: 'lookup', description: 'find', inputSchema: { type: 'object' } }]);
  const spec = await broker.start();
  const proc = spawn(spec.command, spec.args, { env: { ...process.env, ...Object.fromEntries(spec.env.map(e => [e.name, e.value])) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  readline.createInterface({ input: proc.stdout }).on('line', line => { const m = JSON.parse(line); replies.get(m.id)?.(m); });
  const request = (id, method, params = {}) => new Promise(resolve => { replies.set(id, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try {
    assert.equal((await request(1, 'initialize', { protocolVersion: '2025-03-26' })).result.serverInfo.name, 'z2a-client-tools');
    assert.equal((await request(2, 'tools/list')).result.tools[0].name, 'lookup');
    const call = new Promise(resolve => broker.once('call', resolve));
    const result = request(3, 'tools/call', { name: 'lookup', arguments: { q: 'hello' } });
    const event = await call; broker.resolve(event.id, 'answer');
    assert.equal((await result).result.content[0].text, 'answer');
  } finally { proc.kill(); await broker.close(); }
});
import { EventEmitter } from 'node:events';
import { ToolRound } from '../src/bridge/tool-round.js';

test('工具轮次把结果送回同一个会话并拒绝跨密钥与重复结果', async () => {
  class Broker extends EventEmitter {
    async close() { this.closed = true; }
    resolve(id, output) { if (id !== 'call-1') return false; this.output = output; setImmediate(() => events.push({type:'text_delta',text:'完成'})); setImmediate(() => events.push({type:'finish',usage:{outputTokens:1}})); return true; }
  }
  const queue = [], waiters = [];
  const events = { push(x) { const w = waiters.shift(); if (w) w({value:x,done:false}); else queue.push(x); }, [Symbol.asyncIterator]() { return this; }, next() { return queue.length ? Promise.resolve({value:queue.shift(),done:false}) : new Promise(resolve => waiters.push(resolve)); } };
  const broker = new Broker(); let closes = 0;
  const session = { events, async send() { setImmediate(() => broker.emit('call',{id:'call-1',name:'lookup',arguments:{}})); }, async close() { closes++; } };
  const round = new ToolRound({ broker, session, keyId:'key-a', accountId:'acc', model:'model', onClose:()=>{} });
  const first = await round.start('hi'); assert.equal(first.calls[0].id, 'call-1');
  await assert.rejects(round.resume('key-b', [{id:'call-1',output:'secret'}]));
  await assert.rejects(round.resume('key-a', [{id:'call-1',output:'x'},{id:'call-1',output:'y'}]));
  const last = await round.resume('key-a', [{id:'call-1',output:'result'}]);
  assert.equal(last.text, '完成'); assert.equal(last.finished, true); assert.equal(broker.output, 'result'); assert.equal(closes, 1);
});
import { normalizeTools, parseToolRequest, toolResponse, handleToolRoute } from '../src/gateway/tools-api.js';

test('三个协议的工具定义和结果保留调用 ID 与参数', () => {
  const schema = {type:'object',properties:{q:{type:'string'}}};
  for (const [protocol, tools] of [['chat',[{type:'function',function:{name:'find',parameters:schema}}]], ['anthropic',[{name:'find',input_schema:schema}]], ['responses',[{type:'function',name:'find',parameters:schema}]]]) {
    assert.deepEqual(normalizeTools(tools, protocol)[0].inputSchema, schema);
    const r = toolResponse(protocol,{calls:[{id:'call-1',name:'find',arguments:{q:'x'}}],text:'',usage:null},'model','id');
    const call = protocol === 'chat' ? r.choices[0].message.tool_calls[0] : protocol === 'anthropic' ? r.content[0] : r.output[0];
    assert.equal(protocol === 'responses' ? call.call_id : call.id, 'call-1');
  }
  assert.equal(parseToolRequest({messages:[{role:'tool',tool_call_id:'call-1',content:'x'}]},'chat')[0].id,'call-1');
  assert.equal(parseToolRequest({messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'call-1',content:'x'}]}]},'anthropic')[0].id,'call-1');
  assert.equal(parseToolRequest({input:[{type:'function_call_output',call_id:'call-1',output:'x'}]},'responses')[0].id,'call-1');
});

test('三个协议流式输出包含工具调用与正确结束事件', async () => {
  for (const protocol of ['chat','anthropic','responses']) {
    let chunks = '';
    const raw = { writableEnded:false, writeHead() {}, write(s) { chunks += s; }, end() { this.writableEnded=true; } };
    const reply = { raw };
    await handleToolRoute({req:{},reply,body:{stream:true},protocol,key:{id:'test'},model:'m',execute:async()=>({calls:[{id:'call-1',name:'find',arguments:{q:'x'}}],text:'',finished:false,usage:null})});
    assert.match(chunks,/call-1/); assert.match(chunks,/find/);
    assert.match(chunks, protocol === 'chat' ? /\[DONE\]/ : protocol === 'anthropic' ? /message_stop/ : /response.completed/);
  }
});

test('新用户消息允许之前完整工具历史，并拒绝末尾缺少工具结果', () => {
  const anthropic = {messages:[{role:'assistant',content:[{type:'tool_use',id:'old',name:'f',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'old',content:'x'}]},{role:'assistant',content:'完成'},{role:'user',content:'继续'}]};
  assert.deepEqual(parseToolRequest(anthropic,'anthropic'),[]);
  assert.deepEqual(parseToolRequest({messages:[{role:'assistant',tool_calls:[{id:'old'}]},{role:'tool',tool_call_id:'old',content:'x'},{role:'assistant',content:'完成'},{role:'user',content:'继续'}]},'chat'),[]);
  assert.deepEqual(parseToolRequest({input:[{type:'function_call',call_id:'old'},{type:'function_call_output',call_id:'old',output:'x'},{role:'user',content:'继续'}]},'responses'),[]);
  assert.throws(()=>parseToolRequest({messages:[{role:'assistant',content:[{type:'tool_use',id:'old'}]}]},'anthropic'),/缺少结果/);
});

test('没有新工具或待处理结果时，历史工具调用不触发新工具会话', async () => {
  const {usesTools}=await import('../src/gateway/tools-api.js');
  const messages=[{role:'assistant',content:[{type:'tool_use',id:'old'}]},{role:'user',content:[{type:'tool_result',tool_use_id:'old'}]},{role:'assistant',content:'完成'},{role:'user',content:'继续'}];
  assert.equal(usesTools({messages},'anthropic'),false);
  assert.equal(usesTools({messages,tools:[{name:'Read'}]},'anthropic'),true);
});
import {waitForAvailableAccount} from '../src/scheduler.js';

test('账号忙碌时等待空闲，排队探测不会泄漏并发计数', async () => {
  const id='test-scheduler-wait', state={inflight:1,queueWaiters:0};
  const release=()=>{state.inflight=Math.max(0,state.inflight-1)}; const undoQueue=()=>{state.queueWaiters--};
  let attempts=0;
  const select=()=>{attempts++; const queued=state.inflight>0; if(queued) state.queueWaiters++; state.inflight++; return {account:{id},queued};};
  setTimeout(release,25);
  const result=await waitForAvailableAccount([], 'model', {}, {select,release,undoQueue,pauseMs:10,timeoutMs:500});
  assert.equal(result.queued,false); assert.ok(attempts>1); assert.equal(state.inflight,1); assert.equal(state.queueWaiters,0);
  release();
});

test('等待中的账号请求可取消并释放排队计数', async () => {
  const id='test-scheduler-abort', state={inflight:1,queueWaiters:0};
  const release=()=>{state.inflight=Math.max(0,state.inflight-1)}; const undoQueue=()=>{state.queueWaiters--};
  const select=()=>{state.inflight++;state.queueWaiters++;return {account:{id},queued:true};};
  const controller=new AbortController(); setTimeout(()=>controller.abort(),10);
  await assert.rejects(waitForAvailableAccount([], 'm', {}, {select,release,undoQueue,pauseMs:1000,signal:controller.signal}),/断开/);
  assert.equal(state.inflight,1); assert.equal(state.queueWaiters,0); release();
});

test('工具会话关闭时，等待模型响应的请求立即结束', async () => {
  const broker=new EventEmitter(); broker.close=async()=>{};
  const session={events:{async *[Symbol.asyncIterator]() { await new Promise(()=>{}); }},send:async()=>{},close:async()=>{}};
  const round=new ToolRound({broker,session,keyId:'k',accountId:'a',model:'m'});
  const pending=round.start('prompt');
  await new Promise(resolve=>setTimeout(resolve,10)); await round.close();
  await assert.rejects(pending,/已关闭/);
});

test('冷却中的忙碌账号继续重试，而真正不可用的账号立即失败', async () => {
  let attempts=0;
  const select=()=>++attempts<3 ? {account:null,busy:true} : {account:{id:'ready'},queued:false};
  const r=await waitForAvailableAccount([], 'm', {}, {select,pauseMs:10,timeoutMs:200});
  assert.equal(r.account.id,'ready'); assert.equal(attempts,3); assert.ok(r.busySince <= Date.now());
  let count=0;
  const unavailable=await waitForAvailableAccount([], 'm', {}, {select:()=>{count++;return {account:null,busy:false}},pauseMs:10,timeoutMs:200});
  assert.equal(unavailable.account,null); assert.equal(count,1);
  const timed=await waitForAvailableAccount([], 'm', {}, {select:()=>({account:null,busy:true}),pauseMs:10,timeoutMs:35});
  assert.equal(timed.busyTimeout,true);
});

import { startToolRound } from '../src/bridge/tool-round.js';
test('工具会话在上游忙碌时重试，成功后停止；持续忙碌会到期', async () => {
  async function run(alwaysBusy) {
    let attempts=0, marked=0;
    const dependencies={
      busyWindowMs:260,resultTimeoutSec:60,getChain:()=>[],
      waitFor:async()=>({account:{id:'retry-test'}}),
      setBusy:()=>{marked++},
      makeBroker:()=>{const broker=new EventEmitter();broker.start=async()=>({});broker.close=async()=>{};return broker;},
      open:async()=>{const busy=alwaysBusy || ++attempts===1; if(alwaysBusy) attempts++;
        let trigger; const ready=new Promise(resolve=>{trigger=resolve});
        return {slot:{toolLeases:0},events:{async *[Symbol.asyncIterator](){await ready;yield busy ? {type:'error',code:3008,message:'busy'} : {type:'finish',usage:{}};}},send:async()=>trigger(),close:async()=>{}};
      }
    };
    const options={key:{id:'k'},model:'m',tools:[{name:'x'}],prompt:'hello',dependencies};
    if(alwaysBusy) {await assert.rejects(startToolRound(options),e=>e.code==='account_busy' && e.status===529);assert.ok(attempts>=2);}
    else {const r=await startToolRound(options);assert.equal(r.finished,true);assert.equal(attempts,2);assert.equal(marked,1);}
  }
  await run(false); await run(true);
});


test('排队后上游仍忙碌，共用同一个重试时间窗口', async () => {
  let attempts=0;
  const dependencies={busyWindowMs:300,resultTimeoutSec:60,getChain:()=>[],
    waitFor:async()=>({account:{id:'retry-window'},busySince:Date.now()-270}),setBusy:()=>{},
    makeBroker:()=>{const b=new EventEmitter();b.start=async()=>({});b.close=async()=>{};return b;},
    open:async()=>{attempts++;let trigger;const ready=new Promise(r=>{trigger=r});return {slot:{toolLeases:0},events:{async *[Symbol.asyncIterator](){await ready;yield {type:'error',code:3008,message:'busy'};}},send:async()=>trigger(),close:async()=>{}};}
  };
  const start=Date.now();
  await assert.rejects(startToolRound({key:{id:'k'},model:'m',tools:[{name:'x'}],prompt:'x',dependencies}),e=>e.code==='account_busy');
  assert.equal(attempts,1); assert.ok(Date.now()-start<220);
});

test('工具调用已经输出后视为可见，不能安全重放', async () => {
  const {isVisibleToken}=await import('../src/retry.js');
  assert.equal(isVisibleToken({type:'tool_call'}),true);
  assert.equal(isVisibleToken({type:'text_delta',text:''}),false);
});

test('工具请求持续忙碌时向 Claude 返回 overloaded_error', async () => {
  const raw={writableEnded:false,writeHead(){},write(){},end(){this.writableEnded=true;}};
  const reply={raw,status:null,body:null,code(v){this.status=v;return this;},header(){return this;},send(v){this.body=v;return this;}};
  const execute=async()=>{throw Object.assign(new Error('账号忙碌'),{kind:'busy',status:529,code:'account_busy'});};
  await handleToolRoute({req:{},reply,body:{},protocol:'anthropic',key:{id:'k'},model:'m',execute});
  assert.equal(reply.status,529); assert.equal(reply.body.error.type,'overloaded_error');
});
