/* ---------- admin: sites & companies ---------- */
function guard(v){
  if(can('admin'))return false;
  v.innerHTML='<div class="empty"><b>Administrator access required</b>Switch to an Admin account to manage this section.</div>';
  return true;
}
function vSites(v){
  if(guard(v))return;
  const count=c=>S.assets.filter(a=>a.siteCode===c).length;
  v.innerHTML=`
  <div class="grid" style="gap:14px;max-width:1000px">
    <div class="card">
      <header><h2>Companies</h2></header>
      <div class="tw"><table><thead><tr><th>Name</th><th>Code</th><th>Sites</th><th class="noprint"></th></tr></thead><tbody>
        ${S.companies.map(c=>`<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.code)}</td>
          <td class="mono">${S.sites.filter(s=>s.companyId===c.id).length}</td>
          <td class="noprint"><button class="btn sm d" data-delc="${c.id}">Remove</button></td></tr>`).join('')}
      </tbody></table></div>
      <div class="in row">
        <input type="text" id="cname" placeholder="Company name" style="width:230px">
        <input type="text" id="ccode" placeholder="Code" style="width:90px" class="mono">
        <button class="btn p" id="caddb">Add company</button>
      </div>
    </div>
    <div class="card">
      <header><h2>Sites</h2><span style="margin-left:auto;color:var(--muted);font-size:12.5px">Site code prefixes every asset tag</span></header>
      <div class="tw"><table><thead><tr><th>Site</th><th>Code</th><th>Location</th><th>Company</th><th>Assets</th><th class="noprint"></th></tr></thead><tbody>
        ${S.sites.map(s=>`<tr>
          <td>${esc(s.name)}</td>
          <td class="mono">${esc(s.code)}</td>
          <td>${esc(s.location||'\u2014')}</td>
          <td>${esc((S.companies.find(c=>c.id===s.companyId)||{}).name||'—')}</td>
          <td class="mono">${count(s.code)}</td>
          <td class="noprint"><button class="btn sm d" data-dels="${s.id}" ${count(s.code)?'disabled title="Move its assets first"':''}>Remove</button></td>
        </tr>`).join('')}
      </tbody></table></div>
      <div class="in row">
        <input type="text" id="sname" placeholder="Site name" style="width:210px">
        <input type="text" id="scode" placeholder="Code" style="width:80px" class="mono">
        <input type="text" id="sloc" placeholder="Location" style="width:170px">
        <select id="scomp" style="width:auto">${S.companies.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
        <button class="btn p" id="saddb">Add site</button>
      </div>
    </div>
  </div>`;
  const run=async(fn,ok)=>{
    try{ await fn(); const b=await API.bootstrap();
      S.sites=b.sites;S.depts=b.depts;S.companies=b.companies;S.assets=b.assets;
      render(); if(ok)toast(ok); }
    catch(err){ if(!handleAuthLoss(err))toast(err.message); }
  };
  $('#caddb').onclick=()=>{
    const n=$('#cname').value.trim(),c=$('#ccode').value.trim().toUpperCase();
    if(!n||!c)return toast('Company name and code are both needed');
    run(()=>API.createCompany({name:n,code:c}),'Company added');
  };
  $('#saddb').onclick=()=>{
    const n=$('#sname').value.trim(),c=$('#scode').value.trim().toUpperCase();
    if(!n||!c)return toast('Site name and code are both needed');
    run(()=>API.createSite({name:n,code:c,location:$('#sloc').value.trim(),companyId:$('#scomp').value}),'Site added');
  };
  v.querySelectorAll('[data-dels]').forEach(b=>b.onclick=()=>run(()=>API.deleteSite(b.dataset.dels),'Site removed'));
  v.querySelectorAll('[data-delc]').forEach(b=>b.onclick=()=>run(()=>API.deleteCompany(b.dataset.delc),'Company removed'));
}

