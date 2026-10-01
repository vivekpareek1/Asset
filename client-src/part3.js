/* ---------- shell ---------- */
const NAV=[
  {g:'Overview'},
  {v:'dash',t:'Dashboard'},
  {v:'assets',t:'Assets',ct:()=>scopedAssets().length},
  {v:'add',t:'Add asset',edit:true},
  {v:'import',t:'Import data',edit:true},
  {v:'reports',t:'Reports'},
  {g:'Administration'},
  {v:'sites',t:'Companies & sites',ct:()=>S.sites.length,admin:true},
  {v:'depts',t:'Departments',ct:()=>S.depts.length,admin:true},
  {v:'fields',t:'Custom fields',ct:()=>S.fields.length,admin:true},
  {v:'users',t:'Portal users',ct:()=>S.users.length,admin:true},
  {v:'theme',t:'Theme settings',admin:true},
  {v:'uploadtests',t:'Upload tests',admin:true},
  {v:'log',t:'Activity log'}
];
function renderShell(){
  const nav=NAV.filter(n=>n.g||(!n.admin||can('admin'))&&(!n.edit||can('edit'))).map(n=>{
    if(n.g)return `<div class="grp">${n.t||n.g}</div>`;
    const c=n.ct?`<span class="ct">${n.ct()}</span>`:'';
    const ic={'dash': '&#9673;', 'assets': '&#9638;', 'add': '&#65291;', 'import': '&#8593;', 'reports': '&#9776;', 'sites': '&#8962;', 'depts': '&#128101;', 'fields': '&#9881;', 'users': '&#128100;', 'theme': '&#127912;', 'uploadtests': '&#128268;', 'log': '&#128337;'}[n.v]||'&#8226;';
    return `<button data-nav="${n.v}" class="${VIEW===n.v?'on':''}"><span class="ic" aria-hidden="true">${ic}</span>${n.t}${c}</button>`;
  }).join('');
  document.body.innerHTML=`
  <div class="shell">
    <aside class="rail" id="rail">
      <div class="brand">${S.logo?`<img class="mark" src="${logoSrc(S.logo)}" alt="Company logo">`:'<span class="mark">A</span>'}<span><b>AssetOps</b><br><span style="font-size:11px;font-weight:400">IT asset register</span></span></div>
      <nav class="nav">${nav}</nav>
      <div class="railfoot">${S.assets.length} assets · ${S.sites.length} sites</div>
    </aside>
    <div class="main">
      <div class="top">
        <button class="btn sm noprint" id="menu" style="display:none">Menu</button>
        <h1 id="ttl"></h1>
        <div class="who noprint">
          <button type="button" class="modetoggle" id="modetoggle" aria-label="Toggle dark mode"></button>
          <span>${esc(ME.name)} · ${esc(ME.role)}</span>
          <button class="btn sm" id="security">Security</button>
          <button class="btn sm" id="signout">Sign out</button>
        </div>
      </div>
      <div class="body" id="view"></div>
    </div>
  </div>`;
  document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{VIEW=b.dataset.nav;SEL.clear();F.page=1;render();});
  $('#signout').onclick=signOut;
  $('#security').onclick=()=>{PWOPEN=true;render();};
  bindModeToggle();
  if(innerWidth<=820){$('#menu').style.display='';$('#menu').onclick=e=>{e.stopPropagation();$('#rail').classList.toggle('open');};
    document.querySelector('.main').addEventListener('click',()=>$('#rail').classList.remove('open'));}
}
const TITLES={dash:'Fleet overview',assets:'Asset register',add:'Add asset',import:'Import data',importResult:'Import results',reports:'Reports',sites:'Companies & sites',depts:'Departments',fields:'Custom fields',users:'Portal users',theme:'Theme settings',uploadtests:'Upload tests',log:'Activity log',qrlabels:'QR labels'};
function render(){
  renderShell();
  $('#ttl').textContent=TITLES[VIEW]||'';
  const v=$('#view');
  ({dash:vDash,assets:vAssets,add:vAdd,import:vImport,importResult:vImportResult,reports:vReports,sites:vSites,depts:vDepts,fields:vFields,users:vUsers,theme:vTheme,uploadtests:vUploadTests,log:vLog,qrlabels:vQrLabels}[VIEW]||vDash)(v);
  if(DRAWER)openDrawer(DRAWER,true);
  if(TRESET)document.body.insertAdjacentHTML('beforeend',resetModal());
  bindResetModal();
  if(PWOPEN)document.body.insertAdjacentHTML('beforeend',passwordModal());
  bindPasswordModal();
}

