/* ---------- asset drawer ---------- */
function fieldInput(f,val,idp){
  const id=idp+f.key;
  if(f.type==='select')return `<select id="${id}"><option value=""></option>${f.options.map(o=>`<option ${val===o?'selected':''}>${esc(o)}</option>`).join('')}</select>`;
  const t=f.type==='number'?'number':f.type==='date'?'date':'text';
  return `<input type="${t}" id="${id}" value="${esc(val||'')}">`;
}
function openDrawer(id,keep){
  const a=S.assets.find(x=>x.id===id);if(!a)return;
  DRAWER=id;
  if(!keep)document.querySelectorAll('.scrim,.drawer').forEach(n=>n.remove());
  else document.querySelectorAll('.scrim,.drawer').forEach(n=>n.remove());
  const ed=can('edit');
  const wrap=document.createElement('div');
  wrap.innerHTML=`
  <div class="scrim" id="scrim"></div>
  <aside class="drawer" role="dialog" aria-label="Asset detail">
    <header>
      <div><h2 class="mono">${esc(a.tag)}</h2><span style="color:var(--muted);font-size:12.5px">${esc(a.brand)} ${esc(a.model)}</span></div>
      <button class="btn sm" id="dclose" style="margin-left:auto">Close</button>
    </header>
    <div class="in">
      ${ed?`
      <div class="g2">
        <label class="f"><span>Assigned to</span><input type="text" id="e_user" value="${esc(a.user)}"></label>
        <label class="f"><span>Department</span><select id="e_dept">${S.depts.map(d=>`<option ${a.dept===d.name?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label>
        <label class="f"><span>Site</span><select id="e_site">${S.sites.map(s=>`<option value="${s.code}" ${a.siteCode===s.code?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label class="f"><span>Status</span><select id="e_status">${STATUSES.map(s=>`<option ${a.status===s?'selected':''}>${s}</option>`).join('')}</select></label>
        <label class="f"><span>Type</span><select id="e_type">${['Desktop','All-in-One','Laptop','Printer','Server','Network'].map(s=>`<option ${a.type===s?'selected':''}>${s}</option>`).join('')}</select></label>
        <label class="f"><span>Make</span><input type="text" id="e_brand" value="${esc(a.brand)}"></label>
        <label class="f"><span>Model</span><input type="text" id="e_model" value="${esc(a.model)}"></label>
        <label class="f"><span>Serial number</span><input type="text" id="e_serial" value="${esc(a.serial)}"></label>
        <label class="f"><span>Processor</span><input type="text" id="e_cpu" value="${esc(a.cpu)}"></label>
        <label class="f"><span>Memory</span><input type="text" id="e_ram" value="${esc(a.ram)}"></label>
        <label class="f"><span>Storage</span><input type="text" id="e_storage" value="${esc(a.storage)}"></label>
        <label class="f"><span>Operating system</span><input type="text" id="e_os" value="${esc(a.os)}"></label>
        <label class="f"><span>Vendor</span><input type="text" id="e_vendor" value="${esc(a.vendor||'')}" placeholder="Who it was bought from"></label>
        <label class="f"><span>Purchase price (\u20B9)</span><input type="text" id="e_purchasePrice" class="mono" value="${a.purchasePrice==null?'':a.purchasePrice}" placeholder="Leave blank if unknown"></label>
        <label class="f"><span>Purchase year</span><input type="number" id="e_purchaseYear" value="${esc(a.purchaseYear)}"></label>
        <label class="f"><span>Warranty end</span><input type="date" id="e_warrantyEnd" value="${esc(a.warrantyEnd)}"></label>
      </div>
      ${S.fields.length?`<h3 style="margin:6px 0 8px">Additional fields</h3><div class="g2">
        ${S.fields.map(f=>`<label class="f"><span>${esc(f.label)}${f.required?' <i>*</i>':''}</span>${fieldInput(f,(a.custom||{})[f.key],'e_cf_')}</label>`).join('')}
      </div>`:''}
      `:`
      <dl class="kv">
        <dt>Assigned to</dt><dd>${esc(a.user)}</dd>
        <dt>Department</dt><dd>${esc(a.dept)}</dd>
        <dt>Site</dt><dd>${esc(siteName(a.siteCode))}</dd>
        <dt>Status</dt><dd><span class="pill ${statusCls(a.status)}">${esc(a.status)}</span></dd>
        <dt>Make and model</dt><dd>${esc(a.brand)} ${esc(a.model)}</dd>
        <dt>Serial number</dt><dd class="mono">${esc(a.serial)}</dd>
        <dt>Processor</dt><dd>${esc(a.cpu)}</dd>
        <dt>Memory</dt><dd>${esc(a.ram)}</dd>
        <dt>Storage</dt><dd>${esc(a.storage)}</dd>
        <dt>Operating system</dt><dd>${esc(a.os)}</dd>
        <dt>Vendor</dt><dd>${a.vendor?esc(a.vendor):'Not recorded'}</dd>
        <dt>Purchase price</dt><dd class="mono">${money(a.purchasePrice)}</dd>
        <dt>Warranty end</dt><dd>${esc(a.warrantyEnd)}</dd>
        ${S.fields.map(f=>`<dt>${esc(f.label)}</dt><dd>${esc((a.custom||{})[f.key]||'—')}</dd>`).join('')}
      </dl>`}

      <h3 style="margin:16px 0 8px">Attachments</h3>
      <div id="files">${(a.files||[]).length?(a.files||[]).map((f,i)=>`<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line2);padding:5px 0">
        <span>${f.data?`<a href="${f.data}" download="${esc(f.name)}">${esc(f.name)}</a>`:esc(f.name)} <span style="color:var(--muted);font-size:12px">${(f.size/1024).toFixed(0)} KB</span></span>
        ${ed?`<button class="btn sm d" data-rmf="${i}">Remove</button>`:''}
      </div>`).join(''):'<p style="color:var(--muted);margin:0">No files attached.</p>'}</div>
      ${ed?`<div style="margin-top:9px"><input type="file" id="fup" multiple>
      <p class="note" style="margin-top:8px">Files under 120 KB are stored and downloadable. Larger files are recorded by name and size only, so the register stays within its storage limit.</p></div>`:''}
    </div>
    <footer>
      ${ed?`<button class="btn p" id="dsave">Save changes</button>`:''}
      ${can('admin')?`<button class="btn d" id="ddel">Delete asset</button>`:''}
      <span style="margin-left:auto;color:var(--muted);font-size:12px;align-self:center">${esc(a.tag)}</span>
    </footer>
  </aside>`;
  document.body.appendChild(wrap);
  const close=()=>{DRAWER=null;wrap.remove();};
  wrap.querySelector('#scrim').onclick=close;
  wrap.querySelector('#dclose').onclick=close;
  document.addEventListener('keydown',function k(e){if(e.key==='Escape'){close();document.removeEventListener('keydown',k);}});
  wrap.querySelectorAll('[data-rmf]').forEach(b=>b.onclick=()=>{a.files.splice(+b.dataset.rmf,1);save();openDrawer(id);});
  const fup=wrap.querySelector('#fup');
  if(fup)fup.onchange=e=>{
    const fs=[...e.target.files];let pending=fs.length;
    if(!pending)return;
    fs.forEach(f=>{
      if(f.size<120*1024){
        const r=new FileReader();
        r.onload=()=>{a.files.push({name:f.name,size:f.size,data:r.result});if(!--pending){save();logit('Attachment added',f.name+' on '+a.tag);openDrawer(id);}};
        r.onerror=()=>{a.files.push({name:f.name,size:f.size});if(!--pending){save();openDrawer(id);}};
        r.readAsDataURL(f);
      }else{
        a.files.push({name:f.name,size:f.size});
        if(!--pending){save();logit('Attachment recorded',f.name+' on '+a.tag);openDrawer(id);}
      }
    });
  };
  const ds=wrap.querySelector('#dsave');
  if(ds)ds.onclick=async()=>{
    const g=k=>wrap.querySelector('#e_'+k).value;
    const patch={version:a.version};
    ['user','dept','status','type','brand','model','serial','cpu','ram','storage','os','warrantyEnd','vendor']
      .forEach(k=>patch[k]=g(k).trim());
    patch.siteCode=g('site');
    patch.purchaseYear=+g('purchaseYear')||a.purchaseYear;
    const rawPrice=g('purchasePrice').trim();
    patch.purchasePrice=rawPrice===''?null:rawPrice;
    const custom={};let missing=null;
    S.fields.forEach(f=>{
      const v=wrap.querySelector('#e_cf_'+f.key).value.trim();
      if(f.required&&!v)missing=f.label;
      custom[f.key]=v;
    });
    if(missing){toast(missing+' is required');return;}
    patch.custom=custom;
    ds.disabled=true;
    try{
      const r=await API.updateAsset(a.id,patch);
      putLocalAsset(r.asset);
      close();render();toast('Saved '+r.asset.tag);
    }catch(err){
      ds.disabled=false;
      if(handleAuthLoss(err))return;
      if(err.code==='CONFLICT'&&err.current){
        // Someone else got there first. Show what they changed rather than
        // overwriting it; the person decides what to do next.
        putLocalAsset(err.current);
        close();render();
        showConflict(err.current);
        return;
      }
      toast(err.message);
    }
  };
  const dd=wrap.querySelector('#ddel');
  if(dd)dd.onclick=async()=>{
    if(!confirm('Delete '+a.tag+'?'))return;
    try{
      await API.deleteAsset(a.id);
      S.assets=S.assets.filter(x=>x.id!==a.id);SEL.delete(a.id);
      close();render();toast('Deleted '+a.tag);
    }catch(err){ if(!handleAuthLoss(err))toast(err.message); }
  };
}

/** Explains a rejected write instead of silently discarding one side of it. */
function showConflict(current){
  const wrap=document.createElement('div');
  wrap.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-label="Edit conflict"><div class="box">
    <h2>Someone else changed this asset</h2>
    <p>Your change was not saved, because <strong>${esc(current.tag)}</strong> was updated by someone else while you had it open. Nothing was overwritten. The row below is what is stored now — reopen it and apply your change on top.</p>
    <dl class="kv">
      <dt>Assigned to</dt><dd>${esc(current.user)}</dd>
      <dt>Department</dt><dd>${esc(current.dept)}</dd>
      <dt>Status</dt><dd>${esc(current.status)}</dd>
      <dt>Vendor</dt><dd>${current.vendor?esc(current.vendor):'Not recorded'}</dd>
      <dt>Purchase price</dt><dd>${money(current.purchasePrice)}</dd>
      <dt>Last updated</dt><dd>${esc(fmtDT(current.updatedAt))}</dd>
    </dl>
    <div class="row" style="margin-top:14px">
      <button class="btn p" id="cfopen">Open the current version</button>
      <button class="btn" id="cfclose">Close</button>
    </div>
  </div></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('#cfclose').onclick=()=>wrap.remove();
  wrap.querySelector('#cfopen').onclick=()=>{wrap.remove();openDrawer(current.id);};
}

/* ---------- add asset ---------- */
function nextTag(code){
  const n=S.assets.filter(a=>a.siteCode===code).length+1;
  let t,i=n;
  do{t=code+'-PC-'+String(i).padStart(3,'0');i++;}while(S.assets.some(a=>a.tag===t));
  return t;
}
function vAdd(v){
  if(!can('edit')){v.innerHTML='<div class="empty"><b>Read-only access</b>Your role cannot add assets. Switch to an Admin or Manager account.</div>';return;}
  v.innerHTML=`
  <div class="card" style="max-width:880px">
    <header><h2>New asset</h2><span style="margin-left:auto;color:var(--muted);font-size:12.5px">Asset tag is generated from the site code</span></header>
    <div class="in">
      <div class="g2">
        <label class="f"><span>Site <i>*</i></span><select id="n_site">${S.sites.map(s=>`<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select></label>
        <label class="f"><span>Asset tag</span><input type="text" id="n_tag" class="mono"></label>
        <label class="f"><span>Assigned to <i>*</i></span><input type="text" id="n_user" placeholder="User name or shared purpose"></label>
        <label class="f"><span>Department</span><select id="n_dept">${S.depts.map(d=>`<option>${esc(d.name)}</option>`).join('')}</select></label>
        <label class="f"><span>Type</span><select id="n_type">${['Desktop','All-in-One','Laptop','Printer','Server','Network'].map(s=>`<option>${s}</option>`).join('')}</select></label>
        <label class="f"><span>Status</span><select id="n_status">${STATUSES.map(s=>`<option ${s==='In use'?'selected':''}>${s}</option>`).join('')}</select></label>
        <label class="f"><span>Make</span><input type="text" id="n_brand" placeholder="Lenovo, HP, Dell…"></label>
        <label class="f"><span>Model</span><input type="text" id="n_model"></label>
        <label class="f"><span>Serial number</span><input type="text" id="n_serial"></label>
        <label class="f"><span>Processor</span><input type="text" id="n_cpu"></label>
        <label class="f"><span>Memory</span><input type="text" id="n_ram" placeholder="8 GB"></label>
        <label class="f"><span>Storage</span><input type="text" id="n_storage" placeholder="512 GB SSD"></label>
        <label class="f"><span>Operating system</span><input type="text" id="n_os" placeholder="Windows 11 Pro"></label>
        <label class="f"><span>Vendor</span><input type="text" id="n_vendor" placeholder="Who it was bought from"></label>
        <label class="f"><span>Purchase price (\u20B9)</span><input type="text" id="n_purchasePrice" class="mono" placeholder="Leave blank if unknown"></label>
        <label class="f"><span>Purchase year</span><input type="number" id="n_purchaseYear" value="${YEAR}"></label>
        <label class="f"><span>Warranty end</span><input type="date" id="n_warrantyEnd"></label>
      </div>
      ${S.fields.length?`<h3 style="margin:6px 0 8px">Additional fields</h3><div class="g2">
        ${S.fields.map(f=>`<label class="f"><span>${esc(f.label)}${f.required?' <i>*</i>':''}</span>${fieldInput(f,'','n_cf_')}</label>`).join('')}
      </div>`:'<p class="note">No custom fields defined yet. Add them under Custom fields and they appear here automatically.</p>'}
      <div class="row" style="margin-top:8px">
        <button class="btn p" id="nsave">Add asset</button>
        <button class="btn" id="nreset">Reset form</button>
      </div>
    </div>
  </div>`;
  const setTag=()=>$('#n_tag').value=nextTag($('#n_site').value);
  setTag();$('#n_site').onchange=setTag;
  $('#nreset').onclick=()=>{VIEW='add';render();};
  $('#nsave').onclick=async()=>{
    const g=k=>$('#n_'+k).value.trim();
    if(!g('user')){toast('Assigned to is required');$('#n_user').focus();return;}
    const custom={};let missing=null;
    S.fields.forEach(f=>{const v=$('#n_cf_'+f.key).value.trim();if(f.required&&!v)missing=f.label;custom[f.key]=v;});
    if(missing){toast(missing+' is required');return;}
    const rawPrice=g('purchasePrice');
    const btn=$('#nsave');btn.disabled=true;
    try{
      const r=await API.createAsset({
        tag:g('tag'),serial:g('serial'),type:g('type'),brand:g('brand')||'Unbranded',
        model:g('model'),user:g('user'),dept:g('dept'),siteCode:g('site'),cpu:g('cpu'),
        ram:g('ram'),storage:g('storage'),os:g('os'),status:g('status'),vendor:g('vendor'),
        purchasePrice:rawPrice===''?null:rawPrice,purchaseYear:+g('purchaseYear')||YEAR,
        warrantyEnd:g('warrantyEnd'),custom
      });
      putLocalAsset(r.asset);
      VIEW='assets';F={...F,q:r.asset.tag,page:1};render();toast('Added '+r.asset.tag);
    }catch(err){
      btn.disabled=false;
      if(handleAuthLoss(err))return;
      if(err.fields){
        const first=Object.values(err.fields)[0];
        toast(first||err.message);
      } else toast(err.message);
    }
  };
}
