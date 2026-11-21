#!/usr/bin/env node
/* CI static check for deadramp-base: the catalog parses with its
 * stated counts, index.html loads, and every local asset it names
 * exists. Headless and dependency free. The catalog export itself is
 * verified by tools/test-export.js, which CI also runs. */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..');
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!cond) failures++;
}
const cat = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'base-catalog.json'), 'utf8'));
check('catalog parses and states its offering count', Number.isInteger(cat.meta.offerings), `offerings=${cat.meta.offerings}`);
check('catalog offerings array matches stated count', Array.isArray(cat.offerings) && cat.offerings.length === cat.meta.offerings);
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
check('index.html references the application script', html.includes('./js/main.js'));
for (const m of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
  check(`asset exists: ${m[1]}`, fs.existsSync(path.join(REPO, m[1])));
}
for (const f of fs.readdirSync(path.join(REPO, 'js'))) {
  if (f.endsWith('.js')) new Function(fs.readFileSync(path.join(REPO, 'js', f), 'utf8').replace(/^import[^;]+;$/gm, '').replace(/^export /gm, '')) && check(`js parses: ${f}`, true);
}
console.log(failures ? `${failures} FAILURES` : 'ALL STATIC CHECKS PASSED');
process.exit(failures ? 1 : 0);
