#!/usr/bin/env node
'use strict';
/**
 * Rebuilds public/index.html from the client sources. No bundler needed.
 *
 *   node client-src/build.js            write the file
 *   node client-src/build.js --check    fail if the committed file is stale
 *
 * public/index.html IS committed, because the server serves it directly and
 * there is no build step at deploy time. --check exists so a stale commit is
 * caught here rather than noticed in production.
 */
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const ORDER = ['theme-core.js', 'client-api.js', 'login.js', 'part2.js', 'part3.js',
               'part4.js', 'part5.js', 'part6.js', 'part7.js', 'part8.js'];

const js = ORDER.map(f => fs.readFileSync(path.join(here, f), 'utf8').replace(/\s*$/, '') + '\n').join('');
const head = fs.readFileSync(path.join(here, 'part1.html'), 'utf8');
const out = head + '\n<body>\n<script>\n' + js + '</script>\n</body>\n';
const dest = path.join(here, '..', 'public', 'index.html');

if (process.argv.includes('--check')) {
  const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
  if (current === out) {
    console.log('public/index.html is up to date.');
    process.exit(0);
  }
  console.error('public/index.html is stale. Run: node client-src/build.js');
  process.exit(1);
}

fs.writeFileSync(dest, out);
console.log(`Wrote ${path.relative(process.cwd(), dest)} (${out.length} bytes from ${ORDER.length} sources)`);
