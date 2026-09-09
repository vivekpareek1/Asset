'use strict';
/**
 * Authentication and authorisation.
 *
 * Passwords are scrypt-hashed with a per-user salt. Sessions are random 256-bit
 * ids stored server-side, so signing out actually revokes access — a stateless
 * signed token cannot be revoked before it expires.
 */
const crypto = require('node:crypto');
const { uid, nowISO } = require('./db');

const SESSION_COOKIE = 'assetops_sid';
const SESSION_DAYS = 7;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const ROLES = ['Admin', 'Manager', 'Viewer'];
const RANK = { Viewer: 0, Manager: 1, Admin: 2 };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { hash, salt };
}
/** Constant-time comparison: a plain !== leaks timing information. */
function verifyPassword(password, hash, salt) {
  let derived;
  try { derived = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT); }
  catch { return false; }
  const stored = Buffer.from(hash, 'hex');
  if (stored.length !== derived.length) return false;
  return crypto.timingSafeEqual(stored, derived);
}

/**
 * Passwords are checked for length and for the handful of values that show up
 * in every breach list. This is not a strength meter; it is a floor.
 */
// Only entries of 10+ characters earn their place here; anything shorter is
// already rejected by the length rule above.
const WEAK = new Set([
  'password12', 'password123', 'password1234', 'passw0rd123', '1234567890',
  '12345678910', 'qwerty12345', 'qwertyuiop', 'administrator', 'adminadmin',
  'letmein123', 'welcome123', 'changeme123', 'iloveyou123', 'assetops123',
  'asdfghjkl;', 'abcd1234567', 'trustno1234', 'passwordpassword', 'qwertyasdf'
]);
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password must be 200 characters or fewer.';
  if (WEAK.has(pw.toLowerCase())) return 'That password is too common. Choose another.';
  return null;
}

/* --- login throttling ---------------------------------------------------
   Counters live in the database, so every instance shares one window. The
   previous in-process map reset on restart and could be sidestepped by
   spreading attempts across instances. --------------------------------- */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const throttleKey = (email, ip) => `${String(email).toLowerCase()}|${ip}`;

async function tooManyAttempts(db, key) {
  const row = await db.get('SELECT * FROM login_attempts WHERE akey = ?', [key]);
  if (!row) return false;
  if (Date.now() - new Date(row.first_at).getTime() > WINDOW_MS) {
    await db.run('DELETE FROM login_attempts WHERE akey = ?', [key]);
    return false;
  }
  return Number(row.attempts) >= MAX_ATTEMPTS;
}

async function noteFailure(db, key) {
  const row = await db.get('SELECT * FROM login_attempts WHERE akey = ?', [key]);
  if (!row || Date.now() - new Date(row.first_at).getTime() > WINDOW_MS) {
    await db.run('DELETE FROM login_attempts WHERE akey = ?', [key]);
    await db.run('INSERT INTO login_attempts (akey,first_at,attempts) VALUES (?,?,1)', [key, nowISO()]);
    return;
  }
  await db.run('UPDATE login_attempts SET attempts = attempts + 1 WHERE akey = ?', [key]);
}

const clearAttempts = (db, key) => db.run('DELETE FROM login_attempts WHERE akey = ?', [key]);
const purgeAttempts = db => db.run('DELETE FROM login_attempts WHERE first_at <= ?',
  [new Date(Date.now() - WINDOW_MS).toISOString()]);

/* --- sessions --- */

/**
 * @param {boolean} mfaPending true while a second factor is still owed. Such a
 *   session authenticates nothing except the verify endpoint.
 */
async function createSession(db, userId, mfaPending = false) {
  const id = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + (mfaPending ? 600000 : SESSION_DAYS * 86400000)).toISOString();
  await db.run('INSERT INTO sessions (id,user_id,created_at,expires_at,mfa_pending) VALUES (?,?,?,?,?)',
    [id, userId, nowISO(), expires, mfaPending ? 1 : 0]);
  return { id, expires };
}

