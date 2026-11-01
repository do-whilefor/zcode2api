'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const image = process.argv[2];
const captcha = process.argv[3] === '1';
const proxy = process.argv[4] === '1';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 }).trim();
const name = `zcode2api-offline-${process.pid}`;
try {
  // No outbound networking is available to the running application.
  docker('run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/app/data', '-e', 'ZCODE2API_ADMIN_PASSWORD=offline-container-password', image);
  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { docker('exec', name, 'zcode2api', '--healthcheck', 'auto'); healthy = true; break; } catch { }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.ok(healthy, docker('logs', name));
  assert.equal(docker('exec', name, 'zcode2api', '--version'), 'zcode2api ci');
  if (captcha) docker('exec', name, 'node', '-e', "const {JSDOM}=require('/app/captcha_node/node_modules/jsdom');const d=new JSDOM('<p>offline</p>');if(d.window.document.querySelector('p').textContent!=='offline')process.exit(1);d.window.close()");
  else docker('exec', name, 'sh', '-c', '! command -v node');
  if (proxy) assert.match(docker('exec', name, 'mihomo', '-v'), /1\.19\.33/);
  else docker('exec', name, 'sh', '-c', '! command -v mihomo');
  console.log(`Offline container smoke passed: CAPTCHA_RUNTIME=${Number(captcha)}, PROXY_RUNTIME=${Number(proxy)}`);
} finally {
  try { docker('rm', '-f', name); } catch { }
}
