/* ============================================================================
   Theme settings — admin-editable colours, typography and company logo.

   The functions in TAPI stand in for the Express endpoints in routes/admin.js.
   They keep the real contract: same status codes, same { error: { code, message,
   fields } } shape, and the same ordering on replace — commit the settings
   record first, delete the superseded file only afterwards.
   ========================================================================== */

/** Resolves the logo URL; the server streams the bytes with hardened headers. */
function logoSrc(l){ return l ? l.url : null; }

/* The request log shows what the server actually answered. */
function rlog(method, path, status, note){
  RLOG.unshift({ t:new Date().toLocaleTimeString('en-GB'), method, path, status, note });
  if(RLOG.length > 30) RLOG.length = 30;
  const el = document.getElementById('rlog');
  if(el) el.innerHTML = renderRlog();
}
function renderRlog(){
  if(!RLOG.length) return '<span class="dim">No requests yet.</span>';
  return RLOG.map(l =>
    `<div><span class="dim">${l.t}</span> <span class="m">${l.method}</span> ${esc(l.path)} ` +
    `<span class="${l.status < 300 ? 'ok' : 'no'}">${l.status}</span>` +
    `${l.note ? ` <span class="dim">${esc(l.note)}</span>` : ''}</div>`
  ).join('');
}

/** Wraps an API call so the log records the real status either way. */
async function traced(method, path, fn, noteOk){
  try{
    const out = await fn();
    rlog(method, path, path.includes('/logo') && method === 'POST' ? 201 : 200, noteOk ? noteOk(out) : '');
    return out;
  }catch(err){
    rlog(method, path, err.status || 0, err.code || 'ERROR');
    throw err;
  }
}

const TAPI = {
  putTheme: t => traced('PUT', '/api/settings/theme', () => API.putTheme(t)),
  resetTheme: action => traced('POST', '/api/settings/theme/reset', () => API.resetTheme(action)),
  postLogo: async file => {
    const b64 = await fileToBase64(file);
    return traced('POST', '/api/settings/logo', () => API.putLogo(b64),
      r => (r.deduplicated ? 'deduplicated' : 'stored') +
           (r.sanitizedBytes > 0 ? `, ${r.sanitizedBytes} bytes of active content stripped` : ''));
  },
  deleteLogo: () => traced('DELETE', '/api/settings/logo', () => API.deleteLogo())
};

/* ---------- theme settings view ---------- */
const COLOR_FIELDS = [
  { key:'primaryColor',    label:'Primary colour' },
  { key:'secondaryColor',  label:'Secondary colour' },
  { key:'textColor',       label:'Text colour' },
  { key:'backgroundColor', label:'Background colour' }
];
const tdirty = () => JSON.stringify(TDRAFT) !== JSON.stringify(TSAVED);

