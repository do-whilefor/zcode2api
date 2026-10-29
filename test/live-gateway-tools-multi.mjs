import Fastify from 'fastify';
import {createKey,deleteKey} from '../src/gateway/auth.js';
import {registerAnthropicRoutes} from '../src/gateway/anthropic.js';
import {registerResponsesRoutes} from '../src/gateway/responses.js';
import {releaseSlot} from '../src/bridge/pool.js';
import {listAccounts} from '../src/accounts.js';
const activeAccountIds = listAccounts().filter(a => a.status === 'active').map(a => a.id);
const app=Fastify(); registerAnthropicRoutes(app); registerResponsesRoutes(app);
const key=createKey({name:'temporary-multiprotocol-tool-test'}), headers={authorization:`Bearer ${key.secret}`};
const desc='Get the required test number', schema={type:'object',properties:{},additionalProperties:false};
const question='请调用 get_probe_number 获取数字并原样回复，不要猜测。';
try {
 const tool={name:'get_probe_number',description:desc,input_schema:schema};
 const messages=[{role:'user',content:question}];
 let r=await app.inject({method:'POST',url:'/v1/messages',headers,payload:{model:'glm-5.3-flash',max_tokens:256,messages,tools:[tool]}});
 if(r.statusCode!==200) throw Error(`anthropic first ${r.statusCode} ${r.body}`);
 const msg=r.json(), call=msg.content.find(x=>x.type==='tool_use'); if(!call) throw Error('anthropic 没有工具调用');
 messages.push({role:'assistant',content:msg.content},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'72831'}]});
 r=await app.inject({method:'POST',url:'/v1/messages',headers,payload:{model:'glm-5.3-flash',max_tokens:256,messages,tools:[tool],stream:true}});
 if(r.statusCode!==200 || !r.body.includes('72831') || !r.body.includes('message_stop')) throw Error(`anthropic continuation ${r.body}`);
 console.log('Anthropic 工具回环及流式响应通过');
 const tools=[{type:'function',name:'get_probe_number',description:desc,parameters:schema}];
 r=await app.inject({method:'POST',url:'/v1/responses',headers,payload:{model:'glm-5.3-flash',input:question,tools}});
 if(r.statusCode!==200) throw Error(`responses first ${r.statusCode} ${r.body}`);
 const output=r.json().output.find(x=>x.type==='function_call'); if(!output) throw Error('responses 没有工具调用');
 r=await app.inject({method:'POST',url:'/v1/responses',headers,payload:{model:'glm-5.3-flash',input:[{type:'function_call_output',call_id:output.call_id,output:'72831'}],tools,stream:true}});
 if(r.statusCode!==200 || !r.body.includes('72831') || !r.body.includes('response.completed')) throw Error(`responses continuation ${r.body}`);
 console.log('Responses 工具回环及流式响应通过');
} finally {deleteKey(key.id);await app.close();await Promise.all(activeAccountIds.map(id => releaseSlot(id)));}
