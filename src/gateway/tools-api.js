import { startToolRound, resumeToolRound, abandonToolRound, peekRound } from '../bridge/tool-round.js';
import { randomUuid } from '../crypto.js';
import { addKeyUsage } from './auth.js';
import { busyWaitMs } from '../retry.js';
import { logger } from '../log.js';
import { db } from '../db.js';

const log = logger('gateway-tools');

const fail = message => Object.assign(new Error(message), { status: 400, code: 'invalid_tool_request' });
export function normalizeTools(tools, protocol) {
  if (!Array.isArray(tools) || !tools.length) throw fail('工具定义不能为空');
  const names = new Set();
  const usable = [];
  const skipped = [];
  for (const raw of tools) {
    const f = protocol === 'chat' ? raw.function : raw;
    // 非 function 类型（web_search 等托管工具、namespace 多代理工具组、custom 自由工具）不支持回环，
    // 静默跳过而不是整单 400——Codex CLI 固定携带 namespace:multi_agent_v1 与 web_search，硬拒会让其所有请求失败
    if (protocol !== 'anthropic' && raw.type !== 'function') { skipped.push(`${raw.type}${raw.name ? ':' + raw.name : ''}`); continue; }
    if (f?.strict === true) throw fail('当前不支持 strict 工具参数约束');
    const name = f?.name;
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name) || names.has(name)) throw fail('工具名称无效或重复');
    names.add(name);
    const schema = protocol === 'anthropic' ? f.input_schema : f.parameters;
    if (schema && (typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object')) throw fail(`工具 ${name} 的参数 schema 必须是对象`);
    usable.push({ name, description: String(f.description || ''), inputSchema: schema || { type: 'object', properties: {} } });
  }
  if (skipped.length) log.warn(`已跳过不支持的客户端工具类型: ${skipped.join(', ')}`);
  if (!usable.length) throw fail(`没有可用的 function 工具（已跳过 ${skipped.length} 个其他类型: ${skipped.join(', ')}）——本网关仅支持 function 工具回环`);
  return usable;
}
export function parseToolRequest(body, protocol) {
  let results = [];
  if (protocol === 'chat') {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) results.unshift({ id: messages[i].tool_call_id, output: messages[i].content });
    if (!results.length && messages.at(-1)?.role === 'assistant' && (messages.at(-1)?.tool_calls?.length || messages.at(-1)?.function_call)) throw fail('末尾工具调用缺少结果');
  } else if (protocol === 'anthropic') {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1);
    if (last?.role === 'user' && Array.isArray(last.content)) {
      results = last.content.filter(c => c.type === 'tool_result').map(c => ({ id: c.tool_use_id, output: c.content, isError: !!c.is_error }));
      if (results.length && last.content.some(c => c.type !== 'tool_result')) throw fail('当前不支持工具结果和其他内容混合提交');
    }
    if (!results.length && last?.role === 'assistant' && Array.isArray(last.content) && last.content.some(c => c.type === 'tool_use')) throw fail('末尾工具调用缺少结果');
  } else {
    if (Array.isArray(body.input)) {
      for (let i = body.input.length - 1; i >= 0 && body.input[i]?.type === 'function_call_output'; i--) results.unshift({ id: body.input[i].call_id, output: body.input[i].output });
    }
    if (!results.length && Array.isArray(body.input) && body.input.at(-1)?.type === 'function_call') throw fail('末尾工具调用缺少结果');
  }
  if (results.some(r => typeof r.id !== 'string' || !r.id)) throw fail('工具结果缺少调用 ID');
  return results;
}
export function usesTools(body, protocol) {
  if (body.tools?.length || (body.tool_choice != null && body.tool_choice !== 'auto' && body.tool_choice?.type !== 'auto')) return true;
  if (protocol === 'chat') {
    const last = Array.isArray(body.messages) ? body.messages.at(-1) : null;
    return last?.role === 'tool' || last?.role === 'function' || !!last?.tool_calls?.length || !!last?.function_call;
  }
  if (protocol === 'anthropic') {
    const last = Array.isArray(body.messages) ? body.messages.at(-1) : null;
    return Array.isArray(last?.content) && last.content.some(c => c.type === 'tool_use' || c.type === 'tool_result');
  }
  const last = Array.isArray(body.input) ? body.input.at(-1) : null;
  return last?.type === 'function_call' || last?.type === 'function_call_output';
}

/**
 * 路由判定：是否走工具回合路径。
 *  - 没有待回执结果 → true（开新回合）；
 *  - 有待回执且命中本密钥的活回合 → true（resume）；
 *  - 有待回执但回合已不存在（服务重启丢失 / 客户端自答回执 / 未声明 tools 时模型调了运行时内置工具）→ false，
 *    降级为普通文本回合——工具结果按文本折叠进上下文，模型看到错误信息可自适应，而不是 400 打断整个会话。
 *  解析失败（缺调用 ID 等结构错误）→ true，仍由工具路径给出明确的 400。
 */