/* ---------- admin: departments ---------- */
function vDepts(v){
  if(guard(v))return;
  const count=n=>S.assets.filter(a=>a.dept===n).length;
  v.innerHTML=`
  <div class="card" style="max-width:640px">
    <header><h2>Departments</h2><span style="margin-left:auto;color:var(--muted);font-size:12.5px">Renaming updates every assigned asset</span></header>
    <div class="tw"><table><thead><tr><th>Department</th><th>Assets</th><th class="noprint"></th></tr></thead><tbody>
      ${S.depts.map(d=>`<tr>
        <td><input type="text" value="${esc(d.name)}" data-dn="${d.id}"></td>
        <td class="mono">${count(d.name)}</td>
        <td class="noprint"><button class="btn sm d" data-deld="${d.id}" ${count(d.name)?'disabled title="Reassign its assets first"':''}>Remove</button></td>
      </tr>`).join('')}
    </tbody></table></div>
    <div class="in row"><input type="text" id="dname" placeholder="New department" style="width:240px"><button class="btn p" id="daddb">Add department</button></div>
  </div>`;
  const run=async(fn,ok)=>{
    try{ await fn(); const b=await API.bootstrap();
      S.depts=b.depts;S.assets=b.assets; render(); if(ok)toast(ok); }
    catch(err){ if(!handleAuthLoss(err))toast(err.message); }
  };
  $('#daddb').onclick=()=>{
    const n=$('#dname').value.trim();
    if(!n)return toast('Enter a department name');
    run(()=>API.createDept(n),'Department added');
  };
  v.querySelectorAll('[data-dn]').forEach(i=>i.onchange=()=>{
    const nu=i.value.trim();
    if(!nu)return render();
    run(()=>API.renameDept(i.dataset.dn,nu),'Renamed');
  });
  v.querySelectorAll('[data-deld]').forEach(b=>b.onclick=()=>run(()=>API.deleteDept(b.dataset.deld),'Department removed'));
}

/* ---------- admin: custom fields ---------- */
function vFields(v){
  if(guard(v))return;
  v.innerHTML=`
  <div class="grid" style="gap:14px;max-width:900px">
    <div class="card">
      <header><h2>Custom fields</h2><span style="margin-left:auto;color:var(--muted);font-size:12.5px">Appear on the add form, the asset drawer and CSV exports</span></header>
      <div class="tw"><table><thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Choices</th><th>Required</th><th>In table</th><th class="noprint"></th></tr></thead><tbody>
        ${S.fields.length?S.fields.map(f=>`<tr>
          <td>${esc(f.label)}</td><td class="mono">${esc(f.key)}</td><td>${esc(f.type)}</td>
          <td><span class="trunc">${esc((f.options||[]).join(', ')||'—')}</span></td>
          <td><input type="checkbox" data-req="${f.id}" ${f.required?'checked':''}></td>
          <td><input type="checkbox" data-tab="${f.id}" ${f.inTable?'checked':''}></td>
          <td class="noprint"><button class="btn sm d" data-delf="${f.id}">Remove</button></td>
        </tr>`).join(''):`<tr><td colspan="7"><div class="empty"><b>No custom fields yet</b>Add one below to start capturing information the standard form does not cover.</div></td></tr>`}
      </tbody></table></div>
    </div>
    <div class="card">
      <header><h2>Add a field</h2></header>
      <div class="in">
        <div class="g2">
          <label class="f"><span>Label <i>*</i></span><input type="text" id="flabel" placeholder="Purchase order number"></label>
          <label class="f"><span>Type</span><select id="ftype2"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="select">Choice list</option></select></label>
        </div>
        <label class="f" id="foptwrap" style="display:none"><span>Choices, one per line</span><textarea id="foptions" rows="3" placeholder="Under warranty&#10;AMC&#10;Not covered"></textarea></label>
        <div class="row">
          <label class="row" style="gap:5px"><input type="checkbox" id="freq"> Required</label>
          <label class="row" style="gap:5px"><input type="checkbox" id="ftab"> Show as a table column</label>
        </div>
        <div class="row" style="margin-top:10px"><button class="btn p" id="faddb">Add field</button></div>
      </div>
    </div>
  </div>`;
  $('#ftype2').onchange=e=>$('#foptwrap').style.display=e.target.value==='select'?'':'none';
  const run=async(fn,ok)=>{
    try{ await fn(); const b=await API.bootstrap(); S.fields=b.fields; render(); if(ok)toast(ok); }
    catch(err){ if(!handleAuthLoss(err))toast(err.message); }
  };
  $('#faddb').onclick=()=>{
    const label=$('#flabel').value.trim();
    if(!label)return toast('Give the field a label');
    const type=$('#ftype2').value;
    run(()=>API.createField({
      label,type,
      options:type==='select'?$('#foptions').value.split('\n').map(x=>x.trim()).filter(Boolean):[],
      required:$('#freq').checked,inTable:$('#ftab').checked
    }),'Field added');
  };
  v.querySelectorAll('[data-req]').forEach(c=>c.onchange=()=>run(()=>API.updateField(c.dataset.req,{required:c.checked})));
  v.querySelectorAll('[data-tab]').forEach(c=>c.onchange=()=>run(()=>API.updateField(c.dataset.tab,{inTable:c.checked})));
  v.querySelectorAll('[data-delf]').forEach(b=>b.onclick=()=>{
    const f=S.fields.find(x=>x.id===b.dataset.delf);
    if(!confirm('Remove "'+f.label+'"? Values already recorded on assets stay in storage but stop showing.'))return;
    run(()=>API.deleteField(b.dataset.delf),'Field removed');
  });
}

