'use strict';
// Real isolated Electron: no provider calls or production session data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ceramic-'));
  const out = path.resolve('output/playwright/ceramic-' + Date.now());
  fs.mkdirSync(out, {recursive:true});
  fs.mkdirSync(path.join(root,'data'));
  fs.writeFileSync(path.join(root,'data/prepared-projects.json'),JSON.stringify({schemaVersion:1,projects:[],migrations:[]}));
  let hub, cdp;
  const evidence = {passed:false, checks:[], layouts:[]};
  const ok = (label, value) => { assert(value, label); evidence.checks.push(label); console.log('PASS '+label); };
  const wait = async expression => { for(let i=0;i<300;i++){if(await cdp.eval(expression))return;await sleep(100);}throw Error('Timeout '+expression); };
  const click = async selector => {
    const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!e.contains(document.elementFromPoint(x,y)))throw Error('covered '+${JSON.stringify(selector)});return{x,y};})()`);
    for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
  };
  const shot = async name => {const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
  const resize = async (width,height) => {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await cdp.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  };
  const layout = async label => {
    const result=await cdp.eval(`(()=>{
      const rail=document.querySelector('#scene-rail'),nav=document.querySelector('.rail-navigation'),rr=rail.getBoundingClientRect();
      const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const buttons=[...rail.querySelectorAll('button')].filter(e=>!e.closest('.theme-menu,.options-menu'));
      return {width:rr.width,viewport:[innerWidth,innerHeight],navScroll:nav.scrollHeight-nav.clientHeight,railScroll:rail.scrollHeight-rail.clientHeight,overflow:getComputedStyle(nav).overflowY,
        buttons:buttons.map(e=>{const r=rect(e),l=e.querySelector('.btn-label'),i=e.querySelector('.btn-icon');return{id:e.id,...r,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),label:l?rect(l):null,icon:i?rect(i):null};})};
    })()`);
    evidence.layouts.push({label,...result});
    ok(label+' no scroll or hidden destinations', result.width===100 && result.navScroll<=1 && result.railScroll<=1 && !['auto','scroll'].includes(result.overflow) && result.buttons.length===11 && result.buttons.every(b=>b.hit&&b.y>=0&&b.bottom<=result.viewport[1]+1&&b.height>=28&&(!b.label||(b.label.x>=b.x&&b.label.right<=b.right+1&&b.label.y>=b.y&&b.label.bottom<=b.bottom+1))));
  };
  try {
    const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,windowMode:'hidden',extraEnv:{AI_HUB_WORKSPACE_ROOT:root,CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude')}});
    cdp=await connectFirstPage(hub);
    await wait('!!window.WorkspaceController');
    await resize(1450,950);
    ok('approved local bitmap decodes',await cdp.eval(`new Promise(resolve=>{const e=document.querySelector('#btn-home .btn-icon'),s=getComputedStyle(e).backgroundImage,img=new Image();img.onload=()=>resolve(img.naturalWidth===1536&&img.naturalHeight===1024);img.onerror=()=>resolve(false);img.src=s.slice(5,-2);})`));
    ok('eight unique ceramic samples retain text and accessible names',await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.rail-navigation button')];return b.length===8&&new Set(b.map(e=>getComputedStyle(e.querySelector('.btn-icon')).backgroundPosition)).size===8&&b.every(e=>e.querySelector('.btn-label').textContent.trim()&&(e.title||e.getAttribute('aria-label')));})()`));
    for(const theme of ['dark','codex']) {
      await cdp.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for(const [width,height] of [[1450,950],[1100,720],[900,640],[900,600],[900,480]]) {
        await resize(width,height);await layout(theme+' '+width+'x'+height);
        if(height===950||height===480)await shot(theme+'-'+height);
      }
    }
    await resize(1100,720);
    await cdp.eval("require('electron').webFrame.setZoomFactor(1.25)");
    await cdp.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await layout('125 percent UI zoom');await shot('zoom125');
    await cdp.eval("require('electron').webFrame.setZoomFactor(1)");
    await resize(900,480);
    for(const [button,panel] of [['#btn-rail-accounts','#account-page'],['#btn-rail-capabilities','#capability-page'],['#btn-rail-memory','#memory-page']]) {
      await click(button);await wait(`!!document.querySelector(${JSON.stringify(panel)})&&!document.querySelector(${JSON.stringify(panel)}).hidden`);
      ok(button+' opens beside rail',await cdp.eval(`document.querySelector(${JSON.stringify(panel)}).getBoundingClientRect().left>=100`));
      await click(button);
    }
    for(const [button,menu] of [['#btn-theme','#theme-menu'],['#btn-options','#options-menu']]) {
      await click(button);await wait(`getComputedStyle(document.querySelector(${JSON.stringify(menu)})).display!=='none'`);
      ok(button+' menu reachable',await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(menu)}),r=e.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+12,r.y+12));})()`));
      await shot(button.slice(1)+'-menu');await click(button);
    }
    await resize(1450,950);
    await cdp.eval("document.documentElement.dataset.theme='dark'");
    await shot('final-dark');
    evidence.passed=true;
  } finally {
    if(hub)fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));
    if(cdp){if(!evidence.passed)await shot('failure');await cdp.close();}
    if(hub)await gracefulQuit(hub);
    fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(evidence,null,2));
    console.log('ARTIFACT_ROOT '+out);
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
