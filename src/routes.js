'use strict';
/**
 * REST API. One endpoint per entity, so a change touches one row rather than
 * rewriting the whole register.
 *
 * Asset updates carry the version the client last saw. If the row moved on in
 * the meantime the write is refused with 409 and the current row is returned,
 * so the person can see what changed instead of silently flattening it.
 */
const express = require('express');
const A = require('./auth');
const L = require('./logo');
const T = require('./totp');
const crypto = require('node:crypto');
const { uid, nowISO, isUniqueViolation, duplicateField } = require('./db');

const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');

const STATUSES = ['In use', 'Spare', 'In repair', 'Replace due', 'Retired'];
const TYPES = ['Desktop', 'All-in-One', 'Laptop', 'Printer', 'Server', 'Network'];
const FIELD_TYPES = ['text', 'number', 'date', 'select'];

const fail = (res, status, code, message, extra) =>
  res.status(status).json({ error: { code, message, ...(extra || {}) } });

const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
/**
 * Like str, but refuses over-length input instead of trimming it down.
 * Silent truncation turns "TOOLONGSITECODE!!" into a valid-looking
 * "TOOLONGSITEC" and stores something the person never typed.
 * @returns {string|null} null when the value is longer than max
 */
function exact(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? null : s;
}
const jsonOr = (s, f) => { try { const v = JSON.parse(s); return v == null ? f : v; } catch { return f; } };

/** DB row -> the shape the browser works with. */
function rowToAsset(r) {
  return {
    id: r.id, tag: r.tag, serial: r.serial, type: r.asset_type, brand: r.brand, model: r.model,
    user: r.user_name, dept: r.dept, siteCode: r.site_code, cpu: r.cpu, ram: r.ram,
    storage: r.storage, os: r.os, status: r.status, vendor: r.vendor,
    purchasePrice: r.purchase_price == null ? null : Number(r.purchase_price),
    purchaseYear: r.purchase_year == null ? null : Number(r.purchase_year),
    warrantyEnd: r.warranty_end, custom: jsonOr(r.custom, {}), files: jsonOr(r.attachments, []),
    version: Number(r.version), updatedAt: r.updated_at
  };
}

/** Parses "45,000", "Rs. 45000", "₹45000.50". Blank means unknown, not zero. */
function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Validates an incoming asset. `partial` skips required checks for updates. */
function validateAsset(body, { partial = false, sites, depts } = {}) {
  const e = {};
  const v = {};
  const has = k => body[k] !== undefined;

  if (!partial || has('user')) {
    v.user = str(body.user, 120);
    if (!v.user) e.user = 'Assigned to is required.';
  }
  if (!partial || has('siteCode')) {
    v.siteCode = str(body.siteCode, 12);
    if (!sites.some(s => s.code === v.siteCode)) e.siteCode = 'Unknown site code.';
  }
  if (has('dept')) {
    v.dept = str(body.dept, 80) || 'Unassigned';
    if (!depts.some(d => d.name === v.dept)) e.dept = 'Unknown department.';
  }
  if (has('status')) {
    v.status = str(body.status, 40);
    if (!STATUSES.includes(v.status)) e.status = `Status must be one of: ${STATUSES.join(', ')}.`;
  }
  if (has('type')) {
    v.type = str(body.type, 40);
    if (!TYPES.includes(v.type)) e.type = `Type must be one of: ${TYPES.join(', ')}.`;
  }
  if (has('tag')) {
    // The tag identifies the asset, so an over-long one is an error rather than
    // something to quietly shorten into a different tag.
    const t = exact(body.tag, 60);
    if (t === null) e.tag = 'Asset tag must be 60 characters or fewer.';
    else v.tag = t;
  }
  // Free-text descriptions are trimmed to a sane length; they identify nothing.
  for (const k of ['serial', 'brand', 'model', 'cpu', 'ram', 'storage', 'os', 'vendor', 'warrantyEnd']) {
    if (has(k)) v[k] = str(body[k], 160);
  }
  if (has('purchasePrice')) {
    const raw = body.purchasePrice;
    if (raw === null || raw === '') v.purchasePrice = null;
    else {
      const p = parsePrice(raw);
      if (p === null) e.purchasePrice = 'Purchase price must be a number, or left blank.';
      else v.purchasePrice = p;
    }
  }
  if (has('purchaseYear')) {
    const y = Number(String(body.purchaseYear).replace(/\D/g, '').slice(0, 4));
    const thisYear = new Date().getFullYear();
    v.purchaseYear = (y >= 1990 && y <= thisYear + 1) ? y : null;
  }
  if (has('custom')) {
    v.custom = (body.custom && typeof body.custom === 'object' && !Array.isArray(body.custom)) ? body.custom : {};
  }
  return { valid: Object.keys(e).length === 0, errors: e, value: v };
}

/**
 * Finds the asset already holding a serial number, so the rejection can name
 * it — "already used by HO-PC-014 (Priya Singh)" tells the person exactly
 * where to look, instead of a bare "duplicate".
 */
async function findBySerial(db, serial, excludeId) {
  if (!serial) return null;
  return db.get(
    excludeId
      ? 'SELECT tag, user_name FROM assets WHERE lower(serial) = lower(?) AND id <> ?'
      : 'SELECT tag, user_name FROM assets WHERE lower(serial) = lower(?)',
    excludeId ? [serial, excludeId] : [serial]
  );
}
const serialTakenMessage = row => `Serial number is already recorded on ${row.tag}${row.user_name ? ` (${row.user_name})` : ''}.`;

async function freshUser(db, id) {
  return A.shapeUser(await db.get('SELECT * FROM users WHERE id = ?', [id]));
}

