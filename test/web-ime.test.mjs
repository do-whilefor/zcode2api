import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function imeHarness(userAgent) {
  const source = fs.readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('let composing = false;'), source.indexOf('\nfunction showLogin()'));
  const listeners = {};
  let now = 1000;
  const context = { navigator: { userAgent }, performance: { now: () => now }, document: { addEventListener: (name, handler) => { listeners[name] = handler; } } };
  vm.runInNewContext(code, context);
  const key = () => {
    const event = { key: 'Enter', target: { closest: () => ({}) }, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    listeners.keydown(event);
    return event;
  };
  return { listeners, key, advance: (ms) => { now += ms; } };
}

test('输入法候选词回车不取消默认选字，并阻止组合期间提交', () => {
  const h = imeHarness('Safari');
  h.listeners.compositionstart();
  const e = h.key();
  assert.equal(e.prevented, undefined);
  assert.equal(e.stopped, true);
  const submit = { preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  h.listeners.submit(submit);
  assert.equal(submit.prevented, true);
});
test('Safari 选字后短暂拦截回车，超时恢复；其他浏览器不延迟', () => {
  const safari = imeHarness('Mozilla/5.0 Version/17.0 Safari/605.1.15');
  safari.listeners.compositionend();
  assert.equal(safari.key().prevented, true);
  safari.advance(501);
  assert.equal(safari.key().prevented, undefined);
  const chrome = imeHarness('Mozilla/5.0 Chrome/130.0 Safari/537.36');
  chrome.listeners.compositionend();
  assert.equal(chrome.key().prevented, undefined);
});
