'use strict';
/** Visits every screen as every role, and fails on any console error. */
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

async function browser() {
  const { app, db } = await harness();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const problems = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: base + '/',
    beforeParse(win) {
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
      win.URL.createObjectURL = () => 'blob:x';
      win.URL.revokeObjectURL = () => {};
      win.scrollTo = () => {}; win.confirm = () => true; win.print = () => {};
      // Any console.error during a render is a defect, not noise.
      win.console.error = (...a) => problems.push('console.error: ' + a.join(' '));
    }
  });
  const w = dom.window;
  w.addEventListener('error', e => problems.push('window error: ' + e.message));
  w.addEventListener('unhandledrejection', e => problems.push('unhandled rejection: ' + (e.reason && e.reason.message)));
  return {
    w, db, problems,
    $: s => w.document.querySelector(s),
    $$: s => [...w.document.querySelectorAll(s)],
    click: el => el && el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
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

test('every screen renders for an Admin, with real data in place', async () => {
  const b = await browser();
  await signIn(b);
  // Give the register something to draw.
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'sites')); await wait(250);
  b.$('#sname').value = 'Head Office'; b.$('#scode').value = 'HO'; b.click(b.$('#saddb')); await wait(500);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'depts')); await wait(200);
  b.$('#dname').value = 'IT'; b.click(b.$('#daddb')); await wait(500);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'fields')); await wait(200);
  b.$('#flabel').value = 'Invoice number'; b.$('#ftab').checked = true; b.click(b.$('#faddb')); await wait(500);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'add')); await wait(250);
  b.$('#n_user').value = 'Someone'; b.$('#n_vendor').value = 'Ingram'; b.$('#n_purchasePrice').value = '45000';
  b.click(b.$('#nsave')); await wait(700);

  const views = b.$$('[data-nav]').map(x => x.dataset.nav);
  assert.ok(views.length >= 10, 'the admin sees every section');
  for (const v of views) {
    b.click(b.$$('[data-nav]').find(x => x.dataset.nav === v));
    await wait(v === 'log' ? 700 : 300);
    const html = b.$('#view').innerHTML;
    assert.ok(html.length > 40, `${v} rendered nothing`);
    assert.ok(!/undefined|\[object Object\]|NaN/.test(html.replace(/undefined-\w+/g, '')),
      `${v} rendered a placeholder value`);
  }
  // Reports: walk every tab.
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'reports')); await wait(300);
  for (const t of b.$$('.tabs button')) { b.click(t); await wait(120); }
  // The drawer and the security dialog.
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'assets')); await wait(300);
  b.click(b.$$('#tbl td[data-open]')[0]); await wait(300);
  assert.ok(b.$('.drawer'), 'the asset drawer opens');
  b.click(b.$('#dclose')); await wait(200);
  b.click(b.$('#security')); await wait(300);
  assert.ok(b.$('#pwgo') && b.$('#mfastart'), 'the security dialog offers both controls');
  b.click(b.$('#pwcancel')); await wait(200);

  assert.deepEqual(b.problems, [], 'no runtime problems across the whole tour');
  await b.close();
});

test('every screen a Manager can reach renders cleanly', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'sites')); await wait(250);
  b.$('#sname').value = 'HO'; b.$('#scode').value = 'HO'; b.click(b.$('#saddb')); await wait(500);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'users')); await wait(250);
  b.$('#uname').value = 'Mgr'; b.$('#uemail').value = 'mgr@example.com';
  b.$('#urole').value = 'Manager'; b.$('#upass').value = 'a-fine-password-1';
  b.click(b.$('#uaddb')); await wait(700);
  b.click(b.$('#signout')); await wait(600);
  await signIn(b, 'mgr@example.com', 'a-fine-password-1');

  // A freshly created account is asked to set its own password first.
  assert.ok(b.$('#pwgo'), 'the temporary password prompts a change');
  b.click(b.$('#pwcancel')); await wait(300);

  const views = b.$$('[data-nav]').map(x => x.dataset.nav);
  assert.ok(!views.includes('users') && !views.includes('theme'), 'admin sections are hidden');
  for (const v of views) {
    b.click(b.$$('[data-nav]').find(x => x.dataset.nav === v));
    await wait(v === 'log' ? 700 : 300);
    assert.ok(b.$('#view').innerHTML.length > 40, `${v} rendered nothing`);
  }
  assert.deepEqual(b.problems, [], 'no runtime problems as a Manager');
  await b.close();
});

