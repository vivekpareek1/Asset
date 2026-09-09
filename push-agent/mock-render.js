'use strict';
/** Stand-in for the Render API: services and deploys, enough to drive the agent. */
const http=require('http');
function createRender(opts={}){
  const state={calls:[],deploys:[],service:opts.service||{id:'srv-abc',name:'assetops',type:'web_service',serviceDetails:{url:'https://assetops.onrender.com'}},
    sequence:opts.sequence||['build_in_progress','update_in_progress','live'],unauthorized:opts.unauthorized||false,ticks:0};
  const srv=http.createServer((req,res)=>{
    let body='';req.on('data',c=>body+=c);
    req.on('end',()=>{
      const send=(c,o)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o));};
      state.calls.push(req.method+' '+req.url);
      if(state.unauthorized)return send(401,{message:'Unauthorized'});
      let m;
      if((m=req.url.match(/^\/services\/([^/?]+)$/))&&req.method==='GET')return send(200,state.service);
      if((m=req.url.match(/^\/services\/([^/]+)\/deploys$/))&&req.method==='POST'){
        const d={id:'dep-'+(state.deploys.length+1),status:'created',commit:{id:'f'.repeat(40)}};
        state.deploys.push(d);return send(201,d);
      }
      if((m=req.url.match(/^\/services\/([^/]+)\/deploys\?limit=1$/))&&req.method==='GET'){
        const last=state.deploys[state.deploys.length-1];
        return send(200,last?[{deploy:last}]:[]);
      }
      if((m=req.url.match(/^\/services\/([^/]+)\/deploys\/([^/?]+)$/))&&req.method==='GET'){
        const d=state.deploys.find(x=>x.id===m[2]);
        if(!d)return send(404,{message:'not found'});
        d.status=state.sequence[Math.min(state.ticks,state.sequence.length-1)];
        state.ticks++;
        return send(200,d);
      }
      send(404,{message:'Not Found: '+req.url});
    });
  });
  return {srv,state};
}
module.exports={createRender};
