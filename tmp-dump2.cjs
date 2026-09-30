'use strict';
const fs = require('node:fs');
const file = process.argv[2];
const c = fs.readFileSync(file, 'utf8');
const re = /<{7} HEAD\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n>{7} v1\.4\.15\r?\n/g;
let m, i = 0;
while ((m = re.exec(c))) {
  i++;
  console.log(`===== conflict ${i} =====`);
  console.log('--- HEAD (' + m[1].length + ' chars):');
  console.log(m[1].slice(0, 1500));
  console.log('--- THEIRS (' + m[2].length + ' chars):');
  console.log(m[2].slice(0, 1500));
}
if (i === 0) console.log('no conflicts found');