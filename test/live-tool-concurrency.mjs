import {startToolRound,resumeToolRound} from '../src/bridge/tool-round.js';
import {listAccounts} from '../src/accounts.js';
import {releaseSlot} from '../src/bridge/pool.js';
const accountIds=listAccounts().filter(a=>a.status==='active').map(a=>a.id);
const key={id:'local-concurrency-test',group_order:null,sticky_minutes:0};
const model='GLM-5.3-Flash', tools=[{name:'get_probe_number',description:'Get the required test number',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
const start=()=>startToolRound({key,model,reasoningLevel:'low',tools,prompt:'请调用 get_probe_number 取得数字并原样回复。'});
const finish=r=>resumeToolRound({key,model,results:r.calls.map(c=>({id:c.id,output:'72831'}))});
try {
 const first=await start(); if(!first.calls.length) throw Error('首个请求未调用工具');
 let ready=false; const secondPromise=start().then(r=>{ready=true;return r});
 await new Promise(resolve=>setTimeout(resolve,1500));
 if(accountIds.length===1 && ready) throw Error('同账号繁忙时第二请求没有等待');
 const one=await finish(first); if(!one.text.includes('72831')) throw Error('首个请求未完成');
 const second=await secondPromise; if(!second.calls.length) throw Error('第二请求未调用工具');
 const two=await finish(second); if(!two.text.includes('72831')) throw Error('第二请求未完成');
 console.log('真实运行时并发等待及两次工具回环通过');
} finally {await Promise.all(accountIds.map(id=>releaseSlot(id)));}
