'use strict';
/**
 * Upload validation, running on the SERVER.
 *
 * Previously this lived only in the browser, which meant a request sent straight
 * to the API skipped every check. The browser copy may stay as a courtesy, but
 * this is the copy that decides.
 */
const crypto = require('node:crypto');

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const EXT = { png: '.png', jpeg: '.jpg', svg: '.svg' };
const MIME = { png: 'image/png', jpeg: 'image/jpeg', svg: 'image/svg+xml' };

/** Identifies the real format from magic bytes; the declared type is ignored. */
function sniffFormat(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const head = buf.subarray(0, 2048).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^<(\?xml|!DOCTYPE svg|svg)[\s>]/i.test(head) && /<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

function looksComplete(buf, format) {
  if (format === 'png') {
    return buf.length > 20 && buf.subarray(buf.length - 8).toString('latin1') === 'IEND\xae\x42\x60\x82';
  }
  if (format === 'jpeg') {
    return buf.length > 4 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  }
  if (format === 'svg') return /<\/svg\s*>\s*$/i.test(buf.toString('utf8').trimEnd());
  return false;
}

/**
 * Strips active content from an SVG. Served same-origin, an SVG is an HTML
 * document to the browser, so a <script> inside it would run with the viewer's
 * session. Rejecting SVG outright is safer; this exists because the product
 * needs SVG logos.
 */
function sanitizeSvg(text) {
  let s = String(text);
  let previous;
  // Repeat until stable: a single pass can leave a payload that only becomes
  // visible once an outer wrapper is removed.
  do {
    previous = s;
    s = s.replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '');
    s = s.replace(/<\s*(foreignObject|iframe|embed|object|animate|animateTransform|set|handler)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    s = s.replace(/<\s*(script|foreignObject|iframe|embed|object|use|animate|set)\b[^>]*\/\s*>/gi, '');
    s = s.replace(/<\s*(script|foreignObject|iframe|embed|object)\b[^>]*>/gi, '');
    s = s.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    s = s.replace(/(href|xlink:href)\s*=\s*(?:"|')?\s*(?:javascript|data|vbscript)\s*:[^"'>\s]*(?:"|')?/gi, '');
    s = s.replace(/<!ENTITY[\s\S]*?>/gi, '');
    s = s.replace(/<\s*!DOCTYPE[^>]*\[[\s\S]*?\]\s*>/gi, '');
    s = s.replace(/<\s*!DOCTYPE[^>]*>/gi, '');
  } while (s !== previous);
  return s;
}

/**
 * Validates a logo and returns what should be stored.
 * @param {Buffer} buf raw bytes
 * @returns {{ok:true,file:object}|{ok:false,code:string,status:number,message:string}}
 */
function prepareLogo(buf) {
  if (!buf || buf.length === 0) {
    return { ok: false, status: 422, code: 'EMPTY_FILE', message: 'The uploaded file is empty.' };
  }
  if (buf.length > MAX_LOGO_BYTES) {
    return { ok: false, status: 413, code: 'FILE_TOO_LARGE', message: 'Logo must be 2 MB or smaller.' };
  }
  const format = sniffFormat(buf);
  if (!format) {
    return { ok: false, status: 415, code: 'UNSUPPORTED_TYPE', message: 'Only PNG, JPG and SVG files are accepted.' };
  }
  if (!looksComplete(buf, format)) {
    return { ok: false, status: 422, code: 'CORRUPT_FILE', message: 'The image file appears to be truncated or corrupt.' };
  }

  let payload = buf, stripped = 0;
  if (format === 'svg') {
    const raw = buf.toString('utf8');
    const clean = sanitizeSvg(raw);
    stripped = Buffer.byteLength(raw) - Buffer.byteLength(clean);
    payload = Buffer.from(clean, 'utf8');
  }
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  // The name is derived from content, never from the client: no traversal, free
  // deduplication, and a URL that only changes when the image does.
  const name = `logo-${sha256.slice(0, 32)}${EXT[format]}`;
  return {
    ok: true,
    // The raw buffer goes to the database as binary; base64 would cost a third
    // more space on every read and write.
    file: { name, mime: MIME[format], bytes: payload.length, sha256, content: payload, format, stripped }
  };
}

/**
 * Decodes a base64 payload defensively; a malformed one must not throw.
 * The limit here is a memory guard, deliberately larger than the product rule:
 * a slightly oversize image should be reported as "too large" by prepareLogo,
 * not as a malformed payload.
 */
const DECODE_CEILING = 8 * 1024 * 1024;
function decodeBase64(s, limitBytes = DECODE_CEILING) {
  if (typeof s !== 'string') return null;
  const cleaned = s.includes(',') && s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
  if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(cleaned)) return null;
  // Reject before allocating: base64 inflates by 4/3.
  if (cleaned.length > (limitBytes + 16) * 4 / 3 + 16) return null;
  const buf = Buffer.from(cleaned, 'base64');
  return buf.length ? buf : null;
}

module.exports = { MAX_LOGO_BYTES, DECODE_CEILING, EXT, MIME, sniffFormat, looksComplete, sanitizeSvg, prepareLogo, decodeBase64 };
