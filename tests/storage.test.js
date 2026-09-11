'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { harness, client, loginAs, seedMasters, ADMIN } = require('./helpers');

let TBL = null;
function crc32(buf) {
  if (!TBL) { TBL = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c; } }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makePng(r = 30, g = 90, b = 120) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b]))),
    chunk('IEND', Buffer.alloc(0))]);
}

async function asAdmin() {
  const { app, db } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  await seedMasters(c);
  return { app, db, c };
}

test('a logo is stored as binary, not base64 text', async () => {
  const { db, c } = await asAdmin();
  const png = makePng();
  const r = await c.post('/api/settings/logo', { data: png.toString('base64') });
  assert.equal(r.status, 201);
  const row = await db.get('SELECT * FROM files WHERE name = ?', [r.body.logo.filename]);
  const stored = Buffer.from(row.content);
  assert.ok(!(typeof row.content === 'string'), 'the column holds bytes, not a string');
  assert.equal(stored.length, png.length, 'no base64 inflation on disk');
  assert.equal(Number(row.bytes), png.length);
  assert.deepEqual([...stored.subarray(0, 8)], [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a], 'PNG header intact');
  await c.close();
});

test('the stored bytes are served back byte for byte', async () => {
  const { c } = await asAdmin();
  const png = makePng(7, 8, 9);
  const r = await c.post('/api/settings/logo', { data: png.toString('base64') });
  const res = await c.raw('GET', r.body.logo.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-length'), String(png.length));
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control'), /immutable/);
  await c.close();
});

test('a sanitised SVG is stored as the cleaned bytes', async () => {
  const { db, c } = await asAdmin();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><rect width="4" height="4"/></svg>');
  const r = await c.post('/api/settings/logo', { data: svg.toString('base64') });
  const row = await db.get('SELECT * FROM files WHERE name = ?', [r.body.logo.filename]);
  const text = Buffer.from(row.content).toString('utf8');
  assert.ok(!/onload/i.test(text));
  assert.equal(Number(row.bytes), Buffer.byteLength(text), 'the recorded size matches what is stored');
  await c.close();
});

/* ---- custom field values now come through an import ---- */

test('import carries custom field values', async () => {
  const { c } = await asAdmin();
  await c.post('/api/fields', { label: 'Invoice number', type: 'text' });
  await c.post('/api/fields', { label: 'AMC vendor', type: 'select', options: ['In-house', 'External'] });

  const r = await c.post('/api/assets/import', { rows: [
    { user: 'With Custom', siteCode: 'HO', dept: 'IT',
      custom: { invoice_number: 'INV-9911', amc_vendor: 'External' } }
  ]});
  assert.equal(r.body.created, 1);
  const boot = (await c.get('/api/bootstrap')).body;
  const a = boot.assets.find(x => x.user === 'With Custom');
  assert.equal(a.custom.invoice_number, 'INV-9911');
  assert.equal(a.custom.amc_vendor, 'External');
  await c.close();
});

test('an import cannot invent custom columns', async () => {
  const { c } = await asAdmin();
  await c.post('/api/fields', { label: 'Invoice number', type: 'text' });
  await c.post('/api/assets/import', { rows: [
    { user: 'Sneaky', siteCode: 'HO', dept: 'IT',
      custom: { invoice_number: 'INV-1', not_a_field: 'should vanish', role: 'Admin' } }
  ]});
  const a = (await c.get('/api/bootstrap')).body.assets.find(x => x.user === 'Sneaky');
  assert.equal(a.custom.invoice_number, 'INV-1');
  assert.equal(a.custom.not_a_field, undefined, 'undeclared keys are dropped');
  assert.equal(a.custom.role, undefined);
  await c.close();
});

test('a second import merges custom values instead of clearing them', async () => {
  const { c } = await asAdmin();
  await c.post('/api/fields', { label: 'Invoice number', type: 'text' });
  await c.post('/api/fields', { label: 'AMC vendor', type: 'text' });
  const created = await c.post('/api/assets/import', { rows: [
    { user: 'Merge Me', siteCode: 'HO', dept: 'IT', custom: { invoice_number: 'INV-1', amc_vendor: 'In-house' } }
  ]});
  assert.equal(created.body.created, 1);
  const a = (await c.get('/api/bootstrap')).body.assets.find(x => x.user === 'Merge Me');

  await c.post('/api/assets/import', { rows: [{ tag: a.tag, custom: { amc_vendor: 'External' } }] });
  const after = (await c.get('/api/bootstrap')).body.assets.find(x => x.id === a.id);
  assert.equal(after.custom.amc_vendor, 'External', 'the supplied value is applied');
  assert.equal(after.custom.invoice_number, 'INV-1', 'the untouched value survives');
  await c.close();
});

test('a malformed custom payload is ignored, not fatal', async () => {
  const { c } = await asAdmin();
  await c.post('/api/fields', { label: 'Invoice number', type: 'text' });
  for (const custom of ['a string', 42, ['a'], null]) {
    const r = await c.post('/api/assets/import', { rows: [{ user: 'Odd ' + String(custom), siteCode: 'HO', custom }] });
    assert.equal(r.status, 200, JSON.stringify(custom));
    assert.equal(r.body.created, 1);
  }
  await c.close();
});

/* ---- re-uploading a sheet: match by serial, not just tag ---- */

test('a re-imported row with no tag matches by serial and updates instead of duplicating', async () => {
  const { c } = await asAdmin();
  const first = await c.post('/api/assets/import', { rows: [
    { user: 'Original Person', siteCode: 'HO', dept: 'IT', serial: 'SN-ABC-123', vendor: 'Old Vendor' }
  ]});
  assert.equal(first.body.created, 1);
  const before = (await c.get('/api/bootstrap')).body.assets.find(a => a.serial === 'SN-ABC-123');
  assert.ok(before);

  // The sheet comes back later with the same serial but an updated vendor —
  // and, as real sheets do, no tag column at all.
  const second = await c.post('/api/assets/import', { rows: [
    { user: 'Original Person', siteCode: 'HO', dept: 'IT', serial: 'SN-ABC-123', vendor: 'New Vendor' }
  ]});
  assert.equal(second.body.created, 0, 'not treated as a new asset');
  assert.equal(second.body.updated, 1, 'matched the existing one by serial');

  const after = (await c.get('/api/bootstrap')).body.assets.filter(a => a.serial === 'SN-ABC-123');
  assert.equal(after.length, 1, 'still exactly one asset for this serial');
  assert.equal(after[0].id, before.id, 'same asset row');
  assert.equal(after[0].vendor, 'New Vendor');
  await c.close();
});

test('a genuinely new serial is added, not matched to something else', async () => {
  const { c } = await asAdmin();
  await c.post('/api/assets/import', { rows: [
    { user: 'Person A', siteCode: 'HO', dept: 'IT', serial: 'SN-AAA' }
  ]});
  const r = await c.post('/api/assets/import', { rows: [
    { user: 'Person B', siteCode: 'HO', dept: 'IT', serial: 'SN-BBB' }
  ]});
  assert.equal(r.body.created, 1);
  assert.equal(r.body.updated, 0);
  const boot = (await c.get('/api/bootstrap')).body;
  assert.equal(boot.assets.length, 2);
  await c.close();
});

test('tag match is preferred over serial match when both are present', async () => {
  const { c } = await asAdmin();
  const created = await c.post('/api/assets', { user: 'Tagged', siteCode: 'HO', dept: 'IT', serial: 'SN-SHARED' });
  const a = created.body.asset;
  const r = await c.post('/api/assets/import', { rows: [
    { tag: a.tag, serial: 'SN-SHARED', vendor: 'Via Tag Match' }
  ]});
  assert.equal(r.body.updated, 1);
  const after = (await c.get('/api/bootstrap')).body.assets.find(x => x.id === a.id);
  assert.equal(after.vendor, 'Via Tag Match');
  const boot = (await c.get('/api/bootstrap')).body;
  assert.equal(boot.assets.length, 1, 'no duplicate was created');
  await c.close();
});

test('the API itself refuses to create two assets sharing a serial', async () => {
  const { c } = await asAdmin();
  const first = await c.post('/api/assets', { user: 'First', siteCode: 'HO', dept: 'IT', tag: 'HO-PC-501', serial: 'SN-DUPE' });
  assert.equal(first.status, 201);
  const second = await c.post('/api/assets', { user: 'Second', siteCode: 'HO', dept: 'IT', tag: 'HO-PC-502', serial: 'SN-DUPE' });
  assert.equal(second.status, 409, 'the database-level unique index catches this even though nothing else does yet');
  assert.equal(second.body.error.code, 'DUPLICATE_SERIAL');
  await c.close();
});

test('a serial shared by two PRE-EXISTING assets (legacy data predating the constraint) is too ambiguous to auto-match', async () => {
  // The API cannot produce this state itself — the unique index (verified in
  // the test above) prevents it going forward. To simulate data that existed
  // before that index did, the index is dropped for this one test only, the
  // two colliding rows are inserted directly, and normal operation resumes —
  // exactly what a database migrated from an older version of this app could
  // look like on day one.
  const { c, db } = await asAdmin();
  await db.run('DROP INDEX IF EXISTS idx_assets_serial_unique');
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO assets (id,tag,serial,site_code,dept,user_name,version,updated_at) VALUES (?,?,?,?,?,?,1,?)',
    ['legacy1', 'HO-PC-501', 'SN-DUPE', 'HO', 'IT', 'First', now]);
  await db.run(
    'INSERT INTO assets (id,tag,serial,site_code,dept,user_name,version,updated_at) VALUES (?,?,?,?,?,?,1,?)',
    ['legacy2', 'HO-PC-502', 'SN-DUPE', 'HO', 'IT', 'Second', now]);

  const r = await c.post('/api/assets/import', { rows: [
    { user: 'Ambiguous', siteCode: 'HO', dept: 'IT', serial: 'SN-DUPE', vendor: 'Should Not Land' }
  ]});
  assert.equal(r.body.created, 0);
  assert.equal(r.body.updated, 0);
  assert.equal(r.body.skipped, 1);
  const boot = (await c.get('/api/bootstrap')).body;
  assert.ok(boot.assets.every(a => a.vendor !== 'Should Not Land'), 'neither legacy asset was touched');
  await c.close();
});