/* ---------- dashboard ---------- */
function vDash(v){
  const A=scopedAssets();
  const byStatus={};STATUSES.forEach(s=>byStatus[s]=0);
  A.forEach(a=>byStatus[a.status]=(byStatus[a.status]||0)+1);
  const lowRam=A.filter(a=>ramGB(a)>0&&ramGB(a)<=4).length;
  const outWarr=A.filter(a=>a.warrantyEnd&&new Date(a.warrantyEnd)<new Date()).length;
  const priced=A.filter(a=>a.purchasePrice!=null);
  const spend=totalValue(priced);
  const byVendor={};priced.forEach(a=>{const v=a.vendor||'Vendor not recorded';byVendor[v]=(byVendor[v]||0)+a.purchasePrice;});
  const vendorRows=Object.entries(byVendor).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxVendor=Math.max(1,...vendorRows.map(r=>r[1]));
  const bySite={};A.forEach(a=>bySite[a.siteCode]=(bySite[a.siteCode]||0)+1);
  const siteRows=Object.entries(bySite).sort((a,b)=>b[1]-a[1]);
  const maxSite=Math.max(1,...siteRows.map(r=>r[1]));
  const byDept={};A.forEach(a=>byDept[a.dept]=(byDept[a.dept]||0)+1);
  const deptRows=Object.entries(byDept).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxDept=Math.max(1,...deptRows.map(r=>r[1]));

  // Every date-type custom field whose label names it as an expiry (MS Office,
  // ZWCAD, and whatever else gets added later) is picked up automatically —
  // nothing here hardcodes field names, so a new "X Licence Expiry Date" field
  // added later shows up on this list without a code change.
  const expiryFields=S.fields.filter(f=>f.type==='date'&&/expiry/i.test(f.label));
  const today=new Date(); today.setHours(0,0,0,0);
  const daysUntil=d=>{const t=new Date(d);if(isNaN(t))return null;t.setHours(0,0,0,0);return Math.round((t-today)/86400000);};
  // Bounded on BOTH sides: a warranty that lapsed three years ago is already
  // counted in the "Out of warranty" stat above and re-listing it here would
  // just be noise. This card is specifically for what needs a decision soon —
  // recently lapsed (still worth chasing) through the next 60 days.
  const expiring=[];
  A.forEach(a=>{
    if(a.warrantyEnd){const d=daysUntil(a.warrantyEnd);if(d!=null&&d>=-30&&d<=60)expiring.push({a,label:'Warranty',date:a.warrantyEnd,days:d});}
    expiryFields.forEach(f=>{
      const v=(a.custom||{})[f.key];
      if(!v)return;
      const d=daysUntil(v);
      if(d!=null&&d>=-30&&d<=60)expiring.push({a,label:f.label.replace(/ Expiry Date$/i,''),date:v,days:d});
    });
  });
  expiring.sort((x,y)=>x.days-y.days);
  const overdue=expiring.filter(x=>x.days<0).length;
  const next30=expiring.filter(x=>x.days>=0&&x.days<=30).length;
  const next60=expiring.filter(x=>x.days>30&&x.days<=60).length;
  const expiringShown=expiring.slice(0,15);

  const buckets=[
    {t:'2010–2013',c:'#A8442A',f:a=>a.purchaseYear<=2013},
    {t:'2014–2016',c:'#8A6614',f:a=>a.purchaseYear>=2014&&a.purchaseYear<=2016},
    {t:'2017–2019',c:'#1E5A78',f:a=>a.purchaseYear>=2017&&a.purchaseYear<=2019},
    {t:'2020+',c:'#2F6B4C',f:a=>a.purchaseYear>=2020}
  ].map(b=>({...b,n:A.filter(b.f).length}));
  const tot=Math.max(1,A.length);

  v.innerHTML=`
  <div class="grid" style="gap:18px">
    <div class="stats">
      <div class="stat"><b>${A.length}</b><span>Assets in register</span></div>
      <div class="stat"><b>${Object.keys(bySite).length}</b><span>Sites covered</span></div>
      <div class="stat ${byStatus['Replace due']?'attn':''}"><b>${byStatus['Replace due']||0}</b><span>Flagged for replacement</span></div>
      <div class="stat"><b>${lowRam}</b><span>Running on 4 GB or less</span></div>
      <div class="stat"><b>${outWarr}</b><span>Out of warranty</span></div>
      <div class="stat"><b style="font-size:calc(var(--app-font-size) * 1.5)">${money(spend)}</b><span>Recorded spend${priced.length<A.length?` \u00b7 ${A.length-priced.length} without a price`:''}</span></div>
    </div>

    <div class="card">
      <header><h2>Expiring soon</h2><span style="margin-left:auto;color:var(--muted);font-size:12.5px">Warranty and licence dates, last 30 to next 60 days</span></header>
      <div class="in">
        ${expiring.length?`
        <div class="row" style="gap:18px;margin-bottom:14px">
          <div><b class="mono" style="font-size:22px;color:${overdue?'var(--oxide)':'var(--ink)'}">${overdue}</b> <span style="color:var(--muted);font-size:12.5px">overdue</span></div>
          <div><b class="mono" style="font-size:22px;color:${next30?'var(--amber)':'var(--ink)'}">${next30}</b> <span style="color:var(--muted);font-size:12.5px">next 30 days</span></div>
          <div><b class="mono" style="font-size:22px">${next60}</b> <span style="color:var(--muted);font-size:12.5px">31–60 days</span></div>
        </div>
        <div class="tw" style="max-height:340px"><table><thead><tr><th>Asset</th><th>Assigned to</th><th>Item</th><th>Expires</th><th>Days</th></tr></thead>
          <tbody>${expiringShown.map(x=>`<tr data-open="${x.a.id}" style="cursor:pointer">
            <td class="mono">${esc(x.a.tag)}</td><td>${esc(x.a.user)}</td><td>${esc(x.label)}</td>
            <td class="mono">${esc(x.date)}</td>
            <td class="mono" style="color:${x.days<0?'var(--oxide)':x.days<=7?'var(--amber)':'var(--muted)'}">${x.days<0?Math.abs(x.days)+' over':x.days+'d'}</td>
          </tr>`).join('')}</tbody></table></div>
        ${expiring.length>expiringShown.length?`<p style="margin:10px 0 0;color:var(--muted);font-size:12.5px">${expiring.length-expiringShown.length} more not shown — narrow it down from Reports.</p>`:''}
        `:`<p style="margin:0;color:var(--muted);font-size:13px">Nothing due in this window — no warranty or licence expiry within the last 30 or next 60 days.</p>`}
      </div>
    </div>

    <div class="card">
      <header><h2>Fleet by hardware age</h2><span style="margin-left:auto;color:var(--muted);font-size:12.5px">Estimated from processor generation</span></header>
      <div class="in">
        <div class="spine">
          ${buckets.filter(b=>b.n).map(b=>`<div style="background:${b.c};flex:${b.n}" title="${b.t}: ${b.n}">${b.n/tot>0.07?b.n:''}</div>`).join('')}
        </div>
        <div class="spinelegend">
          ${buckets.map(b=>`<span><i style="background:${b.c}"></i>${b.t} · ${b.n}</span>`).join('')}
        </div>
        <p style="margin:12px 0 0;color:var(--muted);font-size:13px;max-width:66ch">
          ${buckets[0].n+buckets[1].n} machines are ten years old or older. Those carry the ${byStatus['Replace due']||0} replacement flags and most of the 4 GB memory constraints.
        </p>
      </div>
    </div>

    <div class="grid two-col">
      <div class="card"><header><h2>Assets by site</h2></header><div class="in"><div class="bars">
        ${siteRows.map(([c,n])=>`<div class="bar"><span class="trunc" title="${esc(siteName(c))}">${esc(siteName(c))}</span><span class="t" style="width:${n/maxSite*100}%"></span><span class="n">${n}</span></div>`).join('')}
      </div></div></div>
      <div class="card"><header><h2>Top departments</h2></header><div class="in"><div class="bars">
        ${deptRows.map(([c,n])=>`<div class="bar"><span class="trunc" title="${esc(c)}">${esc(c)}</span><span class="t" style="width:${n/maxDept*100}%"></span><span class="n">${n}</span></div>`).join('')}
      </div></div></div>
    </div>

    ${vendorRows.length?`<div class="card"><header><h2>Spend by vendor</h2>
      <span style="margin-left:auto;color:var(--muted);font-size:12.5px">${priced.length} of ${A.length} assets have a recorded price</span></header>
      <div class="in"><div class="bars">
      ${vendorRows.map(([v,amt])=>`<div class="bar"><span class="trunc" title="${esc(v)}">${esc(v)}</span><span class="t" style="width:${amt/maxVendor*100}%"></span><span class="n">${money(amt)}</span></div>`).join('')}
    </div></div></div>`:`<div class="note">No purchase prices recorded yet. Add a vendor and price on any asset, or map the columns on the Import data page to fill them in bulk \u2014 the spend reports appear once there is something to report.</div>`}

    <div class="card"><header><h2>Status breakdown</h2></header><div class="in">
      <div class="donut-wrap">
        ${donutSVG(STATUSES.map(s=>({value:byStatus[s]||0,color:STATUS_COLOR[s]})))}
        <div class="donut-legend">
          ${STATUSES.map(s=>`<button class="btn sm" data-jump="${s}" style="justify-content:flex-start;border:0;background:none;padding:3px 4px">
            <span class="row" style="gap:8px"><i style="background:${STATUS_COLOR[s]};width:10px;height:10px;border-radius:2px;display:inline-block"></i>
            ${s} <b class="mono" style="margin-left:auto;padding-left:14px">${byStatus[s]||0}</b></span></button>`).join('')}
        </div>
      </div>
    </div></div>
  </div>`;
  v.querySelectorAll('[data-jump]').forEach(b=>b.onclick=()=>{F={...F,status:b.dataset.jump,page:1};VIEW='assets';render();});
  v.querySelectorAll('[data-open]').forEach(el=>el.onclick=()=>openDrawer(el.dataset.open));
}

