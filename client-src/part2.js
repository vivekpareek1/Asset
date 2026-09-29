/* ---------- state ---------- */
let S=null, VIEW='dash', SEL=new Set(), DRAWER=null, IMPORTED=null;
/* Theme page state. Editor drafts, not persisted settings. */
let TDRAFT=null, TSAVED=null, TPEND=null, TST={saving:false,error:null,success:null},
    TERR={}, TRESET=false, TRESULTS=[], RLOG=[];
let F={q:'',site:'',dept:'',status:'',type:'',brand:'',vendor:'',sort:{k:'tag',dir:1},page:1,per:50};
let lastIdx=-1, dragging=false, dragMode=true;
let ACTIVITY=[];

const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=p=>p+Math.random().toString(36).slice(2,9);
const nowISO=()=>new Date().toISOString();
const fmtDT=t=>{const d=new Date(t);return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})+' '+d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});};
const YEAR=new Date().getFullYear();

/* ---------- purchase cost ---------- */
const INR=new Intl.NumberFormat('en-IN',{maximumFractionDigits:0});
function money(v){
  return (v===null||v===undefined||v==='')?'\u2014':'\u20B9'+INR.format(Math.round(Number(v)));
}
function parsePrice(v){
  if(v===null||v===undefined)return null;
  const s=String(v).replace(/,/g,'');
  const m=s.match(/-?\d+(?:\.\d+)?/);
  if(!m)return null;
  const n=Number(m[0]);
  return (Number.isFinite(n)&&n>=0)?n:null;
}

/**
 * Make and model as one readable label. Many models already start with the
 * make ("HP AIO Desktop" by HP), and joining them blindly printed "HP HP AIO".
 */
function fullModel(a){
  const b=String(a.brand||'').trim(), m=String(a.model||'').trim();
  if(!b||b.toLowerCase()==='unbranded')return m||'\u2014';
  if(!m)return b;
  return m.toLowerCase().startsWith(b.toLowerCase())?m:b+' '+m;
}

/**
 * Styled replacement for window.confirm(). Resolves true or false.
 * Escape and clicking outside both mean "no", and focus starts on Cancel so
 * a stray Enter can never delete anything.
 */
function confirmDialog({title='Are you sure?',message='',confirmLabel='Confirm',danger=false}={}){
  return new Promise(resolve=>{
    const prev=document.activeElement;
    const wrap=document.createElement('div');
    wrap.innerHTML=`<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="cdt" aria-describedby="cdm"><div class="box">
      <h2 id="cdt">${esc(title)}</h2><p id="cdm">${esc(message)}</p>
      <div class="row"><button class="btn ${danger?'danger':'p'}" id="cdyes">${esc(confirmLabel)}</button><button class="btn" id="cdno">Cancel</button></div>
    </div></div>`;
    document.body.appendChild(wrap);
    const onKey=e=>{if(e.key==='Escape'){e.preventDefault();done(false);}};
    const done=v=>{
      document.removeEventListener('keydown',onKey,true);
      wrap.remove();
      if(prev&&typeof prev.focus==='function'){try{prev.focus();}catch(e){/* element may be gone */}}
      resolve(v);
    };
    document.addEventListener('keydown',onKey,true);
    wrap.querySelector('#cdyes').onclick=()=>done(true);
    wrap.querySelector('#cdno').onclick=()=>done(false);
    wrap.querySelector('.modal').addEventListener('click',e=>{if(e.target.classList.contains('modal'))done(false);});
    wrap.querySelector('#cdno').focus();
  });
}

function totalValue(list){return list.reduce((s,a)=>s+(a.purchasePrice||0),0);}

/**
 * Loads everything the signed-in user is allowed to see. Replaces the old
 * single-document read: the server decides scope, the client just renders it.
 */
async function loadState(){
  const b=await API.bootstrap();
  ME=b.user;
  S={
    companies:b.companies,
    sites:b.sites,
    depts:b.depts,
    assets:b.assets,
    fields:b.fields,
    users:b.users,
    theme:b.theme||{...DEFAULT_THEME},
    logo:b.logo,
    files:{}
  };
  applyTheme(S.theme);
  TDRAFT={...S.theme}; TSAVED={...S.theme};
}

/** Replaces one asset in the local cache after the server confirms the write. */
function putLocalAsset(a){
  const i=S.assets.findIndex(x=>x.id===a.id);
  if(i>=0)S.assets[i]=a; else S.assets.unshift(a);
}

/**
 * One place to turn an API failure into something on screen. A lost session
 * sends the person back to sign-in rather than showing a confusing error.
 */
function apiFail(err,fallback){
  if(handleAuthLoss(err))return null;
  toast(err.message||fallback||'That did not work.');
  return err;
}

/* The activity log lives on the server; the client only reads it. */
function logit(){}

function toast(m){
  const t=document.createElement('div');t.className='toast';t.textContent=m;document.body.appendChild(t);
  setTimeout(()=>t.remove(),2400);
}
/** Roles are enforced on the server; this only decides what to draw. */
function can(level){
  const r=ME?ME.role:'Viewer';
  if(level==='admin')return r==='Admin';
  if(level==='edit')return r==='Admin'||r==='Manager';
  return Boolean(ME);
}

/* The server returns only the sites this user may see, so no client filter. */
function scopedAssets(){ return S.assets; }

const siteName=c=>{const s=S.sites.find(x=>x.code===c);return s?s.name:c;};
const STATUSES=['In use','Spare','In repair','Replace due','Retired'];
/**
 * A ring built from plain SVG circles (stroke-dasharray per segment) rather
 * than a charting library — five segments at most, so hand-rolling it keeps
 * the bundle dependency-free.
 */
