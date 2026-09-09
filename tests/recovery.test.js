'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, client, loginAs, ADMIN } = require('./helpers');
const A = require('../src/auth');

async function withUser() {
  const { app, db } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  await c.post('/api/users', { name: 'Locked Out', email: 'locked@example.com', role: 'Manager', password: 'first-password-1' });
  const u = await db.get('SELECT * FROM users WHERE email = ?', ['locked@example.com']);
  return { app, db, c, u };
}

test('an administrator can issue a reset token', async () => {
  const { c, u } = await withUser();
  const r = await c.post(`/api/users/${u.id}/reset-token`, {});
  assert.equal(r.status, 201);
  assert.ok(r.body.token && r.body.token.length > 20);
  assert.equal(r.body.email, 'locked@example.com');
  assert.ok(new Date(r.body.expiresAt) > new Date());
  await c.close();
});

test('only the hash of the token is stored', async () => {
  const { c, db, u } = await withUser();
  const r = await c.post(`/api/users/${u.id}/reset-token`, {});
  const row = await db.get('SELECT * FROM password_resets WHERE user_id = ?', [u.id]);
  assert.ok(row);
  assert.notEqual(row.token_hash, r.body.token, 'the raw token is never written down');
  assert.equal(row.token_hash.length, 64);
  await c.close();
});

test('a non-admin cannot issue one', async () => {
  const { app, c, u } = await withUser();
  const m = client(app);
  await loginAs(m, 'locked@example.com', 'first-password-1');
  assert.equal((await m.post(`/api/users/${u.id}/reset-token`, {})).status, 403);
  await m.close(); await c.close();
});

test('the token sets a new password without any session', async () => {
  const { app, c, u } = await withUser();
  const token = (await c.post(`/api/users/${u.id}/reset-token`, {})).body.token;
  const anon = client(app);
  const r = await anon.post('/api/auth/reset', { token, newPassword: 'a-new-strong-password' });
  assert.equal(r.status, 200);
  const back = client(app);
  assert.equal((await back.post('/api/auth/login', { email: 'locked@example.com', password: 'a-new-strong-password' })).status, 200);
  assert.equal((await back.post('/api/auth/login', { email: 'locked@example.com', password: 'first-password-1' })).status, 401,
    'the old password stops working');
  await anon.close(); await back.close(); await c.close();
});

test('a reset token works only once', async () => {
  const { app, c, u } = await withUser();
  const token = (await c.post(`/api/users/${u.id}/reset-token`, {})).body.token;
  const anon = client(app);
  assert.equal((await anon.post('/api/auth/reset', { token, newPassword: 'a-new-strong-password' })).status, 200);
  const again = await anon.post('/api/auth/reset', { token, newPassword: 'yet-another-password' });
  assert.equal(again.status, 401);
  assert.equal(again.body.error.code, 'INVALID_TOKEN');
  await anon.close(); await c.close();
});

test('a made-up or expired token is refused', async () => {
  const { app, db, c, u } = await withUser();
  const anon = client(app);
  assert.equal((await anon.post('/api/auth/reset', { token: 'nonsense', newPassword: 'a-new-strong-password' })).status, 401);
  const token = (await c.post(`/api/users/${u.id}/reset-token`, {})).body.token;
  await db.run('UPDATE password_resets SET expires_at = ? WHERE user_id = ?',
    [new Date(Date.now() - 1000).toISOString(), u.id]);
  assert.equal((await anon.post('/api/auth/reset', { token, newPassword: 'a-new-strong-password' })).status, 401);
  await anon.close(); await c.close();
});

test('a weak new password is refused during reset', async () => {
  const { app, c, u } = await withUser();
  const token = (await c.post(`/api/users/${u.id}/reset-token`, {})).body.token;
  const anon = client(app);
  const r = await anon.post('/api/auth/reset', { token, newPassword: 'short' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'WEAK_PASSWORD');
  await anon.close(); await c.close();
});

test('a reset evicts every live session for that account', async () => {
  const { app, c, u } = await withUser();
  const victim = client(app);
  await loginAs(victim, 'locked@example.com', 'first-password-1');
  assert.equal((await victim.get('/api/bootstrap')).status, 200);
  const token = (await c.post(`/api/users/${u.id}/reset-token`, {})).body.token;
  const anon = client(app);
  await anon.post('/api/auth/reset', { token, newPassword: 'a-new-strong-password' });
  assert.equal((await victim.get('/api/bootstrap')).status, 401, 'the old session is gone');
  await victim.close(); await anon.close(); await c.close();
});

test('issuing a new token invalidates the previous unused one', async () => {
  const { app, c, u } = await withUser();
  const first = (await c.post(`/api/users/${u.id}/reset-token`, {})).body.token;
  const second = (await c.post(`/api/users/${u.id}/reset-token`, {})).body.token;
  const anon = client(app);
  assert.equal((await anon.post('/api/auth/reset', { token: first, newPassword: 'a-new-strong-password' })).status, 401);
  assert.equal((await anon.post('/api/auth/reset', { token: second, newPassword: 'a-new-strong-password' })).status, 200);
  await anon.close(); await c.close();
});

/* ---- throttle is now shared, not per-process ---- */

test('the throttle counter lives in the database', async () => {
  const { app, db } = await harness();
  const c = client(app);
  for (let i = 0; i < 3; i++) await c.post('/api/auth/login', { email: ADMIN.email, password: 'wrong-one' });
  const row = await db.get('SELECT * FROM login_attempts');
  assert.ok(row, 'a counter row exists');
  assert.equal(Number(row.attempts), 3);
  await c.close();
});

test('a second instance shares the same counter', async () => {
  const { app, db } = await harness();
  // Two clients stand in for two server instances: what matters is that the
  // count is read from the database rather than from process memory.
  const a = client(app), b = client(app);
  for (let i = 0; i < 5; i++) await a.post('/api/auth/login', { email: ADMIN.email, password: 'wrong-one' });
  for (let i = 0; i < 5; i++) await b.post('/api/auth/login', { email: ADMIN.email, password: 'wrong-one' });
  const row = await db.get('SELECT * FROM login_attempts');
  assert.equal(Number(row.attempts), 10, 'attempts accumulated across both');
  const blocked = await b.post('/api/auth/login', ADMIN);
  assert.equal(blocked.status, 429);
  await a.close(); await b.close();
});

test('a successful sign-in clears the counter', async () => {
  const { app, db } = await harness();
  const c = client(app);
  for (let i = 0; i < 3; i++) await c.post('/api/auth/login', { email: ADMIN.email, password: 'wrong-one' });
  assert.equal((await c.post('/api/auth/login', ADMIN)).status, 200);
  const row = await db.get('SELECT * FROM login_attempts');
  assert.equal(row, null, 'the counter row is removed');
  await c.close();
});

test('the window expires, so a locked account recovers by itself', async () => {
  const { app, db } = await harness();
  const c = client(app);
  for (let i = 0; i < A.MAX_ATTEMPTS; i++) await c.post('/api/auth/login', { email: ADMIN.email, password: 'wrong-one' });
  assert.equal((await c.post('/api/auth/login', ADMIN)).status, 429);
  await db.run('UPDATE login_attempts SET first_at = ?',
    [new Date(Date.now() - A.WINDOW_MS - 1000).toISOString()]);
  assert.equal((await c.post('/api/auth/login', ADMIN)).status, 200, 'the old window no longer counts');
  await c.close();
});
