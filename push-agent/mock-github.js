'use strict';
/** A stand-in for the GitHub REST API, enough to exercise push-agent end to end. */
const http=require('http');
const crypto=require('crypto');

function createMock(opts={}){
  const state={repos:new Map(),blobs:new Map(),trees:new Map(),commits:new Map(),refs:new Map(),calls:[],fail5xx:opts.fail5xx||0,denied:opts.denied||false,badToken:opts.badToken||false};
  const sha=()=>crypto.randomBytes(20).toString('hex');
  if(opts.repo)state.repos.set(opts.repo,{full_name:opts.repo,default_branch:opts.defaultBranch||'main',private:true});
  if(opts.existingRef)state.refs.set(opts.repo+'/'+(opts.defaultBranch||'main'),opts.existingRef);

  const srv=http.createServer((req,res)=>{
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      const send=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(obj));};
      state.calls.push(req.method+' '+req.url);
      if(state.badToken)return send(401,{message:'Bad credentials'});
      if(state.denied)return send(403,{message:'Resource not accessible by integration'});
      if(state.fail5xx>0){state.fail5xx--;res.writeHead(500);return res.end('{"message":"server error"}');}
      const j=body?JSON.parse(body):null;
      let m;
      if((m=req.url.match(/^\/repos\/([^/]+)\/([^/]+)$/))&&req.method==='GET'){
        const key=m[1]+'/'+m[2];
        return state.repos.has(key)?send(200,state.repos.get(key)):send(404,{message:'Not Found'});
      }
      if(req.url==='/user/repos'&&req.method==='POST'){
        const key='vivekpareek1/'+j.name;
        state.repos.set(key,{full_name:key,default_branch:'main',private:j.private});
        return send(201,state.repos.get(key));
      }
      if((m=req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/))&&req.method==='GET'){
        const k=m[1]+'/'+m[2]+'/'+m[3];
        return state.refs.has(k)?send(200,{ref:'refs/heads/'+m[3],object:{sha:state.refs.get(k)}}):send(404,{message:'Not Found'});
      }
      if((m=req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/blobs$/))&&req.method==='POST'){
        const s=sha();state.blobs.set(s,j);return send(201,{sha:s});
      }
      if((m=req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees$/))&&req.method==='POST'){
        const s=sha();state.trees.set(s,j.tree);return send(201,{sha:s});
      }
      if((m=req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/commits$/))&&req.method==='POST'){
        const s=sha();state.commits.set(s,j);return send(201,{sha:s});
      }
      if((m=req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/))&&req.method==='POST'){
        state.refs.set(m[1]+'/'+m[2]+'/'+j.ref.replace('refs/heads/',''),j.sha);
        return send(201,{ref:j.ref,object:{sha:j.sha}});
      }
      if((m=req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/))&&req.method==='PATCH'){
        state.refs.set(m[1]+'/'+m[2]+'/'+m[3],j.sha);
        return send(200,{object:{sha:j.sha}});
      }
      send(404,{message:'Not Found: '+req.url});
    });
  });
  return {srv,state};
}
module.exports={createMock};
