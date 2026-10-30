import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
const claims = fs.readFileSync(new URL('../src/web/claims-view.js', import.meta.url), 'utf8');
const context = vm.createContext({ icon: () => '' });
vm.runInContext(source.slice(source.indexOf('const esc ='), source.indexOf('const fmtDur =')) +
  source.slice(source.indexOf('function filterAccounts('), source.indexOf('async function pageAccounts(')) + claims, context);

test('账号搜索覆盖完整 ID、模型和分组，筛选排序不改变原始列表', () => {
  const accounts = [
    { id: 'a', label: 'A', status: 'unverified', remaining: 10, card_expires_at: 300, group_id: 'g' },
    { id: 'b', label: 'B', status: 'active', remaining: 20, card_expires_at: 200, customer_id: '00123456789012345678', capabilities: ['GLM-5.3'] },
    { id: 'c', label: 'C', status: 'needs_relogin', remaining: null, card_expires_at: null },
  ];
  const ids = filter => Array.from(context.filterAccounts(accounts, { g: '备用池' }, { status: 'all', ...filter }), a => a.id);
  assert.deepEqual(ids({ q: '00123456789012345678' }), ['b']);
  assert.deepEqual(ids({ q: ' glm-5.3 ' }), ['b']);
  assert.deepEqual(ids({ q: '备用池' }), ['a']);
  assert.deepEqual(ids({ status: 'needs_relogin' }), ['a', 'c']);
  assert.deepEqual(ids({ sort: 'remaining' }), ['b', 'a', 'c']);
  assert.deepEqual(ids({ sort: 'expiring' }), ['b', 'a', 'c']);
  assert.deepEqual(accounts.map(a => a.id), ['a', 'b', 'c']);
});

test('待生效奖励与可领取卡分开，重复 plan_id 只保留一次', () => {
  const preview = { account_id: 'a', label: '账号', plans: [{ plan_id: 'card', name: '活动卡', entitlements: [{ grant_units: 3000000 }] }, { plan_id: 'card' }, { name: '无 ID' }] };
  assert.equal(context.claimablePlans(preview).length, 1);
  assert.equal(context.claimablePlans(preview)[0].entitlements[0].grant_units, 3000000);
  assert.equal((context.claimAccountMarkup(preview).match(/data-claim=/g) || []).length, 1);
  const pending = { pending_buckets: [{ name: 'Flash', total: 300000000, effective_at: Date.now() + 3600000 }] };
  const markup = context.claimAccountMarkup({ ...preview, plans: [] }, pending);
  assert.match(markup, /已领取 · 待生效/);
  assert.match(markup, /不计入当前可用余额/);
  assert.match(markup, /3亿/);
  assert.doesNotMatch(markup, /data-claim=/);
  assert.match(context.accountQuotaMarkup(pending), /quota-entry-pending/);
});

test('账号与领卡视图转义上游名称、ID、错误及任务内容', () => {
  const unsafe = '<img src=x onerror="alert(1)">';
  const markup = context.claimAccountMarkup({ account_id: unsafe, label: unsafe, error: unsafe,
    plans: [{ plan_id: unsafe, entitlements: [{ show_name: unsafe, unit_type: unsafe, grant_units: 1 }] }],
    incentives: { active: true, rewards: [{ title: unsafe, description: unsafe, current: 1, target: 3 }] },
  });
  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(context.accountQuotaMarkup({ quota_buckets: [{ name: unsafe, remaining: 1, total: 2 }] }), /<img/);
});

test('部分来源失败仍显示活动卡，查询失败不显示暂无可领', () => {
  const preview = { account_id: 'a', warning: '<缺少 data>', plans: [{ plan_id: 'weekend-card', name: 'Weekend Build', entitlements: [{ show_name: 'GLM-5.3-Flash', grant_units: 300000000, unit_type: 'token' }] }] };
  const markup = context.claimAccountMarkup(preview);
  assert.match(markup, /1 项可领取/);
  assert.match(markup, /3亿/);
  assert.match(markup, /data-plan="weekend-card"/);
  assert.match(markup, /部分领取来源暂不可用/);
  assert.match(markup, /&lt;缺少 data&gt;/);
  assert.doesNotMatch(markup, /暂无可领/);
  const unavailable = context.claimAccountMarkup({ account_id: 'a', error: '所有来源不可用' });
  assert.match(unavailable, /查询失败/);
  assert.doesNotMatch(unavailable, /暂无可领|data-claim=/);
  const partial = context.claimAccountMarkup({ account_id: 'a', warning: '一个来源不可用' });
  assert.match(partial, /清单不完整/);
  assert.doesNotMatch(partial, /暂无可领|data-claim=/);
});
