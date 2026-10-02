'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..');
const out = path.join(repo, 'output', 'coldwhite-workspaces');
fs.mkdirSync(out, { recursive:true });
const reservePort = () => new Promise(resolve => {
  const server = net.createServer(); server.listen(0,'127.0.0.1',()=>{ const port=server.address().port;server.close(()=>resolve(port)); });
});
const report = { checks:[], cloudCalls:false, boundary:'真实隔离 Electron；仅 UI 与本地 IPC；不启动真实 AI' };
let hub, cdp;
const until = async (expression, label=expression) => {
  for(let i=0;i<150;i++){if(await cdp.eval(`Boolean(${expression})`))return;await _waitMs(100);}
  throw Error('timeout '+label);
};
const click = async selector => {
  let p=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:e===document.elementFromPoint(x,y)||e.contains(document.elementFromPoint(x,y))}})()`);
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y});await _waitMs(160);
  p=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:e===document.elementFromPoint(x,y)||e.contains(document.elementFromPoint(x,y))}})()`);
  assert(p.hit, 'covered '+selector);
  for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1});
  await _waitMs(260);
};
const check = (ok, label) => { assert(ok,label);report.checks.push(label); };
const screenshot = async name => {
  const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));
};
const geometry = () => cdp.eval(`(()=>{const r=id=>{const b=document.getElementById(id).getBoundingClientRect();return {x:b.x,right:b.right,bottom:b.bottom,width:b.width,height:b.height}};return {viewport:[innerWidth,innerHeight],docWidth:document.documentElement.scrollWidth,rail:r('scene-rail'),sidebar:r('session-sidebar'),main:r('terminal-panel'),footer:r('hub-system-footer'),current:[...document.querySelectorAll('#scene-rail [aria-current=page]')].map(e=>e.id)}})()`);

