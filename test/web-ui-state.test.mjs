import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ URLSearchParams });
vm.runInContext(fs.readFileSync(new URL('../src/web/ui-state.js', import.meta.url), 'utf8'), context);
const ui = context.Z2AUI;

test('页面链接保留中文搜索与筛选参数，无效页面返回仪表盘', () => {
  const route = ui.readRoute(ui.routeHash('accounts', { q: '默认池 & GLM', status: 'active' }));
  assert.equal(route.page, 'accounts');
  assert.equal(route.query.q, '默认池 & GLM');
  assert.equal(route.query.status, 'active');
  assert.equal(ui.readRoute('#/unknown').page, 'dashboard');
  assert.equal(ui.readRoute('').page, 'dashboard');
});

test('连续时间轴补齐跨日空时段，保留范围首尾的部分时段', () => {
  const end = Date.parse('2026-10-30T00:30:00+08:00');
  const timeline = ui.usageTimeline({ hours: 24, time_unit: 'hour', utc_offset_minutes: 480, range_end: end, range_start: end - 86400000,
    byHour: [{ bucket: '2026-10-29T23:00:00', reqs: 8, ok: 6, tin: 100, tout: 20 }] });
  assert.equal(timeline.rows.length, 25);
  assert.equal(timeline.rows[0].bucket, '2026-10-29T00:00:00');
  assert.equal(timeline.rows.at(-1).bucket, '2026-10-30T00:00:00');
  assert.equal(timeline.rows.filter(r => r.reqs === 0).length, 24);
  assert.equal(timeline.rows.find(r => r.reqs).tokens, 120);
  assert.equal(timeline.rows[0].partial, true);
  assert.equal(timeline.rows[1].partial, false);
  assert.equal(timeline.rows.at(-1).partial, true);
});

test('按天统计跨月和负时区时保持时间顺序，不修改接口数据', () => {
  const stats = { hours: 168, time_unit: 'day', utc_offset_minutes: -300, range_end: Date.parse('2026-11-02T13:00:00-05:00'), byHour: [{ bucket: '2026-10-31', reqs: 2, ok: 2 }] };
  const original = JSON.stringify(stats);
  const timeline = ui.usageTimeline(stats);
  assert.equal(timeline.rows.length, 8);
  assert.equal(timeline.rows[0].bucket, '2026-10-26');
  assert.equal(timeline.rows.at(-1).bucket, '2026-11-02');
  assert.equal(timeline.rows.reduce((sum, r) => sum + r.reqs, 0), 2);
  assert.equal(JSON.stringify(stats), original);
});

test('临期提醒只包含未来 24 小时内的额度卡，异常状态独立归类', () => {
  const now = 100000000;
  const accounts = [{ id: 'expired', status: 'expired', card_expires_at: now - 1 }, { id: 'soon', status: 'active', card_expires_at: now + 86400000 },
    { id: 'later', status: 'active', card_expires_at: now + 86400001 }, { id: 'auth', status: 'needs_relogin' }, { id: 'verify', status: 'unverified' }];
  const result = ui.accountAttention(accounts, now);
  assert.deepEqual(Array.from(result.expiring, a => a.id), ['soon']);
  assert.deepEqual(Array.from(result.authorization, a => a.id), ['auth', 'verify']);
  assert.deepEqual(Array.from(result.unavailable, a => a.id), ['expired']);
});

test('137 个账号分页有界，删除或筛选导致越界时回到最后有效页', () => {
  const accounts = Array.from({ length: 137 }, (_, i) => ({ id: i + 1 }));
  const first = ui.paginate(accounts, 1, 25);
  assert.equal(first.items.length, 25);
  assert.equal(first.pages, 6);
  assert.equal(first.start, 1);
  assert.equal(first.end, 25);
  const last = ui.paginate(accounts, 999, 25);
  assert.equal(last.page, 6);
  assert.equal(last.items.length, 12);
  assert.equal(last.start, 126);
  assert.equal(last.end, 137);
  assert.equal(ui.paginate(accounts.slice(0, 3), 6, 25).page, 1);
  assert.equal(accounts.length, 137);
  assert.equal(accounts[0].id, 1);
});

test('空列表和无效分页参数不会生成负偏移、无限页或重复账号', () => {
  const empty = ui.paginate([], -1, 0);
  assert.equal(empty.start, 0);
  assert.equal(empty.end, 0);
  assert.equal(empty.page, 1);
  assert.equal(empty.pages, 1);
  const accounts = Array.from({ length: 137 }, (_, i) => i);
  const seen = Array.from({ length: 6 }, (_, i) => Array.from(ui.paginate(accounts, i + 1, 25).items)).flat();
  assert.deepEqual(seen, accounts);
  assert.equal(ui.paginate(accounts, NaN, Infinity).pageSize, 100);
});
