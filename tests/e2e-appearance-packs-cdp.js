'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), http = require('http'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { ARTWORK_KEYS } = require('../core/appearance-packs');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));}); });
const out = path.resolve(process.argv[2] || 'artifacts/20261017-avatar-packs-codex1/gui');
fs.mkdirSync(out,{recursive:true});
(async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-appearance-e2e-'));
  const dataDir=path.join(temp,'data');
  const library=path.resolve('renderer/assets/appearance-packs');
  const files=fs.readdirSync(library).filter(f=>f.endsWith('.json'));
  assert.ok(files.length >= 2,'at least two complete generated packs are needed');
  const first=JSON.parse(fs.readFileSync(path.join(library,files[0]))), second=JSON.parse(fs.readFileSync(path.join(library,files[1])));
  const remote={...first,id:'remote-test',name:'在线下载验证'};
  const payload=Buffer.from(JSON.stringify(remote));
  const catalog={schema:1,version:'1.0.0',packs:[{id:remote.id,name:remote.name,version:remote.version,file:'remote-test-1.0.0.json',bytes:payload.length,sha256:crypto.createHash('sha256').update(payload).digest('hex')}]};
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push(req.url);
    if(req.url.startsWith('/bad')) {res.writeHead(200,{'content-type':'text/html'});res.end('<html>company proxy blocked</html>');return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(req.url.endsWith('catalog.json')?JSON.stringify(catalog):payload);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const sources=['bad','good'].map(id=>({id,name:id==='bad'?'模拟拦截源':'模拟可用源',manifest:`${base}/${id}/catalog.json`,files:`${base}/${id}/`}));
  let hub,cdp;const evidence={baseline:'17385f65ac26bfff6f2db5c4e182ed9fd1add58c',checks:[],sources:'local HTTP fixture; actual UI and existing download pipeline',generatedPacks:files.length};
  async function wait(expr, ms=15000) {const end=Date.now()+ms;while(!(await cdp.eval(expr))){if(Date.now()>end)throw new Error('wait timeout: '+expr);await _waitMs(100);}}
  async function click(selector) {
    const q=JSON.stringify(selector);
    const pos=await cdp.eval(`(()=>{const el=document.querySelector(${q});if(!el)throw Error('missing '+${q});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...pos,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...pos,button:'left',clickCount:1});
  }
  async function shot(name){const s=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,`20261017-${name}-codex1.png`),Buffer.from(s.data,'base64'));}
  async function prefs(){return cdp.eval("require('electron').ipcRenderer.invoke('appearance:get').then(x=>x.preferences)");}
  try {
    hub=await launchIsolatedHub({dataDir,port:await freePort(),label:'appearance-packs',extraEnv:{AI_HUB_APPEARANCE_SOURCES:JSON.stringify(sources)}});
    cdp=await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
    await wait('!!document.getElementById("options-appearance") && typeof sessions!=="undefined"');
    await _waitMs(800);assert.equal(requests.length,0);evidence.checks.push('startup does not download');
    await click('#btn-theme');await click('#options-appearance');await wait('document.getElementById("appearance-dialog")?.open');
    await shot('appearance-packs');
    await click(`[data-apply="${first.id}"]`);await wait(`document.getElementById('hub-appearance-artwork').textContent.includes('data:image/png')`);
    assert.equal((await prefs()).pack,first.id);evidence.checks.push('whole-pack switch through theme menu');
    const defaultPreview=await cdp.eval("getComputedStyle(document.querySelector('.ap-pack img[src=\"assets/ai-avatars/cel-v2/claude.png\"]')).content");
    assert.ok(['normal','none'].includes(defaultPreview));evidence.checks.push('default preview remains the actual original');
    await cdp.eval(`(()=>{const img=document.createElement('img');img.id='appearance-live-avatar';img.src='assets/ai-avatars/cel-v2/claude.png';img.style.cssText='width:64px;height:64px';document.getElementById('msg-overlay').appendChild(img);})()`);
    assert.ok((await cdp.eval("getComputedStyle(document.getElementById('appearance-live-avatar')).content")).startsWith('url("data:image/png'));
    await click('[data-tab="individual"]');
    await cdp.eval(`(()=>{const el=document.getElementById('ap-overrides-codex');el.value=${JSON.stringify(second.id)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`document.querySelector('#ap-overrides-codex')?.value===${JSON.stringify(second.id)}`);await _waitMs(200);
    assert.equal((await prefs()).overrides.codex,second.id);evidence.checks.push('per-provider mix');
    await cdp.send('Page.setInterceptFileChooserDialog',{enabled:true});
    await click('[data-upload="claude"][data-field="overrides"]');
    const dom=await cdp.send('DOM.getDocument');const input=await cdp.send('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'#appearance-upload-file'});
    // Suppress the operating-system picker; CDP supplies the same file-input event.
    const sharp = require('sharp');
    const webpUpload = path.join(temp, '20261017-upload-fixture.webp');
    await sharp(path.resolve('renderer/assets/ai-avatars/cel-v2/claude.png')).resize(320,240).webp().toFile(webpUpload);
    await cdp.send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[webpUpload]});
    await wait("document.querySelector('#ap-overrides-claude')?.value.startsWith('custom-')");
    const customPrefs=await prefs();assert.ok(customPrefs.overrides.claude.startsWith('custom-'));evidence.checks.push('real WebP file input, Chromium PNG conversion, native decode, crop, persist and display');
    await shot('appearance-mix');
    await click('[data-tab="icons"]');await click('[data-icon-style="mono"]');await wait("document.documentElement.dataset.hubIconStyle==='mono'");
    await cdp.eval("(()=>{const el=document.createElement('div');el.className='session-item slim running';el.id='appearance-status-fixture';el.innerHTML='<span class=\"sl-kind ai-logo logo-claude\" data-state=\"run\" title=\"Claude · 运行中\"></span>';document.getElementById('session-list').appendChild(el);})()");
    const ring=await cdp.eval("(()=>{const el=document.querySelector('#appearance-status-fixture .ai-logo');const cs=getComputedStyle(el);return {filter:cs.filter,outline:cs.outlineWidth,title:el.title};})()");
    assert.equal(ring.filter,'none');assert.notEqual(ring.outline,'0px');assert.ok(ring.title.includes('运行中'));evidence.checks.push('monochrome icon preserves runtime ring and tooltip');
    await shot('appearance-icons');
    await click('[data-tab="online"]');await click('[data-action="check"]');await wait("!!document.querySelector('[data-download=remote-test]')",30000);
    await click('[data-download="remote-test"]');await wait("document.querySelector('[data-download=remote-test]')?.textContent==='已安装'",30000);
    const downloaded=await cdp.eval("require('electron').ipcRenderer.invoke('appearance:get').then(x=>({state:x.state,prefs:x.preferences,packs:x.packs.map(p=>p.id)}))");
    assert.equal(downloaded.state.attempts.length,2);assert.ok(downloaded.packs.includes('remote-test'));assert.equal(downloaded.prefs.pack,first.id);evidence.checks.push('online check, source fallback, checksum, install without changing active choice');
    await shot('appearance-online');
    await cdp.send('Page.reload');await wait('!!document.getElementById("options-appearance")');await _waitMs(900);
    const after=await prefs();assert.equal(after.pack,first.id);assert.equal(after.overrides.codex,second.id);assert.ok(after.overrides.claude.startsWith('custom-'));assert.equal(after.icons,'mono');evidence.checks.push('reload persistence');
    await click('#btn-theme');await click('#options-appearance');await wait('document.getElementById("appearance-dialog")?.open');await click('[data-action="reset"]');await _waitMs(200);
    assert.equal((await prefs()).pack,'default');assert.equal((await prefs()).icons,'brand');evidence.checks.push('restore defaults');
    evidence.ok=true;fs.writeFileSync(path.join(out,'20261017-appearance-e2e-codex1.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));
  } finally {try {if(cdp)await cdp.close();if(hub)await gracefulQuit(hub);} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}}
})().catch(e=>{console.error(e);process.exitCode=1;});
