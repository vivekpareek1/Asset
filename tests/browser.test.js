'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { JSDOM } = require('jsdom');
const { harness } = require('./helpers');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ADMIN = { email: 'admin@example.com', password: 'a-strong-admin-pass' };
const wait = ms => new Promise(r => setTimeout(r, ms));

/** Boots the real server and points a jsdom window at it, cookies and all. */
async function browser() {
  const { app, db } = await harness();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: base + '/',
    beforeParse(win) {
      // jsdom has no fetch and does not persist cookies for us; supply both,
      // plus the browser globals the app legitimately expects.
      win.fetch = async (u, o = {}) => {
        const headers = { ...(o.headers || {}) };
        if (cookie) headers.Cookie = cookie;
        const res = await fetch(String(u).startsWith('http') ? u : base + u, { ...o, headers });
        const sc = res.headers.get('set-cookie');
        if (sc) cookie = sc.split(';')[0];
        return res;
      };
      if (typeof win.TextEncoder === 'undefined') win.TextEncoder = TextEncoder;
      if (typeof win.TextDecoder === 'undefined') win.TextDecoder = TextDecoder;
      win.URL.createObjectURL = () => 'blob:preview';
      win.URL.revokeObjectURL = () => {};
      win.scrollTo = () => {};
      win.confirm = () => true;
      win.print = () => {};
    }
  });
  const w = dom.window;
  const errs = [];
  w.addEventListener('error', e => errs.push(e.message));
  return {
    w, db, errs, base,
    $: s => w.document.querySelector(s),
    $$: s => [...w.document.querySelectorAll(s)],
    click: el => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    change: el => el && el.dispatchEvent(new w.Event('change', { bubbles: true })),
    input: el => el && el.dispatchEvent(new w.Event('input', { bubbles: true })),
    submit: el => el && el.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })),
    close: () => new Promise(r => server.close(r))
  };
}

async function signIn(b, email = ADMIN.email, password = ADMIN.password) {
  await wait(400);
  b.$('#lemail').value = email;
  b.$('#lpass').value = password;
  b.submit(b.$('#loginform'));
  await wait(900);
}

test('the app shows a sign-in screen, not the register', async () => {
  const b = await browser();
  await wait(500);
  assert.ok(b.$('#loginform'), 'login form rendered');
  assert.equal(b.$('.rail'), null, 'no navigation before sign-in');
  assert.ok(!/AssetOps<\/b>/.test(b.w.document.body.innerHTML) || !b.$('[data-nav]'), 'no asset data leaked');
  await b.close();
});

test('a wrong password keeps you on the sign-in screen', async () => {
  const b = await browser();
  await signIn(b, ADMIN.email, 'definitely-not-it');
  assert.ok(b.$('#loginform'), 'still on the login screen');
  assert.match(b.$('.alert.e').textContent, /do not match/);
  assert.equal(b.$('.rail'), null);
  await b.close();
});

test('signing in loads the register and shows the real user', async () => {
  const b = await browser();
  await signIn(b);
  assert.ok(b.$('.rail'), 'shell rendered');
  assert.match(b.$('.who').textContent, /Administrator/);
  assert.match(b.$('.who').textContent, /Admin/);
  assert.ok(b.$('#signout'), 'a sign-out control exists');
  assert.equal(b.$('#me'), null, 'the old role-switcher dropdown is gone');
  assert.equal(b.errs.length, 0, b.errs.join('|'));
  await b.close();
});

test('signing out returns to the sign-in screen', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$('#signout'));
  await wait(700);
  assert.ok(b.$('#loginform'));
  assert.equal(b.$('.rail'), null);
  await b.close();
});

test('an asset added in the browser is stored on the server', async () => {
  const b = await browser();
  await signIn(b);
  // masters first
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'sites'));
  await wait(200);
  b.$('#sname').value = 'Head Office'; b.$('#scode').value = 'HO';
  b.click(b.$('#saddb')); await wait(600);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'depts'));
  await wait(200);
  b.$('#dname').value = 'IT'; b.click(b.$('#daddb')); await wait(600);

  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'add'));
  await wait(250);
  b.$('#n_user').value = 'Browser User';
  b.$('#n_vendor').value = 'Ingram Micro';
  b.$('#n_purchasePrice').value = '₹ 52,000';
  b.click(b.$('#nsave'));
  await wait(800);

  const row = await b.db.get('SELECT * FROM assets WHERE user_name = ?', ['Browser User']);
  assert.ok(row, 'asset reached the database');
  assert.equal(row.vendor, 'Ingram Micro');
  assert.equal(Number(row.purchase_price), 52000, 'the rupee-formatted price was parsed');
  assert.equal(Number(row.version), 1);
  assert.equal(b.errs.length, 0, b.errs.join('|'));
  await b.close();
});