/* ---------- assets ---------- */
function cols(){
  const base=[
    {k:'tag',t:'Asset tag',r:a=>`<span class="mono">${esc(a.tag)}</span>`},
    {k:'user',t:'Assigned to',r:a=>esc(a.user)},
    {k:'dept',t:'Department',r:a=>esc(a.dept)},
    {k:'site',t:'Site',r:a=>esc(siteName(a.siteCode))},
    {k:'model',t:'Model',r:a=>`<span class="trunc" title="${esc(a.model)}">${esc(a.model)}</span>`},
    {k:'cpu',t:'Processor',r:a=>`<span class="trunc" title="${esc(a.cpu)}">${esc(a.cpu)}</span>`},
    {k:'ram',t:'Memory',r:a=>esc(a.ram)},
    {k:'storage',t:'Storage',r:a=>`<span class="trunc" title="${esc(a.storage)}">${esc(a.storage)}</span>`},
    {k:'status',t:'Status',r:a=>`<span class="pill ${statusCls(a.status)}">${esc(a.status)}</span>`},
    {k:'vendor',t:'Vendor',r:a=>a.vendor?esc(a.vendor):'<span class="dash" title="Not recorded">\u2014</span>'},
    {k:'purchasePrice',t:'Purchase price',r:a=>`<span class="mono" style="${a.purchasePrice==null?'color:var(--muted)':''}">${money(a.purchasePrice)}</span>`}
  ];
  S.fields.filter(f=>f.inTable).forEach(f=>base.push({k:'cf_'+f.key,t:f.label,r:a=>esc((a.custom||{})[f.key]||'—')}));
  return base;
}
function vAssets(v){
  const A=scopedAssets();
  const list=filtered();
  const pages=Math.max(1,Math.ceil(list.length/F.per));
  if(F.page>pages)F.page=pages;
  const page=list.slice((F.page-1)*F.per,F.page*F.per);
  const C=cols();
  const opts=(arr,sel)=>arr.map(o=>`<option value="${esc(o)}" ${sel===o?'selected':''}>${esc(o)}</option>`).join('');
  const brands=[...new Set(A.map(a=>a.brand))].sort();
  const vendors=[...new Set(A.map(a=>a.vendor).filter(Boolean))].sort();

  v.innerHTML=`
  <div class="card">
    <header class="noprint" style="flex-wrap:wrap">
      <input type="text" id="q" placeholder="Search tag, user, model, processor, serial" value="${esc(F.q)}" class="qbox">
      <select id="fsite" style="width:auto"><option value="">All sites</option>${S.sites.filter(s=>A.some(a=>a.siteCode===s.code)).map(s=>`<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select>
      <select id="fdept" style="width:auto"><option value="">All departments</option>${opts([...new Set(A.map(a=>a.dept))].sort(),F.dept)}</select>
      <select id="fstatus" style="width:auto"><option value="">Any status</option>${opts(STATUSES,F.status)}</select>
      <select id="ftype" style="width:auto"><option value="">Any type</option>${opts(['Desktop','All-in-One','Laptop','Printer','Server','Network'],F.type)}</select>
      <select id="fbrand" style="width:auto"><option value="">Any make</option>${opts(brands,F.brand)}</select>
      <select id="fvendor" style="width:auto"><option value="">Any vendor</option>${opts(vendors,F.vendor)}</select>
      <button class="btn" id="clear">Clear</button>
      <span style="margin-left:auto;color:var(--muted);font-size:12.5px">${list.length} of ${A.length}${(()=>{const p=list.filter(a=>a.purchasePrice!=null);return p.length?` \u00b7 ${money(totalValue(p))} across ${p.length} priced`:'';})()}</span>
      <button class="btn" id="exp">Export CSV</button>
      <button class="btn" id="expxl">Export Excel</button>
    </header>
    <div class="tw">
      <table id="tbl">
        <thead><tr>
          <th class="chk"><input type="checkbox" id="all" ${page.length&&page.every(a=>SEL.has(a.id))?'checked':''} aria-label="Select all on this page"></th>
          ${C.map(c=>`<th class="s" data-k="${c.k}">${esc(c.t)}${F.sort.k===c.k?(F.sort.dir>0?' ↑':' ↓'):''}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${page.length?page.map(a=>`<tr data-id="${a.id}" class="${SEL.has(a.id)?'sel':''}">
            <td class="chk"><input type="checkbox" data-c="${a.id}" ${SEL.has(a.id)?'checked':''} aria-label="Select ${esc(a.tag)}"></td>
            ${C.map(c=>`<td data-open="${a.id}">${c.r(a)}</td>`).join('')}
          </tr>`).join(''):`<tr><td colspan="${C.length+1}"><div class="empty"><b>No assets match these filters</b>Adjust the search or clear the filters to see the full register.</div></td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="in row noprint" style="border-top:1px solid var(--line2)">
      <button class="btn sm" id="prev" ${F.page<=1?'disabled':''}>Previous</button>
      <span class="mono" style="font-size:12.5px">Page ${F.page} of ${pages}</span>
      <button class="btn sm" id="next" ${F.page>=pages?'disabled':''}>Next</button>
      <span style="color:var(--muted);font-size:12.5px;margin-left:8px">Drag down the checkbox column or shift-click to select a range.</span>
    </div>
  </div>
  <div id="bulkbar"></div>`;

  const rerender=()=>{const y=window.scrollY;render();window.scrollTo(0,y);};
  $('#q').oninput=e=>{F.q=e.target.value;F.page=1;clearTimeout(window._qt);window._qt=setTimeout(rerender,220);};
  $('#fsite').value=F.site;$('#fdept').value=F.dept;$('#fstatus').value=F.status;$('#ftype').value=F.type;$('#fbrand').value=F.brand;$('#fvendor').value=F.vendor;
  ['site','dept','status','type','brand','vendor'].forEach(k=>{$('#f'+k).onchange=e=>{F[k]=e.target.value;F.page=1;rerender();};});
  $('#clear').onclick=()=>{F={...F,q:'',site:'',dept:'',status:'',type:'',brand:'',vendor:'',page:1};rerender();};
  $('#exp').onclick=()=>{exportAssets(list,'assets-filtered.csv');toast(list.length+' rows exported');};
  $('#expxl').onclick=()=>exportAssetsXlsx(list,'assets-filtered.xlsx');
  $('#prev').onclick=()=>{F.page--;rerender();};
  $('#next').onclick=()=>{F.page++;rerender();};
  v.querySelectorAll('th.s').forEach(th=>th.onclick=()=>{
    const k=th.dataset.k;
    F.sort=F.sort.k===k?{k,dir:-F.sort.dir}:{k,dir:1};rerender();
  });
  $('#all').onchange=e=>{page.forEach(a=>e.target.checked?SEL.add(a.id):SEL.delete(a.id));rerender();};
  v.querySelectorAll('td[data-open]').forEach(td=>td.onclick=()=>openDrawer(td.dataset.open));

  // selection: click, shift-range, drag
  const boxes=[...v.querySelectorAll('input[data-c]')];
  boxes.forEach((b,i)=>{
    b.onclick=ev=>{
      ev.stopPropagation();
      if(ev.shiftKey&&lastIdx>-1){
        const [s,e2]=[Math.min(lastIdx,i),Math.max(lastIdx,i)];
        for(let j=s;j<=e2;j++){b.checked?SEL.add(boxes[j].dataset.c):SEL.delete(boxes[j].dataset.c);}
      }else{
        b.checked?SEL.add(b.dataset.c):SEL.delete(b.dataset.c);
      }
      lastIdx=i;rerender();
    };
    b.onmousedown=ev=>{
      if(ev.shiftKey)return;
      dragging=true;dragMode=!b.checked;document.body.style.userSelect='none';
    };
    b.parentElement.parentElement.onmouseenter=()=>{
      if(!dragging)return;
      dragMode?SEL.add(b.dataset.c):SEL.delete(b.dataset.c);
      b.checked=dragMode;b.closest('tr').classList.toggle('sel',dragMode);
      drawBulk();
    };
  });
  drawBulk();
}
function endDrag(){ if(dragging){dragging=false;document.body.style.userSelect='';} }
document.addEventListener('mouseup',endDrag);

function drawBulk(){
  const bb=document.getElementById('bulkbar');if(!bb)return;
  if(!SEL.size){bb.innerHTML='';return;}
  const editable=can('edit');
  bb.innerHTML=`<div class="bulk noprint">
    <b>${SEL.size} selected</b>
    ${editable?`
    <select id="bs"><option value="">Set status…</option>${STATUSES.map(s=>`<option>${s}</option>`).join('')}</select>
    <select id="bsite"><option value="">Move to site…</option>${S.sites.map(s=>`<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select>
    <select id="bdept"><option value="">Set department…</option>${S.depts.map(d=>`<option>${esc(d.name)}</option>`).join('')}</select>
    <input type="text" id="bvend" placeholder="Set vendor…" style="width:150px;background:#22333F;border-color:#2E4150;color:#fff" list="vendorlist">
    <datalist id="vendorlist">${[...new Set(S.assets.map(a=>a.vendor).filter(Boolean))].sort().map(v=>`<option value="${esc(v)}">`).join('')}</datalist>
    <button class="btn sm" id="bvendgo">Apply vendor</button>`:''}
    <button class="btn sm" id="bexp">Export CSV</button>
    <button class="btn sm" id="bexpxl">Export Excel</button>
    <button class="btn sm" id="bqr">Print QR labels</button>
    ${can('admin')?`<button class="btn sm d" id="bdel" style="border-color:#7A3524;color:#F0B9AB">Delete</button>`:''}
    <button class="btn sm" id="bclr" style="margin-left:auto">Clear selection</button>
  </div>`;
  const ids=[...SEL];

  /** One request for the whole selection; the server applies it in a transaction. */
  const apply=async (patch,msg)=>{
    try{
      const r=await API.bulkAssets(ids,patch);
      const b=await API.bootstrap();          // re-read: versions moved on the server
      S.assets=b.assets;
      toast(`${msg} for ${r.changed} of ${ids.length}`);
      if(r.changed<ids.length)toast(`${ids.length-r.changed} skipped — outside your site access`);
    }catch(err){ apiFail(err,'The bulk change failed.'); }
    render();
  };
  if(editable){
    document.getElementById('bs').onchange=e=>e.target.value&&apply({status:e.target.value},'Status set to '+e.target.value);
    document.getElementById('bsite').onchange=e=>e.target.value&&apply({siteCode:e.target.value},'Moved to '+siteName(e.target.value));
    document.getElementById('bdept').onchange=e=>e.target.value&&apply({dept:e.target.value},'Department set to '+e.target.value);
    const bv=document.getElementById('bvend');
    const applyVendor=()=>{const v=bv.value.trim();if(!v)return toast('Type a vendor name first');apply({vendor:v},'Vendor set to '+v);};
    document.getElementById('bvendgo').onclick=applyVendor;
    bv.onkeydown=e=>{if(e.key==='Enter')applyVendor();};
  }
  document.getElementById('bexp').onclick=()=>{exportAssets(S.assets.filter(a=>SEL.has(a.id)),'assets-selected.csv');toast(ids.length+' rows exported');};
  document.getElementById('bexpxl').onclick=()=>exportAssetsXlsx(S.assets.filter(a=>SEL.has(a.id)),'assets-selected.xlsx');
  document.getElementById('bqr').onclick=()=>{QR_IDS=[...ids];VIEW='qrlabels';render();};
  const bd=document.getElementById('bdel');
  if(bd)bd.onclick=async()=>{
    if(!await confirmDialog({title:'Delete '+ids.length+(ids.length===1?' asset?':' assets?'),message:'They will be removed from the register for good. This cannot be undone.',confirmLabel:'Delete',danger:true}))return;
    let done=0,failed=0;
    for(const id of ids){
      try{ await API.deleteAsset(id); done++; }
      catch(err){ if(handleAuthLoss(err))return; failed++; }
    }
    S.assets=S.assets.filter(a=>!ids.includes(a.id)||failed&&false);
    try{ const b=await API.bootstrap(); S.assets=b.assets; }catch(err){ if(handleAuthLoss(err))return; }
    SEL.clear();render();
    toast(failed?`${done} deleted, ${failed} could not be`:`${done} deleted`);
  };
  document.getElementById('bclr').onclick=()=>{SEL.clear();render();};
}

/* ---------- account security ---------- */
let PWOPEN=false, MFASETUP=null, MFACODES=null;

function passwordModal(){
  const on=ME&&ME.mfaEnabled;
  return `<div class="modal" role="dialog" aria-modal="true" aria-label="Account security"><div class="box">
    <h2>Account security</h2>
    <div id="pwerr"></div>

    <h3 style="margin:4px 0 8px">Password</h3>
    <p>At least 10 characters. Changing it signs out your other devices.</p>
    <label class="f"><span>Current password</span><input type="password" id="pwold" autocomplete="current-password"></label>
    <label class="f"><span>New password</span><input type="password" id="pwnew" autocomplete="new-password"></label>
    <div class="row"><button class="btn p" id="pwgo">Change password</button></div>

    <h3 style="margin:20px 0 8px">Two-step sign-in</h3>
    ${MFACODES?`
      <div class="alert k" role="status">Two-step sign-in is on. Save these recovery codes now \u2014 they are shown once and each works a single time.</div>
      <div class="rlog" style="max-height:none">${MFACODES.map(c=>`<div>${esc(c)}</div>`).join('')}</div>
      <div class="row" style="margin-top:9px">
        <button class="btn" id="mfacopy">Copy them</button>
        <button class="btn p" id="mfadone">I have saved them</button>
      </div>`
    : MFASETUP?`
      <p>Add this secret to your authenticator app, then type the code it shows.</p>
      <div class="logobox"><div class="meta"><strong>Secret</strong><br><span class="mono">${esc(MFASETUP.secret)}</span></div></div>
      <p style="word-break:break-all;font-size:11.5px;color:var(--muted)" class="mono">${esc(MFASETUP.uri)}</p>
      <label class="f"><span>Code from the app</span><input type="text" id="mfacode" class="mono" inputmode="numeric" maxlength="6"></label>
      <div class="row"><button class="btn p" id="mfaon">Turn it on</button><button class="btn" id="mfacancel">Cancel</button></div>`
    : on?`
      <p>Two-step sign-in is on. Turning it off needs your password.</p>
      <label class="f"><span>Password</span><input type="password" id="mfapw" autocomplete="current-password"></label>
      <div class="row"><button class="btn d" id="mfaoff">Turn it off</button></div>`
    :`
      <p>Ask for a code from an authenticator app each time you sign in. Strongly recommended for administrators.</p>
      <div class="row"><button class="btn" id="mfastart">Set it up</button></div>`}

    <div class="row" style="margin-top:18px"><button class="btn" id="pwcancel" style="margin-left:auto">Close</button></div>
  </div></div>`;
}

function bindPasswordModal(){
  const box=document.getElementById('pwerr');
  if(!box)return;
  const err=m=>{box.innerHTML=`<div class="alert e" role="alert">${esc(m)}</div>`;};
  const close=()=>{PWOPEN=false;MFASETUP=null;MFACODES=null;render();};
  document.getElementById('pwcancel').onclick=close;

  const go=document.getElementById('pwgo');
  if(go)go.onclick=async()=>{
    go.disabled=true;
    try{
      await API.changePassword(document.getElementById('pwold').value,document.getElementById('pwnew').value);
      if(ME)ME.mustChange=false;
      close();toast('Password changed. Other devices were signed out.');
    }catch(e){ if(handleAuthLoss(e))return; go.disabled=false; err(e.message); }
  };

  const start=document.getElementById('mfastart');
  if(start)start.onclick=async()=>{
    start.disabled=true;
    try{ MFASETUP=await API.mfaSetup(); render(); }
    catch(e){ if(handleAuthLoss(e))return; start.disabled=false; err(e.message); }
  };
  const cancel=document.getElementById('mfacancel');
  if(cancel)cancel.onclick=()=>{MFASETUP=null;render();};

  const on=document.getElementById('mfaon');
  if(on)on.onclick=async()=>{
    on.disabled=true;
    try{
      const r=await API.mfaEnable(document.getElementById('mfacode').value.trim());
      MFACODES=r.backupCodes; MFASETUP=null; ME.mfaEnabled=true; render();
    }catch(e){ if(handleAuthLoss(e))return; on.disabled=false; err(e.message); }
  };

  const copy=document.getElementById('mfacopy');
  if(copy)copy.onclick=()=>{
    const text=MFACODES.join('\n');
    if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(()=>toast('Copied'),()=>toast('Copy failed \u2014 select them by hand'));
    else toast('Select the codes and copy them by hand');
  };
  const done=document.getElementById('mfadone');
  if(done)done.onclick=close;

  const off=document.getElementById('mfaoff');
  if(off)off.onclick=async()=>{
    off.disabled=true;
    try{
      await API.mfaDisable(document.getElementById('mfapw').value);
      ME.mfaEnabled=false; MFASETUP=null; MFACODES=null; render(); toast('Two-step sign-in turned off.');
    }catch(e){ if(handleAuthLoss(e))return; off.disabled=false; err(e.message); }
  };
}


/* ---------- QR asset labels ---------- */
let QR_IDS=[];
/**
 * Loads kazuhikoarase's qrcode-generator on demand — same lazy-CDN pattern
 * the Excel import already uses, so a feature nobody opens costs nothing on
 * every other page.
 */
function loadQR(cb){
  if(window.qrcode)return cb();
  // Self-hosted rather than pulled from a CDN: a corporate outbound proxy that
  // allows this app's own origin but blocks a random CDN domain is a realistic
  // scenario for exactly the kind of internal IT tool this is, and self-hosting
  // removes that failure mode entirely rather than hoping the CDN is reachable.
  const base=document.createElement('script');
  base.src='/vendor/qrcode.js';
  base.onload=()=>{
    const utf8=document.createElement('script');   // adds multi-byte support; harmless for plain ASCII tags
    utf8.src='/vendor/qrcode-utf8.js';
    utf8.onload=cb; utf8.onerror=cb;                // base library alone is fully usable if this one fails
    document.head.appendChild(utf8);
  };
  base.onerror=()=>toast('QR code generator failed to load.');
  document.head.appendChild(base);
}
function qrSvg(text,size=112){
  const q=qrcode(0,'M'); // type 0 = auto-sized to fit the data
  q.addData(text); q.make();
  return q.createSvgTag({cellSize:size/q.getModuleCount(),margin:0});
}
function vQrLabels(v){
  const assets=S.assets.filter(a=>QR_IDS.includes(a.id));
  if(!assets.length){VIEW='assets';render();return;}
  v.innerHTML=`
  <div class="row noprint" style="margin-bottom:14px">
    <button class="btn p" id="qrprint">Print</button>
    <button class="btn" id="qrback">Back to assets</button>
    <span style="color:var(--muted);font-size:12.5px;margin-left:6px">${assets.length} labels — asset tag encoded as plain text, four to a row when printed</span>
  </div>
  <div class="qrsheet" id="qrsheet">${assets.map(a=>`<div class="qrlabel">
    <div class="qr" data-tag="${esc(a.tag)}"></div>
    <div class="tag">${esc(a.tag)}</div>
    <div class="who">${esc(a.user||'Unassigned')}</div>
  </div>`).join('')}</div>`;
  $('#qrback').onclick=()=>{VIEW='assets';render();};
  $('#qrprint').onclick=()=>window.print();
  loadQR(()=>{
    document.querySelectorAll('#qrsheet .qr').forEach(el=>{
      try{ el.innerHTML=qrSvg(el.dataset.tag); }
      catch(e){ el.textContent='(could not render)'; }
    });
  });
}