async function promoteSession(db, id) {
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await db.run('UPDATE sessions SET mfa_pending = 0, expires_at = ? WHERE id = ?', [expires, id]);
}
async function destroySession(db, id) {
  if (id) await db.run('DELETE FROM sessions WHERE id = ?', [id]);
}
/** Returns the user only for a fully authenticated session. */
async function userForSession(db, id) {
  if (!id) return null;
  const row = await db.get(
    `SELECT u.*, s.mfa_pending FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`, [id, nowISO()]);
  if (!row || !row.active || Number(row.mfa_pending) === 1) return null;
  return shapeUser(row);
}

/** The half-authenticated user, for the second-factor step only. */
async function pendingUserForSession(db, id) {
  if (!id) return null;
  const row = await db.get(
    `SELECT u.*, s.mfa_pending FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`, [id, nowISO()]);
  if (!row || !row.active || Number(row.mfa_pending) !== 1) return null;
  return { ...shapeUser(row), totpSecret: row.totp_secret, backupCodes: safeJson(row.backup_codes, []) };
}
async function purgeExpiredSessions(db) {
  await db.run('DELETE FROM sessions WHERE expires_at <= ?', [nowISO()]);
}

/** Never let pw_hash or pw_salt out of this module. */
function shapeUser(row) {
  return {
    id: row.id, email: row.email, name: row.name, role: row.role,
    active: Boolean(row.active), mustChange: Boolean(row.must_change),
    mfaEnabled: Boolean(row.totp_enabled),
    sites: safeJson(row.sites, [])
  };
}
function safeJson(s, fallback) {
  try { const v = JSON.parse(s); return v === null ? fallback : v; } catch { return fallback; }
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function cookieHeader(id, { secure, maxAgeSec }) {
  const bits = [`${SESSION_COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/* --- middleware --- */

function attachUser(db) {
  return async (req, res, next) => {
    try {
      const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      req.sessionId = sid || null;
      req.user = await userForSession(db, sid);
    } catch { req.user = null; }
    next();
  };
}

const deny = (res, status, code, message) =>
  res.status(status).json({ error: { code, message } });

/** requireRole('Manager') admits Manager and Admin: roles are ranked, not equal. */
function requireRole(min) {
  return (req, res, next) => {
    if (!req.user) return deny(res, 401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (RANK[req.user.role] === undefined) return deny(res, 403, 'FORBIDDEN', 'Unknown role.');
    if (RANK[req.user.role] < RANK[min]) {
      return deny(res, 403, 'FORBIDDEN', `This action needs the ${min} role or higher.`);
    }
    next();
  };
}

/**
 * Blocks cross-site form posts. A browser cannot set Content-Type:
 * application/json cross-origin without a preflight, and our CORS policy
 * answers no preflight, so requiring it stops the classic CSRF shape.
 * SameSite=Lax on the cookie is the other half.
 */
function requireJson(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    return deny(res, 415, 'JSON_REQUIRED', 'Requests must be sent as application/json.');
  }
  next();
}

/** A user may be limited to certain sites; empty means every site. */
function siteAllowed(user, code) {
  if (!user) return false;
  if (!user.sites || user.sites.length === 0) return true;
  return user.sites.includes(code);
}

module.exports = {
  SESSION_COOKIE, SESSION_DAYS, ROLES, RANK,
  hashPassword, verifyPassword, passwordProblem,
  createSession, promoteSession, destroySession,
  userForSession, pendingUserForSession, purgeExpiredSessions,
  shapeUser, safeJson, parseCookies, cookieHeader,
  attachUser, requireRole, requireJson, siteAllowed,
  throttleKey, tooManyAttempts, noteFailure, clearAttempts, purgeAttempts,
  MAX_ATTEMPTS, WINDOW_MS
};
