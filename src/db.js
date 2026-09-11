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
     id TEXT PRIMARY KEY, tag TEXT NOT NULL, serial TEXT NOT NULL DEFAULT '',
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
  // Named explicitly so a violation can be traced back to exactly one field.
  // Case-insensitive (lower()), and serial excludes blanks — many legacy
  // assets have no recorded serial, and those must not collide with each other.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_tag_unique ON assets (lower(tag))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_serial_unique ON assets (lower(serial)) WHERE serial <> ''`,
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

/** True for a CREATE UNIQUE INDEX statement, as opposed to a table or plain index. */
const isUniqueIndexStmt = stmt => /^\s*CREATE\s+UNIQUE\s+INDEX/i.test(stmt);

/**
 * Creates a unique index without ever crashing boot. A fresh install never
 * hits the catch branch. An install with pre-existing duplicate data would
 * otherwise fail CREATE UNIQUE INDEX and take the whole application down on
 * every subsequent restart, for data that was already there — which is a far
 * worse outcome than starting up with that one constraint unenforced and a
 * loud warning in the logs pointing at exactly what to fix.
 */
async function createIndexSafely(driver, stmt) {
  try {
    if (driver.kind === 'postgres') await driver.pool.query(stmt);
    else driver.db.exec(stmt);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const name = (stmt.match(/INDEX\s+(?:IF NOT EXISTS\s+)?"?(\w+)"?/i) || [])[1] || stmt;
    console.warn(
      `[assetops] could not create unique index "${name}": existing data has duplicates. ` +
      `The app will keep running, but this constraint is NOT enforced until the duplicates ` +
      `are resolved and the server is restarted. Query the affected table to find them, e.g. ` +
      `SELECT lower(serial), count(*) FROM assets WHERE serial <> '' GROUP BY 1 HAVING count(*) > 1.`
    );
  }
}

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
    for (const stmt of schemaFor('sqlite')) {
      if (isUniqueIndexStmt(stmt)) { await createIndexSafely(this, stmt); continue; }
      this.db.exec(stmt);
    }
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
  /**
   * @param {string} connectionString
   * @param {string} schema Postgres schema (namespace) this app's tables live
   *   in. Needed when the database is SHARED with another, unrelated project —
   *   without this, "users", "settings", "sessions" etc. would collide with
   *   that project's own tables of the same name. Never share the public
   *   schema with another application.
   */
  constructor(connectionString, schema = 'assetops') {
    const { Pool } = require('pg');
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error(`Invalid Postgres schema name: ${schema}`);
    }
    this.schema = schema;
    // 'options' is a libpq startup parameter: every connection this pool opens
    // starts with this search_path already set, so a plain "CREATE TABLE
    // users" lands in our schema, never in public where another app's tables
    // of the same name might already exist.
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 6,
      options: `-c search_path=${schema}`
    });
    this.kind = 'postgres';
  }
  async init() {
    // The schema itself is created OUTSIDE that search_path assumption, since
    // it does not exist yet on a first boot.
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
    for (const stmt of schemaFor('postgres')) {
      if (isUniqueIndexStmt(stmt)) { await createIndexSafely(this, stmt); continue; }
      await this.pool.query(stmt);
    }
    for (const [table, col, type] of ADDED_COLUMNS) {
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

function openDb({
  url = process.env.DATABASE_URL,
  schema = process.env.PG_SCHEMA || 'assetops',
  file = process.env.SQLITE_FILE || 'data/assetops.db'
} = {}) {
  if (url) return new PgDb(url, schema);
  const fs = require('node:fs');
  const path = require('node:path');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  return new SqliteDb(file);
}

const uid = p => p + crypto.randomBytes(9).toString('hex');

/**
 * True when err is a unique-constraint violation, from either driver.
 * A duplicate check before an INSERT (SELECT ... WHERE tag = ?) is only
 * advisory under concurrency: two requests can both pass it and then both
 * INSERT. This is the backstop that turns that race into a clean 409 instead
 * of a raw database error reaching the client.
 */
function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;                 // Postgres
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  if (err.code === 'SQLITE_CONSTRAINT') return true;
  return /unique constraint|UNIQUE constraint failed/i.test(String(err.message || ''));
}
const nowISO = () => new Date().toISOString();

/**
 * Identifies which column a unique-constraint violation came from, so the
 * error shown to the person can say "serial number" instead of a generic
 * "something is already in use". Reads Postgres's err.constraint (exact
 * index name) or SQLite's err.message (which names the index), so this
 * works identically on both drivers without depending on either one's
 * internal error format beyond what was verified against real instances of
 * each.
 * @returns {'tag'|'serial'|null}
 */
function duplicateField(err) {
  const text = String((err && (err.constraint || err.message)) || '');
  if (/idx_assets_tag_unique/i.test(text)) return 'tag';
  if (/idx_assets_serial_unique/i.test(text)) return 'serial';
  return null;
}

module.exports = { openDb, schemaFor, ADDED_COLUMNS, toPg, uid, nowISO, isUniqueViolation, duplicateField };
