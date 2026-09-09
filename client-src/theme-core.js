/* ============================================================================
   Section 1 — src/shared/themeSchema.js, verbatim (module syntax removed).
   Same code the Express routes use. Client and server cannot disagree.
   ========================================================================== */
const FONT_SIZE_MIN=12, FONT_SIZE_MAX=32;
const FONT_FAMILIES=[
  {id:'system',label:'System UI',stack:'system-ui, -apple-system, "Segoe UI", sans-serif',google:null},
  {id:'inter',label:'Inter',stack:'"Inter", system-ui, sans-serif',google:'Inter:wght@400;500;600;700'},
  {id:'plex-sans',label:'IBM Plex Sans',stack:'"IBM Plex Sans", system-ui, sans-serif',google:'IBM+Plex+Sans:wght@400;500;600;700'},
  {id:'source-sans',label:'Source Sans 3',stack:'"Source Sans 3", system-ui, sans-serif',google:'Source+Sans+3:wght@400;500;600;700'},
  {id:'roboto',label:'Roboto',stack:'"Roboto", system-ui, sans-serif',google:'Roboto:wght@400;500;700'},
  {id:'lora',label:'Lora',stack:'"Lora", Georgia, serif',google:'Lora:wght@400;500;600'},
  {id:'georgia',label:'Georgia',stack:'Georgia, "Times New Roman", serif',google:null}
];
const FONT_FAMILY_IDS=FONT_FAMILIES.map(f=>f.id);
const DEFAULT_THEME=Object.freeze({
  primaryColor:'#1e5a78',secondaryColor:'#2f6b4c',textColor:'#17222e',
  backgroundColor:'#ffffff',fontFamily:'system',fontSize:14
});
const HEX_RE=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const isHexColor=v=>typeof v==='string'&&HEX_RE.test(v.trim());
function normalizeHex(v){const s=String(v).trim().toLowerCase();
  return s.length===4?'#'+s[1]+s[1]+s[2]+s[2]+s[3]+s[3]:s;}
function isValidFontSize(v){const n=typeof v==='string'&&v.trim()!==''?Number(v):v;
  return Number.isInteger(n)&&n>=FONT_SIZE_MIN&&n<=FONT_SIZE_MAX;}
const isValidFontFamily=v=>typeof v==='string'&&FONT_FAMILY_IDS.includes(v);
const fontStackFor=id=>(FONT_FAMILIES.find(x=>x.id===id)||FONT_FAMILIES[0]).stack;
function luminance(hex){const h=normalizeHex(hex);
  const ch=[1,3,5].map(i=>{const c=parseInt(h.slice(i,i+2),16)/255;
    return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);});
  return 0.2126*ch[0]+0.7152*ch[1]+0.0722*ch[2];}
function contrastRatio(a,b){const l1=luminance(a),l2=luminance(b);
  return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);}
function validateTheme(input,base=DEFAULT_THEME){
  const errors={},warnings=[],value={...base};
  if(input===null||typeof input!=='object'||Array.isArray(input))
    return {valid:false,errors:{_:'Body must be a JSON object.'},value,warnings};
  for(const key of ['primaryColor','secondaryColor','textColor','backgroundColor']){
    if(input[key]===undefined)continue;
    if(!isHexColor(input[key]))errors[key]='Must be a hex colour such as #1e5a78.';
    else value[key]=normalizeHex(input[key]);
  }
  if(input.fontFamily!==undefined){
    if(!isValidFontFamily(input.fontFamily))errors.fontFamily=`Must be one of: ${FONT_FAMILY_IDS.join(', ')}.`;
    else value.fontFamily=input.fontFamily;
  }
  if(input.fontSize!==undefined){
    if(!isValidFontSize(input.fontSize))errors.fontSize=`Must be a whole number between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}.`;
    else value.fontSize=Number(input.fontSize);
  }
  if(!errors.textColor&&!errors.backgroundColor){
    const r=contrastRatio(value.textColor,value.backgroundColor);
    if(r<4.5)warnings.push(`Text on background is ${r.toFixed(2)}:1, below the WCAG AA minimum of 4.5:1.`);
  }
  return {valid:Object.keys(errors).length===0,errors,value,warnings};
}
function themeToCssVars(t){return{
  '--app-primary':t.primaryColor,'--app-secondary':t.secondaryColor,
  '--app-text':t.textColor,'--app-bg':t.backgroundColor,
  '--app-font-family':fontStackFor(t.fontFamily),'--app-font-size':`${t.fontSize}px`,
  '--app-font-size-sm':`${Math.round(t.fontSize*0.86)}px`,
  '--app-font-size-lg':`${Math.round(t.fontSize*1.28)}px`
};}

/* ============================================================================
   Section 2 — src/admin/applyTheme.js
   ========================================================================== */