export function shouldUseToolRoute(key, body, protocol, model) {
  if (!usesTools(body, protocol)) return false;
  let results = [];
  try { results = parseToolRequest(body, protocol); } catch { return true; }
  if (!results.length) return true;
  const round = peekRound(results[0].id);
  return !!round && round.keyId === key.id && round.model === model && results.every((r) => peekRound(r.id) === round);
}

export async function runTools({ body, protocol, key, model, reasoningLevel, maxOutputTokens, signal }) {
  if (body.parallel_tool_calls === false || body.tool_choice?.disable_parallel_tool_use === true) throw fail('当前不支持禁止并行工具调用');
  const choice = body.tool_choice;
  if (choice && choice !== 'auto' && !(typeof choice === 'object' && choice.type === 'auto')) throw fail('当前运行时不支持强制工具选择或关闭工具');
  const results = parseToolRequest(body, protocol);
  if (results.length) return resumeToolRound({ key, model, results, signal });
  const tools = normalizeTools(body.tools, protocol);
  const payload = protocol === 'responses' ? { instructions: body.instructions || null, input: body.input } : protocol === 'anthropic' ? { system: body.system || null, messages: body.messages } : { messages: body.messages };
  return startToolRound({ key, model, reasoningLevel, maxOutputTokens, tools, prompt: JSON.stringify(payload), signal });
}
export function toolResponse(protocol, r, model, id) {
  const usage = { input: r.usage?.inputTokens ?? 0, output: r.usage?.outputTokens ?? 0 };
  if (protocol === 'chat') return { id, object: 'chat.completion', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, message: { role: 'assistant', content: r.text || null, ...(r.calls.length ? { tool_calls: r.calls.map(c => ({ id: c.id, type:'function', function:{ name:c.name, arguments:JSON.stringify(c.arguments) } })) } : {}) }, finish_reason: r.calls.length ? 'tool_calls' : 'stop' }], usage:{prompt_tokens:usage.input,completion_tokens:usage.output,total_tokens:usage.input+usage.output} };
  if (protocol === 'anthropic') return { id, type:'message', role:'assistant', model, content:[...(r.text ? [{type:'text',text:r.text}] : []), ...r.calls.map(c=>({type:'tool_use',id:c.id,name:c.name,input:c.arguments}))], stop_reason:r.calls.length ? 'tool_use' : 'end_turn', stop_sequence:null, usage:{input_tokens:usage.input,output_tokens:usage.output} };
  return { id, object:'response', created_at:Math.floor(Date.now()/1000), status:'completed', model, output:[...(r.text ? [{id:'msg_'+randomUuid(),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:r.text,annotations:[]}]}] : []), ...r.calls.map(c=>({id:'fc_'+randomUuid(),type:'function_call',call_id:c.id,name:c.name,arguments:JSON.stringify(c.arguments),status:'completed'}))], output_text:r.text || '', usage:{input_tokens:usage.input,output_tokens:usage.output,total_tokens:usage.input+usage.output} };
}
export async function handleToolRoute({ req, reply, body, protocol, key, model, reasoningLevel, maxOutputTokens, execute = runTools, onResponse }) {
  const id = (protocol === 'chat' ? 'chatcmpl-' : protocol === 'anthropic' ? 'msg_' : 'resp_') + randomUuid();
  const streaming = !!body.stream;
  let timer;
  const abortController = new AbortController();
  const onClose = () => { if (!reply.raw.writableFinished) abortController.abort(); };
  reply.raw.once?.('close', onClose);
  if (streaming) {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    timer = setInterval(() => { if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n'); }, 15000);
  }
  try {
    const result = await execute({ body, protocol, key, model, reasoningLevel, maxOutputTokens, signal: abortController.signal });
    if (reply.raw.destroyed && result.calls?.length) { await abandonToolRound(key.id, result.calls); return reply; }
    if (result.finished && result.usage) addKeyUsage(key.id, (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0));
    if (result.finished && result.accountId) {
      const u = result.usage || {};
      db().prepare(`INSERT INTO usage_log(request_id,ts,key_id,client_ip,account_id,model,reasoning_level,stream,attempt_count,status,tokens_in,tokens_out,tokens_reasoning,cache_read,cache_write) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, Date.now(), key.id, req.ip || '', result.accountId, model, reasoningLevel || null, streaming ? 1 : 0, 1, 'success', u.inputTokens ?? null, u.outputTokens ?? null, u.reasoningTokens ?? null, u.cacheReadTokens ?? null, u.cacheWriteTokens ?? null);
    }
    const response = toolResponse(protocol, result, model, id);
    onResponse?.(response);
    if (!streaming) return response;
    if (!reply.raw.writableEnded) writeToolStream(reply.raw, protocol, response);
  } catch (e) {
    const error = { message: e.message, type: ['busy', 'exhausted'].includes(e.kind) ? (protocol === 'anthropic' ? 'overloaded_error' : 'server_error') : 'invalid_request_error', code: e.code || 'tool_error' };
    if (!streaming) {
      if (e.kind === 'busy' || e.kind === 'exhausted') reply.header('retry-after', String(Math.max(1, Math.ceil(busyWaitMs() / 1000))));
      return reply.code(e.status || 502).send(protocol === 'anthropic' ? { type: 'error', error } : { error });
    }
    if (!reply.raw.writableEnded) {
      // 按协议给结构化失败事件：Responses 客户端（Codex）以 response.completed/failed 判定流完整性，
      // 只写一行 data:{error} 会被判「流提前断开」而盲目重连
      if (protocol === 'responses') {
        reply.raw.write(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', sequence_number: 0, response: { id, object: 'response', status: 'failed', error: { code: String(e.code || e.kind || 'tool_error'), message: e.message } } })}\n\n`);
      } else if (protocol === 'anthropic') {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`);
      } else {
        reply.raw.write(`data: ${JSON.stringify({ error })}\n\n`);
      }
    }
  } finally {
    if (timer) clearInterval(timer);
    reply.raw.off?.('close', onClose);
    if (streaming && !reply.raw.writableEnded) reply.raw.end();
  }
  return reply;
}
function writeToolStream(raw, protocol, response) {
  const data = value => raw.write(`data: ${JSON.stringify(value)}\n\n`);
  const event = (name, value) => raw.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  if (protocol === 'chat') {
    const base = { id:response.id, object:'chat.completion.chunk', created:response.created, model:response.model };
    const choice = response.choices[0];
    data({...base,choices:[{index:0,delta:{role:'assistant',...(choice.message.content ? {content:choice.message.content} : {})},finish_reason:null}]});
    (choice.message.tool_calls || []).forEach((call,index) => data({...base,choices:[{index:0,delta:{tool_calls:[{...call,index}]},finish_reason:null}]}));
    data({...base,choices:[{index:0,delta:{},finish_reason:choice.finish_reason}]});
    data({...base,choices:[],usage:response.usage}); raw.write('data: [DONE]\n\n'); return;
  }
  if (protocol === 'anthropic') {
    event('message_start',{type:'message_start',message:{...response,content:[],stop_reason:null,usage:{input_tokens:response.usage.input_tokens,output_tokens:0}}});
    response.content.forEach((block,index) => {
      if (block.type === 'text') {
        event('content_block_start',{type:'content_block_start',index,content_block:{type:'text',text:''}});
        event('content_block_delta',{type:'content_block_delta',index,delta:{type:'text_delta',text:block.text}});
      } else {
        event('content_block_start',{type:'content_block_start',index,content_block:{type:'tool_use',id:block.id,name:block.name,input:{}}});
        event('content_block_delta',{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}});
      }
      event('content_block_stop',{type:'content_block_stop',index});
    });
    event('message_delta',{type:'message_delta',delta:{stop_reason:response.stop_reason,stop_sequence:null},usage:{output_tokens:response.usage.output_tokens}});
    event('message_stop',{type:'message_stop'}); return;
  }
  let seq = 0; const emit = (name, value) => event(name,{type:name,sequence_number:++seq,...value});
  emit('response.created',{response:{...response,status:'in_progress',output:[]}});
  response.output.forEach((item,index) => {
    emit('response.output_item.added',{output_index:index,item:{...item,status:'in_progress',...(item.type==='function_call'?{arguments:''}:{content:[]})}});
    if (item.type === 'function_call') {
      emit('response.function_call_arguments.delta',{item_id:item.id,output_index:index,delta:item.arguments});
      emit('response.function_call_arguments.done',{item_id:item.id,output_index:index,arguments:item.arguments});
    } else {
      const part=item.content[0]; emit('response.content_part.added',{item_id:item.id,output_index:index,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
      emit('response.output_text.delta',{item_id:item.id,output_index:index,content_index:0,delta:part.text});
      emit('response.output_text.done',{item_id:item.id,output_index:index,content_index:0,text:part.text});
      emit('response.content_part.done',{item_id:item.id,output_index:index,content_index:0,part});
    }
    emit('response.output_item.done',{output_index:index,item});
  });
  emit('response.completed',{response});
}