function vTheme(v){
  if(guard(v)) return;
  if(!TDRAFT){ TDRAFT = { ...S.theme }; TSAVED = { ...S.theme }; }
  const ratio = contrastRatio(TDRAFT.textColor, TDRAFT.backgroundColor);
  const busy = TST.saving, dis = busy ? 'disabled' : '';

  v.innerHTML = `
  ${TST.error   ? `<div class="alert e" role="alert">${esc(TST.error)}</div>` : ''}
  ${TST.success ? `<div class="alert k" role="status">${esc(TST.success)}</div>` : ''}
  <div class="tcols">
    <div class="card"><div class="in">
      <fieldset ${dis}>
        <legend>Colours</legend>
        ${COLOR_FIELDS.map(f => `
          <label class="f"><span>${f.label}</span>
            <div class="colrow">
              <input type="color" value="${isHexColor(TDRAFT[f.key]) ? normalizeHex(TDRAFT[f.key]) : '#000000'}"
                     data-color="${f.key}" aria-label="${f.label} picker">
              <input type="text" class="mono" value="${esc(TDRAFT[f.key])}" data-hex="${f.key}"
                     spellcheck="false" aria-invalid="${TERR[f.key] ? 'true' : 'false'}">
            </div>
            ${TERR[f.key] ? `<em class="ferr">${esc(TERR[f.key])}</em>` : ''}
          </label>`).join('')}
        ${ratio < 4.5 ? `<p class="twarn" role="status">Text on background is ${ratio.toFixed(2)}:1. WCAG AA asks for 4.5:1. You can still save this.</p>` : ''}
      </fieldset>

      <fieldset ${dis}>
        <legend>Typography</legend>
        <label class="f"><span>Font family</span>
          <select id="tff">${FONT_FAMILIES.map(f => `<option value="${f.id}" ${TDRAFT.fontFamily === f.id ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>
          ${TERR.fontFamily ? `<em class="ferr">${esc(TERR.fontFamily)}</em>` : ''}
        </label>
        <label class="f"><span>Base font size — ${TDRAFT.fontSize}px</span>
          <input type="range" id="tfs" min="${FONT_SIZE_MIN}" max="${FONT_SIZE_MAX}" step="1"
                 value="${TDRAFT.fontSize}" style="width:100%">
          ${TERR.fontSize ? `<em class="ferr">${esc(TERR.fontSize)}</em>` : ''}
        </label>
      </fieldset>

      <fieldset ${dis}>
        <legend>Company logo</legend>
        ${S.logo ? `<div class="logobox">
          <img src="${logoSrc(S.logo)}" alt="Current company logo">
          <div class="meta">Stored as<br><span class="mono">${esc(S.logo.filename)}</span><br>${(S.logo.bytes/1024).toFixed(1)} KB · ${esc(S.logo.format.toUpperCase())}</div>
        </div>` : '<p class="note" style="margin-bottom:10px">No logo uploaded.</p>'}
        ${TPEND ? `<div class="logobox pending">
            <img src="${TPEND.url}" alt="Logo preview">
            <div class="meta"><strong>Preview — not saved yet</strong><br>${esc(TPEND.file.name)}<br>${(TPEND.file.size/1024).toFixed(1)} KB</div>
          </div>
          <div class="row"><button class="btn p" id="tlsave" ${dis}>Save logo</button><button class="btn" id="tldrop">Discard</button></div>`
        : `<div class="drop" id="tdrop">
            <input type="file" id="tfile" accept="image/png,image/jpeg,image/svg+xml">
            <p style="margin:8px 0 0;color:var(--muted);font-size:12.5px">PNG, JPG or SVG · up to 2 MB · or drop a file here</p>
          </div>
          ${S.logo ? `<div class="row" style="margin-top:9px"><button class="btn d" id="tldel" ${dis}>Remove logo</button></div>` : ''}`}
      </fieldset>

      <div class="row">
        <button class="btn p" id="tsave" ${busy || !tdirty() ? 'disabled' : ''}>${busy ? '<span class="spin"></span>Saving…' : 'Save changes'}</button>
        <button class="btn" id="treset" ${dis}>Reset to default</button>
        ${tdirty() ? '<span class="dirty">Unsaved changes</span>' : ''}
      </div>
    </div></div>

    <div class="tsticky">
      <div class="card">
        <header><h2>Live preview</h2><span style="margin-left:auto;color:var(--muted);font-size:12.5px">Scoped — the rest of the page is unaffected until you save</span></header>
        <div class="in"><div class="stage" id="tstage">
          ${S.logo ? `<img class="lg" src="${logoSrc(S.logo)}" alt="">` : ''}
          <h3>Fleet overview</h3>
          <p>Body copy in ${esc(fontStackFor(TDRAFT.fontFamily).split(',')[0].replace(/"/g,''))} at ${TDRAFT.fontSize}px. The table below uses the derived small size, not the base value.</p>
          <button class="pbtn">Add asset</button><span class="sec">Export CSV</span>
          <table><thead><tr><th>Asset tag</th><th>Site</th><th>Status</th></tr></thead>
            <tbody>
              <tr><td class="mono">HO-PC-001</td><td>Head Office</td><td>In use</td></tr>
              <tr><td class="mono">DWC-PC-014</td><td>West County</td><td>Replace due</td></tr>
            </tbody></table>
        </div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <header><h2>Request log</h2><span style="margin-left:auto;color:var(--muted);font-size:12.5px">Status codes from the API</span></header>
        <div class="in"><div class="rlog" id="rlog">${renderRlog()}</div></div>
      </div>
    </div>
  </div>`;

  applyTheme(TDRAFT, document.getElementById('tstage'));   // scoped preview only

  v.querySelectorAll('[data-color]').forEach(i => i.oninput = () => tset(i.dataset.color, i.value));
  v.querySelectorAll('[data-hex]').forEach(i => {
    // Update the preview and the dirty state in place, so the caret survives typing.
    i.oninput = () => { TDRAFT[i.dataset.hex] = i.value; repaintStage(); refreshDirty(); };
    i.onblur  = () => render();
  });
  document.getElementById('tff').onchange = e => tset('fontFamily', e.target.value);
  document.getElementById('tfs').oninput  = e => tset('fontSize', Number(e.target.value));
  document.getElementById('tsave').onclick  = doThemeSave;
  document.getElementById('treset').onclick = () => { TRESET = true; render(); };

  const f = document.getElementById('tfile');
  if(f) f.onchange = e => chooseLogo(e.target.files[0]);
  const d = document.getElementById('tdrop');
  if(d){
    d.ondragover  = e => { e.preventDefault(); d.classList.add('over'); };
    d.ondragleave = () => d.classList.remove('over');
    d.ondrop      = e => { e.preventDefault(); d.classList.remove('over'); chooseLogo(e.dataTransfer.files[0]); };
  }
  const ls = document.getElementById('tlsave');
  if(ls) ls.onclick = doLogoSave;
  const ld = document.getElementById('tldrop');
  if(ld) ld.onclick = () => { URL.revokeObjectURL(TPEND.url); TPEND = null; render(); };
  const del = document.getElementById('tldel');
  if(del) del.onclick = doLogoDelete;
}

function repaintStage(){
  const s = document.getElementById('tstage');
  if(s) applyTheme(TDRAFT, s);
}
/** Keeps Save and the unsaved-changes hint current during uninterrupted typing. */
function refreshDirty(){
  const btn = document.getElementById('tsave');
  if(!btn) return;
  btn.disabled = TST.saving || !tdirty();
  const row = btn.parentElement, hint = row.querySelector('.dirty');
  if(tdirty() && !hint){
    const s = document.createElement('span');
    s.className = 'dirty'; s.textContent = 'Unsaved changes';
    row.appendChild(s);
  } else if(!tdirty() && hint) hint.remove();
}
function tset(k, v){ TDRAFT[k] = v; TST.success = null; render(); }

async function doThemeSave(){
  const check = validateTheme(TDRAFT, TSAVED);
  if(!check.valid){ TERR = check.errors; render(); return; }
  TERR = {}; TST = { saving:true, error:null, success:null }; render();
  try{
    const res = await TAPI.putTheme(TDRAFT);
    S.theme = res.theme;
    TDRAFT = { ...res.theme }; TSAVED = { ...res.theme };
    applyTheme(res.theme);                                  // now repaint the app
    const ratio = contrastRatio(res.theme.textColor, res.theme.backgroundColor);
    TST = { saving:false, error:null,
            success: ratio < 4.5
              ? `Theme saved. Text on background is ${ratio.toFixed(2)}:1, below the WCAG AA minimum of 4.5:1.`
              : 'Theme saved.' };
  }catch(err){
    if(handleAuthLoss(err))return;
    TERR = err.fields || {};
    TST = { saving:false, error:err.message, success:null };
  }
  render();
}

/** Client-side pre-check only; the server re-validates on content. */
function chooseLogo(file){
  if(!file) return;
  if(file.size > MAX_LOGO_BYTES){ TST.error = 'Logo must be 2 MB or smaller.'; render(); return; }
  if(!ALLOWED_MIME[String(file.type).toLowerCase()]){ TST.error = 'Choose a PNG, JPG or SVG file.'; render(); return; }
  if(TPEND) URL.revokeObjectURL(TPEND.url);
  TPEND = { file, url:URL.createObjectURL(file) };
  TST.error = null; TST.success = null;
  render();
}
async function doLogoSave(){
  if(!TPEND) return;
  TST = { saving:true, error:null, success:null }; render();
  try{
    const res = await TAPI.postLogo(TPEND.file);
    S.logo = res.logo;
    URL.revokeObjectURL(TPEND.url); TPEND = null;
    let msg = res.deduplicated ? 'That logo was already stored, so nothing was written.' : 'Logo updated.';
    if(res.sanitizedBytes > 0) msg += ` ${res.sanitizedBytes} bytes of active content were stripped from the SVG.`;
    TST = { saving:false, error:null, success:msg };
  }catch(err){ if(!handleAuthLoss(err))TST = { saving:false, error:err.message, success:null }; }
  render();
}
async function doLogoDelete(){
  TST = { saving:true, error:null, success:null }; render();
  try{ await TAPI.deleteLogo(); S.logo = null; TST = { saving:false, error:null, success:'Logo removed.' }; }
  catch(err){ if(handleAuthLoss(err))return; TST = { saving:false, error:err.message, success:null }; }
  render();
}

function resetModal(){
  return `<div class="modal" role="dialog" aria-modal="true" aria-label="Reset theme"><div class="box">
    <h2>Reset to default</h2>
    <p>Colours and typography go back to the shipped defaults. What should happen to the company logo? The API rejects this request without an explicit choice.</p>
    <div class="row">
      <button class="btn" id="rkeep">Keep the logo</button>
      <button class="btn d" id="rdel">Delete the logo too</button>
      <button class="btn" id="rcancel">Cancel</button>
    </div>
  </div></div>`;
}
function bindResetModal(){
  const k = document.getElementById('rkeep');
  if(!k) return;
  k.onclick = () => doThemeReset('keep');
  document.getElementById('rdel').onclick = () => doThemeReset('delete');
  document.getElementById('rcancel').onclick = () => { TRESET = false; render(); };
}
async function doThemeReset(action){
  TRESET = false; TST = { saving:true, error:null, success:null }; render();
  try{
    const res = await TAPI.resetTheme(action);
    S.theme = res.theme; S.logo = res.logo;
    TDRAFT = { ...res.theme }; TSAVED = { ...res.theme };
    applyTheme(res.theme);
    TST = { saving:false, error:null,
            success: res.logoDeleted ? 'Theme reset and logo removed.' : 'Theme reset. The logo was kept.' };
  }catch(err){ if(!handleAuthLoss(err))TST = { saving:false, error:err.message, success:null }; }
  render();
}