test('every screen a Viewer can reach renders cleanly', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'users')); await wait(250);
  b.$('#uname').value = 'Vwr'; b.$('#uemail').value = 'vwr@example.com';
  b.$('#urole').value = 'Viewer'; b.$('#upass').value = 'a-fine-password-1';
  b.click(b.$('#uaddb')); await wait(700);
  b.click(b.$('#signout')); await wait(600);
  await signIn(b, 'vwr@example.com', 'a-fine-password-1');
  if (b.$('#pwcancel')) { b.click(b.$('#pwcancel')); await wait(300); }

  for (const v of b.$$('[data-nav]').map(x => x.dataset.nav)) {
    b.click(b.$$('[data-nav]').find(x => x.dataset.nav === v));
    await wait(v === 'log' ? 700 : 300);
    assert.ok(b.$('#view').innerHTML.length > 40, `${v} rendered nothing`);
  }
  assert.deepEqual(b.problems, [], 'no runtime problems as a Viewer');
  await b.close();
});

test('an empty register renders without falling over', async () => {
  const b = await browser();
  await signIn(b);
  // No sites, no departments, no assets: every screen must still draw.
  for (const v of b.$$('[data-nav]').map(x => x.dataset.nav)) {
    b.click(b.$$('[data-nav]').find(x => x.dataset.nav === v));
    await wait(v === 'log' ? 700 : 300);
    assert.ok(b.$('#view').innerHTML.length > 40, `${v} rendered nothing when empty`);
  }
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'reports')); await wait(300);
  for (const t of b.$$('.tabs button')) { b.click(t); await wait(120); }
  assert.deepEqual(b.problems, [], 'no runtime problems on an empty register');
  await b.close();
});

test('the sign-in, second-factor and reset screens all render', async () => {
  const b = await browser();
  await wait(400);
  assert.ok(b.$('#loginform'));
  b.click(b.$('#lforgot')); await wait(200);
  assert.ok(b.$('#rsform'), 'the reset screen renders');
  b.click(b.$('#rsback')); await wait(200);
  assert.ok(b.$('#loginform'), 'and goes back');
  assert.deepEqual(b.problems, []);
  await b.close();
});

test('hostile text in the data is rendered as text, never as markup', async () => {
  const b = await browser();
  await signIn(b);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'sites')); await wait(250);
  b.$('#sname').value = 'HO'; b.$('#scode').value = 'HO'; b.click(b.$('#saddb')); await wait(500);
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'depts')); await wait(200);
  b.$('#dname').value = '<img src=x onerror=alert(1)>'; b.click(b.$('#daddb')); await wait(500);

  const payload = '<img src=x onerror="window.__xss=1">';
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'add')); await wait(250);
  b.$('#n_user').value = payload;
  b.$('#n_model').value = '"><script>window.__xss=2<\/script>';
  b.$('#n_vendor').value = "'><svg onload=window.__xss=3>";
  b.click(b.$('#nsave')); await wait(800);

  for (const v of ['assets', 'dash', 'reports', 'depts']) {
    b.click(b.$$('[data-nav]').find(x => x.dataset.nav === v));
    await wait(350);
  }
  b.click(b.$$('[data-nav]').find(x => x.dataset.nav === 'assets')); await wait(350);
  b.click(b.$$('#tbl td[data-open]')[0]); await wait(300);

  assert.equal(b.w.__xss, undefined, 'no injected script ran');
  assert.equal(b.w.document.querySelectorAll('img[onerror]').length, 0, 'no attribute handler survived');
  assert.equal(b.w.document.querySelectorAll('svg[onload]').length, 0);
  // The text itself must still be visible, escaped.
  assert.ok(b.w.document.body.textContent.includes('onerror'), 'the payload is shown as text');
  assert.deepEqual(b.problems, []);
  await b.close();
});