test('a conflicting edit is explained, and nothing is overwritten', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'sites'));
  await wait(200);
  b.$('#sname').value = 'HO'; b.$('#scode').value = 'HO'; b.click(b.$('#saddb')); await wait(500);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'depts'));
  await wait(200);
  b.$('#dname').value = 'IT'; b.click(b.$('#daddb')); await wait(500);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'add'));
  await wait(250);
  b.$('#n_user').value = 'Contested'; b.click(b.$('#nsave')); await wait(700);

  const row = await b.db.get('SELECT * FROM assets WHERE user_name = ?', ['Contested']);
  // Somebody else edits it behind the browser's back.
  await b.db.run('UPDATE assets SET vendor = ?, version = version + 1, updated_at = ? WHERE id = ?',
    ['Someone Else', new Date().toISOString(), row.id]);

  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'assets'));
  await wait(300);
  b.click(b.$$('#tbl td[data-open]')[0]);
  await wait(300);
  b.$('#e_vendor').value = 'My Change';
  b.click(b.$('#dsave'));
  await wait(700);

  assert.match(b.w.document.body.textContent, /Someone else changed this asset/, 'the conflict is explained');
  const after = await b.db.get('SELECT vendor FROM assets WHERE id = ?', [row.id]);
  assert.equal(after.vendor, 'Someone Else', "the other person's change survived");
  await b.close();
});

test('a Viewer sees the register but no editing controls', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'users'));
  await wait(250);
  b.$('#uname').value = 'Read Only';
  b.$('#uemail').value = 'ro@example.com';
  b.$('#urole').value = 'Viewer';
  b.$('#upass').value = 'a-fine-password-1';
  b.click(b.$('#uaddb'));
  await wait(700);
  assert.match(b.w.document.body.textContent, /ro@example\.com/, 'user created');

  b.click(b.$('#signout'));
  await wait(600);
  await signIn(b, 'ro@example.com', 'a-fine-password-1');
  assert.ok(b.$('.rail'), 'viewer signed in');
  const navs = b.$$('[data-nav]').map(x => x.dataset.nav);
  assert.ok(!navs.includes('add'), 'no Add asset');
  assert.ok(!navs.includes('users'), 'no Portal users');
  assert.ok(!navs.includes('theme'), 'no Theme settings');
  assert.ok(navs.includes('assets'), 'the register is still readable');
  await b.close();
});

test('the theme survives a full sign-out and back in', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'theme'));
  await wait(300);
  const hex = b.$$('[data-hex]')[0];
  hex.value = '#0f5132';
  b.input(hex);
  await wait(150);
  b.click(b.$('#tsave'));
  await wait(800);
  assert.equal(b.w.document.documentElement.style.getPropertyValue('--app-primary'), '#0f5132');

  b.click(b.$('#signout')); await wait(600);
  await signIn(b);
  assert.equal(b.w.document.documentElement.style.getPropertyValue('--app-primary'), '#0f5132',
    'the saved theme is applied on the next sign-in');
  await b.close();
});

test('a malicious SVG uploaded from the browser is stored sanitised', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'uploadtests'));
  await wait(300);
  b.click(b.$$('[data-case]').find(x => x.dataset.case === 'svg-xss'));
  await wait(1200);
  const row = await b.db.get('SELECT * FROM files ORDER BY created_at DESC');
  assert.ok(row, 'a file was stored');
  const svg = Buffer.from(row.content).toString('utf8');
  for (const bad of [/<script/i, /onload/i, /onerror/i, /javascript:/i, /foreignObject/i]) {
    assert.ok(!bad.test(svg), `${bad} survived`);
  }
  assert.match(b.$('#tres').textContent, /201/);
  await b.close();
});

test('the forged-PNG test is rejected by the server and nothing is stored', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'uploadtests'));
  await wait(300);
  b.click(b.$$('[data-case]').find(x => x.dataset.case === 'php'));
  await wait(1000);
  assert.match(b.$('#tres').textContent, /415/);
  const n = await b.db.get('SELECT count(*) AS c FROM files');
  assert.equal(Number(n.c), 0);
  await b.close();
});

test('the activity log comes from the server and names the real user', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'log'));
  await wait(700);
  const text = b.$('#view').textContent;
  assert.match(text, /Signed in/);
  assert.match(text, /Administrator/);
  await b.close();
});

/* ---- second factor and recovery, driven through the real UI ---- */

const T2 = require('../src/totp');

