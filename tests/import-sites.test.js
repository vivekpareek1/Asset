'use strict';
/** Import must resolve sites the way departments already are — by matching
 * existing data first, creating a new record only when nothing matches — and
 * must never hang, no matter how many rows share a colliding site name. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, client, loginAs, ADMIN } = require('./helpers');

async function asAdmin() {
  const { app, db } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  return { app, db, c };
}

test('an unrecognised site is created automatically, not skipped', async () => {
  const { c } = await asAdmin();
  const r = await c.post('/api/assets/import', { rows: [
    { user: 'New Hire', siteCode: 'Riverside Project', dept: 'IT' }
  ]});
  assert.equal(r.body.created, 1, JSON.stringify(r.body));
  assert.equal(r.body.skipped, 0);
  const boot = (await c.get('/api/bootstrap')).body;
  assert.ok(boot.sites.some(s => s.name === 'Riverside Project'));
  assert.equal(boot.assets[0].siteCode, boot.sites.find(s => s.name === 'Riverside Project').code);
  await c.close();
});

test('a site is matched by NAME, not only by code, so it is never duplicated', async () => {
  const { c } = await asAdmin();
  await c.post('/api/sites', { name: 'Head Office', code: 'HO' });
  const before = (await c.get('/api/bootstrap')).body.sites.length;
  const r = await c.post('/api/assets/import', { rows: [
    { user: 'A', siteCode: 'Head Office', dept: 'IT' },   // the full name, not the code
    { user: 'B', siteCode: 'HO', dept: 'IT' }              // the code itself
  ]});
  assert.equal(r.body.created, 2);
  const after = (await c.get('/api/bootstrap')).body;
  assert.equal(after.sites.length, before, 'no duplicate site was created either way');
  assert.ok(after.assets.every(a => a.siteCode === 'HO'));
  await c.close();
});

test('matching is case-insensitive on both code and name', async () => {
  const { c } = await asAdmin();
  await c.post('/api/sites', { name: 'Head Office', code: 'HO' });
  const r = await c.post('/api/assets/import', { rows: [
    { user: 'A', siteCode: 'head office', dept: 'IT' },
    { user: 'B', siteCode: 'ho', dept: 'IT' }
  ]});
  const after = (await c.get('/api/bootstrap')).body;
  assert.equal(after.sites.filter(s => s.code === 'HO' || s.name.toLowerCase() === 'head office').length, 1);
  assert.equal(r.body.created, 2);
  await c.close();
});

test('two rows naming a brand-new site both land on the SAME newly created site', async () => {
  const { c } = await asAdmin();
  const r = await c.post('/api/assets/import', { rows: [
    { user: 'A', siteCode: 'Eden Woods', dept: 'IT' },
    { user: 'B', siteCode: 'Eden Woods', dept: 'IT' }
  ]});
  assert.equal(r.body.created, 2);
  const boot = (await c.get('/api/bootstrap')).body;
  const matches = boot.sites.filter(s => s.name === 'Eden Woods');
  assert.equal(matches.length, 1, 'exactly one site record for the repeated name');
  assert.ok(boot.assets.every(a => a.siteCode === matches[0].code));
  await c.close();
});

test('a row with no site at all, and no default chosen, is skipped with a clear reason', async () => {
  const { c } = await asAdmin();
  const r = await c.post('/api/assets/import', { rows: [{ user: 'No Site', dept: 'IT' }] });
  assert.equal(r.body.created, 0);
  assert.equal(r.body.skipped, 1);
  assert.match(r.body.report[0].reason, /no default site/i);
  await c.close();
});

test('a blank site falls back to the chosen default site rather than being skipped', async () => {
  const { c } = await asAdmin();
  await c.post('/api/sites', { name: 'Head Office', code: 'HO' });
  const r = await c.post('/api/assets/import', { rows: [{ user: 'Uses Default', defaultSite: 'HO' }] });
  assert.equal(r.body.created, 1);
  const a = (await c.get('/api/bootstrap')).body.assets.find(x => x.user === 'Uses Default');
  assert.equal(a.siteCode, 'HO');
  await c.close();
});

/* ---- the regression that actually mattered: this used to hang forever ---- */

