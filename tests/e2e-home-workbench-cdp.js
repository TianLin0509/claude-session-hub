// Real isolated Hub UI: welcome page B and existing launch-center integration.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-welcome-b-'));
  const data = path.join(root, 'data'), work = path.join(root, 'workspace');
  const out = path.resolve(__dirname, '../output/playwright/welcome-b-' + Date.now());
  for (const dir of [data, work, out]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(data, 'prepared-projects.json'), JSON.stringify({schemaVersion:1,projects:[],migrations:[]}));
  const evidence = { checks: [], root, scope: 'Real Electron UI; no model prompts sent' };
  let hub, cdp;
  const check = (name, value) => { assert(value, name); evidence.checks.push(name); console.log('PASS ' + name); };
  try {
    const port = await new Promise(resolve => { const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));}); });
    hub = await launchIsolatedHub({ dataDir:data, port, windowMode:'hidden', extraEnv:{
      AI_HUB_WORKSPACE_ROOT:work, CODEX_HOME:path.join(root,'codex'), CLAUDE_CONFIG_DIR:path.join(root,'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),
    }});
    evidence.pid = hub.pid;
    cdp = await connectFirstPage(hub);
    const until = async expression => { for(let i=0;i<250;i++){if(await cdp.eval(expression))return;await _waitMs(100);} throw Error('Timeout: '+expression); };
    const click = async selector => {
      const point=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('obscured '+${JSON.stringify(selector)});return{x,y};})()`);
      for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
    };
    const size = async (width,height) => { await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false}); await cdp.send('Page.bringToFront'); await _waitMs(250); };
    const shot = async name => { await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:5}); await _waitMs(250); const s=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}); fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64')); };
    await until('!!window.LaunchCenter && document.getElementById("empty-state").dataset.homeReady === "true"');
    await cdp.eval(`window.__welcomeErrors=[];window.addEventListener('error',e=>window.__welcomeErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__welcomeErrors.push(String(e.reason)))`);
    await size(1440,1000);
    check('首次打开即显示 B 欢迎页和两个入口',await cdp.eval('document.getElementById("empty-state").getBoundingClientRect().height>0 && document.querySelectorAll("[data-home-create]").length===2 && !document.getElementById("home-card-stack")'));
    check('桌面左右分栏',await cdp.eval(`(()=>{const a=document.querySelector('.home-welcome-intro').getBoundingClientRect(),b=document.querySelector('.home-welcome-portals').getBoundingClientRect();return b.x>a.right;})()`));
    await shot('20260912-welcome-b-desktop-codex1');
    await click('#home-create-session');
    await until('document.getElementById("new-session-menu").style.display!=="none" && document.getElementById("launch-intent-session").getAttribute("aria-selected")==="true"');
    check('普通入口直接打开会话创建，未自动创建',await cdp.eval('sessions.size===0'));
    await shot('20260912-welcome-session-create-codex1');
    await click('#new-session-close');
    await click('#home-create-group');
    await until('document.getElementById("launch-intent-group").getAttribute("aria-selected")==="true" && !!document.querySelector(".mcm-create")');
    check('群聊入口首次即打开开发场景和双成员配置',await cdp.eval(`document.querySelector('[data-mcm-scene="dev"]').classList.contains('selected') && document.querySelectorAll('.mcm-slot').length===2`));
    await shot('20260912-welcome-group-create-codex1');
    await click('#new-session-close');
    // Native keyboard activation and focus restoration use the existing launcher.
    await cdp.eval('document.getElementById("home-create-session").focus()');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await until('document.getElementById("new-session-menu").style.display!=="none"');
    await click('#new-session-close');
    check('键盘可打开入口，关闭后焦点返回',await cdp.eval('document.activeElement.id==="home-create-session"'));
    // Create through the actual form. Latest Codex runtime stays lazy until a prompt.
    await click('#home-create-session');
    await click('.new-session-option[data-kind="codex"]');
    await click('#new-session-submit');
    await until('sessions.size===1 && !!document.querySelector(".floating-input-box")');
    const sid = await cdp.eval('Array.from(sessions.keys())[0]');
    await click('#btn-home');
    await until('document.getElementById("empty-state").getBoundingClientRect().height>0');
    check('创建普通会话后可返回欢迎页',await cdp.eval('document.getElementById("completion-notification-toggle").parentElement.id==="home-notification-slot"'));
    await click(`#session-list [data-session-id="${sid}"]`);
    await until('document.querySelector(".floating-input-box").getBoundingClientRect().height>0');
    check('侧栏仍可回到已有会话',await cdp.eval('!document.getElementById("empty-state") || document.getElementById("empty-state").style.display==="none"'));
    await click('#btn-home');
    await click('#home-create-group');
    await until('document.querySelectorAll(".mcm-slot").length===2');
    check('会话切换后再次打开群聊，无重复配置面板',await cdp.eval('document.querySelectorAll(".mcm-create").length===1'));
    await click('#new-session-close');
    for (const theme of ['dark','claude','codex','hub','slate','frost']) {
      await cdp.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      check('主题 '+theme+' 无横向溢出',await cdp.eval('document.getElementById("empty-state").scrollWidth<=document.getElementById("empty-state").clientWidth'));
      if(theme==='hub')await shot('20260912-welcome-b-light-codex1');
    }
    await cdp.eval('document.documentElement.dataset.theme="dark"');
    await size(1000,900);
    check('窄窗口自动上下布局',await cdp.eval(`(()=>{const a=document.querySelector('.home-welcome-intro').getBoundingClientRect(),b=document.querySelector('.home-welcome-portals').getBoundingClientRect();return b.y>=a.bottom;})()`));
    check('窄窗口欢迎区域无横向溢出',await cdp.eval('document.getElementById("empty-state").scrollWidth<=document.getElementById("empty-state").clientWidth'));
    await shot('20260912-welcome-b-narrow-codex1');
    await click('#home-create-session');await until('document.getElementById("new-session-menu").style.display!=="none"');await click('#new-session-close');
    check('窄窗口按钮仍可点击',true);
    await size(1440,1000);
    check('交互过程无页面异常',await cdp.eval('window.__welcomeErrors.length===0'));
    await cdp.send('Page.reload');
    await until('!!window.LaunchCenter && document.getElementById("empty-state").dataset.homeReady==="true"');
    await click('#btn-home');await click('#home-create-group');
    await until('!!document.querySelector(".mcm-create")');
    check('重载后创建入口仍正常',true);
    await click('#new-session-close');
    evidence.passed=true;
  } finally {
    if(cdp) { if(!evidence.passed) { try { evidence.failureDom=await cdp.eval('({home:document.getElementById("empty-state")?.outerHTML,errors:window.__welcomeErrors})'); } catch(e) { evidence.diagnosticError=e.message; } } await cdp.close(); }
    if(hub) { fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n')); await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out,'20260912-welcome-b-evidence-codex1.json'),JSON.stringify(evidence,null,2));
    console.log('ARTIFACT_ROOT '+out);
  }
}
run().catch(e=>{console.error(e);process.exitCode=1});