(async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-coldwhite-ui-'));
  const workspace=path.join(temp,'work');fs.mkdirSync(workspace);
  try {
    hub=await launchIsolatedHub({dataDir:path.join(temp,'data'),port:await reservePort(),label:'coldwhite-ui',extraEnv:{AI_HUB_WORKSPACE_ROOT:workspace,CLAUDE_HUB_E2E:'1',CODEX_HOME:path.join(temp,'codex'),CLAUDE_CONFIG_DIR:path.join(temp,'claude'),CLAUDE_HUB_AGENT_RUNTIME:'native',CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(repo,'tests/fixtures/codex-app-server.js')}});
    cdp=await connectFirstPage(hub);
    await until('!!window.hubWorkspaces && !!window.__hubE2E?.cardQuestionNavigator');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
    await until('document.querySelector("#empty-state").dataset.homeReady === "true"');
    const initial=await geometry();report.initial=initial;
    check(await cdp.eval('document.documentElement.dataset.theme === "codex"'),'冷白为新用户默认主题');
    check(initial.rail.width===162 && initial.sidebar.width===224 && initial.main.x===386,'独立导航列与会话列参与布局');
    await until('document.documentElement.classList.contains("navigation-artwork-ready")');
    const icons=await cdp.eval(`[...document.querySelectorAll('#scene-rail .rail-artwork')].map(e=>({display:getComputedStyle(e).display,width:e.getBoundingClientRect().width,src:e.getAttribute('src'),loaded:e.naturalWidth>0}))`);
    check(icons.length===12 && icons.every(e=>e.display==='block' && e.loaded && e.src.includes('sticker-v2/')),'十二功能入口使用已选线描贴纸原图');
    check(await cdp.eval(`document.querySelector('#btn-assistant img').src.endsWith('assistant/penguin.png') && !document.querySelector('.nav-artwork')`),'助理保留企鹅，旧机器人精灵图不再注入');
    await screenshot('01-home');
    const routes=[['btn-assistant','terminal-panel'],['btn-research','chuxin-panel'],['btn-study','study-panel'],['btn-ran','ran-panel'],['btn-rail-memo','hub-workspace'],['btn-rail-capabilities','hub-workspace'],['btn-rail-accounts','account-page'],['btn-writing','writing-panel']];
    for(const [button,panel] of routes){
      await click('#'+button);
      await until(`document.querySelector('#${button}').classList.contains('cw-current')`);
      const g=await geometry();
      check(g.current.length===1 && g.current[0]===button,button+' 选中唯一且正确');
      check(g.sidebar.width===(button==='btn-assistant'?224:0),button==='btn-assistant'?'助理沿用普通会话栏':'工具页释放会话栏 '+button);
      const rect=await cdp.eval(`(()=>{const e=document.getElementById('${panel}'),r=e.getBoundingClientRect();return {x:r.x,right:r.right,bottom:r.bottom,display:getComputedStyle(e).display}})()`);
      check(rect.x===g.rail.right+g.sidebar.width && rect.right<=1441 && rect.bottom<=g.footer.bottom-g.footer.height+1,'页面与导航及底栏无覆盖 '+button);
      check(await cdp.eval('getComputedStyle(document.querySelector("#sidebar-strip")).display !== "none"'),'系统底栏在 '+button+' 可见');
      await screenshot('page-'+button);
    }
    await click('#btn-rail-capabilities');
    await until('document.querySelector(".cp-filter-disclosure")');
    check(await cdp.eval('!document.querySelector(".cp-filter-disclosure").open'),'复杂筛选默认收起');
    await click('.cp-filter-disclosure>summary');
    await click('[data-cp-agent="codex"]');
    check(await cdp.eval('document.querySelector(".cp-filter-disclosure").open && document.querySelector("[data-cp-agent=codex]").getAttribute("aria-pressed")==="true"'),'筛选重绘保留展开及手选状态');
    await click('.cp-filter-disclosure>summary');
    check(await cdp.eval('document.querySelector(".cp-filter-disclosure>summary").textContent.includes("Codex")'),'收起仍显示筛选摘要');
    await click('#btn-home');
    check((await geometry()).sidebar.width===224,'回会话恢复原会话栏');
    await click('#rail-pin');
    const collapsed=await geometry();
    check(collapsed.rail.width===56 && collapsed.main.x===280,'收起导航仍保留图标且无覆盖');
    await click('#btn-rail-accounts');
    check((await geometry()).current[0]==='btn-rail-accounts','收起导航仍能打开账号');
    await click('#btn-home');
    await click('#rail-pin');
    for(const [width,height] of [[1280,800],[1024,720],[900,600],[900,480]]){
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await _waitMs(200);
      const g=await geometry();
      check(g.docWidth<=width+1 && g.main.right<=width+1 && g.sidebar.x>=g.rail.right,'无横向溢出 '+width+'x'+height);
      for(const id of ['btn-writing','btn-options','btn-new']){
        check(await cdp.eval(`(()=>{const e=document.getElementById('${id}');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(hit===e||e.contains(hit))})()`),'小窗口入口可点击 '+id+' '+width+'x'+height);
      }
      await screenshot('home-'+width+'x'+height);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1100,height:720,deviceScaleFactor:1,mobile:false});
    await cdp.eval('require("electron").webFrame.setZoomFactor(1.25)');await _waitMs(220);
    check((await geometry()).docWidth<=await cdp.eval('innerWidth+1'),'125% 缩放没有整页溢出');
    await screenshot('zoom125');
    await cdp.eval('require("electron").webFrame.setZoomFactor(1)');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
    await cdp.eval(`window.__hubE2E.cardQuestionNavigator.mountFixture({sessionId:'coldwhite-questions',count:3,clear:true})`);
    await until('document.querySelectorAll("#card-question-nav .card-question-nav-item").length===3');
    const directoryState=()=>cdp.eval(`(()=>{const e=document.querySelector('#card-question-nav');return {width:e.getBoundingClientRect().width,className:e.className,pinned:e.querySelector('.question-directory-toggle').getAttribute('aria-pressed'),layout:document.querySelector('#terminal-panel').clientWidth,preference:localStorage.getItem('hub.questionDirectoryPinned.v2.coldwhite-questions')}})()`);
    report.directoryInitial=await directoryState();
    await click('#card-question-nav .question-directory-toggle');
    report.directoryPinned=await directoryState();
    check(await cdp.eval('document.querySelector("#card-question-nav").getBoundingClientRect().width>=200'),'问题目录仍可展开');
    await click('#card-question-nav .question-directory-toggle');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:500,y:300});await _waitMs(250);
    report.directoryUnpinned=await directoryState();
    check(await cdp.eval('document.querySelector("#card-question-nav").getBoundingClientRect().width<100'),'问题目录仍可收起');
    for(const theme of ['dark','claude','codex']){
      await cdp.eval(`themeController.setTheme('${theme}')`);await _waitMs(160);
      check(await cdp.eval(`document.documentElement.dataset.theme === '${theme}'`),'主题切换 '+theme);
      check(await cdp.eval(`[...document.querySelectorAll('#scene-rail .rail-artwork')].every(e=>getComputedStyle(e).display!=='none' && e.naturalWidth>0)`),'主题保留功能图标 '+theme);
    }
    await click('#rail-pin');
    await cdp.send('Page.reload');
    await until('!!window.hubWorkspaces && document.querySelector("#empty-state").dataset.homeReady==="true"');
    check((await geometry()).rail.width===56,'重启页面记住手选导航状态');
    await click('#rail-pin');
    report.passed=true;
  } catch(error){report.error=error.stack;process.exitCode=1;if(cdp)await screenshot('failure').catch(()=>{});}
  finally {
    if(cdp)await cdp.close();
    if(hub){report.shutdown=await gracefulQuit(hub);fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));}
    fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,error:report.error,out}));
  }
})();
