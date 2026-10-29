import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.ZCODE2API_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'z2a-busy-'));
const {db}=await import('../src/db.js');
const {selectAccount,waitForAvailableAccount,releaseInflight,markBusy,markAuthDead,markAccountRecovered}=await import('../src/scheduler.js');
const {BUSY_RETRY_WINDOW_MS}=await import('../src/retry.js');
const d=db();
for (const [id,role] of [['g1','primary'],['g2','backup']]) d.prepare('INSERT INTO groups(id,name,role,enabled,created_at) VALUES(?,?,?,?,?)').run(id,id,role,1,Date.now());
for (const [id,group] of [['a1','g1'],['a2','g2']]) d.prepare("INSERT INTO accounts(id,label,family,group_id,status,enc_tokens,device_mid,app_version,created_at) VALUES(?,?,?,?,'active','{}','test','test',?)").run(id,id,'bigmodel',group,Date.now());

test('优先组忙碌时选择备用组空闲账号',()=>{
 const first=selectAccount(['g1','g2'],'model'); assert.equal(first.account.id,'a1');
 const second=selectAccount(['g1','g2'],'model'); assert.equal(second.account.id,'a2'); assert.equal(second.queued,false);
 releaseInflight('a1'); releaseInflight('a2');
});
test('上游忙碌冷却后继续选择账号；失效熔断不误作忙碌',async()=>{
 assert.equal(BUSY_RETRY_WINDOW_MS,10000);
 markBusy('a1'); const start=Date.now();
 const r=await waitForAvailableAccount(['g1'],'model',{}, {timeoutMs:2500,pauseMs:20});
 assert.equal(r.account.id,'a1'); assert.ok(Date.now()-start>=200); releaseInflight('a1');
 markAccountRecovered('a1'); markBusy('a1'); markAuthDead('a1');
 const dead=await waitForAvailableAccount(['g1'],'model',{}, {timeoutMs:200,pauseMs:10});
 assert.equal(dead.account,null); assert.equal(dead.busy,false); markAccountRecovered('a1');
});
test('额度耗尽不会因短暂冷却被错误地当作忙碌重试', async () => {
 markAccountRecovered('a1'); markBusy('a1');
 d.prepare('UPDATE accounts SET last_balance=? WHERE id=?').run(JSON.stringify({data:{balances:[{remaining_units:0}]}}),'a1');
 const r=await waitForAvailableAccount(['g1'],'model',{}, {timeoutMs:200,pauseMs:10});
 assert.equal(r.account,null); assert.equal(r.busy,false);
 d.prepare('UPDATE accounts SET last_balance=NULL WHERE id=?').run('a1'); markAccountRecovered('a1');
});
