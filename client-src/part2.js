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
function exportAssets(list,name){
  const fx=S.fields;
  const head=['Asset tag','Serial','Type','Brand','Model','Assigned to','Department','Site','CPU','RAM','Storage','OS','Status','Vendor','Purchase price','Purchase year','Warranty end',...fx.map(f=>f.label)];
  const lines=[head.map(csvCell).join(',')];
  // Price exports as a bare number so a spreadsheet reads it as currency, not text.
  list.forEach(a=>lines.push([a.tag,a.serial,a.type,a.brand,a.model,a.user,a.dept,siteName(a.siteCode),a.cpu,a.ram,a.storage,a.os,a.status,a.vendor||'',a.purchasePrice==null?'':a.purchasePrice,a.purchaseYear,a.warrantyEnd,...fx.map(f=>(a.custom||{})[f.key]||'')].map(csvCell).join(',')));
  download(name||'assets.csv',lines.join('\n'));
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
