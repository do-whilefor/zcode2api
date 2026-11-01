'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const profile = fs.readFileSync(process.argv[2] || 'coverage.out', 'utf8');
let total = 0, covered = 0;
for (const line of profile.trim().split(/\r?\n/).slice(1)) {
  if (!line.startsWith('zcode2api/internal/server/')) continue;
  const match = line.match(/\s(\d+)\s(\d+)$/);
  assert.ok(match, `Invalid coverage entry: ${line}`);
  total += Number(match[1]);
  if (Number(match[2]) > 0) covered += Number(match[1]);
}
assert.ok(total > 0, 'Backend coverage is empty');
const percent = covered / total * 100;
const minimum = Number(process.argv[3] || 75);
const summary = `Backend statement coverage: ${percent.toFixed(2)}% (${covered}/${total}); minimum ${minimum}%`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
assert.ok(percent >= minimum, summary);