function createRouter({ db, log }) {
  const r = express.Router();
  const authed = A.requireRole('Viewer');
  const editor = A.requireRole('Manager');
  const admin = A.requireRole('Admin');

  const masters = async () => ({
    sites: await db.all('SELECT * FROM sites ORDER BY name'),
    depts: await db.all('SELECT * FROM departments ORDER BY name')
  });

  /* ------------------------------------------------------------ auth ---- */

  r.post('/auth/login', async (req, res) => {
    const email = str(req.body && req.body.email, 200).toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const ip = req.ip || 'unknown';
    const key = A.throttleKey(email, ip);

    if (await A.tooManyAttempts(db, key)) {
      return fail(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again in 15 minutes.');
    }
    const row = email ? await db.get('SELECT * FROM users WHERE email = ?', [email]) : null;
    // Same message and roughly the same work either way: a distinct "no such
    // user" reply would let anyone enumerate accounts.
    const okPassword = row ? A.verifyPassword(password, row.pw_hash, row.pw_salt)
                           : A.verifyPassword(password, '00', 'x');
    if (!row || !okPassword || !row.active) {
      await A.noteFailure(db, key);
      await log(db, 'system', 'Sign-in failed', email || '(no email)');
      return fail(res, 401, 'INVALID_CREDENTIALS', 'That email and password do not match.');
    }

    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    // With a second factor enabled the password alone gets a short-lived,
    // half-authenticated session that opens nothing but the verify endpoint.
    if (Number(row.totp_enabled) === 1) {
      const pending = await A.createSession(db, row.id, true);
      res.setHeader('Set-Cookie', A.cookieHeader(pending.id, { secure, maxAgeSec: 600 }));
      return res.json({ mfaRequired: true });
    }

    await A.clearAttempts(db, key);
    const s2 = await A.createSession(db, row.id);
    res.setHeader('Set-Cookie', A.cookieHeader(s2.id, { secure, maxAgeSec: A.SESSION_DAYS * 86400 }));
    await log(db, row.name, 'Signed in', '');
    res.json({ user: A.shapeUser(row) });
  });

  /** Second factor: an authenticator code, or a single-use recovery code. */
  r.post('/auth/mfa', async (req, res) => {
    const pending = await A.pendingUserForSession(db, req.sessionId);
    if (!pending) return fail(res, 401, 'NO_PENDING_LOGIN', 'Start again from the sign-in screen.');
    const key = A.throttleKey(pending.email, req.ip || 'unknown');
    if (await A.tooManyAttempts(db, key)) {
      return fail(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again in 15 minutes.');
    }
    const code = String((req.body && req.body.code) || '');

    if (T.verifyTotp(pending.totpSecret, code)) {
      await A.promoteSession(db, req.sessionId);
      await A.clearAttempts(db, key);
      await log(db, pending.name, 'Signed in', 'with an authenticator code');
      return res.json({ user: await freshUser(db, pending.id) });
    }
    const used = T.useBackupCode(pending.backupCodes, code);
    if (used.ok) {
      await db.run('UPDATE users SET backup_codes = ? WHERE id = ?', [JSON.stringify(used.remaining), pending.id]);
      await A.promoteSession(db, req.sessionId);
      await A.clearAttempts(db, key);
      await log(db, pending.name, 'Signed in', `with a recovery code, ${used.remaining.length} left`);
      return res.json({ user: await freshUser(db, pending.id), backupCodesRemaining: used.remaining.length });
    }
    await A.noteFailure(db, key);
    await log(db, 'system', 'Second factor failed', pending.email);
    fail(res, 401, 'INVALID_CODE', 'That code is not valid.');
  });

  r.post('/auth/logout', async (req, res) => {
    await A.destroySession(db, req.sessionId);
    // The clearing cookie must carry the same attributes as the one it replaces.
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', A.cookieHeader('', { secure, maxAgeSec: 0 }));
    res.json({ ok: true });
  });

  r.get('/auth/me', (req, res) => {
    if (!req.user) return fail(res, 401, 'UNAUTHENTICATED', 'Sign in to continue.');
    res.json({ user: req.user });
  });

  r.post('/auth/password', authed, async (req, res) => {
    const current = String((req.body && req.body.currentPassword) || '');
    const next = String((req.body && req.body.newPassword) || '');
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!row || !A.verifyPassword(current, row.pw_hash, row.pw_salt)) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'The current password is wrong.');
    }
    const problem = A.passwordProblem(next);
    if (problem) return fail(res, 422, 'WEAK_PASSWORD', problem);
    const { hash, salt } = A.hashPassword(next);
    await db.run('UPDATE users SET pw_hash=?, pw_salt=?, must_change=0 WHERE id=?', [hash, salt, row.id]);
    // Every other session for this account is dropped: a password change should
    // evict anyone who had the old one.
    await db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [row.id, req.sessionId]);
    await log(db, req.user.name, 'Password changed', '');
    res.json({ ok: true });
  });

  /* --------------------------------------------- second factor setup ---- */

  /** Step one: hand out a secret. Nothing is enabled until a code proves it works. */
  r.post('/auth/mfa/setup', authed, async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (Number(row.totp_enabled) === 1) {
      return fail(res, 409, 'ALREADY_ENABLED', 'Two-factor sign-in is already on for this account.');
    }
    const secret = T.generateSecret();
    // Stored but not enabled: an abandoned setup leaves the account as it was.
    await db.run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', [secret, row.id]);
    res.json({ secret, uri: T.otpauthUri(secret, row.email) });
  });

  /** Step two: a correct code turns it on and returns the recovery codes once. */
  r.post('/auth/mfa/enable', authed, async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (Number(row.totp_enabled) === 1) return fail(res, 409, 'ALREADY_ENABLED', 'Already on.');
    if (!row.totp_secret) return fail(res, 400, 'NO_SETUP', 'Start with the setup step.');
    if (!T.verifyTotp(row.totp_secret, String((req.body && req.body.code) || ''))) {
      return fail(res, 401, 'INVALID_CODE', 'That code is not valid. Check your phone clock and try again.');
    }
    const codes = T.generateBackupCodes();
    await db.run('UPDATE users SET totp_enabled = 1, backup_codes = ? WHERE id = ?',
      [JSON.stringify(codes.map(T.hashBackupCode)), row.id]);
    await log(db, req.user.name, 'Two-factor enabled', '');
    // Shown once. Only hashes are kept, so they cannot be recovered later.
    res.json({ enabled: true, backupCodes: codes });
  });

  /** Turning it off needs the current password, not just an open session. */
  r.post('/auth/mfa/disable', authed, async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!A.verifyPassword(String((req.body && req.body.password) || ''), row.pw_hash, row.pw_salt)) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'That password is wrong.');
    }
    await db.run("UPDATE users SET totp_enabled = 0, totp_secret = NULL, backup_codes = '[]' WHERE id = ?", [row.id]);
    await log(db, req.user.name, 'Two-factor disabled', '');
    res.json({ enabled: false });
  });

  /* ------------------------------------------------- password recovery -- */

  /**
   * An administrator issues a reset token for someone who is locked out. There
   * is no mail server here, so the token is returned once for the administrator
   * to pass on by whatever channel they already trust.
   */
  r.post('/users/:id/reset-token', admin, async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'No such user.');
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + 3600000).toISOString();   // one hour
    // Only a hash is stored: a leaked database should not yield usable tokens.
    await db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [row.id]);
    await db.run('INSERT INTO password_resets (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)',
      [uid('r'), row.id, sha256(token), nowISO(), expires]);
    await log(db, req.user.name, 'Reset token issued', row.email);
    res.status(201).json({ token, expiresAt: expires, email: row.email });
  });

  /** Redeeming needs no session: the person is locked out, that is the point. */
  r.post('/auth/reset', async (req, res) => {
    // Throttled by address. The token itself is 24 random bytes, so guessing is
    // hopeless, but an unlimited endpoint is still an open invitation.
    const key = A.throttleKey('reset', req.ip || 'unknown');
    if (await A.tooManyAttempts(db, key)) {
      return fail(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Try again in 15 minutes.');
    }
    const token = String((req.body && req.body.token) || '');
    const newPassword = String((req.body && req.body.newPassword) || '');
    const problem = A.passwordProblem(newPassword);
    if (problem) return fail(res, 422, 'WEAK_PASSWORD', problem);

    const row = token ? await db.get('SELECT * FROM password_resets WHERE token_hash = ?', [sha256(token)]) : null;
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      await A.noteFailure(db, key);
      return fail(res, 401, 'INVALID_TOKEN', 'That reset link is not valid or has expired.');
    }
    await A.clearAttempts(db, key);
    const { hash, salt } = A.hashPassword(newPassword);
    await db.tx(async t => {
      await t.run('UPDATE users SET pw_hash=?, pw_salt=?, must_change=0 WHERE id=?', [hash, salt, row.user_id]);
      await t.run('UPDATE password_resets SET used_at = ? WHERE id = ?', [nowISO(), row.id]);
      // Anyone signed in with the old password is evicted.
      await t.run('DELETE FROM sessions WHERE user_id = ?', [row.user_id]);
    });
    const u = await db.get('SELECT name FROM users WHERE id = ?', [row.user_id]);
    await log(db, u ? u.name : 'system', 'Password reset', 'redeemed a reset token');
    res.json({ ok: true });
  });

  /* -------------------------------------------------------- bootstrap ---- */

  r.get('/bootstrap', authed, async (req, res) => {
    const m = await masters();
    const scoped = req.user.sites && req.user.sites.length;
    const assets = scoped
      ? await db.all(`SELECT * FROM assets WHERE site_code IN (${req.user.sites.map(() => '?').join(',')}) ORDER BY tag`,
          req.user.sites)
      : await db.all('SELECT * FROM assets ORDER BY tag');
    const settings = await db.all('SELECT * FROM settings');
    const bag = {};
    settings.forEach(s => { bag[s.skey] = jsonOr(s.value, null); });
    res.json({
      user: req.user,
      assets: assets.map(rowToAsset),
      sites: m.sites.map(s => ({ id: s.id, code: s.code, name: s.name, location: s.location, companyId: s.company_id })),
      depts: m.depts.map(d => ({ id: d.id, name: d.name })),
      companies: (await db.all('SELECT * FROM companies ORDER BY name')),
      fields: (await db.all('SELECT * FROM custom_fields ORDER BY label')).map(f => ({
        id: f.id, key: f.field_key, label: f.label, type: f.field_type,
        options: jsonOr(f.options, []), required: Boolean(f.required), inTable: Boolean(f.in_table)
      })),
      users: req.user.role === 'Admin'
        ? (await db.all('SELECT * FROM users ORDER BY name')).map(A.shapeUser) : [],
      theme: bag.theme || null,
      logo: bag.logo || null
    });
  });

  r.get('/activity', authed, async (req, res) => {
    const rows = await db.all('SELECT * FROM activity ORDER BY ts DESC LIMIT 300');
    res.json({ log: rows });
  });

  /* ------------------------------------------------------------ assets -- */

  r.post('/assets', editor, async (req, res) => {
    const m = await masters();
    const { valid, errors, value } = validateAsset(req.body || {}, { sites: m.sites, depts: m.depts });
    if (!valid) return fail(res, 422, 'VALIDATION_FAILED', 'One or more values are invalid.', { fields: errors });
    if (!A.siteAllowed(req.user, value.siteCode)) {
      return fail(res, 403, 'FORBIDDEN', 'You do not have access to that site.');
    }
    // An explicit tag is checked once and, if taken, rejected outright — the
    // person asked for that exact tag, so silently picking another would be
    // wrong. An auto-generated tag is retried on collision instead, since any
    // free tag satisfies the request and a collision there is just two people
    // creating assets on the same site at the same moment.
    const wantedTag = value.tag || null;
    if (wantedTag) {
      const clash = await db.get('SELECT id FROM assets WHERE lower(tag) = lower(?)', [wantedTag]);
      if (clash) return fail(res, 409, 'TAG_IN_USE', `Asset tag ${wantedTag} is already in use.`, { fields: { tag: `Asset tag ${wantedTag} is already in use.` } });
    }
    // Serial numbers identify physical hardware, so two assets sharing one is
    // almost always a mistake worth catching before it is saved, not after.
    // Blank is exempt: most of this register's legacy stock has no recorded serial.
    if (value.serial) {
      const dupe = await findBySerial(db, value.serial, null);
      if (dupe) return fail(res, 409, 'DUPLICATE_SERIAL', serialTakenMessage(dupe), { fields: { serial: serialTakenMessage(dupe) } });
    }

    const id = uid('a');
    const insertOne = async tag => db.run(
      `INSERT INTO assets (id,tag,serial,asset_type,brand,model,user_name,dept,site_code,cpu,ram,storage,os,
        status,vendor,purchase_price,purchase_year,warranty_end,custom,attachments,version,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      [id, tag, value.serial || '', value.type || 'Desktop', value.brand || '', value.model || '',
       value.user, value.dept || 'Unassigned', value.siteCode, value.cpu || '', value.ram || '',
       value.storage || '', value.os || '', value.status || 'In use', value.vendor || '',
       value.purchasePrice ?? null, value.purchaseYear ?? null, value.warrantyEnd || '',
       JSON.stringify(value.custom || {}), '[]', nowISO()]);

    let tag = wantedTag || await nextTag(db, value.siteCode);
    const MAX_RETRIES = 5;
    for (let attempt = 0; ; attempt++) {
      try {
        await insertOne(tag);
        break;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // The two pre-checks above are advisory; this DB-level catch is what
        // actually protects against two requests landing at the same instant.
        // duplicateField tells us WHICH constraint fired, so a serial race
        // is never misreported — and never blindly retried — as a tag problem.
        const col = duplicateField(err);
        if (col === 'serial') {
          const dupe = await findBySerial(db, value.serial, null);
          return fail(res, 409, 'DUPLICATE_SERIAL', dupe ? serialTakenMessage(dupe) : 'That serial number is already recorded.',
            { fields: { serial: dupe ? serialTakenMessage(dupe) : 'Already recorded on another asset.' } });
        }
        if (wantedTag) return fail(res, 409, 'TAG_IN_USE', `Asset tag ${wantedTag} is already in use.`, { fields: { tag: `Asset tag ${wantedTag} is already in use.` } });
        if (attempt >= MAX_RETRIES) {
          return fail(res, 409, 'TAG_IN_USE', 'Could not allocate a free asset tag. Try again.');
        }
        tag = await nextTag(db, value.siteCode);   // someone else just took the old one; pick the next
      }
    }
    await log(db, req.user.name, 'Created', `${tag} — ${value.user}`);
    res.status(201).json({ asset: rowToAsset(await db.get('SELECT * FROM assets WHERE id=?', [id])) });
  });

  r.put('/assets/:id', editor, async (req, res) => {
    const m = await masters();
    const existing = await db.get('SELECT * FROM assets WHERE id = ?', [req.params.id]);
    if (!existing) return fail(res, 404, 'NOT_FOUND', 'No such asset.');
    if (!A.siteAllowed(req.user, existing.site_code)) {
      return fail(res, 403, 'FORBIDDEN', 'You do not have access to that site.');
    }
    const clientVersion = Number(req.body && req.body.version);
    if (!Number.isInteger(clientVersion)) {
      return fail(res, 400, 'VERSION_REQUIRED', 'Include the version you loaded, so a concurrent edit can be detected.');
    }
    if (clientVersion !== Number(existing.version)) {
      return fail(res, 409, 'CONFLICT',
        'Someone else changed this asset since you opened it. Review their version, then apply your change.',
        { current: rowToAsset(existing) });
    }
    const { valid, errors, value } = validateAsset(req.body || {}, { partial: true, sites: m.sites, depts: m.depts });
    if (!valid) return fail(res, 422, 'VALIDATION_FAILED', 'One or more values are invalid.', { fields: errors });
    if (value.siteCode && !A.siteAllowed(req.user, value.siteCode)) {
      return fail(res, 403, 'FORBIDDEN', 'You cannot move an asset to a site you do not have access to.');
    }
    if (value.tag && value.tag.toLowerCase() !== existing.tag.toLowerCase()) {
      const clash = await db.get('SELECT id FROM assets WHERE lower(tag)=lower(?) AND id<>?', [value.tag, existing.id]);
      if (clash) return fail(res, 409, 'TAG_IN_USE', `Asset tag ${value.tag} is already in use.`, { fields: { tag: `Asset tag ${value.tag} is already in use.` } });
    }
    if (value.serial !== undefined && value.serial && value.serial.toLowerCase() !== existing.serial.toLowerCase()) {
      const dupe = await findBySerial(db, value.serial, existing.id);
      if (dupe) return fail(res, 409, 'DUPLICATE_SERIAL', serialTakenMessage(dupe), { fields: { serial: serialTakenMessage(dupe) } });
    }

    const map = { tag:'tag', serial:'serial', type:'asset_type', brand:'brand', model:'model', user:'user_name',
      dept:'dept', siteCode:'site_code', cpu:'cpu', ram:'ram', storage:'storage', os:'os', status:'status',
      vendor:'vendor', purchasePrice:'purchase_price', purchaseYear:'purchase_year', warrantyEnd:'warranty_end' };
    const sets = [], params = [];
    for (const [k, col] of Object.entries(map)) {
      if (value[k] !== undefined) { sets.push(`${col} = ?`); params.push(value[k]); }
    }
    if (value.custom !== undefined) { sets.push('custom = ?'); params.push(JSON.stringify(value.custom)); }
    sets.push('version = version + 1', 'updated_at = ?');
    params.push(nowISO(), existing.id, clientVersion);

    // The version is re-checked inside the UPDATE, so two requests arriving at
    // the same instant cannot both pass the read above and both write. A tag
    // or serial collision can still surface here if someone else claimed that
    // exact value in the gap since the pre-checks above — caught explicitly,
    // naming the right field, rather than leaking a raw database error.
    let out;
    try {
      out = await db.run(`UPDATE assets SET ${sets.join(', ')} WHERE id = ? AND version = ?`, params);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const col = duplicateField(err);
      if (col === 'serial') {
        const dupe = await findBySerial(db, value.serial, existing.id);
        return fail(res, 409, 'DUPLICATE_SERIAL', dupe ? serialTakenMessage(dupe) : 'That serial number is already recorded.',
          { fields: { serial: dupe ? serialTakenMessage(dupe) : 'Already recorded on another asset.' } });
      }
      return fail(res, 409, 'TAG_IN_USE', `Asset tag ${value.tag} is already in use.`, { fields: { tag: `Asset tag ${value.tag} is already in use.` } });
    }
    if (!out.changes) {
      const now = await db.get('SELECT * FROM assets WHERE id = ?', [existing.id]);
      return fail(res, 409, 'CONFLICT', 'Someone else changed this asset a moment ago.', { current: rowToAsset(now) });
    }
    await log(db, req.user.name, 'Updated', `${value.tag || existing.tag}`);
    res.json({ asset: rowToAsset(await db.get('SELECT * FROM assets WHERE id=?', [existing.id])) });
  });

  r.delete('/assets/:id', admin, async (req, res) => {
    const existing = await db.get('SELECT * FROM assets WHERE id = ?', [req.params.id]);
    if (!existing) return fail(res, 404, 'NOT_FOUND', 'No such asset.');
    await db.run('DELETE FROM assets WHERE id = ?', [existing.id]);
    await log(db, req.user.name, 'Deleted', existing.tag);
    res.json({ ok: true });
  });

  /** Bulk edits touch one column across many rows, so no version check applies. */
  r.post('/assets/bulk', editor, async (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 2000) : [];
    const patch = (req.body && req.body.patch) || {};
    if (!ids.length) return fail(res, 400, 'NO_IDS', 'Select at least one asset.');
    const allowed = ['status', 'siteCode', 'dept', 'vendor'];
    const key = Object.keys(patch).find(k => allowed.includes(k));
    if (!key) return fail(res, 400, 'BAD_PATCH', `Bulk edit supports: ${allowed.join(', ')}.`);

    const m = await masters();
    const { valid, errors, value } = validateAsset({ [key]: patch[key] }, { partial: true, sites: m.sites, depts: m.depts });
    if (!valid) return fail(res, 422, 'VALIDATION_FAILED', 'Invalid value.', { fields: errors });
    if (key === 'siteCode' && !A.siteAllowed(req.user, value.siteCode)) {
      return fail(res, 403, 'FORBIDDEN', 'You do not have access to that site.');
    }
    const col = { status: 'status', siteCode: 'site_code', dept: 'dept', vendor: 'vendor' }[key];

    const changed = await db.tx(async t => {
      let n = 0;
      for (const id of ids) {
        const row = await t.get('SELECT site_code FROM assets WHERE id = ?', [id]);
        if (!row || !A.siteAllowed(req.user, row.site_code)) continue;
        const out = await t.run(`UPDATE assets SET ${col} = ?, version = version + 1, updated_at = ? WHERE id = ?`,
          [value[key], nowISO(), id]);
        n += out.changes;
      }
      return n;
    });
    await log(db, req.user.name, 'Bulk update', `${key} set to ${value[key]} for ${changed} assets`);
    res.json({ changed });
  });

  r.post('/assets/import', editor, async (req, res) => {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows.slice(0, 5000) : [];
    if (!rows.length) return fail(res, 400, 'NO_ROWS', 'Nothing to import.');
    const m = await masters();
    // Keyed both ways: a real-world file as often gives a full site NAME
    // ("Dosti Greate County") as it does a short code ("HO"), so both must
    // resolve to the same site rather than one of them silently failing.
    const siteCodes = new Set(m.sites.map(s => s.code));
    const siteByCode = new Map(m.sites.map(s => [s.code.toLowerCase(), s.code]));
    const siteByName = new Map(m.sites.map(s => [s.name.toLowerCase(), s.code]));
    const usedSiteCodes = new Set(m.sites.map(s => s.code.toUpperCase()));
    const deptNames = new Set(m.depts.map(d => d.name));

    /**
     * Resolves a raw site value to a site code, creating a new site if
     * nothing matches — mirroring how an unrecognised department is already
     * handled below. Without this, any import from a file whose site names
     * don't already exist in this exact register (the normal case for a
     * fresh deployment, or any file from outside this app) has every single
     * row skipped, which reads as "only one row imported" whenever exactly
     * one row happens to match a site created some other way.
     */
    async function resolveSite(t, raw) {
      const value = str(raw, 120);
      if (!value) return null;
      const key = value.toLowerCase();
      if (siteByCode.has(key)) return siteByCode.get(key);
      if (siteByName.has(key)) return siteByName.get(key);

      const base = value.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'STE';
      // Appending the counter WITHOUT re-truncating: slicing back to 3 chars
      // after appending a two-digit suffix collapsed every code from n=10
      // onward to the same 3 characters, which looped forever the moment a
      // prefix collided ten times (very reachable on a real file where many
      // distinct site names share the same first three letters).
      let code = base, n = 1;
      while (usedSiteCodes.has(code) && n <= 9999) { code = `${base}${++n}`; }
      usedSiteCodes.add(code);

      const g = await guarded(t, () => t.run(
        'INSERT INTO sites (id,code,name,location,company_id) VALUES (?,?,?,?,?)',
        [uid('s'), code, value, '', '']));
      if (!g.ok) {
        // Someone else created a site with this exact code in the same instant;
        // the safe move is to look it up again rather than guess.
        const row = await t.get('SELECT code FROM sites WHERE lower(code) = lower(?)', [code]);
        if (row) code = row.code;
      }
      siteCodes.add(code); siteByCode.set(code.toLowerCase(), code); siteByName.set(key, code);
      return code;
    }
    const fieldDefs = await db.all('SELECT * FROM custom_fields');
    const fieldKeys = new Set(fieldDefs.map(f => f.field_key));
    const pickCustom = raw => {
      const out = {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
      for (const [k, v] of Object.entries(raw)) if (fieldKeys.has(k)) out[k] = str(v, 200);
      return out;
    };

    /**
     * In-batch duplicate detection, BEFORE anything touches the database.
     * Two rows sharing a tag or serial within the same uploaded file is
     * almost always a copy-paste mistake in the source sheet, not a
     * deliberate re-import — so only the first occurrence of each value
     * proceeds, and every later one is reported by row number rather than
     * silently merged into the first or silently dropped.
     */
    function findBatchDuplicates() {
      const byTag = new Map(), bySerial = new Map();
      rows.forEach((raw, i) => {
        const rec = raw && typeof raw === 'object' ? raw : {};
        const tag = str(rec.tag, 60).toLowerCase();
        const serial = str(rec.serial, 160).toLowerCase();
        if (tag) { if (!byTag.has(tag)) byTag.set(tag, []); byTag.get(tag).push(i); }
        if (serial) { if (!bySerial.has(serial)) bySerial.set(serial, []); bySerial.get(serial).push(i); }
      });
      const skipRow = new Map();   // row index -> { field, value, firstRow }
      for (const [value, idxs] of byTag) {
        if (idxs.length < 2) continue;
        for (let k = 1; k < idxs.length; k++) skipRow.set(idxs[k], { field: 'tag', value: rows[idxs[k]].tag, firstRow: idxs[0] + 1 });
      }
      for (const [value, idxs] of bySerial) {
        if (idxs.length < 2) continue;
        for (let k = 1; k < idxs.length; k++) if (!skipRow.has(idxs[k])) {
          skipRow.set(idxs[k], { field: 'serial', value: rows[idxs[k]].serial, firstRow: idxs[0] + 1 });
        }
      }
      return skipRow;
    }
    const batchDupes = findBatchDuplicates();

    let spCounter = 0;
    /** Postgres poisons a whole transaction on any statement error; SAVEPOINT scopes that to one row. */
    async function guarded(t, fn) {
      if (t.kind !== 'postgres') {
        try { return { ok: true, value: await fn() }; }
        catch (err) { if (isUniqueViolation(err)) return { ok: false, err }; throw err; }
      }
      const sp = `imp_${spCounter++}`;
      await t.run(`SAVEPOINT ${sp}`);
      try {
        const value = await fn();
        await t.run(`RELEASE SAVEPOINT ${sp}`);
        return { ok: true, value };
      } catch (err) {
        await t.run(`ROLLBACK TO SAVEPOINT ${sp}`);
        await t.run(`RELEASE SAVEPOINT ${sp}`);
        if (isUniqueViolation(err)) return { ok: false, err };
        throw err;
      }
    }

    const report = [];    // one entry per row: the detail behind every created/updated/skipped count
    const note = (rowNum, action, extra) => report.push({ row: rowNum, action, ...extra });

    const result = await db.tx(async t => {
      let created = 0, updated = 0, skipped = 0;
      for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 1;
        const raw = rows[i];
        const rec = raw && typeof raw === 'object' ? raw : {};
        const user = str(rec.user, 120);
        const tag = str(rec.tag, 60);
        const serial = str(rec.serial, 160);

        if (batchDupes.has(i)) {
          const d = batchDupes.get(i);
          skipped++;
          note(rowNum, 'skipped', { field: d.field, value: d.value,
            reason: `Duplicate ${d.field} — same as row ${d.firstRow} in this file.` });
          continue;
        }
        if (!user && !tag && !serial) {
          skipped++; note(rowNum, 'skipped', { reason: 'No assigned-to, tag, or serial number to identify this row.' });
          continue;
        }

        let existing = tag ? await t.get('SELECT * FROM assets WHERE lower(tag)=lower(?)', [tag]) : null;
        let ambiguousSerial = false;
        if (!existing && serial) {
          const bySerial = await t.all("SELECT * FROM assets WHERE serial <> '' AND lower(serial) = lower(?)", [serial]);
          if (bySerial.length === 1) existing = bySerial[0];
          else if (bySerial.length > 1) ambiguousSerial = true;
        }
        if (ambiguousSerial) {
          skipped++; note(rowNum, 'skipped', { field: 'serial', value: serial,
            reason: 'That serial number already appears on more than one existing asset — too ambiguous to update automatically.' });
          continue;
        }
        // A serial that names an EXISTING asset different from the one this row
        // is about to create/update is a real conflict, not an update target.
        if (serial) {
          const serialOwner = await t.get("SELECT tag FROM assets WHERE serial <> '' AND lower(serial) = lower(?) AND id <> ?",
            [serial, existing ? existing.id : '']);
          if (serialOwner && (!existing || serialOwner.tag.toLowerCase() !== existing.tag.toLowerCase())) {
            skipped++; note(rowNum, 'skipped', { field: 'serial', value: serial,
              reason: `Serial number is already recorded on asset ${serialOwner.tag}.` });
            continue;
          }
        }

        let site = await resolveSite(t, rec.siteCode);
        if (!site) site = await resolveSite(t, rec.defaultSite);
        if (!site && existing) site = existing.site_code;
        if (!site) {
          // Only reachable when the row gives no site at all and no default
          // was chosen either — there is nothing to create a site FROM.
          skipped++; note(rowNum, 'skipped', { field: 'siteCode', value: str(rec.siteCode, 12), reason: 'No site given and no default site selected.' });
          continue;
        }
        if (!A.siteAllowed(req.user, site) || (existing && !A.siteAllowed(req.user, existing.site_code))) {
          skipped++; note(rowNum, 'skipped', { reason: 'You do not have access to that site.' });
          continue;
        }
        let dept = str(rec.dept, 80);
        if (dept && !deptNames.has(dept)) {
          await guarded(t, () => t.run('INSERT INTO departments (id,name) VALUES (?,?)', [uid('d'), dept]));
          deptNames.add(dept);
        }
        if (!dept) dept = 'Unassigned';
        const status = STATUSES.includes(str(rec.status, 40)) ? str(rec.status, 40) : 'In use';
        const price = parsePrice(rec.purchasePrice);

        if (existing) {
          const cols = { serial:'serial', type:'asset_type', brand:'brand', model:'model', user:'user_name',
            dept:'dept', cpu:'cpu', ram:'ram', storage:'storage', os:'os', vendor:'vendor' };
          const sets = [], params = [];
          for (const [k, c] of Object.entries(cols)) {
            const v = str(rec[k], 160);
            if (v) { sets.push(`${c} = ?`); params.push(v); }
          }
          if (price !== null) { sets.push('purchase_price = ?'); params.push(price); }
          if (rec.status) { sets.push('status = ?'); params.push(status); }
          const incoming = pickCustom(rec.custom);
          if (Object.keys(incoming).length) {
            const merged = { ...jsonOr(existing.custom, {}), ...incoming };
            sets.push('custom = ?'); params.push(JSON.stringify(merged));
          }
          sets.push('version = version + 1', 'updated_at = ?');
          params.push(nowISO(), existing.id);
          const g = await guarded(t, () => t.run(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`, params));
          if (!g.ok) {
            skipped++; note(rowNum, 'skipped', { field: 'serial', value: serial, reason: 'Serial number collided with another asset during the update.' });
            continue;
          }
          updated++;
          note(rowNum, 'updated', { tag: existing.tag });
        } else {
          let finalTag = tag || await nextTagTx(t, site);
          const dupe = await t.get('SELECT id FROM assets WHERE lower(tag)=lower(?)', [finalTag]);
          if (dupe) {
            skipped++; note(rowNum, 'skipped', { field: 'tag', value: finalTag, reason: `Asset tag ${finalTag} is already in use.` });
            continue;
          }
          const doInsert = tg => t.run(
            `INSERT INTO assets (id,tag,serial,asset_type,brand,model,user_name,dept,site_code,cpu,ram,storage,os,
              status,vendor,purchase_price,purchase_year,warranty_end,custom,attachments,version,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]',1,?)`,
            [uid('a'), tg, str(rec.serial, 160), str(rec.type, 40) || 'Desktop', str(rec.brand, 80) || 'Unbranded',
             str(rec.model, 160), user || 'Unassigned', dept, site, str(rec.cpu, 160), str(rec.ram, 60),
             str(rec.storage, 80), str(rec.os, 80), status, str(rec.vendor, 120), price,
             Number(String(rec.purchaseYear || '').replace(/\D/g, '').slice(0, 4)) || null,
             str(rec.warrantyEnd, 40), JSON.stringify(pickCustom(rec.custom)), nowISO()]);

          // A single retry was not enough under real multi-request concurrency:
          // several simultaneous imports racing to create the same brand-new
          // site each compute their own "next" tag before any of them commits,
          // so more than one collision in a row is a real, observed outcome —
          // not a rare edge case. Loop like the single-asset-create endpoint
          // does, rather than retrying exactly once.
          let g = await guarded(t, () => doInsert(finalTag));
          let tagAttempts = 0;
          while (!g.ok && !tag && duplicateField(g.err) === 'tag' && tagAttempts < 8) {
            tagAttempts++;
            // Widening spread each attempt: small at first (keeps tags tidy
            // under light contention), wide enough by the last few attempts to
            // make repeat collisions statistically very unlikely even under
            // heavy concurrent writers to the same brand-new site.
            finalTag = await nextTagTx(t, site, tagAttempts * 15);
            g = await guarded(t, () => doInsert(finalTag));
          }
          if (!g.ok) {
            const col = g.err ? duplicateField(g.err) : null;
            skipped++;
            note(rowNum, 'skipped', col === 'serial'
              ? { field: 'serial', value: serial, reason: 'Serial number is already recorded on another asset.' }
              : { field: 'tag', value: finalTag, reason: `Asset tag ${finalTag} is already in use.` });
            continue;
          }
          created++;
          note(rowNum, 'created', { tag: finalTag });
        }
      }
      return { created, updated, skipped };
    });
    await log(db, req.user.name, 'Imported',
      `${result.created} created, ${result.updated} updated, ${result.skipped} skipped`);
    res.json({ ...result, report });
  });

  async function nextTag(d, code) { return nextTagTx(d, code); }
  /**
   * @param {number} spread On the first attempt, 0 — tags stay tidy and
   *   sequential for the common case of one writer. On a retry after a
   *   collision, callers pass a growing spread so concurrent retriers land on
   *   DIFFERENT candidate numbers instead of every one of them recomputing
   *   "count + 1" from the same not-yet-committed state and colliding again on
   *   the exact same number — which is what a plain retry with no spread does,
   *   and observably still fails under double-digit concurrent writers.
   */
  async function nextTagTx(t, code, spread = 0) {
    const rows = await t.all('SELECT tag FROM assets WHERE site_code = ?', [code]);
    const used = new Set(rows.map(r => String(r.tag).toUpperCase()));
    const jitter = spread ? Math.floor(Math.random() * spread) : 0;
    let i = rows.length + 1 + jitter, tag;
    do { tag = `${code}-PC-${String(i).padStart(3, '0')}`; i++; } while (used.has(tag.toUpperCase()));
    return tag;
  }

  /* ----------------------------------------------------------- masters -- */

  const master = (routePath, table, shape, validate) => {
    r.post(routePath, admin, async (req, res) => {
      const v = validate(req.body || {});
      if (v.error) return fail(res, 422, 'VALIDATION_FAILED', v.error);
      const dup = v.unique ? await db.get(`SELECT id FROM ${table} WHERE lower(${v.unique.col}) = lower(?)`, [v.unique.value]) : null;
      if (dup) return fail(res, 409, 'DUPLICATE', v.unique.message);
      const id = uid(v.prefix);
      // The pre-check above is advisory; two admins adding the same code at
      // the same moment can both pass it. The INSERT is the real check.
      try {
        await db.run(v.insert.sql, [id, ...v.insert.params]);
      } catch (err) {
        if (isUniqueViolation(err)) return fail(res, 409, 'DUPLICATE', v.unique ? v.unique.message : 'That record already exists.');
        throw err;
      }
      await log(db, req.user.name, `${v.label} added`, v.unique ? v.unique.value : id);
      res.status(201).json({ item: shape(await db.get(`SELECT * FROM ${table} WHERE id = ?`, [id])) });
    });
    r.delete(routePath + '/:id', admin, async (req, res) => {
      const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
      if (!row) return fail(res, 404, 'NOT_FOUND', 'No such record.');
      const inUse = await v_inUse(table, row);
      if (inUse) return fail(res, 409, 'IN_USE', inUse);
      await db.run(`DELETE FROM ${table} WHERE id = ?`, [row.id]);
      await log(db, req.user.name, 'Removed', `${table}: ${row.name || row.label || row.id}`);
      res.json({ ok: true });
    });
  };
  async function v_inUse(table, row) {
    if (table === 'sites') {
      const n = await db.get('SELECT count(*) AS c FROM assets WHERE site_code = ?', [row.code]);
      if (Number(n.c) > 0) return `That site still has ${n.c} assets. Move them first.`;
    }
    if (table === 'departments') {
      const n = await db.get('SELECT count(*) AS c FROM assets WHERE dept = ?', [row.name]);
      if (Number(n.c) > 0) return `That department still has ${n.c} assets. Reassign them first.`;
    }
    if (table === 'companies') {
      const n = await db.get('SELECT count(*) AS c FROM sites WHERE company_id = ?', [row.id]);
      if (Number(n.c) > 0) return 'That company still has sites. Remove them first.';
    }
    return null;
  }

  master('/sites', 'sites',
    s => ({ id: s.id, code: s.code, name: s.name, location: s.location, companyId: s.company_id }),
    b => {
      const name = exact(b.name, 120);
      const rawCode = exact(b.code, 12);
      if (name === null) return { error: 'Site name must be 120 characters or fewer.' };
      if (rawCode === null) return { error: 'Site code must be 2 to 12 letters or digits.' };
      const code = rawCode.toUpperCase();
      if (!name || !code) return { error: 'Site name and code are both required.' };
      if (!/^[A-Z0-9]{2,12}$/.test(code)) return { error: 'Site code must be 2 to 12 letters or digits.' };
      return { prefix: 's', label: 'Site', unique: { col: 'code', value: code, message: 'That site code is already used.' },
        insert: { sql: 'INSERT INTO sites (id,code,name,location,company_id) VALUES (?,?,?,?,?)',
          params: [code, name, str(b.location, 160), str(b.companyId, 60)] } };
    });

  master('/departments', 'departments', d => ({ id: d.id, name: d.name }), b => {
    const name = exact(b.name, 80);
    if (name === null) return { error: 'Department name must be 80 characters or fewer.' };
    if (!name) return { error: 'Department name is required.' };
    return { prefix: 'd', label: 'Department', unique: { col: 'name', value: name, message: 'That department already exists.' },
      insert: { sql: 'INSERT INTO departments (id,name) VALUES (?,?)', params: [name] } };
  });

  master('/companies', 'companies', c => ({ id: c.id, name: c.name, code: c.code }), b => {
    const name = exact(b.name, 120);
    const rawCode = exact(b.code, 12);
    if (name === null) return { error: 'Company name must be 120 characters or fewer.' };
    if (rawCode === null) return { error: 'Company code must be 12 characters or fewer.' };
    const code = rawCode.toUpperCase();
    if (!name || !code) return { error: 'Company name and code are both required.' };
    if (!/^[A-Z0-9]{2,12}$/.test(code)) return { error: 'Company code must be 2 to 12 letters or digits.' };
    return { prefix: 'c', label: 'Company', unique: { col: 'code', value: code, message: 'That company code is already used.' },
      insert: { sql: 'INSERT INTO companies (id,name,code) VALUES (?,?,?)', params: [name, code] } };
  });

  r.put('/departments/:id', admin, async (req, res) => {
    const row = await db.get('SELECT * FROM departments WHERE id = ?', [req.params.id]);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'No such department.');
    const name = exact(req.body && req.body.name, 80);
    if (name === null) return fail(res, 422, 'VALIDATION_FAILED', 'Department name must be 80 characters or fewer.');
    if (!name) return fail(res, 422, 'VALIDATION_FAILED', 'Department name is required.');
    const dup = await db.get('SELECT id FROM departments WHERE lower(name)=lower(?) AND id<>?', [name, row.id]);
    if (dup) return fail(res, 409, 'DUPLICATE', 'That department already exists.');
    await db.tx(async t => {
      await t.run('UPDATE departments SET name = ? WHERE id = ?', [name, row.id]);
      await t.run('UPDATE assets SET dept = ?, version = version + 1, updated_at = ? WHERE dept = ?',
        [name, nowISO(), row.name]);
    });
    await log(db, req.user.name, 'Department renamed', `${row.name} to ${name}`);
    res.json({ item: { id: row.id, name } });
  });

  /* ---------------------------------------------------- custom fields --- */

  r.post('/fields', admin, async (req, res) => {
    const label = exact(req.body && req.body.label, 80);
    if (label === null) return fail(res, 422, 'VALIDATION_FAILED', 'Label must be 80 characters or fewer.');
    if (!label) return fail(res, 422, 'VALIDATION_FAILED', 'Give the field a label.');
    const type = str(req.body && req.body.type, 20) || 'text';
    if (!FIELD_TYPES.includes(type)) return fail(res, 422, 'VALIDATION_FAILED', `Type must be one of: ${FIELD_TYPES.join(', ')}.`);
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || ('f' + Date.now());
    const dup = await db.get('SELECT id FROM custom_fields WHERE field_key = ?', [key]);
    if (dup) return fail(res, 409, 'DUPLICATE', 'A field with that name already exists.');
    const options = Array.isArray(req.body.options) ? req.body.options.map(o => str(o, 80)).filter(Boolean).slice(0, 50) : [];
    const id = uid('f');
    try {
      await db.run('INSERT INTO custom_fields (id,field_key,label,field_type,options,required,in_table) VALUES (?,?,?,?,?,?,?)',
        [id, key, label, type, JSON.stringify(options), req.body.required ? 1 : 0, req.body.inTable ? 1 : 0]);
    } catch (err) {
      if (isUniqueViolation(err)) return fail(res, 409, 'DUPLICATE', 'A field with that name already exists.');
      throw err;
    }
    await log(db, req.user.name, 'Field added', label);
    res.status(201).json({ field: { id, key, label, type, options, required: !!req.body.required, inTable: !!req.body.inTable } });
  });

  r.put('/fields/:id', admin, async (req, res) => {
    const row = await db.get('SELECT * FROM custom_fields WHERE id = ?', [req.params.id]);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'No such field.');
    const required = req.body.required === undefined ? row.required : (req.body.required ? 1 : 0);
    const inTable = req.body.inTable === undefined ? row.in_table : (req.body.inTable ? 1 : 0);
    await db.run('UPDATE custom_fields SET required=?, in_table=? WHERE id=?', [required, inTable, row.id]);
    res.json({ ok: true });
  });

  r.delete('/fields/:id', admin, async (req, res) => {
    const row = await db.get('SELECT * FROM custom_fields WHERE id = ?', [req.params.id]);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'No such field.');
    await db.run('DELETE FROM custom_fields WHERE id = ?', [row.id]);
    await log(db, req.user.name, 'Field removed', row.label);
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------- users -- */

  r.post('/users', admin, async (req, res) => {
    const name = exact(req.body && req.body.name, 120);
    const rawEmail = exact(req.body && req.body.email, 200);
    if (name === null) return fail(res, 422, 'VALIDATION_FAILED', 'Name must be 120 characters or fewer.');
    if (rawEmail === null) return fail(res, 422, 'VALIDATION_FAILED', 'Email must be 200 characters or fewer.');
    const email = rawEmail.toLowerCase();
    const role = str(req.body && req.body.role, 20);
    const password = String((req.body && req.body.password) || '');
    if (!name || !email) return fail(res, 422, 'VALIDATION_FAILED', 'Name and email are both required.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 422, 'VALIDATION_FAILED', 'Enter a valid email address.');
    if (!A.ROLES.includes(role)) return fail(res, 422, 'VALIDATION_FAILED', `Role must be one of: ${A.ROLES.join(', ')}.`);
    const problem = A.passwordProblem(password);
    if (problem) return fail(res, 422, 'WEAK_PASSWORD', problem);
    const dup = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (dup) return fail(res, 409, 'DUPLICATE', 'That email already has an account.');
    const { hash, salt } = A.hashPassword(password);
    const id = uid('u');
    const sites = Array.isArray(req.body.sites) ? req.body.sites.map(s => str(s, 12)).slice(0, 50) : [];
    try {
      await db.run(
        `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,active,sites,must_change,created_at)
         VALUES (?,?,?,?,?,?,1,?,1,?)`,
        [id, email, name, role, hash, salt, JSON.stringify(sites), nowISO()]);
    } catch (err) {
      if (isUniqueViolation(err)) return fail(res, 409, 'DUPLICATE', 'That email already has an account.');
      throw err;
    }
    await log(db, req.user.name, 'User created', `${name} as ${role}`);
    res.status(201).json({ user: A.shapeUser(await db.get('SELECT * FROM users WHERE id=?', [id])) });
  });

  r.put('/users/:id', admin, async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'No such user.');
    const sets = [], params = [];
    if (req.body.role !== undefined) {
      if (!A.ROLES.includes(req.body.role)) return fail(res, 422, 'VALIDATION_FAILED', 'Unknown role.');
      // Removing the last administrator would lock everyone out of the settings.
      if (row.role === 'Admin' && req.body.role !== 'Admin' && await lastAdmin(db, row.id)) {
        return fail(res, 409, 'LAST_ADMIN', 'This is the only administrator. Promote someone else first.');
      }
      sets.push('role = ?'); params.push(req.body.role);
    }
    if (req.body.active !== undefined) {
      const active = req.body.active ? 1 : 0;
      if (!active && row.role === 'Admin' && await lastAdmin(db, row.id)) {
        return fail(res, 409, 'LAST_ADMIN', 'This is the only administrator. Promote someone else first.');
      }
      sets.push('active = ?'); params.push(active);
      if (!active) await db.run('DELETE FROM sessions WHERE user_id = ?', [row.id]);
    }
    if (req.body.sites !== undefined) {
      const sites = Array.isArray(req.body.sites) ? req.body.sites.map(s => str(s, 12)).slice(0, 50) : [];
      sets.push('sites = ?'); params.push(JSON.stringify(sites));
    }
    if (!sets.length) return fail(res, 400, 'NOTHING_TO_DO', 'No changes were supplied.');
    params.push(row.id);
    await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    await log(db, req.user.name, 'User updated', row.name);
    res.json({ user: A.shapeUser(await db.get('SELECT * FROM users WHERE id=?', [row.id])) });
  });

  r.delete('/users/:id', admin, async (req, res) => {
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'No such user.');
    if (row.id === req.user.id) return fail(res, 409, 'SELF', 'You cannot remove your own account.');
    if (row.role === 'Admin' && await lastAdmin(db, row.id)) {
      return fail(res, 409, 'LAST_ADMIN', 'This is the only administrator.');
    }
    await db.run('DELETE FROM sessions WHERE user_id = ?', [row.id]);
    await db.run('DELETE FROM users WHERE id = ?', [row.id]);
    await log(db, req.user.name, 'User removed', row.name);
    res.json({ ok: true });
  });

  async function lastAdmin(d, exceptId) {
    const n = await d.get('SELECT count(*) AS c FROM users WHERE role = ? AND active = 1 AND id <> ?', ['Admin', exceptId]);
    return Number(n.c) === 0;
  }

  return r;
}

module.exports = { createRouter, rowToAsset, validateAsset, parsePrice, STATUSES, TYPES, FIELD_TYPES };
