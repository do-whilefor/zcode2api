'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'test')).filter(name => /\.test\.(cjs|mjs)$/.test(name)).sort();
if (!tests.length) throw new Error('No frontend tests discovered');
const result = spawnSync(process.execPath, ['--test', ...tests.map(name => path.join(root, 'test', name))], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
