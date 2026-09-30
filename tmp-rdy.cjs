'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const r = spawnSync(process.execPath, ['scripts/readiness-checks.mjs', '--target', 'all', '--json'], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 120000,
  env: { ...process.env, MINITOK_UPDATE_CHECK: '0' },
});
console.log('exit:', r.status);
try {
  const report = JSON.parse(r.stdout);
  const checks = Object.values(report).flat();
  const blocked = checks.filter(c => c.status === 'BLOCKED');
  console.log('total checks:', checks.length, 'BLOCKED:', blocked.length);
  for (const c of blocked) console.log('-', c.name, '|', String(c.detail || '').slice(0, 200));
} catch (e) {
  console.log('stdout tail:', (r.stdout || '').slice(-600));
  console.log('stderr tail:', (r.stderr || '').slice(-600));
}