test('2FA can be turned on from the UI, and then gates the next sign-in', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$('#security'));
  await wait(200);
  assert.ok(b.$('#mfastart'), 'the security dialog offers 2FA');
  b.click(b.$('#mfastart'));
  await wait(600);

  const secret = b.$('.logobox .mono').textContent.trim();
  assert.equal(secret.length, 32, 'a secret is shown');
  b.$('#mfacode').value = T2.totp(secret);
  b.click(b.$('#mfaon'));
  await wait(700);

  const codes = b.$$('.rlog div').map(d => d.textContent.trim()).filter(Boolean);
  assert.equal(codes.length, 10, 'ten recovery codes are shown once');
  b.click(b.$('#mfadone'));
  await wait(300);

  b.click(b.$('#signout'));
  await wait(600);
  b.$('#lemail').value = ADMIN.email;
  b.$('#lpass').value = ADMIN.password;
  b.submit(b.$('#loginform'));
  await wait(800);
  assert.ok(b.$('#mfaform'), 'the password alone now lands on the code screen');
  assert.equal(b.$('.rail'), null, 'the register is not reachable yet');

  b.$('#mcode').value = T2.totp(secret);
  b.submit(b.$('#mfaform'));
  await wait(900);
  assert.ok(b.$('.rail'), 'the correct code completes the sign-in');
  assert.equal(b.errs.length, 0, b.errs.join('|'));
  await b.close();
});

test('a wrong code keeps you on the second-factor screen', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$('#security')); await wait(200);
  b.click(b.$('#mfastart')); await wait(600);
  const secret = b.$('.logobox .mono').textContent.trim();
  b.$('#mfacode').value = T2.totp(secret);
  b.click(b.$('#mfaon')); await wait(600);
  b.click(b.$('#mfadone')); await wait(200);
  b.click(b.$('#signout')); await wait(600);

  b.$('#lemail').value = ADMIN.email;
  b.$('#lpass').value = ADMIN.password;
  b.submit(b.$('#loginform'));
  await wait(700);
  b.$('#mcode').value = '000000';
  b.submit(b.$('#mfaform'));
  await wait(700);
  assert.ok(b.$('#mfaform'), 'still on the code screen');
  assert.match(b.$('.alert.e').textContent, /not valid/);
  await b.close();
});

test('an admin issues a reset token and the user redeems it', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'users'));
  await wait(250);
  b.$('#uname').value = 'Forgot Me';
  b.$('#uemail').value = 'forgot@example.com';
  b.$('#urole').value = 'Manager';
  b.$('#upass').value = 'first-password-1';
  b.click(b.$('#uaddb'));
  await wait(700);

  b.click(b.$$('[data-reset]')[b.$$('[data-reset]').length - 1]);
  await wait(700);
  const token = b.$('.modal .rlog').textContent.trim();
  assert.ok(token.length > 20, 'a token is shown');
  b.click(b.$('#rtdone'));
  await wait(300);

  b.click(b.$('#signout'));
  await wait(600);
  b.click(b.$('#lforgot'));
  await wait(200);
  b.$('#rstoken').value = token;
  b.$('#rspass').value = 'a-brand-new-password';
  b.submit(b.$('#rsform'));
  await wait(800);
  assert.ok(b.$('#loginform'), 'back at sign-in');
  assert.match(b.$('.alert.e, .alert.k, .logincard').textContent, /Password set|Sign in/);

  await signIn(b, 'forgot@example.com', 'a-brand-new-password');
  assert.ok(b.$('.rail'), 'the new password works');
  await b.close();
});

test('an import carrying custom field values reaches the database', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'sites'));
  await wait(200);
  b.$('#sname').value = 'HO'; b.$('#scode').value = 'HO'; b.click(b.$('#saddb')); await wait(500);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'fields'));
  await wait(250);
  b.$('#flabel').value = 'Invoice number';
  b.click(b.$('#faddb'));
  await wait(600);

  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'import'));
  await wait(250);
  b.$('#ipaste').value = 'User name,Invoice number\nImported Person,INV-4242';
  b.click(b.$('#iparse'));
  await wait(400);
  // Map the second column onto the custom field.
  const selects = b.$$('[data-map]');
  const cf = [...selects[1].options].find(o => o.value === 'cf:invoice_number');
  assert.ok(cf, 'the custom field is offered in the mapping');
  selects[1].value = 'cf:invoice_number';
  b.click(b.$('#idoit'));
  await wait(900);

  const row = await b.db.get('SELECT custom FROM assets WHERE user_name = ?', ['Imported Person']);
  assert.ok(row, 'the asset was created');
  assert.equal(JSON.parse(row.custom).invoice_number, 'INV-4242');
  await b.close();
});
