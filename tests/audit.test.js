'use strict';
/** Adversarial checks: things that should be impossible, attempted directly. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, client, loginAs, seedMasters, ADMIN } = require('./helpers');

async function asAdmin() {
  const { app, db } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  await seedMasters(c);
  return { app, db, c };
}

test('SQL injection through a bulk patch key is refused', async () => {
  const { c, db } = await asAdmin();
  const a = (await c.post('/api/assets', { user: 'Target', siteCode: 'HO', dept: 'IT' })).body.asset;
  const attempts = [
    { 'status; DROP TABLE assets; --': 'x' },
    { "status = 'x' WHERE 1=1; --": 'y' },
    { status: "In use'; DROP TABLE assets; --" }
  ];
  for (const patch of attempts) {
    const r = await c.post('/api/assets/bulk', { ids: [a.id], patch });
    assert.ok(r.status === 400 || r.status === 422, JSON.stringify(patch) + ' -> ' + r.status);
  }
  const n = await db.get('SELECT count(*) AS c FROM assets');
  assert.equal(Number(n.c), 1, 'the table is intact');
  await c.close();
});

test('injection through asset text fields is stored as data, not executed', async () => {
  const { c, db } = await asAdmin();
  const nasty = "Robert'); DROP TABLE assets; --";
  const r = await c.post('/api/assets', { user: nasty, siteCode: 'HO', dept: 'IT', vendor: nasty });
  assert.equal(r.status, 201);
  assert.equal(r.body.asset.user, nasty, 'kept verbatim');
  const n = await db.get('SELECT count(*) AS c FROM assets');
  assert.equal(Number(n.c), 1);
  await c.close();
});

test('injection through a custom field label cannot reach SQL', async () => {
  const { c, db } = await asAdmin();
  const r = await c.post('/api/fields', { label: "x'); DROP TABLE custom_fields; --", type: 'text' });
  assert.equal(r.status, 201);
  assert.match(r.body.field.key, /^[a-z0-9_]+$/, 'the key is reduced to safe characters');
  const n = await db.get('SELECT count(*) AS c FROM custom_fields');
  assert.equal(Number(n.c), 1);
  await c.close();
});

test('a site code cannot smuggle SQL or odd characters', async () => {
  const { c } = await asAdmin();
  for (const code of ["A'; DROP TABLE sites; --", 'a b', 'x', '../..', 'TOOLONGSITECODE!!', 'AB<script>']) {
    const r = await c.post('/api/sites', { name: 'Bad', code });
    assert.equal(r.status, 422, `${code} -> ${r.status}`);
  }
  await c.close();
});

test('over-length input is refused, never silently shortened', async () => {
  const { c } = await asAdmin();
  // Each of these would previously be trimmed into something valid-looking and
  // stored as a value the person never typed.
  assert.equal((await c.post('/api/sites', { name: 'X', code: 'A'.repeat(13) })).status, 422);
  assert.equal((await c.post('/api/companies', { name: 'X', code: 'B'.repeat(13) })).status, 422);
  assert.equal((await c.post('/api/departments', { name: 'D'.repeat(81) })).status, 422);
  assert.equal((await c.post('/api/fields', { label: 'L'.repeat(81), type: 'text' })).status, 422);
  assert.equal((await c.post('/api/users', { name: 'N'.repeat(121), email: 'a@b.com', role: 'Viewer', password: 'a-fine-password-1' })).status, 422);
  const longTag = await c.post('/api/assets', { user: 'U', siteCode: 'HO', dept: 'IT', tag: 'T'.repeat(61) });
  assert.equal(longTag.status, 422);
  assert.ok(longTag.body.error.fields.tag);
  await c.close();
});

test('a Manager cannot promote themselves', async () => {
  const { app, db, c } = await asAdmin();
  await c.post('/api/users', { name: 'Climber', email: 'climb@example.com', role: 'Manager', password: 'a-fine-password-1' });
  const u = await db.get('SELECT id FROM users WHERE email = ?', ['climb@example.com']);
  const m = client(app);
  await loginAs(m, 'climb@example.com', 'a-fine-password-1');
  assert.equal((await m.put(`/api/users/${u.id}`, { role: 'Admin' })).status, 403);
  assert.equal((await m.post('/api/users', { name: 'X', email: 'x@e.com', role: 'Admin', password: 'a-fine-password-1' })).status, 403);
  const after = await db.get('SELECT role FROM users WHERE id = ?', [u.id]);
  assert.equal(after.role, 'Manager');
  await m.close(); await c.close();
});

test('a scoped Manager cannot widen their own site access', async () => {
  const { app, db, c } = await asAdmin();
  await c.post('/api/users', { name: 'Scoped', email: 's@example.com', role: 'Manager',
    password: 'a-fine-password-1', sites: ['HO'] });
  const u = await db.get('SELECT id FROM users WHERE email = ?', ['s@example.com']);
  const m = client(app);
  await loginAs(m, 's@example.com', 'a-fine-password-1');
  assert.equal((await m.put(`/api/users/${u.id}`, { sites: [] })).status, 403);
  const after = await db.get('SELECT sites FROM users WHERE id = ?', [u.id]);
  assert.deepEqual(JSON.parse(after.sites), ['HO']);
  await m.close(); await c.close();
});

test('an asset version cannot be forged forward to skip the conflict check', async () => {
  const { c } = await asAdmin();
  const a = (await c.post('/api/assets', { user: 'V', siteCode: 'HO', dept: 'IT' })).body.asset;
  const r = await c.put(`/api/assets/${a.id}`, { version: 9999, vendor: 'X' });
  assert.equal(r.status, 409, 'a version from the future is still a mismatch');
  await c.close();
});

test('redeeming reset tokens is rate limited', async () => {
  const { app } = await harness();
  const anon = client(app);
  let last;
  for (let i = 0; i < 12; i++) {
    last = await anon.post('/api/auth/reset', { token: 'guess-' + i, newPassword: 'a-long-enough-pass' });
  }
  assert.equal(last.status, 429, 'guessing is throttled');
  await anon.close();
});

test('the logout cookie carries the same attributes it is replacing', async () => {
  const { app } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  const r = await c.raw('POST', '/api/auth/logout', {}, { headers: { 'X-Forwarded-Proto': 'https' } });
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/, 'a Secure cookie must be cleared by a Secure cookie');
  await c.close();
});

test('an account created by an administrator is flagged to change its password', async () => {
  const { app, c } = await asAdmin();
  await c.post('/api/users', { name: 'New Joiner', email: 'nj@example.com', role: 'Viewer', password: 'temp-password-99' });
  const nj = client(app);
  const login = await nj.post('/api/auth/login', { email: 'nj@example.com', password: 'temp-password-99' });
  assert.equal(login.body.user.mustChange, true, 'the flag reaches the client');
  await nj.post('/api/auth/password', { currentPassword: 'temp-password-99', newPassword: 'their-own-password' });
  const me = await nj.get('/api/auth/me');
  assert.equal(me.body.user.mustChange, false, 'and clears once changed');
  await nj.close(); await c.close();
});

test('the health endpoint leaks nothing', async () => {
  const { app } = await harness();
  const c = client(app);
  const r = await c.get('/api/health');
  const text = JSON.stringify(r.body);
  for (const secret of ['password', 'pw_hash', 'DATABASE_URL', 'totp', 'connectionString']) {
    assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `health mentions ${secret}`);
  }
  await c.close();
});

test('an unknown API path returns JSON, never the application shell', async () => {
  const { app } = await harness();
  const c = client(app);
  const r = await c.get('/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'NOT_FOUND');
  assert.ok(!/<html|<script/i.test(r.text));
  await c.close();
});

test('malformed JSON gets a clear 400, not a stack trace', async () => {
  const { app } = await harness();
  const c = client(app);
  const http = require('node:http');
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json'
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'BAD_JSON');
  assert.ok(!/at Object|node:internal/.test(JSON.stringify(body)), 'no stack leaked');
  server.close(); await c.close();
});

test('security headers are set on every response', async () => {
  const { app } = await harness();
  const c = client(app);
  const r = await c.get('/api/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.equal(r.headers.get('x-powered-by'), null, 'the server does not advertise itself');
  await c.close();
});
