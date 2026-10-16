'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), net = require('net'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out=path.resolve('artifacts/20261017-avatar-packs-codex1/gui');
const entryPath=path.resolve(process.argv[2] || 'artifacts/20261017-avatar-packs-codex1/company-preview');
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
(async()=>{
  assert.equal(fs.existsSync(path.join(entryPath,'renderer/assets/appearance-packs')),false,'company export excludes the artwork library');
  const library=path.resolve('renderer/assets/appearance-packs');const f=fs.readdirSync(library).find(f=>f.endsWith('.json'));
  const pack={...JSON.parse(fs.readFileSync(path.join(library,f))),id:'company-test',name:'公司按需下载验证'};
  const body=Buffer.from(JSON.stringify(pack));const catalog={schema:1,version:'1.0.0',packs:[{id:pack.id,version:pack.version,name:pack.name,file:'company-test-1.0.0.json',bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')}]};
  const requests=[];const server=http.createServer((req,res)=>{requests.push(req.url);res.writeHead(200,{'content-type':'application/json'});res.end(req.url.endsWith('catalog.json')?JSON.stringify(catalog):body);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`;
  const sources=[{id:'fixture',name:'隔离验证源',manifest:base+'catalog.json',files:base}];
  let hub,cdp;
  async function wait(expr){const until=Date.now()+30000;while(!(await cdp.eval(expr))){if(Date.now()>until)throw Error('timeout '+expr);await _waitMs(100);}}
  async function click(selector){const p=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});}
  try{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-appearance-company-'));
    hub=await launchIsolatedHub({dataDir:path.join(temp,'data'),port:await port(),entryPath,label:'appearance-company',extraEnv:{AI_HUB_APPEARANCE_SOURCES:JSON.stringify(sources)}});
    cdp=await connectFirstPage(hub);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
    await wait('!!document.getElementById("options-appearance") && typeof window._mountSessionTurnCard==="function"');
    await click('#btn-theme');await click('#options-appearance');await wait('document.getElementById("appearance-dialog")?.open');
    assert.equal(requests.length,0);
    assert.equal(await cdp.eval("document.querySelectorAll('.ap-pack').length"),1);
    const names=await cdp.eval("Array.from(document.querySelectorAll('.ap-preview-faces figcaption'),e=>e.textContent)");
    assert.deepEqual(names,['DeepSeek','千问','智谱','MiniMax']);
    await click('[data-tab="online"]');await click('[data-action="check"]');await wait("!!document.querySelector('[data-download=company-test]')");
    await click('[data-download="company-test"]');await wait("document.querySelector('[data-download=company-test]')?.textContent==='已安装'");
    await click('[data-tab="packs"]');await click('[data-apply="company-test"]');
    await wait("document.getElementById('hub-appearance-artwork').textContent.includes('data:image/png')");
    await click('[data-tab="individual"]');
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'20261017-appearance-company-codex1.png'),Buffer.from(shot.data,'base64'));
    await click('[data-action="close"]');
    const result=await cdp.eval(`(()=>{
      const sid='appearance-company-cards';sessions.set(sid,{id:sid,kind:'codeagent',title:'模型头像验证',status:'idle',createdAt:Date.now()});activeSessionId=sid;activeMeetingId=null;currentView='card';
      const overlay=document.getElementById('msg-overlay');overlay.innerHTML='';overlay.classList.remove('hidden');window._sessionTurns.clear();
      const models=['GLM-5.2','DeepSeek-V4','MiniMax-M2','Qwen3-Coder'];
      models.forEach((model,i)=>window._mountSessionTurnCard(sid,{id:'a'+i,role:'assistant',kind:'claude',model,text:'公司模型头像验证',ts:Date.now()+i},{kind:'codeagent'}));
      return Array.from(overlay.querySelectorAll('.turn-card.assistant .turn-avatar img'),el=>({src:el.getAttribute('src'),content:getComputedStyle(el).content,alt:el.alt}));
    })()`);
    assert.equal(result.length,4);
    assert.deepEqual(result.map(r=>r.src.split('/').pop()),['glm.png','deepseek.png','minimax.png','qwen.png']);
    assert.ok(result.every(r=>r.content.startsWith('url("data:image/png')));
    const evidence={ok:true,exportHasExtraPacks:false,initialExtraPacks:0,noStartupNetwork:true,visibleProviders:names,downloadSource:'localhost fixture using real Electron net.fetch',codeAgentModelAvatars:result.map(r=>r.src),unverified:'actual corporate proxy and published remote resources'};
    fs.writeFileSync(path.join(out,'20261017-appearance-company-codex1.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
  }finally{try{if(cdp)await cdp.close();if(hub)await gracefulQuit(hub);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}
})().catch(e=>{console.error(e);process.exitCode=1;});
