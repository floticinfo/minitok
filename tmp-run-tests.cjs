'use strict';
const { spawnSync } = require('node:child_process');
const r = spawnSync('cmd', ['/c', 'npm test'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 25 * 60 * 1000,
  maxBuffer: 64 * 1024 * 1024,
});
const tail = (r.stdout || '').split(/\r?\n/).slice(-40).join('\n');
console.log('exit:', r.status);
console.log('--- tail:');
console.log(tail);
if (r.stderr) console.log('--- stderr tail:\n' + r.stderr.split(/\r?\n/).slice(-10).join('\n'));