test('heavy site-name collisions on the same prefix resolve quickly, never hang', async () => {
  const { c } = await asAdmin();
  // 25 distinct site names that all reduce to the same 3-letter prefix "WAG" —
  // enough to blow past the old single-digit disambiguation scheme and hang
  // the import indefinitely before the fix.
  const rows = Array.from({ length: 25 }, (_, i) => ({
    user: 'Person ' + i, siteCode: `WAGLE OFFICE FLOOR ${i + 1}`, dept: 'IT'
  }));
  const started = Date.now();
  const r = await Promise.race([
    c.post('/api/assets/import', { rows }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMED OUT — the old infinite loop is back')), 15000))
  ]);
  assert.ok(Date.now() - started < 15000);
  assert.equal(r.body.created, 25, JSON.stringify(r.body));
  const boot = (await c.get('/api/bootstrap')).body;
  const created = boot.sites.filter(s => /^WAGLE OFFICE FLOOR/.test(s.name));
  assert.equal(created.length, 25, 'each distinct name got its own site, not merged or lost');
  assert.equal(new Set(created.map(s => s.code)).size, 25, 'every generated code is unique');
  await c.close();
});

test('the real uploaded file imports fully: hundreds of rows, dozens of new sites, fast', async () => {
  let XLSX;
  try { XLSX = require('xlsx'); } catch { return; } // skip if the optional dep isn't installed
  const fs = require('node:fs');
  const path = '/mnt/user-data/uploads/test1.xlsx';
  if (!fs.existsSync(path)) return; // only runs where the sample file is present

  const { c } = await asAdmin();
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
  const head = rows[0];
  const idx = name => head.findIndex(h => String(h || '').trim().toLowerCase() === name);
  const payload = rows.slice(1).map(r => ({
    tag: r[idx('asset name')], user: r[idx('user name')], siteCode: r[idx('site')],
    dept: r[idx('department')] || r[idx('letest dept')], serial: r[idx('serial number')]
  }));

  const started = Date.now();
  const r = await Promise.race([
    c.post('/api/assets/import', { rows: payload }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMED OUT')), 30000))
  ]);
  assert.ok(Date.now() - started < 30000);
  assert.ok(r.body.created > 500, `expected most of ${payload.length} rows to import, got ${r.body.created}`);
  const boot = (await c.get('/api/bootstrap')).body;
  assert.ok(boot.sites.length > 20, 'many distinct real site names were auto-created');
  await c.close();
});

/* ---- cross-request concurrency: separate imports, not rows within one import ---- */

test('many SEPARATE concurrent import requests to the same brand-new site do not collide on the auto-generated tag', async () => {
  // This is a different race than the one above: each request is its own
  // transaction, so none can see another's uncommitted tag allocation. A
  // single retry (the original fix) was not enough — concurrent retries kept
  // recomputing the identical "next" candidate and colliding again. Only
  // meaningful against real Postgres, where transactions genuinely overlap;
  // SQLite serializes writers and would hide this.
  if (!process.env.TEST_DATABASE_URL) return;
  const { app, c } = await asAdmin();
  const sessions = [];
  for (let i = 0; i < 15; i++) {
    const s = client(app);
    await loginAs(s, ADMIN.email, ADMIN.password);
    sessions.push(s);
  }
  const results = await Promise.all(sessions.map((s, i) =>
    s.post('/api/assets/import', { rows: [{ user: 'Racer ' + i, siteCode: 'Concurrent New Site', dept: 'IT' }] })
  ));
  const created = results.filter(r => r.body.created === 1).length;
  assert.ok(created >= 13, `expected most of 15 concurrent imports to succeed, got ${created}`);
  const boot = (await c.get('/api/bootstrap')).body;
  const sites = boot.sites.filter(s => s.name === 'Concurrent New Site');
  assert.equal(sites.length, 1, 'exactly one site record, never duplicated');
  const tags = boot.assets.map(a => a.tag);
  assert.equal(new Set(tags).size, tags.length, 'no duplicate tags, whatever the exact success count');
  await Promise.all(sessions.map(s => s.close())); await c.close();
});
