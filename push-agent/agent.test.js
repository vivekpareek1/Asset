'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createMock}=require('./mock-github');
const {walk,ignored,loadIgnore,human}=require('./push-agent');

let port=12500;
function start(opts){
  const {srv,state}=createMock(opts);
  const p=port++;
  return new Promise(r=>srv.listen(p,()=>r({srv,state,url:'http://127.0.0.1:'+p})));
}
function run(args,env){
  return new Promise(res=>{
    const c=spawn('node',[path.join(__dirname,'push-agent.js'),...args],
      {env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let out='',err='';
    c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);
    c.on('close',code=>res({code,out,err}));
  });
}
async function fixture(){
  const d=await fsp.mkdtemp(path.join(os.tmpdir(),'push-'));
  await fsp.mkdir(path.join(d,'public'),{recursive:true});
  await fsp.mkdir(path.join(d,'node_modules','junk'),{recursive:true});
  await fsp.writeFile(path.join(d,'server.js'),'console.log(1)');
  await fsp.writeFile(path.join(d,'package.json'),'{"name":"x"}');
  await fsp.writeFile(path.join(d,'public','index.html'),'<h1>hi</h1>');
  await fsp.writeFile(path.join(d,'public','logo.png'),Buffer.from([0x89,0x50,0x4e,0x47,1,2,3,255]));
  await fsp.writeFile(path.join(d,'node_modules','junk','big.js'),'x'.repeat(1000));
  await fsp.writeFile(path.join(d,'.env'),'SECRET=hunter2');
  await fsp.writeFile(path.join(d,'notes.log'),'noise');
  await fsp.writeFile(path.join(d,'.gitignore'),'node_modules/\n*.log\n');
  return d;
}

test('walk collects files and honours ignore rules', async () => {
  const d=await fixture();
  const files=await walk(d);
  const rels=files.map(f=>f.rel);
  assert.deepEqual(rels,['.gitignore','package.json','public/index.html','public/logo.png','server.js']);
  assert.ok(!rels.some(r=>r.includes('node_modules')),'node_modules excluded');
  assert.ok(!rels.includes('.env'),'.env never uploaded');
  assert.ok(!rels.includes('notes.log'),'*.log pattern honoured');
});

test('ignore matching handles names, directories and extensions', () => {
  const p=['node_modules','*.log','dist'];
  assert.ok(ignored('node_modules/a/b.js',p));
  assert.ok(ignored('x/y.log',p));
  assert.ok(ignored('dist/app.js',p));
  assert.ok(ignored('.git/config',p),'always skipped');
  assert.ok(ignored('a/.env',p),'always skipped');
  assert.ok(!ignored('src/index.js',p));
});

test('human readable sizes', () => {
  assert.equal(human(512),'512 B');
  assert.equal(human(2048),'2.0 KB');
  assert.equal(human(3*1048576),'3.0 MB');
});

test('refuses to run without a token', async () => {
  const r=await run(['--repo','a/b'],{GITHUB_TOKEN:'',GH_TOKEN:''});
  assert.equal(r.code,1);
  assert.match(r.err,/no token/);
});

test('refuses a malformed repo argument', async () => {
  const r=await run(['--repo','justname'],{GITHUB_TOKEN:'t'});
  assert.equal(r.code,1);
  assert.match(r.err,/owner\/name/);
});

test('dry run lists files and sends nothing', async () => {
  const d=await fixture();
  const {state,url,srv}=await start({repo:'vivekpareek1/assetops'});
  const r=await run(['--repo','vivekpareek1/assetops','--dir',d,'--dry-run'],
    {GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,0,r.err);
  assert.match(r.out,/public\/index\.html/);
  assert.match(r.out,/nothing was sent/);
  assert.equal(state.calls.length,0,'no API calls made');
});

test('pushes to an existing repo with an existing branch', async () => {
  const d=await fixture();
  const {state,url,srv}=await start({repo:'vivekpareek1/assetops',existingRef:'a'.repeat(40)});
  const r=await run(['--repo','vivekpareek1/assetops','--dir',d],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,0,r.err);
  assert.equal(state.blobs.size,5,'one blob per file');
  assert.equal(state.trees.size,1,'a single tree');
  assert.equal(state.commits.size,1,'a single commit');
  const commit=[...state.commits.values()][0];
  assert.deepEqual(commit.parents,['a'.repeat(40)],'commit parented on the old tip');
  assert.ok(state.calls.some(c=>c.startsWith('PATCH')),'ref moved with PATCH');
  assert.match(r.out,/Pushed [0-9a-f]{7}/);
});

test('creates the branch when the repo has no commits yet', async () => {
  const d=await fixture();
  const {state,url,srv}=await start({repo:'vivekpareek1/assetops'});   // no ref
  const r=await run(['--repo','vivekpareek1/assetops','--dir',d],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,0,r.err);
  const commit=[...state.commits.values()][0];
  assert.deepEqual(commit.parents,[],'root commit has no parent');
  assert.ok(state.calls.some(c=>c==='POST /repos/vivekpareek1/assetops/git/refs'),'ref created with POST');
  assert.match(r.out,/does not exist yet/);
});

test('binary files are sent base64, not as text', async () => {
  const d=await fixture();
  const {state,url,srv}=await start({repo:'vivekpareek1/assetops',existingRef:'b'.repeat(40)});
  await run(['--repo','vivekpareek1/assetops','--dir',d],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  const blobs=[...state.blobs.values()];
  assert.ok(blobs.every(b=>b.encoding==='base64'));
  const png=blobs.find(b=>Buffer.from(b.content,'base64')[0]===0x89);
  assert.ok(png,'png blob present');
  assert.deepEqual([...Buffer.from(png.content,'base64')],[0x89,0x50,0x4e,0x47,1,2,3,255],'bytes intact');
});

test('missing repo stops unless --create is given', async () => {
  const d=await fixture();
  const {url,srv}=await start({});
  const r=await run(['--repo','vivekpareek1/nope','--dir',d],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,3);
  assert.match(r.err,/not found.*--create/s);
});

test('--create makes the repository, private by default', async () => {
  const d=await fixture();
  const {state,url,srv}=await start({});
  const r=await run(['--repo','vivekpareek1/assetops','--dir',d,'--create'],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,0,r.err);
  assert.ok(state.repos.has('vivekpareek1/assetops'));
  assert.equal(state.repos.get('vivekpareek1/assetops').private,true,'private unless --public');
  assert.match(r.out,/Creating .* \(private\)/);
});

test('--public is respected', async () => {
  const d=await fixture();
  const {state,url,srv}=await start({});
  await run(['--repo','vivekpareek1/pub','--dir',d,'--create','--public'],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(state.repos.get('vivekpareek1/pub').private,false);
});

test('a bad token fails fast with exit code 2', async () => {
  const d=await fixture();
  const {url,srv}=await start({badToken:true});
  const r=await run(['--repo','vivekpareek1/assetops','--dir',d],{GITHUB_TOKEN:'bad',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,2);
  assert.match(r.err,/token was rejected/);
});

test('a 403 explains which scope is missing', async () => {
  const d=await fixture();
  const {url,srv}=await start({denied:true});
  const r=await run(['--repo','vivekpareek1/assetops','--dir',d],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,2);
  assert.match(r.err,/Contents: read and write/);
});

test('transient 5xx responses are retried, not fatal', async () => {
  const d=await fixture();
  const {state,url,srv}=await start({repo:'vivekpareek1/assetops',existingRef:'c'.repeat(40),fail5xx:2});
  const r=await run(['--repo','vivekpareek1/assetops','--dir',d],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,0,r.err);
  assert.match(r.out,/retrying in/);
  assert.equal(state.commits.size,1,'still exactly one commit');
});

test('an empty directory is refused unless forced', async () => {
  const d=await fsp.mkdtemp(path.join(os.tmpdir(),'empty-'));
  const {url,srv}=await start({repo:'vivekpareek1/assetops'});
  const r=await run(['--repo','vivekpareek1/assetops','--dir',d],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,4);
  assert.match(r.err,/nothing to push/);
});

test('a missing directory is reported clearly', async () => {
  const {url,srv}=await start({repo:'vivekpareek1/assetops'});
  const r=await run(['--repo','vivekpareek1/assetops','--dir','/no/such/dir'],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,1);
  assert.match(r.err,/directory not found/);
});

test('custom branch and message are used', async () => {
  const d=await fixture();
  const {state,url,srv}=await start({repo:'vivekpareek1/assetops'});
  const r=await run(['--repo','vivekpareek1/assetops','--dir',d,'--branch','deploy','--message','ship it'],
    {GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,0,r.err);
  assert.equal([...state.commits.values()][0].message,'ship it');
  assert.ok(state.refs.has('vivekpareek1/assetops/deploy'),[...state.refs.keys()].join(','));
});

test('the tree has no base_tree, so deleted files really disappear', async () => {
  const d=await fixture();
  const {state,url,srv}=await start({repo:'vivekpareek1/assetops',existingRef:'d'.repeat(40)});
  await run(['--repo','vivekpareek1/assetops','--dir',d],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  const treeCall=state.calls.filter(c=>c.includes('/git/trees'));
  assert.equal(treeCall.length,1);
  const tree=[...state.trees.values()][0];
  assert.equal(tree.length,5);
  assert.ok(tree.every(t=>t.type==='blob'&&t.mode.startsWith('100')));
});

/* ------------------------------------------------------------ v2: config -- */

const {createRender}=require('./mock-render');
let rport=13500;
function startRender(opts){
  const {srv,state}=createRender(opts);
  const p=rport++;
  return new Promise(r=>srv.listen(p,()=>r({srv,state,url:'http://127.0.0.1:'+p})));
}
function runIn(cwd,args,env){
  return new Promise(res=>{
    const c=spawn('node',[path.join(__dirname,'push-agent.js'),...args],
      {cwd,env:{...process.env,PUSH_AGENT_POLL_MS:'20',...env},stdio:['ignore','pipe','pipe']});
    let out='',err='';
    c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);
    c.on('close',code=>res({code,out,err}));
  });
}

test('init writes a config file', async () => {
  const d=await fixture();
  const r=await runIn(d,['init','--repo','vivekpareek1/assetops','--dir','./public','--service','srv-abc'],{GITHUB_TOKEN:'t'});
  assert.equal(r.code,0,r.err);
  const cfg=JSON.parse(await fsp.readFile(path.join(d,'.pushagent.json'),'utf8'));
  assert.deepEqual(cfg,{repo:'vivekpareek1/assetops',dir:'./public',service:'srv-abc'});
});

test('init refuses without a repo', async () => {
  const d=await fixture();
  const r=await runIn(d,['init','--service','srv-abc'],{GITHUB_TOKEN:'t'});
  assert.equal(r.code,1);
  assert.match(r.err,/needs at least --repo/);
});

test('saved config makes a bare push work with no flags', async () => {
  const d=await fixture();
  const {state,url,srv}=await start({repo:'vivekpareek1/assetops',existingRef:'e'.repeat(40)});
  await fsp.writeFile(path.join(d,'.pushagent.json'),JSON.stringify({repo:'vivekpareek1/assetops',dir:'.'}));
  const r=await runIn(d,[],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,0,r.err);
  assert.match(r.out,/Using settings from \.pushagent\.json/);
  assert.equal(state.commits.size,1);
});

test('a command line option overrides the saved one', async () => {
  const d=await fixture();
  const {state,url,srv}=await start({repo:'vivekpareek1/assetops'});
  await fsp.writeFile(path.join(d,'.pushagent.json'),
    JSON.stringify({repo:'vivekpareek1/assetops',dir:'.',branch:'saved'}));
  const r=await runIn(d,['--branch','typed'],{GITHUB_TOKEN:'t',GITHUB_API_URL:url});
  srv.close();
  assert.equal(r.code,0,r.err);
  assert.ok(state.refs.has('vivekpareek1/assetops/typed'),[...state.refs.keys()].join(','));
  assert.ok(!state.refs.has('vivekpareek1/assetops/saved'));
});

test('a corrupt config file is reported, not ignored', async () => {
  const d=await fixture();
  await fsp.writeFile(path.join(d,'.pushagent.json'),'{ not json');
  const r=await runIn(d,['--repo','a/b'],{GITHUB_TOKEN:'t'});
  assert.equal(r.code,1);
  assert.match(r.err,/not valid JSON/);
});

/* ------------------------------------------------------------ v2: deploy -- */

test('deploy pushes then waits for Render to go live', async () => {
  const d=await fixture();
  const gh=await start({repo:'vivekpareek1/assetops',existingRef:'a'.repeat(40)});
  const rd=await startRender({});
  const r=await runIn(d,['deploy','--repo','vivekpareek1/assetops','--service','srv-abc'],
    {GITHUB_TOKEN:'t',GITHUB_API_URL:gh.url,RENDER_API_KEY:'rnd',RENDER_API_URL:rd.url});
  gh.srv.close();rd.srv.close();
  assert.equal(r.code,0,r.err);
  assert.equal(gh.state.commits.size,1,'pushed first');
  assert.equal(rd.state.deploys.length,1,'one deploy triggered');
  assert.match(r.out,/build_in_progress/);
  assert.match(r.out,/Live/);
  assert.match(r.out,/assetops\.onrender\.com/);
});

test('a failed Render deploy exits 5', async () => {
  const d=await fixture();
  const gh=await start({repo:'vivekpareek1/assetops',existingRef:'a'.repeat(40)});
  const rd=await startRender({sequence:['build_in_progress','build_failed']});
  const r=await runIn(d,['deploy','--repo','vivekpareek1/assetops','--service','srv-abc'],
    {GITHUB_TOKEN:'t',GITHUB_API_URL:gh.url,RENDER_API_KEY:'rnd',RENDER_API_URL:rd.url});
  gh.srv.close();rd.srv.close();
  assert.equal(r.code,5);
  assert.match(r.out,/build_failed/);
});

test('a deploy that never settles times out with exit 5', async () => {
  const d=await fixture();
  const gh=await start({repo:'vivekpareek1/assetops',existingRef:'a'.repeat(40)});
  const rd=await startRender({sequence:['build_in_progress']});
  const r=await runIn(d,['deploy','--repo','vivekpareek1/assetops','--service','srv-abc','--timeout','1'],
    {GITHUB_TOKEN:'t',GITHUB_API_URL:gh.url,RENDER_API_KEY:'rnd',RENDER_API_URL:rd.url});
  gh.srv.close();rd.srv.close();
  assert.equal(r.code,5);
  assert.match(r.out,/Still build_in_progress/);
});

test('--no-wait triggers the deploy and returns immediately', async () => {
  const d=await fixture();
  const gh=await start({repo:'vivekpareek1/assetops',existingRef:'a'.repeat(40)});
  const rd=await startRender({});
  const r=await runIn(d,['deploy','--repo','vivekpareek1/assetops','--service','srv-abc','--no-wait'],
    {GITHUB_TOKEN:'t',GITHUB_API_URL:gh.url,RENDER_API_KEY:'rnd',RENDER_API_URL:rd.url});
  gh.srv.close();rd.srv.close();
  assert.equal(r.code,0,r.err);
  assert.equal(rd.state.deploys.length,1);
  assert.ok(!rd.state.calls.some(c=>/deploys\/dep-1/.test(c)),'never polled');
  assert.match(r.out,/Not waiting/);
});

test('deploy checks its prerequisites BEFORE uploading anything', async () => {
  const d=await fixture();
  const gh=await start({repo:'vivekpareek1/assetops',existingRef:'a'.repeat(40)});
  const r=await runIn(d,['deploy','--repo','vivekpareek1/assetops'],
    {GITHUB_TOKEN:'t',GITHUB_API_URL:gh.url,RENDER_API_KEY:'rnd'});
  gh.srv.close();
  assert.equal(r.code,1);
  assert.match(r.err,/needs a Render service id/);
  assert.equal(gh.state.blobs.size,0,'nothing was uploaded');
});

test('deploy without RENDER_API_KEY stops before pushing', async () => {
  const d=await fixture();
  const gh=await start({repo:'vivekpareek1/assetops',existingRef:'a'.repeat(40)});
  const r=await runIn(d,['deploy','--repo','vivekpareek1/assetops','--service','srv-abc'],
    {GITHUB_TOKEN:'t',GITHUB_API_URL:gh.url,RENDER_API_KEY:''});
  gh.srv.close();
  assert.equal(r.code,1);
  assert.match(r.err,/RENDER_API_KEY/);
  assert.equal(gh.state.blobs.size,0,'nothing was uploaded');
});

test('a rejected Render key exits 2', async () => {
  const d=await fixture();
  const gh=await start({repo:'vivekpareek1/assetops',existingRef:'a'.repeat(40)});
  const rd=await startRender({unauthorized:true});
  const r=await runIn(d,['deploy','--repo','vivekpareek1/assetops','--service','srv-abc'],
    {GITHUB_TOKEN:'t',GITHUB_API_URL:gh.url,RENDER_API_KEY:'bad',RENDER_API_URL:rd.url});
  gh.srv.close();rd.srv.close();
  assert.equal(r.code,2);
  assert.match(r.err,/rejected the API key/);
});

test('status reports the service and the last deploy', async () => {
  const d=await fixture();
  const rd=await startRender({});
  await runIn(d,['status','--service','srv-abc'],{RENDER_API_KEY:'rnd',RENDER_API_URL:rd.url});
  rd.state.deploys.push({id:'dep-9',status:'live',commit:{id:'abc1234'+'0'.repeat(33)},finishedAt:'2026-09-05T10:00:00Z'});
  const r=await runIn(d,['status','--service','srv-abc'],{RENDER_API_KEY:'rnd',RENDER_API_URL:rd.url});
  rd.srv.close();
  assert.equal(r.code,0,r.err);
  assert.match(r.out,/Service\s+assetops/);
  assert.match(r.out,/Status\s+live/);
  assert.match(r.out,/assetops\.onrender\.com/);
  assert.match(r.out,/Commit\s+abc1234/);
});

test('status needs no GitHub token', async () => {
  const d=await fixture();
  const rd=await startRender({});
  const r=await runIn(d,['status','--service','srv-abc'],{GITHUB_TOKEN:'',RENDER_API_KEY:'rnd',RENDER_API_URL:rd.url});
  rd.srv.close();
  assert.equal(r.code,0,r.err);
});

test('an unknown command is rejected', async () => {
  const r=await run(['frobnicate','--repo','a/b'],{GITHUB_TOKEN:'t'});
  assert.equal(r.code,1);
  assert.match(r.err,/unknown command/);
});

test('a dry run under deploy still sends nothing', async () => {
  const d=await fixture();
  const gh=await start({repo:'vivekpareek1/assetops'});
  const rd=await startRender({});
  const r=await runIn(d,['deploy','--repo','vivekpareek1/assetops','--service','srv-abc','--dry-run'],
    {GITHUB_TOKEN:'t',GITHUB_API_URL:gh.url,RENDER_API_KEY:'rnd',RENDER_API_URL:rd.url});
  gh.srv.close();rd.srv.close();
  assert.equal(r.code,0,r.err);
  assert.equal(gh.state.calls.length,0);
  assert.equal(rd.state.deploys.length,0,'no deploy triggered');
});
