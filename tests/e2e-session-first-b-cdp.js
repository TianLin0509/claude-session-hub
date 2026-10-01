'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = process.env.HUB_SESSION_FIRST_BASELINE || '';
const OUT = path.join(ROOT, 'output', 'session-first-b');
fs.mkdirSync(OUT, { recursive: true });

const port = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(error => error ? reject(error) : resolve(value));
  });
});

async function waitFor(cdp, expression, label) {
  for (let i = 0; i < 250; i++) {
    try { if (await cdp.eval(expression)) return; } catch {}
    await _waitMs(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function move(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await _waitMs(260);
}

async function click(cdp, selector) {
  const point = await cdp.eval(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)});
    if(!e) return null;
    const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
    return {x,y,hit:e===document.elementFromPoint(x,y)||e.contains(document.elementFromPoint(x,y))};
  })()`);
  assert(point?.hit, `click target covered: ${selector} ${JSON.stringify(point)}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x:point.x, y:point.y, button:'left', clickCount:1 });
  }
}

async function shot(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format:'png', fromSurface:true });
  fs.writeFileSync(path.join(OUT, name+'.png'), Buffer.from(result.data,'base64'));
}

async function geometry(cdp) {
  return cdp.eval(`(() => {
    const rect=s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return r?{x:Math.round(r.x),right:Math.round(r.right),width:Math.round(r.width)}:null};
    const dir=document.querySelector('#card-question-nav');
    return {version:document.querySelector('#hub-version')?.textContent.trim(),
      rail:rect('#scene-rail'),sidebar:rect('#session-sidebar'),main:rect('#terminal-panel'),
      directory:dir?.hidden?null:rect('#card-question-nav'),
      directoryCollapsed:dir?.classList.contains('directory-collapsed'),
      directorySpace:getComputedStyle(document.querySelector('#msg-overlay')).paddingRight,
      visibleHubMarks:[...document.querySelectorAll('img[src*="claude-wx.ico"]')].filter(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).display!=='none').length,
      launchButton:rect('#btn-new')};
  })()`);
}

