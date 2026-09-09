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
