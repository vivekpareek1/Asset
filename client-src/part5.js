/* ---------- import ---------- */
const TARGETS=[
  {k:'tag',t:'Asset tag'},{k:'serial',t:'Serial number'},{k:'type',t:'Type'},{k:'brand',t:'Make'},
  {k:'model',t:'Model'},{k:'user',t:'Assigned to'},{k:'dept',t:'Department'},{k:'siteCode',t:'Site code'},
  {k:'cpu',t:'Processor'},{k:'ram',t:'Memory'},{k:'storage',t:'Storage'},{k:'os',t:'Operating system'},
  {k:'status',t:'Status'},{k:'vendor',t:'Vendor'},{k:'purchasePrice',t:'Purchase price'},
  {k:'purchaseYear',t:'Purchase year'},{k:'warrantyEnd',t:'Warranty end'}
];
function guessMap(h){
  const s=String(h).toLowerCase().replace(/[^a-z0-9]/g,'');
  const g={
    tag:['assettag','tag','assetid','assetcode','assetno'],
    serial:['serial','serialnumber','serialno','sno'],
    siteCode:['site','sitename','sitecode','location','branch','office'],
    dept:['dept','department','division'],
    user:['username','user','assignedto','employee','name','owner','custodian'],
    type:['type','assettype','devicetype','desktopaio','category'],
    brand:['make','brand','manufacturer','oem'],
    model:['model','machine','modelno'],
    cpu:['cpu','processor','proc'],
    ram:['ram','memory'],
    storage:['storage','hdd','ssd','harddisk','hddssd','disk','harddrive'],
    os:['os','operatingsystem','windows'],
    status:['status','condition','state'],
    vendor:['vendor','supplier','vendorname','suppliername','purchasedfrom','boughtfrom','dealer','seller','party'],
    purchasePrice:['price','purchaseprice','cost','amount','rate','value','invoiceamount','purchasecost'],
    purchaseYear:['purchaseyear','year','purchased','purchasedate','buyyear'],
    warrantyEnd:['warrantyend','warranty','amcend','expiry','warrantyexpiry']
  };
  // vendor is matched before user: a column headed "supplier name" ends in "name",
  // which would otherwise be read as the person the asset is assigned to.
  const order=['tag','serial','siteCode','dept','vendor','purchasePrice','user','type','brand','model','cpu','ram','storage','os','status','purchaseYear','warrantyEnd'];
  for(const k of order)if(g[k].some(x=>s===x))return k;
  for(const k of order)if(g[k].some(x=>x.length>3&&s.includes(x)))return k;
  return '';
}
function vImport(v){
  if(!can('edit')){v.innerHTML='<div class="empty"><b>Read-only access</b>Your role cannot import data.</div>';return;}
  v.innerHTML=`
  <div class="grid" style="gap:14px;max-width:1000px">
    <div class="card">
      <header><h2>Load a file</h2></header>
      <div class="in">
        <div class="row" style="margin-bottom:10px">
          <input type="file" id="ifile" accept=".csv,.txt,.xlsx,.xls" style="width:auto">
          <span style="color:var(--muted);font-size:12.5px">CSV, or Excel if the reader loads</span>
        </div>
        <label class="f"><span>Or paste rows, first line is the header</span>
          <textarea id="ipaste" rows="6" placeholder="Asset tag,User name,Department,Site,Model,RAM"></textarea></label>
        <button class="btn p" id="iparse">Read rows</button>
      </div>
    </div>
    <div id="imapping"></div>
  </div>`;
  $('#iparse').onclick=()=>{
    const t=$('#ipaste').value.trim();
    if(!t){toast('Paste some rows first, or choose a file');return;}
    stage(csvParse(t));
  };
  $('#ifile').onchange=e=>{
    const f=e.target.files[0];if(!f)return;
    if(/\.(xlsx|xls)$/i.test(f.name))return readXlsx(f);
    const r=new FileReader();
    r.onload=()=>stage(csvParse(r.result));
    r.onerror=()=>toast('Could not read that file');
    r.readAsText(f);
  };
  function readXlsx(f){
    const go=()=>{
      const r=new FileReader();
      r.onload=()=>{
        try{
          const wb=XLSX.read(new Uint8Array(r.result),{type:'array'});
          const ws=wb.Sheets[wb.SheetNames[0]];
          const rows=XLSX.utils.sheet_to_json(ws,{header:1,blankrows:false}).map(row=>row.map(c=>c==null?'':String(c)));
          stage(rows.filter(row=>row.some(c=>c.trim()!=='')));
        }catch(err){toast('Could not read that workbook');}
      };
      r.readAsArrayBuffer(f);
    };
    if(window.XLSX)return go();
    const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload=go;
    s.onerror=()=>toast('Excel reader unavailable. Save the sheet as CSV and try again.');
    document.head.appendChild(s);
  }
  function stage(rows){
    if(rows.length<2){toast('Need a header row and at least one data row');return;}
    IMPORTED={head:rows[0].map(h=>String(h).trim()),rows:rows.slice(1)};
    drawMap();
  }
  function drawMap(){
    const {head,rows}=IMPORTED;
    const auto=head.map(guessMap);
    $('#imapping').innerHTML=`
    <div class="card">
      <header><h2>Match columns</h2><span style="margin-left:auto;color:var(--muted);font-size:12.5px">${rows.length} rows read</span></header>
      <div class="in">
        <div class="g2">
          ${head.map((h,i)=>`<label class="f"><span>${esc(h)||'Column '+(i+1)}</span>
            <select data-map="${i}"><option value="">Ignore this column</option>
            ${TARGETS.map(t=>`<option value="${t.k}" ${auto[i]===t.k?'selected':''}>${t.t}</option>`).join('')}
            ${S.fields.map(f=>`<option value="cf:${f.key}">${esc(f.label)}</option>`).join('')}
            </select></label>`).join('')}
        </div>
        <label class="f" style="max-width:320px"><span>Site for rows with no site column</span>
          <select id="idefsite">${S.sites.map(s=>`<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select></label>
        <div class="note" style="margin-bottom:12px">Rows whose asset tag already exists will update that asset instead of creating a duplicate.</div>
        <h3 style="margin-bottom:6px">Preview</h3>
        <div class="tw" style="max-height:230px;margin-bottom:12px"><table><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${rows.slice(0,5).map(r=>`<tr>${head.map((_,i)=>`<td><span class="trunc">${esc(r[i]||'')}</span></td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <div class="row"><button class="btn p" id="idoit">Import ${rows.length} rows</button><button class="btn" id="icancel">Cancel</button></div>
      </div>
    </div>`;
    $('#icancel').onclick=()=>{IMPORTED=null;$('#imapping').innerHTML='';};
    $('#idoit').onclick=doImport;
  }
  async function doImport(){
    const {head,rows}=IMPORTED;
    const map=[...document.querySelectorAll('[data-map]')].map(s=>s.value);
    if(!map.some(m=>m==='user'||m==='tag')){toast('Match at least an asset tag or an assigned-to column');return;}
    const defSite=$('#idefsite').value;
    const btn=$('#idoit');btn.disabled=true;btn.textContent='Importing…';

    // Shape the rows here; the server re-validates every field and applies the
    // whole batch in one transaction.
    const payload=rows.map(r=>{
      const rec={defaultSite:defSite,custom:{}};
      map.forEach((m,i)=>{
        if(!m)return;
        const val=String(r[i]==null?'':r[i]).trim();
        if(m.startsWith('cf:'))rec.custom[m.slice(3)]=val;
        else rec[m]=val;
      });
      return rec;
    });
    try{
      const r=await API.importAssets(payload);
      const b=await API.bootstrap();
      S.assets=b.assets;S.depts=b.depts;
      IMPORT_RESULT=r;IMPORTED=null;VIEW='importResult';render();
    }catch(err){
      btn.disabled=false;btn.textContent='Import '+rows.length+' rows';
      if(!handleAuthLoss(err))toast(err.message);
    }
  }
}

/**
 * Row-by-row account of the last import: what happened to each line and,
 * for anything skipped, exactly why — so re-uploading the same sheet next
 * quarter is something the person can trust rather than a black box.
 */
let IMPORT_RESULT=null;
function vImportResult(v){
  if(!IMPORT_RESULT){VIEW='import';render();return;}
  const r=IMPORT_RESULT;
  const rows=r.report||[];
  const pillFor=a=>a==='created'?'use':a==='updated'?'spare':'rep';
  const labelFor=a=>a==='created'?'Added':a==='updated'?'Updated':'Skipped';
  v.innerHTML=`
  <div class="stats" style="margin-bottom:14px">
    <div class="stat"><b>${r.created}</b><span>New assets added</span></div>
    <div class="stat"><b>${r.updated}</b><span>Existing assets updated</span></div>
    <div class="stat ${r.skipped?'alert':''}"><b>${r.skipped}</b><span>Rows skipped</span></div>
  </div>
  <div class="card">
    <header><h2>Row by row</h2>
      <span style="margin-left:auto;color:var(--muted);font-size:12.5px">Matched by asset tag first, then by serial number</span></header>
    <div class="tw"><table><thead><tr><th>Row</th><th>Result</th><th>Asset</th><th>Detail</th></tr></thead>
      <tbody>${rows.length?rows.map(row=>`<tr>
        <td class="mono">${row.row}</td>
        <td><span class="pill ${pillFor(row.action)}">${labelFor(row.action)}</span></td>
        <td class="mono">${row.tag?esc(row.tag):'\u2014'}</td>
        <td>${row.reason?esc(row.reason):(row.action==='created'?'New asset created.':'Matched an existing asset and updated it.')}</td>
      </tr>`).join(''):`<tr><td colspan="4"><div class="empty"><b>No row detail available</b></div></td></tr>`}
      </tbody></table></div>
  </div>
  <div class="row" style="margin-top:14px">
    <button class="btn p" id="irassets">View asset register</button>
    <button class="btn" id="iragain">Import another file</button>
  </div>`;
  $('#irassets').onclick=()=>{VIEW='assets';F={...F,q:'',page:1};render();};
  $('#iragain').onclick=()=>{IMPORT_RESULT=null;VIEW='import';render();};
}

/* ---------- reports ---------- */
const REPORTS=[
  {id:'site',t:'Assets by site',d:'Machine count and replacement exposure for each location.',
   run:A=>{const m={};A.forEach(a=>{m[a.siteCode]=m[a.siteCode]||{n:0,rep:0,low:0};m[a.siteCode].n++;if(a.status==='Replace due')m[a.siteCode].rep++;if(ramGB(a)>0&&ramGB(a)<=4)m[a.siteCode].low++;});
     return{head:['Site','Assets','Replace due','4 GB or less'],rows:Object.entries(m).sort((a,b)=>b[1].n-a[1].n).map(([c,x])=>[siteName(c),x.n,x.rep,x.low])};}},
  {id:'replace',t:'Replacement candidates',d:'Every machine flagged for replacement, oldest first.',
   run:A=>({head:['Asset tag','Site','Assigned to','Processor','Memory','Purchase year'],
     rows:A.filter(a=>a.status==='Replace due').sort((a,b)=>a.purchaseYear-b.purchaseYear).map(a=>[a.tag,siteName(a.siteCode),a.user,a.cpu,a.ram,a.purchaseYear])})},
  {id:'dept',t:'Assets by department',d:'Where the fleet sits across the business.',
   run:A=>{const m={};A.forEach(a=>m[a.dept]=(m[a.dept]||0)+1);
     return{head:['Department','Assets'],rows:Object.entries(m).sort((a,b)=>b[1]-a[1])};}},
  {id:'os',t:'Operating system spread',d:'Useful for patching and licence planning.',
   run:A=>{const m={};A.forEach(a=>m[a.os||'Not recorded']=(m[a.os||'Not recorded']||0)+1);
     return{head:['Operating system','Assets'],rows:Object.entries(m).sort((a,b)=>b[1]-a[1])};}},
  {id:'warr',t:'Warranty expired',d:'Assets past their warranty end date.',
   run:A=>({head:['Asset tag','Site','Assigned to','Make','Warranty end'],
     rows:A.filter(a=>a.warrantyEnd&&new Date(a.warrantyEnd)<new Date()).sort((a,b)=>a.warrantyEnd<b.warrantyEnd?-1:1).map(a=>[a.tag,siteName(a.siteCode),a.user,a.brand,a.warrantyEnd])})},
  {id:'ram',t:'Memory below 8 GB',d:'The upgrade shortlist, cheapest fix before replacement.',
   run:A=>({head:['Asset tag','Site','Assigned to','Memory','Processor'],
     rows:A.filter(a=>ramGB(a)>0&&ramGB(a)<8).sort((a,b)=>ramGB(a)-ramGB(b)).map(a=>[a.tag,siteName(a.siteCode),a.user,a.ram,a.cpu])})},
  {id:'vendor',t:'Spend by vendor',d:'What was bought from whom, and what it cost.',
   run:A=>{const m={};A.forEach(a=>{const v=a.vendor||'Not recorded';m[v]=m[v]||{n:0,amt:0,priced:0};
     m[v].n++;if(a.purchasePrice!=null){m[v].amt+=a.purchasePrice;m[v].priced++;}});
     return{head:['Vendor','Assets','With a price','Total spend','Average'],
       rows:Object.entries(m).sort((a,b)=>b[1].amt-a[1].amt).map(([v,x])=>
         [v,x.n,x.priced,money(x.amt||null),x.priced?money(x.amt/x.priced):'\u2014'])};}},
  {id:'spendsite',t:'Spend by site',d:'Where the money went across locations.',
   run:A=>{const m={};A.forEach(a=>{m[a.siteCode]=m[a.siteCode]||{n:0,amt:0,priced:0};
     m[a.siteCode].n++;if(a.purchasePrice!=null){m[a.siteCode].amt+=a.purchasePrice;m[a.siteCode].priced++;}});
     return{head:['Site','Assets','With a price','Total spend'],
       rows:Object.entries(m).sort((a,b)=>b[1].amt-a[1].amt).map(([c,x])=>
         [siteName(c),x.n,x.priced,money(x.amt||null)])};}},
  {id:'noprice',t:'Missing purchase details',d:'Assets with no vendor or no price on record.',
   run:A=>({head:['Asset tag','Site','Assigned to','Vendor','Purchase price'],
     rows:A.filter(a=>!a.vendor||a.purchasePrice==null).map(a=>
       [a.tag,siteName(a.siteCode),a.user,a.vendor||'Not recorded',money(a.purchasePrice)])})},
  {id:'make',t:'Make and model mix',d:'Manufacturer concentration across the estate.',
   run:A=>{const m={};A.forEach(a=>m[a.brand]=(m[a.brand]||0)+1);
     return{head:['Make','Assets'],rows:Object.entries(m).sort((a,b)=>b[1]-a[1])};}}
];
let RPT='site';
function vReports(v){
  const A=scopedAssets();
  const r=REPORTS.find(x=>x.id===RPT)||REPORTS[0];
  const out=r.run(A);
  v.innerHTML=`
  <div class="tabs noprint">${REPORTS.map(x=>`<button data-r="${x.id}" class="${x.id===RPT?'on':''}">${x.t}</button>`).join('')}</div>
  <div class="card">
    <header><div><h2>${r.t}</h2><span style="color:var(--muted);font-size:12.5px">${r.d}</span></div>
      <button class="btn noprint" id="rcsv" style="margin-left:auto">Export CSV</button>
      <button class="btn noprint" id="rprint">Print</button></header>
    <div class="tw"><table><thead><tr>${out.head.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${out.rows.length?out.rows.map(row=>`<tr>${row.map((c,i)=>`<td class="${i&&typeof c==='number'?'mono':''}">${esc(c)}</td>`).join('')}</tr>`).join('')
        :`<tr><td colspan="${out.head.length}"><div class="empty"><b>Nothing to report</b>No assets meet this report's criteria right now.</div></td></tr>`}</tbody></table></div>
    <div class="in" style="border-top:1px solid var(--line2);color:var(--muted);font-size:12.5px">${out.rows.length} rows</div>
  </div>`;
  v.querySelectorAll('[data-r]').forEach(b=>b.onclick=()=>{RPT=b.dataset.r;render();});
  $('#rcsv').onclick=()=>{download(r.id+'-report.csv',[out.head,...out.rows].map(x=>x.map(csvCell).join(',')).join('\n'));toast('Exported');};
  $('#rprint').onclick=()=>window.print();
}
