import Fastify from 'fastify';
import {createKey,deleteKey} from '../src/gateway/auth.js';
import {registerOpenAIRoutes} from '../src/gateway/openai.js';
import {releaseSlot} from '../src/bridge/pool.js';
import {listAccounts} from '../src/accounts.js';
const activeAccountIds = listAccounts().filter(a => a.status === 'active').map(a => a.id);
const app=Fastify(); registerOpenAIRoutes(app);
const key=createKey({name:'temporary-tool-loop-test'});
const headers={authorization:`Bearer ${key.secret}`};
const tools=[{type:'function',function:{name:'get_probe_number',description:'Get a required test number',parameters:{type:'object',properties:{},additionalProperties:false}}}];
const messages=[{role:'user',content:'请调用 get_probe_number 获取数字并原样回复，不要猜测。'}];
try {
 const first=await app.inject({method:'POST',url:'/v1/chat/completions',headers,payload:{model:'glm-5.3-flash',messages,tools}});
 if(first.statusCode!==200) throw Error(`first HTTP ${first.statusCode}: ${first.body}`);
 const message=first.json().choices[0].message;
 if(!message.tool_calls?.length) throw Error('模型没有调用工具');
 messages.push(message,...message.tool_calls.map(c=>({role:'tool',tool_call_id:c.id,content:'72831'})));
 const second=await app.inject({method:'POST',url:'/v1/chat/completions',headers,payload:{model:'glm-5.3-flash',messages,tools}});
 if(second.statusCode!==200) throw Error(`second HTTP ${second.statusCode}: ${second.body}`);
 const text=second.json().choices[0].message.content;
 if(!text?.includes('72831')) throw Error('工具结果没有进入最终回复');
 console.log('网关工具调用和结果回传通过');
} finally {deleteKey(key.id);await app.close();await Promise.all(activeAccountIds.map(id => releaseSlot(id)));}
