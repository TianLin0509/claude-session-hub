'use strict';
// Actual isolated Electron + native App Server fixture; shell check uses real PowerShell.
const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net'),os=require('node:os'),path=require('node:path');
const {connectFirstPage}=require('./helpers/cdp-client');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const ROOT=path.resolve(__dirname,'..');
const TEMP_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'hub-pty-design-'));
const ARTIFACT_DIR=path.join(ROOT,'output/playwright/pty-design');
function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = error; }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function clickPoint(client, selector) {
  await client.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center"})`);
  const point = await client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { found: true, x, y, visible: rect.width > 0 && rect.height > 0, topmost: hit === el || el.contains(hit), hit: hit && (hit.tagName + '.' + hit.className) };
  })()`);
  assert.equal(point.found, true, `${selector} should exist`);
  assert.equal(point.visible, true, `${selector} should be visible`);
  assert.equal(point.topmost, true, `${selector} should be topmost; hit=${point.hit}`);
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}


async function main(){
  fs.mkdirSync(ARTIFACT_DIR,{recursive:true});
  const workspace=path.join(TEMP_ROOT,'project');fs.mkdirSync(workspace);
  const result={checks:[],passed:false};let hub,client,deviceScale=1;
  const shot=name=>screenshot(client,path.join(ARTIFACT_DIR,name+'.png'));
  const size=async width=>{await client.send('Emulation.setDeviceMetricsOverride',{width,height:1050,deviceScaleFactor:0,mobile:false});await _waitMs(300);};
  const buffer=()=>client.eval(`(()=>{const b=terminalCache.get(activeSessionId).terminal.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\\n');})()`);
  try{
    hub=await launchIsolatedHub({dataDir:path.join(TEMP_ROOT,'data'),port:await reservePort(),label:'pty-design',windowMode:'hidden',extraEnv:{CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(TEMP_ROOT,'fixture.json'),AI_HUB_WORKSPACE_ROOT:TEMP_ROOT,CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
    client=await connectFirstPage(hub);await client.eval('window.__ptyErrors=[];addEventListener("error",e=>window.__ptyErrors.push(String(e.error||e.message)));addEventListener("unhandledrejection",e=>window.__ptyErrors.push(String(e.reason)));');deviceScale=await client.eval('devicePixelRatio');await size(1500);
    await waitFor('ready',()=>client.eval('!!window.LaunchCenter'));
    const session=await client.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'codex',opts:{cwd:workspace,workspaceLabel:'PTY 阅读体验',model:'gpt-6-astra',effort:'high',mcpProfile:'none'}})+')');
    await waitFor('session',()=>client.eval('!!document.querySelector(".session-welcome")'));
    await clickPoint(client,'[data-view="pty"]');
    await waitFor('native welcome',()=>client.eval('!!document.querySelector(".pty-awaiting-output")'));
    await shot('welcome');
    await clickPoint(client,'.pty-welcome-compose');
    assert.equal(await client.eval('document.activeElement.classList.contains("floating-input-box")'),true);
    result.checks.push('PTY 空白引导可聚焦输入框，不自动发送');
    await client.send('Input.insertText',{text:'请检查这个项目，并展示修改与验证结果。 fixture:terminal-design'});
    await clickPoint(client,'.floating-input-send');
    await waitFor('finished styled output',async()=>/✓ 已完成/.test(await buffer()));
    const text=await buffer();
    for(const s of ['你','Codex · 进展','执行命令','Codex · 回答','界面已更新','const theme','✓ 已完成'])assert(text.includes(s),s);
    assert.equal((text.match(/PASS  欢迎页/g)||[]).length,1);
    assert(!text.includes('```'));assert(!text.includes('## 界面'));
    assert.equal(await client.eval('!!document.querySelector(".pty-awaiting-output")'),false);
    const colors=await client.eval(`(()=>{const b=terminalCache.get(activeSessionId).terminal.buffer.active;const colors=new Set();for(let i=0;i<b.length;i++){const l=b.getLine(i);for(let c=0;c<l.length;c++){const cell=l.getCell(c);if(cell.getChars().trim()&&cell.isFgRGB())colors.add(cell.getFgColor());}}return [...colors];})()`);
    assert(colors.length>=4,'actual xterm contains section/code colors');
    result.colors=colors;
    result.dimensions=await client.eval('(()=>{const t=terminalCache.get(activeSessionId).terminal;return {font:t.options.fontSize,lineHeight:t.options.lineHeight,dpr:devicePixelRatio,cols:t.cols,rows:t.rows,render:t._core._renderService.dimensions,canvases:[...t.element.querySelectorAll("canvas")].map(c=>({width:c.width,height:c.height,style:c.getAttribute("style"),rect:c.getBoundingClientRect().toJSON()}))};})()');await shot('output-dark');
    await client.eval('terminalCache.get(activeSessionId).terminal.selectAll()');
    assert.match(await client.eval('terminalCache.get(activeSessionId).terminal.getSelection()'),/const theme/);
    await client.eval('terminalCache.get(activeSessionId).terminal.clearSelection();openTerminalSearch()');
    await client.send('Input.insertText',{text:'const theme'});
    assert.equal(await client.eval('document.querySelector("#terminal-search-count").textContent'),'');
    await clickPoint(client,'#terminal-search-close');
    result.checks.push('真实输出分段、代码配色、无重复；xterm 文本选择与搜索正常');
    await clickPoint(client,'#btn-theme');await clickPoint(client,'[data-theme-id="codex"]');await clickPoint(client,'#btn-theme');
    await shot('output-light');
    await size(760);await shot('output-narrow');
    assert(await client.eval('(()=>{const c=terminalCache.get(activeSessionId);return c.terminal.cols>20&&c.terminal.rows>10&&c.container.getBoundingClientRect().right<=innerWidth;})()'));
    await clickPoint(client,'[data-view="card"]');
    await waitFor('cards',()=>client.eval('document.querySelectorAll(".turn-card").length>0'));
    assert.equal(await client.eval('document.querySelector(".pty-output-heading").getBoundingClientRect().height'),0);
    await clickPoint(client,'[data-view="pty"]');await _waitMs(250);
    assert.match(await buffer(),/const theme/);
    result.checks.push('深浅主题、760px 窄屏和卡片切换保留输出');
    await size(1500);
    const shell=await client.eval('ipcRenderer.invoke("create-session",'+JSON.stringify({kind:'powershell',opts:{cwd:workspace}})+')');
    await waitFor('shell',()=>client.eval(`activeSessionId===${JSON.stringify(shell.id)}&&!!terminalCache.get(activeSessionId)?._hydrated`));
    await clickPoint(client,'[data-view="pty"]');
    await client.eval('ipcRenderer.send("terminal-input",'+JSON.stringify({sessionId:shell.id,data:"Write-Output 'PTY_REAL_SHELL_OK'\r"})+')');
    await waitFor('shell output',async()=>/PTY_REAL_SHELL_OK/.test(await buffer()));
    assert.equal(await client.eval('!!document.querySelector(".pty-welcome")'),false);
    await shot('shell');result.checks.push('真实 PowerShell 命令输出正常，原终端输入保留');
    result.passed=true;
  }finally{
    if(client){try{result.transcript=await client.eval('require("electron").ipcRenderer.invoke("parse-session-transcript",{hubSessionId:activeSessionId,opts:{}})');result.diagnostics=await client.eval('({errors:window.__ptyErrors,view:currentView,overlay:document.getElementById("msg-overlay").innerText.slice(0,500)})');await shot('final');}catch(error){result.diagnosticError=String(error);}await client.close();}
    if(hub)await gracefulQuit(hub);
    fs.writeFileSync(path.join(ARTIFACT_DIR,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