test('boot survives pre-existing duplicate serials without crashing, on this driver', async () => {
  // The core guarantee behind the two tests above, exercised directly against
  // whichever driver these tests are running on (SQLite by default, or real
  // Postgres under TEST_DATABASE_URL).
  const { db } = await harness();
  await db.run('DROP INDEX IF EXISTS idx_assets_serial_unique');
  const now = new Date().toISOString();
  await db.run('INSERT INTO assets (id,tag,serial,site_code,updated_at) VALUES (?,?,?,?,?)',
    ['d1', 'HO-PC-901', 'REBOOT-DUPE', 'HO', now]);
  await db.run('INSERT INTO assets (id,tag,serial,site_code,updated_at) VALUES (?,?,?,?,?)',
    ['d2', 'HO-PC-902', 'REBOOT-DUPE', 'HO', now]);
  // Re-running init (as a real restart would) must not throw, even though the
  // index it wants to recreate now conflicts with data already in the table.
  await assert.doesNotReject(() => db.init());
  const rows = await db.all('SELECT tag FROM assets WHERE serial = ?', ['REBOOT-DUPE']);
  assert.equal(rows.length, 2, 'both rows survived the reboot');
});

test('a blank serial never matches another blank-serial asset', async () => {
  const { c } = await asAdmin();
  await c.post('/api/assets', { user: 'No Serial One', siteCode: 'HO', dept: 'IT' });
  const r = await c.post('/api/assets/import', { rows: [
    { user: 'No Serial Two', siteCode: 'HO', dept: 'IT' }
  ]});
  assert.equal(r.body.created, 1, 'treated as new, not matched to the other blank-serial asset');
  const boot = (await c.get('/api/bootstrap')).body;
  assert.equal(boot.assets.length, 2);
  await c.close();
});

test('re-importing the ORIGINAL desktop-sheet shape twice does not duplicate', async () => {
  // Mirrors the real sheet columns: no tag, but a serial-like identifier.
  const { c } = await asAdmin();
  const rows = [
    { user: 'Sheet User 1', dept: 'IT', siteCode: 'HO', serial: 'HO2019001', ram: '8 GB', cpu: 'i3' },
    { user: 'Sheet User 2', dept: 'IT', siteCode: 'HO', serial: 'HO2019002', ram: '4 GB', cpu: 'i3' }
  ];
  const r1 = await c.post('/api/assets/import', { rows });
  assert.equal(r1.body.created, 2);
  // The same sheet, re-uploaded unchanged.
  const r2 = await c.post('/api/assets/import', { rows });
  assert.equal(r2.body.created, 0);
  assert.equal(r2.body.updated, 2);
  const boot = (await c.get('/api/bootstrap')).body;
  assert.equal(boot.assets.length, 2, 'still exactly two assets after two uploads of the same sheet');
  await c.close();
});
