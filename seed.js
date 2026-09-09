#!/usr/bin/env node
'use strict';
/**
 * Loads demo data into an empty register: sites, departments and assets.
 *
 * Refuses to run against a register that already has assets, so it cannot be
 * fired at a live database by accident. Pass --force to override deliberately.
 */
const { openDb, uid, nowISO } = require('./src/db');
const fs = require('node:fs');
const path = require('node:path');

const SITES = [
  ['HO', 'Head Office', 'Mumbai'], ['DWC', 'North Campus', ''], ['DGT', 'East Works', ''],
  ['PLN', 'Riverside Project', ''], ['KSL', 'Central Depot', ''], ['SIO', 'South Office', ''],
  ['KDB', 'West Branch', ''], ['PUN', 'Regional Office', ''], ['KSH', 'Annexe', '']
];

async function main() {
  const force = process.argv.includes('--force');
  const file = process.argv.includes('--file')
    ? process.argv[process.argv.indexOf('--file') + 1]
    : path.join(__dirname, 'seed-data.json');

  const db = openDb();
  await db.init();

  const existing = await db.get('SELECT count(*) AS c FROM assets');
  if (Number(existing.c) > 0 && !force) {
    console.error(`This register already holds ${existing.c} assets. Re-run with --force only if you mean it.`);
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`No seed file at ${file}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  await db.run('INSERT INTO companies (id,name,code) VALUES (?,?,?)', [uid('c'), 'Demo Group', 'DG'])
    .catch(() => {});
  for (const [code, name, loc] of SITES) {
    const has = await db.get('SELECT id FROM sites WHERE code = ?', [code]);
    if (!has) await db.run('INSERT INTO sites (id,code,name,location,company_id) VALUES (?,?,?,?,?)',
      [uid('s'), code, name, loc, '']);
  }
  const depts = [...new Set(data.assets.map(a => a.dept))].sort();
  for (const name of depts) {
    const has = await db.get('SELECT id FROM departments WHERE name = ?', [name]);
    if (!has) await db.run('INSERT INTO departments (id,name) VALUES (?,?)', [uid('d'), name]);
  }

  let n = 0;
  await db.tx(async t => {
    for (const a of data.assets) {
      const dupe = await t.get('SELECT id FROM assets WHERE lower(tag) = lower(?)', [a.tag]);
      if (dupe) continue;
      await t.run(
        `INSERT INTO assets (id,tag,serial,asset_type,brand,model,user_name,dept,site_code,cpu,ram,storage,os,
          status,vendor,purchase_price,purchase_year,warranty_end,custom,attachments,version,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'',NULL,?,?,'{}','[]',1,?)`,
        [uid('a'), a.tag, a.serial || '', a.type || 'Desktop', a.brand || '', a.model || '',
         a.user, a.dept, a.siteCode, a.cpu || '', a.ram || '', a.storage || '', a.os || '',
         a.status || 'In use', a.purchaseYear || null, a.warrantyEnd || '', nowISO()]);
      n++;
    }
  });
  console.log(`Seeded ${n} assets across ${SITES.length} sites and ${depts.length} departments.`);
  await db.close();
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
