'use strict';
/** The bulk custom-field setup script: creates the standard set once, is a
 * no-op on every run after that, and never touches anything it didn't create. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { openDb } = require('../src/db');

function runScript(env) {
  return execFileSync('node', [path.join(__dirname, '..', 'scripts', 'add-standard-fields.js')],
    { env: { ...process.env, ...env }, encoding: 'utf8' });
}

test('creates exactly 27 fields on a clean database', async () => {
  const file = path.join(__dirname, '..', 'data', 'test-standard-fields-1.db');
  require('node:fs').rmSync(file, { force: true });
  const out = runScript({ SQLITE_FILE: file, DATABASE_URL: '' });
  assert.match(out, /27 field\(s\) added, 0 already existed/);
  const db = openDb({ url: null, file });
  const rows = await db.all('SELECT field_key, field_type, options, in_table FROM custom_fields');
  assert.equal(rows.length, 27);
  const gdrive = rows.find(r => r.field_key === 'g_drive_mapping');
  assert.ok(gdrive, 'G Drive Mapping field was created');
  assert.equal(gdrive.field_type, 'select');
  assert.deepEqual(JSON.parse(gdrive.options), ['Active', 'Inactive']);
  assert.equal(Number(gdrive.in_table), 1, 'shown as a table column, as asked for');

  // The second batch: licensing dropdowns must be the right choices, not free text.
  const byKey = k => rows.find(r => r.field_key === k);
  assert.deepEqual(JSON.parse(byKey('workspace_license').options), ['Active', 'Inactive']);
  assert.deepEqual(JSON.parse(byKey('ms_office_license').options), ['Yes', 'No']);
  assert.deepEqual(JSON.parse(byKey('zwcad_license').options), ['Yes', 'No']);
  assert.equal(byKey('ms_office_license_expiry_date').field_type, 'date');
  assert.equal(byKey('zwcad_license_expiry_date').field_type, 'date');
  assert.equal(byKey('workspace_email_id').field_type, 'text');

  await db.close();
  require('node:fs').rmSync(file, { force: true });
});

test('running the new script against a database that already has the FIRST batch only adds the new 9', async () => {
  const file = path.join(__dirname, '..', 'data', 'test-standard-fields-3.db');
  require('node:fs').rmSync(file, { force: true });
  // Recreate the first-batch-only state directly, rather than depending on
  // git history, so this test is self-contained.
  const db0 = openDb({ url: null, file });
  await db0.init();
  const FIRST_BATCH = ['asset_category','product_type','product','configuration_specification','size',
    'state','g_drive_mapping','software_details','current_date','days_from_manufacture','warranty_status',
    'days_from_warranty_expiry','manufacturer_warranty_vs_current_date_years_months',
    'warranty_vs_current_date_years_months','verification_of_assets','verification_date','check_time','remark'];
  for (const key of FIRST_BATCH) {
    await db0.run('INSERT INTO custom_fields (id,field_key,label,field_type,options,required,in_table) VALUES (?,?,?,?,?,0,0)',
      ['f_' + key, key, key, 'text', '[]']);
  }
  await db0.close();

  const out = runScript({ SQLITE_FILE: file, DATABASE_URL: '' });
  assert.match(out, /9 field\(s\) added, 18 already existed/);
  const db = openDb({ url: null, file });
  const count = await db.get('SELECT count(*) AS c FROM custom_fields');
  assert.equal(Number(count.c), 27);
  await db.close();
  require('node:fs').rmSync(file, { force: true });
});

test('running it again creates nothing and touches nothing already there', async () => {
  const file = path.join(__dirname, '..', 'data', 'test-standard-fields-2.db');
  require('node:fs').rmSync(file, { force: true });
  runScript({ SQLITE_FILE: file, DATABASE_URL: '' });

  const db = openDb({ url: null, file });
  // Simulate an admin having since customised one of the fields.
  await db.run("UPDATE custom_fields SET label = ? WHERE field_key = 'remark'", ['Notes (renamed by admin)']);
  await db.close();

  const out = runScript({ SQLITE_FILE: file, DATABASE_URL: '' });
  assert.match(out, /0 field\(s\) added, 27 already existed/);

  const db2 = openDb({ url: null, file });
  const rows = await db2.all('SELECT label FROM custom_fields WHERE field_key = ?', ['remark']);
  assert.equal(rows[0].label, 'Notes (renamed by admin)', "the admin's rename survived a re-run");
  const count = await db2.get('SELECT count(*) AS c FROM custom_fields');
  assert.equal(Number(count.c), 27, 'still exactly 27, nothing duplicated');
  await db2.close();
  require('node:fs').rmSync(file, { force: true });
});