/* ---------- admin: portal users ---------- */
function vUsers(v){
  if(guard(v))return;
  v.innerHTML=`
  <div class="grid" style="gap:14px;max-width:1000px">
    <div class="card">
      <header><h2>Portal users</h2></header>
      <div class="tw"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Site access</th><th>Active</th><th class="noprint"></th></tr></thead><tbody>
        ${S.users.map(u=>`<tr>
          <td>${esc(u.name)}${ME&&ME.id===u.id?' <span class="chip">you</span>':''}</td>
          <td>${esc(u.email)}</td>
          <td><select data-role="${u.id}">${['Admin','Manager','Viewer'].map(r=>`<option ${u.role===r?'selected':''}>${r}</option>`).join('')}</select></td>
          <td><div class="chips">${u.sites.length?u.sites.map(c=>`<span class="chip">${esc(siteName(c))}<button data-unsite="${u.id}|${c}" aria-label="Remove">×</button></span>`).join(''):'<span style="color:var(--muted)">All sites</span>'}
            <select data-addsite="${u.id}" style="width:auto"><option value="">Limit to…</option>${S.sites.filter(s=>!u.sites.includes(s.code)).map(s=>`<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select></div></td>
          <td><input type="checkbox" data-act="${u.id}" ${u.active?'checked':''}></td>
          <td class="noprint"><button class="btn sm" data-reset="${u.id}">Reset token</button>
            <button class="btn sm d" data-delu="${u.id}" ${ME&&ME.id===u.id?'disabled title="You cannot remove your own account"':''}>Remove</button></td>
        </tr>`).join('')}
      </tbody></table></div>
    </div>
    <div class="card">
      <header><h2>Create a user</h2></header>
      <div class="in">
        <div class="g2">
          <label class="f"><span>Full name <i>*</i></span><input type="text" id="uname"></label>
          <label class="f"><span>Email <i>*</i></span><input type="email" id="uemail"></label>
          <label class="f"><span>Role</span><select id="urole"><option>Viewer</option><option>Manager</option><option>Admin</option></select></label>
          <label class="f"><span>Temporary password <i>*</i></span><input type="password" id="upass" autocomplete="new-password" placeholder="At least 10 characters"></label>
        </div>
        <p class="note">Admin manages every section. Manager edits assets and imports data. Viewer reads only. Leave site access empty to cover all sites. The person is asked to change this password after signing in.</p>
        <div class="row" style="margin-top:10px"><button class="btn p" id="uaddb">Create user</button></div>
      </div>
    </div>
  </div>`;
  const run=async(fn,ok)=>{
    try{ await fn(); const b=await API.bootstrap(); S.users=b.users; render(); if(ok)toast(ok); }
    catch(err){ if(!handleAuthLoss(err))toast(err.message); }
  };
  $('#uaddb').onclick=()=>{
    const n=$('#uname').value.trim(),e=$('#uemail').value.trim(),pw=$('#upass').value;
    if(!n||!e)return toast('Name and email are both needed');
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))return toast('Enter a valid email address');
    if(pw.length<10)return toast('The password must be at least 10 characters');
    run(()=>API.createUser({name:n,email:e,role:$('#urole').value,password:pw}),'User created');
  };
  v.querySelectorAll('[data-role]').forEach(s=>s.onchange=()=>run(()=>API.updateUser(s.dataset.role,{role:s.value}),'Role changed'));
  v.querySelectorAll('[data-act]').forEach(c=>c.onchange=()=>run(()=>API.updateUser(c.dataset.act,{active:c.checked})));
  v.querySelectorAll('[data-addsite]').forEach(s=>s.onchange=()=>{
    if(!s.value)return;
    const u=S.users.find(x=>x.id===s.dataset.addsite);
    run(()=>API.updateUser(u.id,{sites:[...u.sites,s.value]}));
  });
  v.querySelectorAll('[data-unsite]').forEach(b=>b.onclick=()=>{
    const [id,c]=b.dataset.unsite.split('|');const u=S.users.find(x=>x.id===id);
    run(()=>API.updateUser(id,{sites:u.sites.filter(x=>x!==c)}));
  });
  v.querySelectorAll('[data-delu]').forEach(b=>b.onclick=()=>run(()=>API.deleteUser(b.dataset.delu),'User removed'));
  v.querySelectorAll('[data-reset]').forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    try{
      const r=await API.issueResetToken(b.dataset.reset);
      showResetToken(r);
    }catch(err){ b.disabled=false; if(!handleAuthLoss(err))toast(err.message); }
  });
}

/**
 * Shows a reset token once. There is no mail server here, so the administrator
 * passes it on through a channel they already trust.
 */
function showResetToken(r){
  const wrap=document.createElement('div');
  wrap.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-label="Reset token"><div class="box">
    <h2>Reset token for ${esc(r.email)}</h2>
    <p>Give this to them through a channel you trust. It works once and expires in an hour. It is shown only now.</p>
    <div class="rlog" style="max-height:none;word-break:break-all">${esc(r.token)}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn" id="rtcopy">Copy</button>
      <button class="btn p" id="rtdone">Done</button>
    </div>
  </div></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('#rtcopy').onclick=()=>{
    if(navigator.clipboard&&navigator.clipboard.writeText)
      navigator.clipboard.writeText(r.token).then(()=>toast('Copied'),()=>toast('Copy failed'));
    else toast('Select the token and copy it by hand');
  };
  wrap.querySelector('#rtdone').onclick=()=>{wrap.remove();render();};
}

/* ---------- activity log ---------- */
function vLog(v){
  v.innerHTML=`<div class="card"><div class="in">Loading the activity log…</div></div>`;
  API.activity().then(r=>{
    ACTIVITY=r.log;
    if(VIEW!=='log')return;
    v.innerHTML=`
    <div class="card">
      <header><h2>Activity log</h2><span style="margin-left:auto;color:var(--muted);font-size:12.5px">${ACTIVITY.length} entries, newest first</span>
      <button class="btn noprint" id="lcsv">Export CSV</button></header>
      <div class="tw"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>
        ${ACTIVITY.length?ACTIVITY.map(l=>`<tr><td class="mono" style="white-space:nowrap">${esc(fmtDT(l.ts))}</td><td>${esc(l.actor)}</td><td>${esc(l.action)}</td><td>${esc(l.detail)}</td></tr>`).join('')
          :`<tr><td colspan="4"><div class="empty"><b>Nothing recorded yet</b>Changes appear here as they happen.</div></td></tr>`}
      </tbody></table></div>
    </div>`;
    const b=document.getElementById('lcsv');
    if(b)b.onclick=()=>{
      download('activity-log.csv',[['When','Who','Action','Detail'],...ACTIVITY.map(l=>[fmtDT(l.ts),l.actor,l.action,l.detail])].map(r=>r.map(csvCell).join(',')).join('\n'));
      toast('Exported');
    };
  }).catch(err=>{
    if(handleAuthLoss(err))return;
    v.innerHTML=`<div class="alert e">${esc(err.message)}</div>`;
  });
}

/* ---------- boot ---------- */
async function boot(){
  document.body.innerHTML='<div class="empty" style="padding:80px"><b>Loading the asset register</b>One moment.</div>';
  try{
    await loadState();
    // An account created by an administrator carries a temporary password.
    // Open the security dialog straight away rather than letting it sit unused.
    if(ME&&ME.mustChange){
      PWOPEN=true;
      render();
      toast('This is a temporary password. Please set your own.');
      return;
    }
    render();
  }catch(err){
    if(err&&err.status===401){ renderLogin(); return; }
    document.body.innerHTML=`<div class="empty" style="padding:80px"><b>The register could not start</b>${esc(err.message)}</div>`;
  }
}

async function start(){
  try{
    const r=await API.me();
    ME=r.user;
    await boot();
  }catch(err){
    renderLogin(err.status===401?null:err.message);
  }
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);
else start();
