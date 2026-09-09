'use strict';
/**
 * Time-based one-time passwords, RFC 6238. Implemented directly rather than
 * pulled in: the algorithm is short, and an authentication dependency is a
 * dependency worth not having.
 */
const crypto = require('node:crypto');

const DIGITS = 6;
const PERIOD = 30;              // seconds per code
const WINDOW = 1;               // accept the neighbouring step either way
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, which is what authenticator apps expect. */
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

/** @returns {string} the DIGITS-long code for a given counter step. */
function hotp(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) |
                 (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

const totp = (secret, at = Date.now()) => hotp(secret, Math.floor(at / 1000 / PERIOD));

/**
 * Checks a submitted code against the current step and its neighbours, which
 * covers ordinary clock drift. Comparison is constant-time.
 */
function verifyTotp(secret, code, at = Date.now()) {
  const given = String(code || '').replace(/\D/g, '');
  if (given.length !== DIGITS) return false;
  const step = Math.floor(at / 1000 / PERIOD);
  for (let w = -WINDOW; w <= WINDOW; w++) {
    const expected = hotp(secret, step + w);
    const a = Buffer.from(expected), b = Buffer.from(given);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** The URI an authenticator app reads from a QR code. */
function otpauthUri(secret, email, issuer = 'AssetOps') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(PERIOD) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/**
 * Recovery codes for a lost phone. They are high-entropy, so a salted SHA-256
 * is enough — scrypt on ten codes per login attempt would be wasteful.
 */
function generateBackupCodes(n = 10) {
  const plain = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    plain.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return plain;
}
const hashBackupCode = code =>
  crypto.createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

/**
 * Consumes a recovery code if it matches an unused one.
 * @returns {{ok:boolean, remaining:string[]}} remaining hashes to store back
 */
function useBackupCode(storedHashes, submitted) {
  const h = hashBackupCode(submitted);
  const idx = storedHashes.indexOf(h);
  if (idx < 0) return { ok: false, remaining: storedHashes };
  const remaining = storedHashes.slice();
  remaining.splice(idx, 1);        // single use
  return { ok: true, remaining };
}

module.exports = { DIGITS, PERIOD, generateSecret, hotp, totp, verifyTotp,
  otpauthUri, generateBackupCodes, hashBackupCode, useBackupCode, base32Encode, base32Decode };
