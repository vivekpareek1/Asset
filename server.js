'use strict';
/**
 * AssetOps server.
 *
 * Three things this version fixes over the previous build:
 *   1. Real sign-in. Roles are enforced on the server, not suggested by the UI.
 *   2. Upload validation and SVG sanitisation run here, so a request sent
 *      straight to the API cannot skip them.
 *   3. One row per record with an optimistic version check, so two people
 *      working at once no longer overwrite each other.
 */
const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDb, uid, nowISO } = require('./src/db');
const A = require('./src/auth');
const { createRouter } = require('./src/routes');
const { createSettingsRouter, serveUploads } = require('./src/settings');

const PORT = process.env.PORT || 10000;

async function log(db, actor, action, detail) {
  try {
    await db.run('INSERT INTO activity (id,ts,actor,action,detail) VALUES (?,?,?,?,?)',
      [uid('l'), nowISO(), String(actor).slice(0, 120), String(action).slice(0, 80), String(detail).slice(0, 400)]);
  } catch (e) { console.error('[assetops] could not write to the activity log:', e.message); }
}

/**
 * Ensures there is an administrator to sign in as. With ADMIN_EMAIL and
 * ADMIN_PASSWORD set, that account is created. Otherwise a password is
 * generated and printed ONCE — better than shipping a default everyone knows.
 */
async function ensureAdmin(db) {
  const existing = await db.get('SELECT id FROM users WHERE role = ? AND active = 1', ['Admin']);
  if (existing) return null;

  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  let password = process.env.ADMIN_PASSWORD || '';
  let generated = false;
  if (!password || A.passwordProblem(password)) {
    if (password) console.warn('[assetops] ADMIN_PASSWORD was rejected: ' + A.passwordProblem(password));
    password = crypto.randomBytes(12).toString('base64url');
    generated = true;
  }
  const { hash, salt } = A.hashPassword(password);
  await db.run(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,active,sites,must_change,created_at)
     VALUES (?,?,?,?,?,?,1,'[]',?,?)`,
    [uid('u'), email, 'Administrator', 'Admin', hash, salt, generated ? 1 : 0, nowISO()]);

  if (generated) {
    console.log('\n' + '='.repeat(64));
    console.log('  First run. An administrator account was created:');
    console.log(`    email:    ${email}`);
    console.log(`    password: ${password}`);
    console.log('  This is shown once. Sign in and change it.');
    console.log('='.repeat(64) + '\n');
  } else {
    console.log(`[assetops] administrator created: ${email}`);
  }
  return { email, generated };
}

async function createApp({ db }) {
  await db.init();
  await A.purgeExpiredSessions(db);
  await A.purgeAttempts(db);
  await ensureAdmin(db);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);           // Render terminates TLS in front of us
  // Comfortably above the 2 MB image rule once base64 inflation (4/3) is
  // allowed for, so oversize images are rejected by our own check with a clear
  // message rather than by the body parser.
  app.use(express.json({ limit: '12mb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.get('/api/health', async (req, res) => {
    let ok = true;
    try { await db.get('SELECT 1 AS x'); } catch { ok = false; }
    res.json({ ok, store: db.kind, persistent: true });
  });

  app.get('/uploads/:name', serveUploads({ db }));

  app.use('/api', A.attachUser(db), A.requireJson);
  app.use('/api', createRouter({ db, log }));
  app.use('/api/settings', createSettingsRouter({ db, log }));

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } }));

  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
  app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  /* eslint-disable-next-line no-unused-vars */
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'That request is too large.' } });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'The request body is not valid JSON.' } });
    }
    console.error('[assetops] unhandled:', err && err.message);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  return app;
}

if (require.main === module) {
  const db = openDb();
  createApp({ db })
    .then(app => app.listen(PORT, () => console.log(`[assetops] listening on ${PORT} (${db.kind})`)))
    .catch(e => { console.error('[assetops] failed to start:', e.stack || e.message); process.exit(1); });
}

module.exports = { createApp, ensureAdmin, log };
