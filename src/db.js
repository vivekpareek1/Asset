'use strict';
/**
 * Storage layer.
 *
 * One row per record, not one JSON blob. Two people editing different assets no
 * longer overwrite each other, and editing the SAME asset is caught by an
 * optimistic version check rather than silently losing a change.
 *
 * Two drivers behind one interface: Postgres in production, the built-in SQLite
 * for local runs and tests. The SQL is written once; only the placeholder style
 * differs, so the tested path and the deployed path are the same code.
 */
const crypto = require('node:crypto');

/**
 * Schema. Binary columns differ between drivers, so the type is substituted per
 * driver rather than storing images as base64 text — base64 costs a third more
 * space on every read and write.
 */
function schemaFor(kind) {
  const BLOB = kind === 'postgres' ? 'BYTEA' : 'BLOB';
  return [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
     role TEXT NOT NULL, pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 1, sites TEXT NOT NULL DEFAULT '[]',
     must_change INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
     totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
     backup_codes TEXT NOT NULL DEFAULT '[]')`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL, mfa_pending INTEGER NOT NULL DEFAULT 0)`,
  // Throttling lives in the database so every instance shares one counter.
  `CREATE TABLE IF NOT EXISTS login_attempts (
     akey TEXT PRIMARY KEY, first_at TEXT NOT NULL, attempts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS password_resets (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL,
     created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sites (
     id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
     location TEXT NOT NULL DEFAULT '', company_id TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS custom_fields (
     id TEXT PRIMARY KEY, field_key TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
     field_type TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]',
     required INTEGER NOT NULL DEFAULT 0, in_table INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS assets (
     id TEXT PRIMARY KEY, tag TEXT UNIQUE NOT NULL, serial TEXT NOT NULL DEFAULT '',
     asset_type TEXT NOT NULL DEFAULT 'Desktop', brand TEXT NOT NULL DEFAULT '',
     model TEXT NOT NULL DEFAULT '', user_name TEXT NOT NULL DEFAULT '',
     dept TEXT NOT NULL DEFAULT 'Unassigned', site_code TEXT NOT NULL,
     cpu TEXT NOT NULL DEFAULT '', ram TEXT NOT NULL DEFAULT '',
     storage TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'In use', vendor TEXT NOT NULL DEFAULT '',
     purchase_price REAL, purchase_year INTEGER,
     warranty_end TEXT NOT NULL DEFAULT '', custom TEXT NOT NULL DEFAULT '{}',
     attachments TEXT NOT NULL DEFAULT '[]',
     version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (skey TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS files (
     name TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
     sha256 TEXT NOT NULL, content ${BLOB} NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS activity (
     id TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL,
     action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS idx_assets_site ON assets(site_code)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id)`
  ];
}

/**
 * Adds columns an older database is missing. Kept separate from the CREATE
 * statements, which only run for a fresh install.
 */
const ADDED_COLUMNS = [
  ['users', 'totp_secret', 'TEXT'],
  ['users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'backup_codes', "TEXT NOT NULL DEFAULT '[]'"],
  ['sessions', 'mfa_pending', 'INTEGER NOT NULL DEFAULT 0']
];

/** Rewrites `?` placeholders to $1, $2 … for Postgres. */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

class SqliteDb {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.kind = 'sqlite';
  }
  async init() {
    for (const stmt of schemaFor('sqlite')) this.db.exec(stmt);
    for (const [table, col, type] of ADDED_COLUMNS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some(c => c.name === col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  }
  async all(sql, params = []) { return this.db.prepare(sql).all(...params); }
  async get(sql, params = []) { const r = this.db.prepare(sql).all(...params); return r[0] || null; }
  async run(sql, params = []) { const r = this.db.prepare(sql).run(...params); return { changes: Number(r.changes) }; }
  /** Serialises the whole transaction; SQLite has one writer anyway. */
  async tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = await fn(this); this.db.exec('COMMIT'); return out; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }
  async close() { this.db.close(); }
}

class PgDb {
  constructor(connectionString) {
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 6 });
    this.kind = 'postgres';
  }
  async init() {
    for (const stmt of schemaFor('postgres')) await this.pool.query(stmt);
    for (const [table, col, type] of ADDED_COLUMNS) {
      // IF NOT EXISTS keeps this safe to run on every boot.
      await this.pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    }
  }
  async all(sql, params = []) { return (await this.pool.query(toPg(sql), params)).rows; }
  async get(sql, params = []) { const r = await this.all(sql, params); return r[0] || null; }
  async run(sql, params = []) { const r = await this.pool.query(toPg(sql), params); return { changes: r.rowCount }; }
  async tx(fn) {
    const client = await this.pool.connect();
    const scoped = {
      kind: 'postgres',
      all: async (s, p = []) => (await client.query(toPg(s), p)).rows,
      get: async (s, p = []) => (await client.query(toPg(s), p)).rows[0] || null,
      run: async (s, p = []) => ({ changes: (await client.query(toPg(s), p)).rowCount })
    };
    try {
      await client.query('BEGIN');
      const out = await fn(scoped);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}

function openDb({ url = process.env.DATABASE_URL, file = process.env.SQLITE_FILE || 'data/assetops.db' } = {}) {
  if (url) return new PgDb(url);
  const fs = require('node:fs');
  const path = require('node:path');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  return new SqliteDb(file);
}

const uid = p => p + crypto.randomBytes(9).toString('hex');
const nowISO = () => new Date().toISOString();

module.exports = { openDb, schemaFor, ADDED_COLUMNS, toPg, uid, nowISO };