const WEBFONT_ID='app-theme-webfont';
function applyTheme(theme,target=document.documentElement){
  const vars=themeToCssVars(theme);
  for(const [n,v] of Object.entries(vars))target.style.setProperty(n,v);
  if(target===document.documentElement)ensureWebfont(theme.fontFamily);
}
function ensureWebfont(id){
  const font=FONT_FAMILIES.find(f=>f.id===id);
  const link=document.getElementById(WEBFONT_ID);
  if(!font||!font.google){if(link)link.remove();return;}
  const href=`https://fonts.googleapis.com/css2?family=${font.google}&display=swap`;
  if(link){if(link.href!==href)link.href=href;return;}
  const el=document.createElement('link');
  el.id=WEBFONT_ID;el.rel='stylesheet';el.href=href;
  document.head.appendChild(el);
}

/* ============================================================================
   Section 3 — logoService.js validation, running in the browser.
   In production this runs on the SERVER; a client-side copy is advisory only.
   The rules below are byte-for-byte the ones the Node service applies.
   ========================================================================== */
const MAX_LOGO_BYTES=2*1024*1024;
const ALLOWED_EXT={png:'.png',jpeg:'.jpg',svg:'.svg'};
const ALLOWED_MIME={'image/png':'png','image/jpeg':'jpeg','image/jpg':'jpeg','image/svg+xml':'svg'};

function sniffFormat(buf){
  if(!buf||buf.length<12)return null;
  if(buf[0]===0x89&&buf[1]===0x50&&buf[2]===0x4e&&buf[3]===0x47&&
     buf[4]===0x0d&&buf[5]===0x0a&&buf[6]===0x1a&&buf[7]===0x0a)return 'png';
  if(buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff)return 'jpeg';
  const head=new TextDecoder().decode(buf.subarray(0,2048)).replace(/^\uFEFF/,'').trimStart();
  if(/^<(\?xml|!DOCTYPE svg|svg)[\s>]/i.test(head)&&/<svg[\s>]/i.test(head))return 'svg';
  return null;
}
function looksComplete(buf,format){
  if(format==='png'){
    if(buf.length<=20)return false;
    const t=buf.subarray(buf.length-8);
    const want=[0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82];
    return want.every((b,i)=>t[i]===b);
  }
  if(format==='jpeg')return buf.length>4&&buf[buf.length-2]===0xff&&buf[buf.length-1]===0xd9;
  if(format==='svg')return /<\/svg\s*>\s*$/i.test(new TextDecoder().decode(buf).trimEnd());
  return false;
}
function sanitizeSvg(text){
  let s=text;
  s=s.replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi,'');
  s=s.replace(/<\s*(foreignObject|iframe|embed|object|animate|set|handler)\b[\s\S]*?<\s*\/\s*\1\s*>/gi,'');
  s=s.replace(/<\s*(script|foreignObject|iframe|embed|object|use)\b[^>]*\/\s*>/gi,'');
  s=s.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'');
  s=s.replace(/(href|xlink:href)\s*=\s*(?:"|')?\s*(javascript|data):[^"'>\s]*(?:"|')?/gi,'');
  s=s.replace(/<!ENTITY[\s\S]*?>/gi,'');
  s=s.replace(/<\s*!DOCTYPE[^>]*\[[\s\S]*?\]\s*>/gi,'');
  return s;
}
/**
 * SHA-256, implemented directly rather than via crypto.subtle. WebCrypto is only
 * available in a secure context, so it is absent over file:// and in some
 * embedded viewers - and an unavailable digest would fail every upload.
 * The Node service uses node:crypto; this produces identical digests.
 */
function sha256Hex(bytes){
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
           0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
           0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
           0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
           0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
           0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
           0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
           0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const ml=bytes.length*8;
  const withPad=new Uint8Array(((bytes.length+9+63)>>6)<<6);
  withPad.set(bytes); withPad[bytes.length]=0x80;
  const dv=new DataView(withPad.buffer);
  dv.setUint32(withPad.length-4, ml>>>0);
  dv.setUint32(withPad.length-8, Math.floor(ml/4294967296));
  const w=new Uint32Array(64);
  const rr=(x,n)=>(x>>>n)|(x<<(32-n));
  for(let i=0;i<withPad.length;i+=64){
    for(let t=0;t<16;t++)w[t]=dv.getUint32(i+t*4);
    for(let t=16;t<64;t++){
      const s0=rr(w[t-15],7)^rr(w[t-15],18)^(w[t-15]>>>3);
      const s1=rr(w[t-2],17)^rr(w[t-2],19)^(w[t-2]>>>10);
      w[t]=(w[t-16]+s0+w[t-7]+s1)>>>0;
    }
    let [a,b,c,d,e,f,g,h]=H;
    for(let t=0;t<64;t++){
      const S1=rr(e,6)^rr(e,11)^rr(e,25);
      const ch=(e&f)^(~e&g);
      const t1=(h+S1+ch+K[t]+w[t])>>>0;
      const S0=rr(a,2)^rr(a,13)^rr(a,22);
      const maj=(a&b)^(a&c)^(b&c);
      const t2=(S0+maj)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    H=[H[0]+a,H[1]+b,H[2]+c,H[3]+d,H[4]+e,H[5]+f,H[6]+g,H[7]+h].map(x=>x>>>0);
  }
  return H.map(x=>x.toString(16).padStart(8,'0')).join('');
}
