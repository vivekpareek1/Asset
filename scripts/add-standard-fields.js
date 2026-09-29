#!/usr/bin/env node
'use strict';
/**
 * One-time setup: adds the custom fields matched to Vivek's real asset
 * tracking sheet (the columns that don't already have a home on the native
 * asset record — tag, serial, brand, model, user, site, cpu, ram, storage,
 * os are already covered and need no new field).
 *
 * Idempotent: safe to run more than once. A field whose key already exists
 * is left untouched, never duplicated or overwritten, so re-running this
 * after someone has already edited these fields' options in the UI won't
 * clobber their changes.
 *
 * Usage:
 *   DATABASE_URL=postgres://...  node scripts/add-standard-fields.js
 *   SQLITE_FILE=data/assetops.db node scripts/add-standard-fields.js   (local)
 */
const { openDb, uid } = require('../src/db');

const FIELDS = [
  { label: 'Asset Category', type: 'text' },
  { label: 'Product Type', type: 'text' },
  { label: 'Product', type: 'text' },
  { label: 'Configuration / Specification', type: 'text' },
  { label: 'Size', type: 'text' },
  { label: 'State', type: 'text' },
  // The one field explicitly asked for as a choice, not free text.
  { label: 'G Drive Mapping', type: 'select', options: ['Active', 'Inactive'], inTable: true },
  { label: 'Software Details', type: 'text' },
  { label: 'Current Date', type: 'date' },
  { label: 'Days from Manufacture', type: 'text' },
  { label: 'Warranty Status', type: 'text' },
  { label: 'Days from Warranty Expiry', type: 'text' },
  { label: 'Manufacturer Warranty vs Current Date (Years & Months)', type: 'text' },
  { label: 'Warranty vs Current Date (Years & Months)', type: 'text' },
  { label: 'Verification of Assets', type: 'select', options: ['Verified', 'Not Verified'] },
  { label: 'Verification Date', type: 'date' },
  { label: 'Check Time', type: 'text' },
  { label: 'Remark', type: 'text' },

  // --- second batch: software and account licensing ---
  // "Google Drive Active/Inactive" was asked for again here but is the same
  // thing as 'G Drive Mapping' above (added in the first batch) — not
  // duplicated under a second name.
  { label: 'Workspace Email ID', type: 'text' },
  { label: 'Workspace License', type: 'select', options: ['Active', 'Inactive'] },
  { label: 'MS Office License', type: 'select', options: ['Yes', 'No'] },
  { label: 'MS Office License Expiry Date', type: 'date' },
  { label: 'ZWCAD License', type: 'select', options: ['Yes', 'No'] },
  { label: 'ZWCAD License Expiry Date', type: 'date' },
  // Catch-all for any other software, distinct from the free-text
  // 'Software Details' field — this is one name plus its own activation
  // and expiry, for whatever isn't MS Office or ZWCAD specifically.
  { label: 'Additional Software Name', type: 'text' },
  { label: 'Additional Software Activation Date', type: 'date' },
  { label: 'Additional Software Expiry Date', type: 'date' }
];

/** Same slugging rule the admin UI itself uses, so keys match what it would generate. */
function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || ('f' + Date.now());
}

async function main() {
  const db = openDb();
  await db.init();

  const existing = new Set((await db.all('SELECT field_key FROM custom_fields')).map(r => r.field_key));
  let created = 0, skipped = 0;

  for (const f of FIELDS) {
    const key = slug(f.label);
    if (existing.has(key)) { console.log(`skip   (already exists) ${f.label}`); skipped++; continue; }
    await db.run(
      'INSERT INTO custom_fields (id,field_key,label,field_type,options,required,in_table) VALUES (?,?,?,?,?,?,?)',
      [uid('f'), key, f.label, f.type, JSON.stringify(f.options || []), 0, f.inTable ? 1 : 0]
    );
    console.log(`added  ${f.label}${f.type === 'select' ? '  [' + f.options.join(', ') + ']' : ''}`);
    created++;
  }

  console.log(`\n${created} field(s) added, ${skipped} already existed. Nothing else was touched.`);
  await db.close();
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
