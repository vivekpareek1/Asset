'use strict';
/** Theme and logo endpoints. Upload validation happens here, on the server. */
const express = require('express');
const A = require('./auth');
const L = require('./logo');
const { nowISO } = require('./db');

const FONT_IDS = ['system', 'inter', 'plex-sans', 'source-sans', 'roboto', 'lora', 'georgia'];
const DEFAULT_THEME = Object.freeze({
  primaryColor: '#1e5a78', secondaryColor: '#2f6b4c', textColor: '#17222e',
  backgroundColor: '#ffffff', fontFamily: 'system', fontSize: 14
});
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const normHex = v => {
  const s = String(v).trim().toLowerCase();
  return s.length === 4 ? '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3] : s;
};

function validateTheme(input, base) {
  const errors = {}, value = { ...base };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: { _: 'Body must be an object.' }, value };
  }
  for (const k of ['primaryColor', 'secondaryColor', 'textColor', 'backgroundColor']) {
    if (input[k] === undefined) continue;
    if (typeof input[k] !== 'string' || !HEX.test(input[k].trim())) errors[k] = 'Must be a hex colour such as #1e5a78.';
    else value[k] = normHex(input[k]);
  }
  if (input.fontFamily !== undefined) {
    // An allowlist, never free text: this value lands in a CSS custom property.
    if (!FONT_IDS.includes(input.fontFamily)) errors.fontFamily = `Must be one of: ${FONT_IDS.join(', ')}.`;
    else value.fontFamily = input.fontFamily;
  }
  if (input.fontSize !== undefined) {
    const n = Number(input.fontSize);
    if (!Number.isInteger(n) || n < 12 || n > 32) errors.fontSize = 'Must be a whole number between 12 and 32.';
    else value.fontSize = n;
  }
  return { valid: Object.keys(errors).length === 0, errors, value };
}

const fail = (res, status, code, message, extra) =>
  res.status(status).json({ error: { code, message, ...(extra || {}) } });

async function getSetting(db, key, fallback) {
  const row = await db.get('SELECT value FROM settings WHERE skey = ?', [key]);
  if (!row) return fallback;
  try { const v = JSON.parse(row.value); return v == null ? fallback : v; } catch { return fallback; }
}
async function putSetting(db, key, value) {
  const existing = await db.get('SELECT skey FROM settings WHERE skey = ?', [key]);
  if (existing) await db.run('UPDATE settings SET value = ?, updated_at = ? WHERE skey = ?', [JSON.stringify(value), nowISO(), key]);
  else await db.run('INSERT INTO settings (skey,value,updated_at) VALUES (?,?,?)', [key, JSON.stringify(value), nowISO()]);
}

function createSettingsRouter({ db, log }) {
  const r = express.Router();
  const admin = A.requireRole('Admin');

  r.get('/theme', A.requireRole('Viewer'), async (req, res) => {
    res.json({
      theme: await getSetting(db, 'theme', { ...DEFAULT_THEME }),
      logo: await getSetting(db, 'logo', null),
      fonts: FONT_IDS, defaults: DEFAULT_THEME
    });
  });

  r.put('/theme', admin, async (req, res) => {
    const current = await getSetting(db, 'theme', { ...DEFAULT_THEME });
    const { valid, errors, value } = validateTheme(req.body, current);
    if (!valid) return fail(res, 422, 'VALIDATION_FAILED', 'One or more values are invalid.', { fields: errors });
    await putSetting(db, 'theme', value);
    await log(db, req.user.name, 'Theme updated', `${value.primaryColor}, ${value.fontFamily}, ${value.fontSize}px`);
    res.json({ theme: value });
  });

  r.post('/theme/reset', admin, async (req, res) => {
    const action = req.body && req.body.logoAction;
    if (!['keep', 'delete'].includes(action)) {
      return fail(res, 400, 'LOGO_ACTION_REQUIRED', 'Specify logoAction: "keep" or "delete".');
    }
    const existing = await getSetting(db, 'logo', null);
    await putSetting(db, 'theme', { ...DEFAULT_THEME });
    if (action === 'delete' && existing) {
      await putSetting(db, 'logo', null);          // commit the record first
      await db.run('DELETE FROM files WHERE name = ?', [existing.filename]);
      await log(db, req.user.name, 'Theme reset', 'defaults restored, logo deleted');
      return res.json({ theme: DEFAULT_THEME, logo: null, logoDeleted: true });
    }
    await log(db, req.user.name, 'Theme reset', 'defaults restored, logo kept');
    res.json({ theme: DEFAULT_THEME, logo: existing, logoDeleted: false });
  });

  /**
   * Upload. The payload is base64 in JSON rather than multipart, which keeps the
   * CSRF rule (application/json only) intact without a form-parsing dependency.
   */
  r.post('/logo', admin, async (req, res) => {
    const buf = L.decodeBase64(req.body && req.body.data);
    if (!buf) return fail(res, 400, 'BAD_PAYLOAD', 'Send { "data": "<base64>" } containing the image.');

    const prepared = L.prepareLogo(buf);
    if (!prepared.ok) return fail(res, prepared.status, prepared.code, prepared.message);
    const f = prepared.file;

    const already = await db.get('SELECT name FROM files WHERE name = ?', [f.name]);
    if (!already) {
      // node:sqlite wants a Uint8Array; pg accepts a Buffer for BYTEA.
      const blob = db.kind === 'postgres' ? f.content : new Uint8Array(f.content);
      await db.run('INSERT INTO files (name,mime,bytes,sha256,content,created_at) VALUES (?,?,?,?,?,?)',
        [f.name, f.mime, f.bytes, f.sha256, blob, nowISO()]);
    }
    const previous = await getSetting(db, 'logo', null);
    const record = { filename: f.name, format: f.format, bytes: f.bytes, sha256: f.sha256,
                     url: `/uploads/${f.name}`, uploadedAt: nowISO() };
    await putSetting(db, 'logo', record);
    // Only now is it safe to drop the old file; and never when the hash matches.
    if (previous && previous.filename !== f.name) {
      await db.run('DELETE FROM files WHERE name = ?', [previous.filename]);
    }
    await log(db, req.user.name, 'Logo uploaded', f.name + (already ? ' (already stored)' : ''));
    res.status(201).json({ logo: record, replaced: Boolean(previous), deduplicated: Boolean(already), sanitizedBytes: f.stripped });
  });

  r.delete('/logo', admin, async (req, res) => {
    const existing = await getSetting(db, 'logo', null);
    if (!existing) return fail(res, 404, 'NO_LOGO', 'There is no logo to remove.');
    await putSetting(db, 'logo', null);
    await db.run('DELETE FROM files WHERE name = ?', [existing.filename]);
    await log(db, req.user.name, 'Logo removed', existing.filename);
    res.json({ logo: null, deleted: true });
  });

  return r;
}

/** Serves stored files. Headers matter as much as the sanitiser upstream. */
function serveUploads({ db }) {
  return async (req, res) => {
    const name = String(req.params.name || '');
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) return res.status(400).end();
    const row = await db.get('SELECT * FROM files WHERE name = ?', [name]);
    if (!row) return res.status(404).end();
    res.setHeader('Content-Type', row.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // name is a content hash
    res.setHeader('Content-Length', String(row.bytes));
    res.end(Buffer.from(row.content));
  };
}

module.exports = { createSettingsRouter, serveUploads, validateTheme, DEFAULT_THEME, FONT_IDS, getSetting, putSetting };
