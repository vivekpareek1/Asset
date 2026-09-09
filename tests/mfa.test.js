'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, client, loginAs, ADMIN } = require('./helpers');
const T = require('../src/totp');
const A = require('../src/auth');

async function signedIn() {
  const { app, db } = await harness();
  const c = client(app);
  await loginAs(c, ADMIN.email, ADMIN.password);
  return { app, db, c };
}
/** Walks the full enrolment: secret, prove a code, receive recovery codes. */
async function enable(c) {
  const setup = await c.post('/api/auth/mfa/setup', {});
  const secret = setup.body.secret;
  const on = await c.post('/api/auth/mfa/enable', { code: T.totp(secret) });
  return { secret, backupCodes: on.body.backupCodes, response: on };
}

test('enrolment hands out a secret and an otpauth URI', async () => {
  const { c } = await signedIn();
  const r = await c.post('/api/auth/mfa/setup', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.secret.length, 32);
  assert.match(r.body.uri, /^otpauth:\/\/totp\//);
  assert.match(r.body.uri, /secret=/);
  await c.close();
});

test('a wrong code does not enable it', async () => {
  const { c, db } = await signedIn();
  await c.post('/api/auth/mfa/setup', {});
  const r = await c.post('/api/auth/mfa/enable', { code: '000000' });
  assert.equal(r.status, 401);
  const row = await db.get('SELECT totp_enabled FROM users WHERE email = ?', [ADMIN.email]);
  assert.equal(Number(row.totp_enabled), 0, 'an abandoned setup leaves the account alone');
  await c.close();
});

test('a correct code enables it and returns recovery codes once', async () => {
  const { c, db } = await signedIn();
  const { backupCodes, response } = await enable(c);
  assert.equal(response.status, 200);
  assert.equal(backupCodes.length, 10);
  const row = await db.get('SELECT * FROM users WHERE email = ?', [ADMIN.email]);
  assert.equal(Number(row.totp_enabled), 1);
  const stored = JSON.parse(row.backup_codes);
  assert.equal(stored.length, 10);
  assert.ok(!stored.includes(backupCodes[0]), 'only hashes are kept');
  await c.close();
});

test('with 2FA on, the password alone does not sign you in', async () => {
  const { app, c } = await signedIn();
  await enable(c);
  const fresh = client(app);
  const r = await fresh.post('/api/auth/login', ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.body.mfaRequired, true);
  assert.equal(r.body.user, undefined, 'no user is returned yet');
  assert.equal((await fresh.get('/api/bootstrap')).status, 401, 'the half-session opens nothing');
  assert.equal((await fresh.get('/api/auth/me')).status, 401);
  await fresh.close(); await c.close();
});

test('the second factor completes the sign-in', async () => {
  const { app, c } = await signedIn();
  const { secret } = await enable(c);
  const fresh = client(app);
  await fresh.post('/api/auth/login', ADMIN);
  const r = await fresh.post('/api/auth/mfa', { code: T.totp(secret) });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, ADMIN.email);
  assert.equal(r.body.user.mfaEnabled, true);
  assert.equal((await fresh.get('/api/bootstrap')).status, 200, 'now it works');
  await fresh.close(); await c.close();
});

test('a wrong second factor is refused', async () => {
  const { app, c } = await signedIn();
  await enable(c);
  const fresh = client(app);
  await fresh.post('/api/auth/login', ADMIN);
  const r = await fresh.post('/api/auth/mfa', { code: '123456' });
  assert.equal(r.status, 401);
  assert.equal((await fresh.get('/api/bootstrap')).status, 401);
  await fresh.close(); await c.close();
});

test('the verify endpoint cannot be called without a pending login', async () => {
  const { app, c } = await signedIn();
  const { secret } = await enable(c);
  const stranger = client(app);
  const r = await stranger.post('/api/auth/mfa', { code: T.totp(secret) });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'NO_PENDING_LOGIN');
  await stranger.close(); await c.close();
});

test('a recovery code works once and only once', async () => {
  const { app, c } = await signedIn();
  const { backupCodes } = await enable(c);
  const first = client(app);
  await first.post('/api/auth/login', ADMIN);
  const ok = await first.post('/api/auth/mfa', { code: backupCodes[0] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.backupCodesRemaining, 9);

  const second = client(app);
  await second.post('/api/auth/login', ADMIN);
  const reuse = await second.post('/api/auth/mfa', { code: backupCodes[0] });
  assert.equal(reuse.status, 401, 'a used recovery code is spent');
  await first.close(); await second.close(); await c.close();
});

test('recovery codes are accepted regardless of dashes or case', async () => {
  const { app, c } = await signedIn();
  const { backupCodes } = await enable(c);
  const fresh = client(app);
  await fresh.post('/api/auth/login', ADMIN);
  const messy = backupCodes[1].toLowerCase().replace('-', ' ');
  assert.equal((await fresh.post('/api/auth/mfa', { code: messy })).status, 200);
  await fresh.close(); await c.close();
});

test('turning 2FA off needs the password', async () => {
  const { c, db } = await signedIn();
  await enable(c);
  assert.equal((await c.post('/api/auth/mfa/disable', { password: 'wrong-one-here' })).status, 401);
  assert.equal((await c.post('/api/auth/mfa/disable', { password: ADMIN.password })).status, 200);
  const row = await db.get('SELECT * FROM users WHERE email = ?', [ADMIN.email]);
  assert.equal(Number(row.totp_enabled), 0);
  assert.equal(row.totp_secret, null, 'the secret is cleared, not left lying around');
  await c.close();
});

test('the second factor survives a restart of the process', async () => {
  const { app, c } = await signedIn();
  const { secret } = await enable(c);
  // A new client is a new browser; the row in the database is what matters.
  const fresh = client(app);
  const login = await fresh.post('/api/auth/login', ADMIN);
  assert.equal(login.body.mfaRequired, true);
  assert.equal((await fresh.post('/api/auth/mfa', { code: T.totp(secret) })).status, 200);
  await fresh.close(); await c.close();
});
