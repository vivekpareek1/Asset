'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, client, loginAs, seedMasters, ADMIN } = require('./helpers');

async function setup() {
  const { app, db } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  await seedMasters(c);
  return { app, db, c };
}

test('two edits to DIFFERENT assets both survive', async () => {
  const { app, c } = await setup();
  const a = (await c.post('/api/assets', { user: 'One', siteCode: 'HO', dept: 'IT' })).body.asset;
  const b = (await c.post('/api/assets', { user: 'Two', siteCode: 'HO', dept: 'IT' })).body.asset;

  const s1 = client(app), s2 = client(app);
  await loginAs(s1, ADMIN.email, ADMIN.password);
  await loginAs(s2, ADMIN.email, ADMIN.password);
  const [r1, r2] = await Promise.all([
    s1.put(`/api/assets/${a.id}`, { version: a.version, vendor: 'Vendor A' }),
    s2.put(`/api/assets/${b.id}`, { version: b.version, vendor: 'Vendor B' })
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const boot = (await c.get('/api/bootstrap')).body;
  assert.equal(boot.assets.find(x => x.id === a.id).vendor, 'Vendor A');
  assert.equal(boot.assets.find(x => x.id === b.id).vendor, 'Vendor B');
  await s1.close(); await s2.close(); await c.close();
});

test('the second edit to the SAME asset is refused, not silently lost', async () => {
  const { app, c } = await setup();
  const a = (await c.post('/api/assets', { user: 'Shared', siteCode: 'HO', dept: 'IT' })).body.asset;

  // Both people load version 1.
  const seen = a.version;
  const first = await c.put(`/api/assets/${a.id}`, { version: seen, vendor: 'First writer' });
  assert.equal(first.status, 200);
  assert.equal(first.body.asset.version, seen + 1);

  const second = await c.put(`/api/assets/${a.id}`, { version: seen, vendor: 'Second writer' });
  assert.equal(second.status, 409, 'stale write must be refused');
  assert.equal(second.body.error.code, 'CONFLICT');
  assert.equal(second.body.error.current.vendor, 'First writer', 'the conflict reply shows what is there now');

  // Retrying with the fresh version succeeds.
  const retry = await c.put(`/api/assets/${a.id}`, { version: second.body.error.current.version, vendor: 'Second writer' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.asset.vendor, 'Second writer');
  await c.close();
});

test('simultaneous writes to one asset: exactly one wins', async () => {
  const { app, c } = await setup();
  const a = (await c.post('/api/assets', { user: 'Race', siteCode: 'HO', dept: 'IT' })).body.asset;
  const sessions = [];
  for (let i = 0; i < 5; i++) {
    const s = client(app);
    await loginAs(s, ADMIN.email, ADMIN.password);
    sessions.push(s);
  }
  const results = await Promise.all(sessions.map((s, i) =>
    s.put(`/api/assets/${a.id}`, { version: a.version, vendor: 'Writer ' + i })));
  const ok = results.filter(r => r.status === 200);
  const conflicts = results.filter(r => r.status === 409);
  assert.equal(ok.length, 1, `exactly one write should land, got ${ok.length}`);
  assert.equal(conflicts.length, 4);
  const final = (await c.get('/api/bootstrap')).body.assets.find(x => x.id === a.id);
  assert.equal(final.version, a.version + 1, 'version advanced exactly once');
  await Promise.all(sessions.map(s => s.close()));
  await c.close();
});

test('an update without a version is refused outright', async () => {
  const { c } = await setup();
  const a = (await c.post('/api/assets', { user: 'NoVer', siteCode: 'HO', dept: 'IT' })).body.asset;
  const r = await c.put(`/api/assets/${a.id}`, { vendor: 'X' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VERSION_REQUIRED');
  await c.close();
});

test('bulk edits do not disturb assets outside the selection', async () => {
  const { c } = await setup();
  const a = (await c.post('/api/assets', { user: 'A', siteCode: 'HO', dept: 'IT' })).body.asset;
  const b = (await c.post('/api/assets', { user: 'B', siteCode: 'HO', dept: 'IT' })).body.asset;
  const r = await c.post('/api/assets/bulk', { ids: [a.id], patch: { status: 'In repair' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, 1);
  const boot = (await c.get('/api/bootstrap')).body;
  assert.equal(boot.assets.find(x => x.id === a.id).status, 'In repair');
  assert.equal(boot.assets.find(x => x.id === b.id).status, 'In use', 'untouched');
  assert.equal(boot.assets.find(x => x.id === b.id).version, b.version, 'version not bumped');
  await c.close();
});

test('bulk rejects an unknown column and an invalid value', async () => {
  const { c } = await setup();
  const a = (await c.post('/api/assets', { user: 'A', siteCode: 'HO', dept: 'IT' })).body.asset;
  assert.equal((await c.post('/api/assets/bulk', { ids: [a.id], patch: { tag: 'HACK' } })).status, 400);
  assert.equal((await c.post('/api/assets/bulk', { ids: [a.id], patch: { status: 'Exploded' } })).status, 422);
  assert.equal((await c.post('/api/assets/bulk', { ids: [], patch: { status: 'Spare' } })).status, 400);
  await c.close();
});

test('a duplicate asset tag is refused', async () => {
  const { c } = await setup();
  await c.post('/api/assets', { user: 'A', siteCode: 'HO', dept: 'IT', tag: 'HO-PC-777' });
  const dup = await c.post('/api/assets', { user: 'B', siteCode: 'HO', dept: 'IT', tag: 'ho-pc-777' });
  assert.equal(dup.status, 409, 'the check is case-insensitive');
  assert.equal(dup.body.error.code, 'TAG_IN_USE');
  await c.close();
});

test('concurrent creates never collide on a generated tag', async () => {
  const { app, c } = await setup();
  const sessions = [];
  for (let i = 0; i < 8; i++) {
    const s = client(app);
    await loginAs(s, ADMIN.email, ADMIN.password);
    sessions.push(s);
  }
  const results = await Promise.all(sessions.map((s, i) =>
    s.post('/api/assets', { user: 'Concurrent ' + i, siteCode: 'HO', dept: 'IT' })));
  const created = results.filter(r => r.status === 201);
  const tags = created.map(r => r.body.asset.tag);
  assert.equal(new Set(tags).size, tags.length, `duplicate tags generated: ${tags.join(',')}`);
  const clashes = results.filter(r => r.status === 409);
  assert.equal(created.length + clashes.length, 8, 'every request got a definite answer');
  assert.ok(created.length >= 1);
  await Promise.all(sessions.map(s => s.close()));
  await c.close();
});

test('renaming a department moves its assets in one transaction', async () => {
  const { c, db } = await setup();
  await c.post('/api/assets', { user: 'A', siteCode: 'HO', dept: 'Legal' });
  await c.post('/api/assets', { user: 'B', siteCode: 'HO', dept: 'Legal' });
  const dept = (await db.get('SELECT * FROM departments WHERE name = ?', ['Legal']));
  const r = await c.put(`/api/departments/${dept.id}`, { name: 'Legal & Compliance' });
  assert.equal(r.status, 200);
  const boot = (await c.get('/api/bootstrap')).body;
  assert.equal(boot.assets.filter(a => a.dept === 'Legal & Compliance').length, 2);
  assert.equal(boot.assets.filter(a => a.dept === 'Legal').length, 0);
  await c.close();
});

test('a site with assets cannot be deleted', async () => {
  const { c, db } = await setup();
  await c.post('/api/assets', { user: 'A', siteCode: 'HO', dept: 'IT' });
  const site = await db.get('SELECT * FROM sites WHERE code = ?', ['HO']);
  const r = await c.del(`/api/sites/${site.id}`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'IN_USE');
  await c.close();
});

test('import creates and updates without erasing blanks', async () => {
  const { c } = await setup();
  const r1 = await c.post('/api/assets/import', { rows: [
    { user: 'Imp One', siteCode: 'HO', dept: 'IT', vendor: 'Ingram', purchasePrice: '52,000' },
    { user: 'Imp Two', siteCode: 'HO', dept: 'IT', vendor: 'Ingram', purchasePrice: 'Rs. 48000' }
  ]});
  assert.equal(r1.status, 200);
  assert.equal(r1.body.created, 2);
  const boot = (await c.get('/api/bootstrap')).body;
  const one = boot.assets.find(a => a.user === 'Imp One');
  assert.equal(one.purchasePrice, 52000);
  assert.equal(boot.assets.find(a => a.user === 'Imp Two').purchasePrice, 48000, 'Rs. prefix parsed');

  const r2 = await c.post('/api/assets/import', { rows: [{ tag: one.tag, purchasePrice: '' }] });
  assert.equal(r2.body.updated, 1);
  const after = (await c.get('/api/bootstrap')).body.assets.find(a => a.id === one.id);
  assert.equal(after.purchasePrice, 52000, 'a blank cell must not wipe the stored price');
  await c.close();
});

test('import skips rows for sites that do not exist', async () => {
  const { c } = await setup();
  const r = await c.post('/api/assets/import', { rows: [
    { user: 'Good', siteCode: 'HO' },
    { user: 'Bad', siteCode: 'NOWHERE' },
    { user: '', tag: '' }
  ]});
  assert.equal(r.body.created, 1);
  assert.equal(r.body.skipped, 2);
  await c.close();
});
