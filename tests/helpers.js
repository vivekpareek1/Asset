'use strict';
const { openDb } = require('../src/db');
const { createApp } = require('../server');
const A = require('../src/auth');

const ADMIN = { email: 'admin@example.com', password: 'a-strong-admin-pass' };

/** A fresh in-memory app per test: no shared state, no ordering surprises. */
let PG_COUNTER = 0;
async function harness() {
  process.env.ADMIN_EMAIL = ADMIN.email;
  process.env.ADMIN_PASSWORD = ADMIN.password;
  let db;
  if (process.env.TEST_DATABASE_URL) {
    // Real-Postgres mode: each test gets its own schema on the SAME shared
    // database, exercising the exact isolation this deployment relies on.
    const schema = 'test_' + (Date.now() % 100000) + '_' + (PG_COUNTER++);
    db = openDb({ url: process.env.TEST_DATABASE_URL, schema });
  } else {
    db = openDb({ url: null, file: ':memory:' });
  }
  const app = await createApp({ db });
  return { app, db };
}

/** Minimal supertest/** Minimal supertest replacement so the tests need no extra dependency. */
function client(app) {
  const http = require('node:http');
  let cookie = null;
  const server = http.createServer(app);
  const ready = new Promise(r => server.listen(0, () => r()));
  const call = async (method, path, body, opts = {}) => {
    await ready;
    const port = server.address().port;
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (cookie && !opts.noCookie) headers.Cookie = cookie;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setC = res.headers.get('set-cookie');
    if (setC && !opts.keepCookie) cookie = setC.split(';')[0];
    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b, o),
    put: (p, b, o) => call('PUT', p, b, o),
    del: (p, b, o) => call('DELETE', p, b, o),
    raw: call,
    setCookie: c => { cookie = c; },
    getCookie: () => cookie,
    close: () => new Promise(r => server.close(r))
  };
}

async function loginAs(c, email, password) {
  const r = await c.post('/api/auth/login', { email, password });
  if (r.status !== 200) throw new Error('login failed: ' + r.text);
  return r.body.user;
}

/** Seeds one site and one department so asset tests have something valid. */
async function seedMasters(c) {
  await c.post('/api/sites', { name: 'Head Office', code: 'HO', location: 'Mumbai' });
  await c.post('/api/sites', { name: 'North Campus', code: 'DWC' });
  await c.post('/api/departments', { name: 'IT' });
  await c.post('/api/departments', { name: 'Legal' });
  await c.post('/api/departments', { name: 'Unassigned' });
}

module.exports = { harness, client, loginAs, seedMasters, ADMIN };
