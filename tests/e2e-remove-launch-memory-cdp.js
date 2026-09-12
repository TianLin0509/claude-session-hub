'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-remove-launch-memory-'));
const output = path.resolve(__dirname, '../output/playwright/remove-launch-memory');
fs.mkdirSync(output, { recursive: true });
async function port() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); }); }
async function wait(label, fn) { const end = Date.now() + 30000; while (Date.now() < end) { const value = await fn(); if (value) return value; await _waitMs(150); } throw new Error('Timeout: ' + label); }
async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  let hub, c;
  const result = { checks: [], output };
  const check = (name, value = true) => { assert.ok(value, name); result.checks.push(name); console.log('PASS ' + name); };
  const click = async selector => {
    const point = await c.eval(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; return {x,y,hit:e.contains(document.elementFromPoint(x,y))}; })()`);
    assert.ok(point?.hit, 'Visible target: ' + selector);
    await c.send('Page.bringToFront');
    const {x,y} = point;
    await c.send('Input.dispatchMouseEvent', { type:'mouseMoved', x,y });
    await c.send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, x,y });
    await c.send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, x,y });
    await _waitMs(200);
  };
  const shot = async name => { const image = await c.send('Page.captureScreenshot', {format:'png'}); fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(image.data,'base64')); };
  try {
    const dataDir = path.join(temp,'data'); fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir,'prepared-projects.json'), JSON.stringify({schemaVersion:1,projects:[],migrations:[]}));
    hub = await launchIsolatedHub({dataDir,port:await port(),label:'remove-launch-memory',windowMode:'hidden',extraEnv:{AI_HUB_WORKSPACE_ROOT:temp,AI_HUB_TOKEN_PLAN_KEY:''}});
    c = await connectFirstPage(hub);
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await wait('renderer',()=>c.eval('!!window.LaunchCenter && !!window.WorkspaceController'));
    // Seed obsolete data, then observe all accesses from a fresh renderer. Only
    // the retired key is intercepted; real creation IPC and storage stay intact.
    await c.eval(`localStorage.setItem('hub.launch.last','{obsolete-invalid-record')`);
    await c.send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {
      window.__launchMemoryAccess=[]; window.__launchErrors=[];
      for(const name of ['getItem','setItem','removeItem']) { const original=Storage.prototype[name]; Storage.prototype[name]=function(key,...args) {
        if(key==='hub.launch.last') { window.__launchMemoryAccess.push(name); throw new Error('retired launch storage accessed'); }
        return original.call(this,key,...args);
      }; }
      window.addEventListener('error',e=>window.__launchErrors.push(String(e.error||e.message)));
      window.addEventListener('unhandledrejection',e=>window.__launchErrors.push(String(e.reason)));
    })()`});
    const origin = await c.eval('performance.timeOrigin'); await c.send('Page.reload');
    await wait('fresh renderer',()=>c.eval(`performance.timeOrigin!==${origin} && !!window.LaunchCenter && document.readyState==='complete'`));
    check('Reload ignores obsolete launch data',await c.eval('window.__launchMemoryAccess.length===0'));
    check('Yellow launch status element is removed',await c.eval(`!document.getElementById('launch-split-status')`));
    await click('#btn-new');
    await wait('center open',()=>c.eval(`document.getElementById('new-session-menu').style.display==='flex'`));
    await click('.new-session-option[data-kind="powershell"]');
    await click('[data-workspace-mode="scratch"]');
    await click('#new-session-submit');
    await wait('real PowerShell created',()=>c.eval(`ipcRenderer.invoke('get-sessions').then(list=>list.some(s=>s.kind==='powershell'))`));
    await wait('creation closes form',()=>c.eval(`document.getElementById('new-session-menu').style.display==='none'`));
    check('Real session creation works without reading or writing launch history',await c.eval('window.__launchMemoryAccess.length===0'));
    await c.eval(`window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('storage')); window.dispatchEvent(new CustomEvent('launch-center:session-created',{detail:{sessionId:'obsolete-notification',launch:{kind:'qwen'}}}));`);
    check('Focus and obsolete notifications cannot restore the warning',await c.eval(`window.__launchMemoryAccess.length===0 && !document.getElementById('launch-split-status') && document.querySelector('#btn-new .btn-label').textContent==='启动'`));
    await shot('after-create');
    await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'n',code:'KeyN',modifiers:2});
    await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'n',code:'KeyN',modifiers:2});
    await wait('keyboard launch',()=>c.eval(`document.getElementById('new-session-menu').style.display==='flex'`));
    check('Ctrl+N still opens the creation panel');
    await click('[data-launch-intent="group"]');
    await wait('group panel',()=>c.eval(`!!document.querySelector('#launch-center-group-host .mcm-slot')`));
    await click('[data-launch-intent="resume"]');
    check('Group and history routes remain available',await c.eval(`window.LaunchCenter.getActiveIntent()==='resume' && !document.getElementById('launch-center-resume-panel').hidden`));
    await click('[data-launch-intent="session"]');
    await click('.new-session-option[data-kind="qwen"]');
    await click('#new-session-submit');
    await wait('real unconfigured provider error',()=>c.eval(`!document.getElementById('new-session-error').hidden && document.getElementById('new-session-error').textContent.includes('创建失败')`));
    check('Actual creation errors remain visible inside the form',await c.eval(`!document.getElementById('launch-split-status') && document.getElementById('new-session-menu').style.display==='flex'`));
    await shot('creation-error');
    assert.deepEqual(await c.eval('window.__launchErrors'),[]);
    result.passed = true;
  } finally {
    if(c) { if(!result.passed) await shot('failure').catch(e=>{result.screenshotError=String(e);}); await c.close(); }
    if(hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