function donutSVG(parts, size=132, thickness=17){
  const r=(size-thickness)/2, c=2*Math.PI*r, cx=size/2, cy=size/2;
  const total=parts.reduce((s,p)=>s+p.value,0)||1;
  let offset=0;
  const rings=parts.filter(p=>p.value>0).map(p=>{
    const frac=p.value/total, len=frac*c;
    const dash=`${len} ${c-len}`;
    const circle=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${p.color}" stroke-width="${thickness}"
      stroke-dasharray="${dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
    offset+=len;
    return circle;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Status breakdown">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line2)" stroke-width="${thickness}"></circle>
    ${rings}
    <text x="${cx}" y="${cy-4}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="22" font-weight="600" fill="var(--ink)">${total}</text>
    <text x="${cx}" y="${cy+15}" text-anchor="middle" font-family="IBM Plex Sans, sans-serif" font-size="11" fill="var(--muted)">assets</text>
  </svg>`;
}
const STATUS_COLOR={'In use':'#2F6B4C','Spare':'#61717F','In repair':'#8A6614','Replace due':'#A8442A','Retired':'#7A8894'};

const statusCls=s=>({'In use':'use','Spare':'spare','In repair':'repair','Replace due':'rep','Retired':'retired'}[s]||'spare');

/* ---------- csv ---------- */
function csvParse(text){
  const rows=[];let row=[],cur='',q=false;
  text=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){cur+='"';i++;} else q=false; }
      else cur+=c;
    }else{
      if(c==='"')q=true;
      else if(c===','){row.push(cur);cur='';}
      else if(c==='\n'){row.push(cur);rows.push(row);row=[];cur='';}
      else cur+=c;
    }
  }
  if(cur!==''||row.length){row.push(cur);rows.push(row);}
  return rows.filter(r=>r.some(v=>String(v).trim()!==''));
}
function csvCell(v){
  v=v==null?'':String(v);
  return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;
}
function download(name,text,mime){
  const b=new Blob([text],{type:mime||'text/csv;charset=utf-8'});
  const u=URL.createObjectURL(b);const a=document.createElement('a');
  a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(u),1500);
}
/** The shared column layout CSV and Excel export both use, so they never drift apart. */
function exportRows(list){
  const fx=S.fields;
  const head=['Asset tag','Serial','Type','Brand','Model','Assigned to','Department','Site','CPU','RAM','Storage','OS','Status','Vendor','Purchase price','Purchase year','Warranty end',...fx.map(f=>f.label)];
  const rows=list.map(a=>[a.tag,a.serial,a.type,a.brand,a.model,a.user,a.dept,siteName(a.siteCode),a.cpu,a.ram,a.storage,a.os,a.status,a.vendor||'',a.purchasePrice==null?'':a.purchasePrice,a.purchaseYear,a.warrantyEnd,...fx.map(f=>(a.custom||{})[f.key]||'')]);
  return {head,rows};
}
function exportAssets(list,name){
  const {head,rows}=exportRows(list);
  // Price exports as a bare number so a spreadsheet reads it as currency, not text.
  const lines=[head.map(csvCell).join(','),...rows.map(r=>r.map(csvCell).join(','))];
  download(name||'assets.csv',lines.join('\n'));
}
/**
 * A genuine .xlsx (not a renamed CSV): numeric cells stay numeric, so a price
 * column can be summed in Excel without a "convert to number" step first.
 * Lazily loads the same SheetJS build the Excel import already uses.
 */
function exportAssetsXlsx(list,name){
  const build=()=>{
    const {head,rows}=exportRows(list);
    const ws=XLSX.utils.aoa_to_sheet([head,...rows]);
    const priceCol=head.indexOf('Purchase price');
    if(priceCol>=0){
      rows.forEach((r,i)=>{
        const ref=XLSX.utils.encode_cell({r:i+1,c:priceCol});
        if(r[priceCol]!=='' && ws[ref])ws[ref].t='n';
      });
    }
    ws['!cols']=head.map(h=>({wch:Math.max(10,h.length+2)}));
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,'Assets');
    XLSX.writeFile(wb,name||'assets.xlsx');
  };
  if(window.XLSX)return build();
  const s=document.createElement('script');
  s.src='/vendor/xlsx.full.min.js';
  s.onload=build;
  s.onerror=()=>toast('Excel export unavailable right now \u2014 try Export CSV instead.');
  document.head.appendChild(s);
}

/* ---------- filtering ---------- */
function filtered(){
  const q=F.q.trim().toLowerCase();
  let a=scopedAssets().filter(x=>{
    if(F.site&&x.siteCode!==F.site)return false;
    if(F.dept&&x.dept!==F.dept)return false;
    if(F.status&&x.status!==F.status)return false;
    if(F.type&&x.type!==F.type)return false;
    if(F.brand&&x.brand!==F.brand)return false;
    if(F.vendor&&(x.vendor||'')!==F.vendor)return false;
    if(q){
      const hay=[x.tag,x.user,x.model,x.cpu,x.serial,x.dept,x.os,x.storage,x.ram,x.vendor].join(' ').toLowerCase();
      if(!hay.includes(q))return false;
    }
    return true;
  });
  const k=F.sort.k,d=F.sort.dir;
  a=a.slice().sort((x,y)=>{
    let vx=k==='site'?siteName(x.siteCode):x[k],vy=k==='site'?siteName(y.siteCode):y[k];
    if(typeof vx==='number'&&typeof vy==='number')return (vx-vy)*d;
    return String(vx==null?'':vx).localeCompare(String(vy==null?'':vy),undefined,{numeric:true})*d;
  });
  return a;
}
function ramGB(a){const m=String(a.ram).match(/\d+/);return m?+m[0]:0;}
