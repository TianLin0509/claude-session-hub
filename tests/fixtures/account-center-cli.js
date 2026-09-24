'use strict';
// Explicit fixture, only enabled under CLAUDE_HUB_HOME_DIR. No real browser/login.
const fs=require('fs'),path=require('path');
const [action,input]=process.argv.slice(2),row=JSON.parse(input||'{}');
const root=process.env.CLAUDE_HUB_HOME_DIR;
if(!root)throw Error('fixture requires isolated home');
const trace=path.join(root,'account-fixture.jsonl');fs.mkdirSync(root,{recursive:true});
fs.appendFileSync(trace,JSON.stringify({action,id:row.id})+'\n');
let result;
// Listing existing receipts does not perform a new login check.
if(action==='images')result={ok:true,accounts:['primary','secondary'].flatMap(loginGroup=>Array.from({length:4},(_,i)=>({id:loginGroup+(i?'-'+(i+1):''),loginGroup,enabled:true,state:loginGroup==='secondary'&&i===2?'login_required':'signed_in',workerAlive:false,observedAt:fs.statSync(trace).birthtimeMs})))};
else if(action==='login'){fs.writeFileSync(path.join(root,'fixture-login-'+row.id),'1');result={ok:true,message:'夹具：官方登录入口已启动，完成后检查登录'};}
else if(action==='open')result={ok:true,message:'夹具：原账号网页已打开，未修改登录状态'};
else if(fs.existsSync(path.join(root,'fixture-offline-'+row.id)))result={ok:true,state:'offline',message:'夹具：专用浏览器未在线',source:'原生协议夹具，不是真实账号',observedAt:Date.now()};
else result={ok:true,state:row.id==='claude'||row.id==='codex-default'||/^image-primary(?:-[234])?$/.test(row.id)||fs.existsSync(path.join(root,'fixture-login-'+row.id))?'signed_in':'unknown',identity:'fixture@example.com',source:'原生协议夹具，不是真实账号',message:'测试状态',observedAt:Date.now()};
process.stdout.write(JSON.stringify(result));
