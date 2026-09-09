'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, client, loginAs, ADMIN } = require('./helpers');
const A = require('../src/auth');

test('every API route refuses an anonymous caller', async () => {
  const { app } = await harness();
  const c = client(app);
  for (const [m, p] of [['get','/api/bootstrap'],['post','/api/assets'],['get','/api/activity'],
                        ['get','/api/settings/theme'],['post','/api/users'],['get','/api/auth/me']]) {
    const r = await c[m === 'get' ? 'get' : 'post'](p, {});
    assert.equal(r.status, 401, `${m} ${p} returned ${r.status}`);
    assert.equal(r.body.error.code, 'UNAUTHENTICATED');
  }
  await c.close();
});

test('sign in with the right password, and the cookie is hardened', async () => {
  const { app } = await harness();
  const c = client(app);
  const r = await c.post('/api/auth/login', ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'Admin');
  assert.equal(r.body.user.pw_hash, undefined, 'no password material leaves the server');
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  const me = await c.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, ADMIN.email);
  await c.close();
});

test('a wrong password is refused, and says nothing about the account', async () => {
  const { app } = await harness();
  const c = client(app);
  const bad = await c.post('/api/auth/login', { email: ADMIN.email, password: 'wrong-password-here' });
  const missing = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password-here' });
  assert.equal(bad.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(bad.body.error.message, missing.body.error.message, 'identical message: no account enumeration');
  await c.close();
});

test('sign out revokes the session immediately', async () => {
  const { app } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  assert.equal((await c.get('/api/bootstrap')).status, 200);
  const cookie = c.getCookie();
  await c.post('/api/auth/logout', {});
  c.setCookie(cookie);                       // replay the old cookie
  const after = await c.get('/api/bootstrap');
  assert.equal(after.status, 401, 'a revoked session must not work again');
  await c.close();
});

test('a forged session id is rejected', async () => {
  const { app } = await harness();
  const c = client(app);
  c.setCookie('assetops_sid=' + 'f'.repeat(64));
  assert.equal((await c.get('/api/bootstrap')).status, 401);
  await c.close();
});

test('login attempts are throttled', async () => {
  const { app } = await harness();
  const c = client(app);
  let last;
  for (let i = 0; i < A.MAX_ATTEMPTS + 2; i++) {
    last = await c.post('/api/auth/login', { email: ADMIN.email, password: 'nope-nope-nope' });
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.error.code, 'TOO_MANY_ATTEMPTS');
  // The correct password is refused too while the window is open: that is the point.
  const good = await c.post('/api/auth/login', ADMIN);
  assert.equal(good.status, 429);
  await c.close();
});

test('an inactive account cannot sign in', async () => {
  const { app, db } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  await c.post('/api/users', { name: 'Temp', email: 'temp@example.com', role: 'Manager', password: 'temp-password-1' });
  const u = await db.get('SELECT id FROM users WHERE email = ?', ['temp@example.com']);
  await c.put(`/api/users/${u.id}`, { active: false });
  const c2 = client(app);
  const r = await c2.post('/api/auth/login', { email: 'temp@example.com', password: 'temp-password-1' });
  assert.equal(r.status, 401);
  await c.close(); await c2.close();
});

test('deactivating a user kills their live session', async () => {
  const { app, db } = await harness();
  const admin = client(app);
  await loginAs(admin, ADMIN.email, ADMIN.password);
  await admin.post('/api/users', { name: 'Live', email: 'live@example.com', role: 'Manager', password: 'live-password-1' });
  const victim = client(app);
  await loginAs(victim, 'live@example.com', 'live-password-1');
  assert.equal((await victim.get('/api/bootstrap')).status, 200);
  const u = await db.get('SELECT id FROM users WHERE email = ?', ['live@example.com']);
  await admin.put(`/api/users/${u.id}`, { active: false });
  assert.equal((await victim.get('/api/bootstrap')).status, 401, 'session dropped on deactivation');
  await admin.close(); await victim.close();
});

test('changing a password evicts other sessions but keeps the current one', async () => {
  const { app } = await harness();
  const a = client(app), b = client(app);
  await loginAs(a, ADMIN.email, ADMIN.password);
  await loginAs(b, ADMIN.email, ADMIN.password);
  const r = await a.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'a-brand-new-secret' });
  assert.equal(r.status, 200);
  assert.equal((await a.get('/api/bootstrap')).status, 200, 'the session that changed it survives');
  assert.equal((await b.get('/api/bootstrap')).status, 401, 'the other session is evicted');
  await a.close(); await b.close();
});

test('a weak new password is refused', async () => {
  const { app } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  for (const pw of ['short', 'password123']) {
    const r = await c.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: pw });
    assert.equal(r.status, 422, pw);
    assert.equal(r.body.error.code, 'WEAK_PASSWORD');
  }
  await c.close();
});

test('a form-encoded post is refused, which blocks the classic CSRF shape', async () => {
  const { app } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  const r = await c.raw('POST', '/api/departments', { name: 'X' },
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
  assert.equal(r.body.error.code, 'JSON_REQUIRED');
  await c.close();
});