async function one(label, entryPath) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `hub-session-first-${label}-`));
  const data = path.join(temp, 'data');
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(data); fs.mkdirSync(workspace);
  let hub, cdp;
  const report = {};
  try {
    hub = await launchIsolatedHub({
      dataDir:data, port:await port(), label, entryPath, windowMode:'background',
      extraEnv:{AI_HUB_WORKSPACE_ROOT:workspace,CODEX_HOME:path.join(temp,'codex'),CLAUDE_CONFIG_DIR:path.join(temp,'claude'),CLAUDE_HUB_E2E:'1'},
    });
    cdp = await connectFirstPage(hub);
    await waitFor(cdp,'!!window.__hubE2E?.cardQuestionNavigator && !!window.WorkspaceController','renderer');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1600,height:950,deviceScaleFactor:1,mobile:false});
    await cdp.eval(`document.documentElement.dataset.theme='dark'`);
    if(label==='candidate') {
      await waitFor(cdp,`document.querySelector('#session-list .session-sec-header') && document.querySelector('#empty-state').dataset.homeReady==='true'`,'home startup');
      report.startup=await cdp.eval(`({home:document.querySelector('#terminal-panel').classList.contains('home-active'),
        visible:getComputedStyle(document.querySelector('#empty-state')).display!=='none',
        nav:document.querySelector('#btn-home').getAttribute('aria-current')})`);
      assert.deepEqual(report.startup,{home:true,visible:true,nav:'page'});
      await cdp.eval(`(()=>{sessions.set('layout-width-fixture',{id:'layout-width-fixture',kind:'codex',
        title:'跨平台协作项目进度追踪版',status:'idle',createdAt:Date.now(),lastMessageTime:Date.now()});
        renderSessionList()})()`);
      await waitFor(cdp,`!![...document.querySelectorAll('#session-list .sl-title')].find(e=>e.textContent==='跨平台协作项目进度追踪版')`,'twelve-character session title');
      report.title=await cdp.eval(`(()=>{const e=[...document.querySelectorAll('#session-list .sl-title')].find(e=>e.textContent==='跨平台协作项目进度追踪版');
        const range=document.createRange();range.selectNodeContents(e);
        return {characters:[...e.textContent].length,available:e.clientWidth,needed:Math.ceil(range.getBoundingClientRect().width),
          rowWidth:e.closest('.session-item').getBoundingClientRect().width}})()`);
      assert.equal(report.title.characters,12);
      assert(report.title.available>=report.title.needed,JSON.stringify(report.title));
      await shot(cdp,'candidate-home-and-session-width');
      await cdp.eval(`document.documentElement.dataset.theme='light'`);
      report.lightLaunch=await cdp.eval(`({width:Math.round(document.querySelector('#btn-new').getBoundingClientRect().width),
        label:getComputedStyle(document.querySelector('#btn-new .btn-label')).display})`);
      assert(report.lightLaunch.width>=85&&report.lightLaunch.label==='block',JSON.stringify(report.lightLaunch));
      await shot(cdp,'candidate-home-light');
      await cdp.eval(`document.documentElement.dataset.theme='dark'`);
    }
    if(label==='candidate')await cdp.eval(`localStorage.setItem('hub.questionDirectory.session-first-comparison','expanded')`);
    await cdp.eval(`window.__hubE2E.cardQuestionNavigator.mountFixture({sessionId:'session-first-comparison',count:3,clear:true})`);
    await waitFor(cdp,`document.querySelectorAll('#card-question-nav .card-question-nav-item').length===3`,'three card questions');
    await move(cdp,800,500);
    report.default = await geometry(cdp);
    await shot(cdp,label+'-default');
    if(label==='candidate') {
      assert.equal(report.default.rail.width,14);
      assert.equal(report.default.sidebar.width,320);
      assert.equal(report.default.main.x,334);
      assert(report.default.launchButton.width>=85,JSON.stringify(report.default));
      assert.equal(await cdp.eval(`getComputedStyle(document.querySelector('#btn-new .btn-label')).display`),'block');
      assert.equal(report.default.visibleHubMarks,1);
      assert.equal(report.default.directoryCollapsed,true);
      assert.equal(report.default.directorySpace,'54px');
      await move(cdp,5,130);
      report.railHover=await geometry(cdp);
      assert.equal(report.railHover.rail.width,80);
      assert.equal(report.railHover.main.x,report.default.main.x);
      await shot(cdp,'candidate-rail-hover');
      await click(cdp,'#rail-pin');
      await move(cdp,800,500);
      assert.equal((await geometry(cdp)).rail.width,80);
      await click(cdp,'#rail-pin');
      await move(cdp,800,500);
      assert.equal((await geometry(cdp)).rail.width,14);
      await click(cdp,'#btn-new');
      await waitFor(cdp,`getComputedStyle(document.querySelector('#new-session-menu')).display!=='none'`,'launch center opens');
      await shot(cdp,'candidate-launch-center');
      await click(cdp,'#new-session-close');
      await waitFor(cdp,`getComputedStyle(document.querySelector('#new-session-menu')).display==='none'`,'launch center closes');
      const collapsed=await geometry(cdp);
      const d=await cdp.eval(`(()=>{const e=document.querySelector('#card-question-nav .question-directory-toggle'),r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
      await move(cdp,d.x,d.y);
      report.directoryHover=await geometry(cdp);
      assert.equal(report.directoryHover.directory.width,232);
      assert.equal(report.directoryHover.directorySpace,'54px');
      assert.equal(report.directoryHover.main.x,collapsed.main.x);
      await shot(cdp,'candidate-directory-hover');
      await move(cdp,800,500);
      assert.equal((await geometry(cdp)).directory.width,38);
      await click(cdp,'#card-question-nav .question-directory-toggle');
      await _waitMs(220);
      report.directoryPinned=await geometry(cdp);
      assert.equal(report.directoryPinned.directory.width,232);
      assert.equal(report.directoryPinned.directorySpace,'252px');
      await move(cdp,800,500);
      assert.equal((await geometry(cdp)).directory.width,232);
      await click(cdp,'#card-question-nav .question-directory-toggle');
      await _waitMs(220);
      await move(cdp,800,500);
      assert.equal((await geometry(cdp)).directory.width,38);
      report.responsive=[];
      for(const [width,height] of [[1366,768],[1100,720],[900,600],[900,480]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
        await move(cdp,Math.min(550,width-100),Math.min(300,height-100));
        const state=await cdp.eval(`(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect();return {
          viewport:[innerWidth,innerHeight],documentWidth:document.documentElement.scrollWidth,
          rail:Math.round(rect('#scene-rail').width),sidebar:Math.round(rect('#session-sidebar').width),
          mainX:Math.round(rect('#terminal-panel').x),mainRight:Math.round(rect('#terminal-panel').right),
          directory:Math.round(rect('#card-question-nav').width),
          launchVisible:(()=>{const r=rect('#btn-new');return r.width>=85&&r.x>=0&&r.right<=innerWidth})()
        }})()`);
        assert.equal(state.rail,14,JSON.stringify(state));
        assert.equal(state.mainX,334,JSON.stringify(state));
        assert(state.mainRight<=width+1&&state.documentWidth<=width+1&&state.launchVisible,JSON.stringify(state));
        report.responsive.push(state);
        if(width===900&&height===600)await shot(cdp,'candidate-900x600');
      }
      await cdp.send('Emulation.setDeviceMetricsOverride',{width:1100,height:720,deviceScaleFactor:1,mobile:false});
      await cdp.eval(`require('electron').webFrame.setZoomFactor(1.25)`);
      await _waitMs(250);
      report.zoom125=await cdp.eval(`({viewport:[innerWidth,innerHeight],documentWidth:document.documentElement.scrollWidth,sidebar:Math.round(document.querySelector('#session-sidebar').getBoundingClientRect().width),launchWidth:Math.round(document.querySelector('#btn-new').getBoundingClientRect().width)})`);
      assert(report.zoom125.documentWidth<=report.zoom125.viewport[0]+1&&report.zoom125.launchWidth>=85,JSON.stringify(report.zoom125));
      await shot(cdp,'candidate-zoom125');
      await cdp.eval(`require('electron').webFrame.setZoomFactor(1)`);
      await cdp.send('Emulation.setDeviceMetricsOverride',{width:1600,height:950,deviceScaleFactor:1,mobile:false});
      await move(cdp,800,500);
      await move(cdp,5,130);
      await click(cdp,'#btn-rail-accounts');
      await waitFor(cdp,`!document.querySelector('#account-page').hidden`,'account page opens');
      await move(cdp,800,500);
      report.accountPage=await cdp.eval(`({rail:Math.round(document.querySelector('#scene-rail').getBoundingClientRect().width),left:Math.round(document.querySelector('#account-page').getBoundingClientRect().left)})`);
      assert.equal(report.accountPage.rail,14);
      assert.equal(report.accountPage.left,14);
      await shot(cdp,'candidate-account-page');
    }
  } finally {
    if(cdp)await cdp.close();
    if(hub)await gracefulQuit(hub);
  }
  return report;
}

(async()=>{
  const baseline=BASELINE && fs.existsSync(path.join(BASELINE,'package.json'))
    ? await one('baseline-1.6.263',BASELINE) : null;
  const candidate=await one('candidate',ROOT);
  const delta=baseline?{mainGainedPx:baseline.default.main.x-candidate.default.main.x,
    sidebarTotalBeforePx:baseline.default.main.x,sidebarTotalAfterPx:candidate.default.main.x,
    directoryReservedBeforePx:parseInt(baseline.default.directorySpace,10),
    directoryReservedAfterPx:parseInt(candidate.default.directorySpace,10)}:null;
  if(delta)assert(delta.mainGainedPx>100,JSON.stringify(delta));
  const report={baseline,candidate,delta};
  fs.writeFileSync(path.join(OUT,'comparison.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1});
