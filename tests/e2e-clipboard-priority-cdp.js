'use strict';
// Real Electron input -> shared clipboard writer -> independent Win32 read -> Chromium paste.
// No production state or AI sessions; the actual system clipboard is backed up and conditionally restored.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = path.resolve(__dirname, '..');
const RUN = `20261015-hub-copy-title-codex1-${Date.now()}`;
const OUTPUT = path.join(ROOT, 'output', RUN);
const TEMP = path.join(require('node:os').tmpdir(), RUN);
const knownFiles = [];
const SENTINEL = `HUB_COPY_SENTINEL_${RUN}`;
let client, hub, backupReady = false;
const result = { run: RUN, cases: [] };
function ps(file, args = []) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', path.join(__dirname, 'helpers', file), ...args],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 }).trim();
}
function remember(text) {
  const target = path.join(TEMP, `20261015-payload-${knownFiles.length}.txt`);
  fs.writeFileSync(target, text, 'utf8'); knownFiles.push(target); return target;
}
async function waitUntil(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await _waitMs(30); }
  throw new Error(`timeout: ${label}`);
}
const waitExpr = (expr, timeout) => waitUntil(() => client.eval(`Boolean(${expr})`), expr, timeout);
async function key(letter) {
  const upper = letter.toUpperCase();
  for (const type of ['keyDown', 'keyUp']) await client.send('Input.dispatchKeyEvent', {
    type, key: letter, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers: 2,
  });
}
async function click(selector, button = 'left') {
  await client.eval(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  const point = await client.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('missing ${selector}');
    const r = el.getBoundingClientRect(); return {x:r.x + Math.min(12,r.width/2),y:r.y+r.height/2}; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, ...point, button, clickCount: 1 });
}
async function select(selector, marker) {
  const selected = await client.eval(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)}); if (!root) throw Error('missing selection target');
    root.scrollIntoView({block:'center'}); root.focus?.();
    const marker = ${JSON.stringify(marker)};
    if (root.tagName === 'TEXTAREA' || root.tagName === 'INPUT') { const at = root.value.indexOf(marker); root.setSelectionRange(at,at+marker.length); return root.value.slice(root.selectionStart,root.selectionEnd); }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node;
    while ((node=walker.nextNode())) { const i = node.nodeValue.indexOf(marker); if (i < 0) continue;
      const range=document.createRange(); range.setStart(node,i); range.setEnd(node,i+marker.length);
      const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString(); }
    return ''; })()`);
  assert.equal(selected, marker);
}
async function resetFeedback() {
  const reset = await client.eval(`require('electron').ipcRenderer.invoke('clipboard:write-text',${JSON.stringify(SENTINEL)})`);
  assert.equal(reset.ok,true);
  await client.eval(`document.getElementById('hub-copy-feedback')?.remove()`);
}
async function verify(label, expected, started) {
  await waitExpr(`document.getElementById('hub-copy-feedback')?.dataset.state === 'success'`);
  const acknowledgementMs = Date.now() - started;
  const probe = JSON.parse(ps('windows-clipboard-inspect.ps1', ['-ExpectedFile', remember(expected)]));
  assert.equal(probe.matchesExpected, true, `${label}: Windows clipboard mismatch`);
  await client.eval(`(() => { const input=document.getElementById('copy-paste-probe'); input.value=''; input.focus(); })()`);
  await key('v');
  await waitExpr(`document.getElementById('copy-paste-probe').value === ${JSON.stringify(expected.replace(/\r\n?/g, '\n'))}`);
  result.cases.push({ label, acknowledgementMs, win32Match: true, nativePasteMatch: true });
  console.log(`PASS ${label}: Windows + paste, ${acknowledgementMs} ms`);
}
async function lockClipboard() {
  const ready = path.join(TEMP, `20261015-lock-${Date.now()}.ready`), release = ready + '.release';
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'helpers', 'hold-clipboard.ps1'), '-ReadyFile', ready, '-ReleaseFile', release], { windowsHide:true, stdio:['ignore','pipe','pipe'] });
  let error = ''; child.stderr.on('data', d => { error += d; });
  const ended = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(error || `clipboard lock exited ${code}`))); });
  await waitUntil(() => fs.existsSync(ready), 'clipboard lock');
  return async () => { fs.writeFileSync(release, 'release'); await ended; };
}
async function main() {
  fs.mkdirSync(TEMP, { recursive: true });
  fs.mkdirSync(OUTPUT, { recursive: true });
  remember(SENTINEL);
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  try {
    result.backup = ps('clipboard-guard.ps1', ['backup', path.join(TEMP, 'clipboard-backup')]); backupReady = true;
    hub = await launchIsolatedHub({ dataDir: path.join(TEMP, 'hub'), port, label: RUN,
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_E2E_REAL_CLIPBOARD: '1' } });
    client = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await client.send('Runtime.enable'); await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await waitExpr(`window.__hubE2E?.clipboard`);
    await client.eval(`window.__hubE2E.cardQuestionNavigator.mountFixture({sessionId:'copy-test',start:1,count:1,clear:true})`);
    const marker = '问题 1：请分析第 1 个方案的收益、风险与下一步。';
    remember(marker);
    await client.eval(`(() => { const el=document.createElement('textarea'); el.id='copy-paste-probe'; el.setAttribute('aria-label','剪贴板粘贴验收');
      el.style='position:fixed;left:520px;bottom:12px;width:640px;height:44px;z-index:99999'; document.body.appendChild(el); })()`);
    const sessions = [
      {id:'title-claude',kind:'claude',title:'Claude · 看一下我们的AI圆桌'},
      {id:'title-codex',kind:'codex',title:'Codex · 【引用会话】复制问题'},
      {id:'title-branch',kind:'codex',title:'分支2: Codex · 调整会话命名'},
      {id:'title-manual',kind:'claude',title:'Claude · 我的手动名称',userRenamed:true},
    ];
    await client.eval(`window.__hubE2E.addFakeSessions(${JSON.stringify(sessions)})`);
    result.titles = await client.eval(`Array.from(document.querySelectorAll('.session-item')).filter(e=>e.dataset.sessionId?.startsWith('title-')).map(e=>({id:e.dataset.sessionId,title:e.querySelector('.sl-title')?.textContent,logo:!!e.querySelector('.sl-kind')}))`);
    for (const [id,title] of [['title-claude','看一下我们的AI圆桌'],['title-codex','【引用会话】复制问题'],['title-branch','分支2: 调整会话命名'],['title-manual','Claude · 我的手动名称']]) {
      const row=result.titles.find(s=>s.id===id); assert(row); assert.equal(row.title,title); assert.equal(row.logo,true);
    }
    console.log('PASS existing titles, branch marker, manual title and logos');
    const card = '#msg-overlay .turn-card.user .turn-body';
    await select(card, marker); await resetFeedback(); let started=Date.now(); await key('c'); await verify('card Ctrl+C',marker,started);
    await select(card, marker); await resetFeedback();
    await click(card,'right'); await waitExpr(`document.getElementById('card-selection-context-menu').style.display==='block'`);
    started=Date.now(); await click('#card-selection-context-menu [data-action="copy"]'); await verify('card right-click Copy',marker,started);
    const inputMarker='输入框复制 中文 🙂\n第二行'; remember(inputMarker);
    await client.eval(`document.getElementById('copy-paste-probe').value=${JSON.stringify(inputMarker)}`);
    await select('#copy-paste-probe',inputMarker); await resetFeedback(); started=Date.now(); await key('c'); await verify('textarea Ctrl+C',inputMarker,started);
    await select('#copy-paste-probe',inputMarker); await resetFeedback(); await click('#copy-paste-probe','right');
    await waitExpr(`document.getElementById('card-selection-context-menu').style.display==='block'`);
    started=Date.now(); await click('#card-selection-context-menu [data-action="copy"]'); await verify('textarea right-click Copy',inputMarker,started);
    // Deliberately make the renderer's direct writer/cache lie. The UI must still write through main.
    await client.eval(`window.__savedClipboardWrite=require('electron').clipboard.writeText; require('electron').clipboard.writeText=()=>{};`);
    await select(card,marker); await resetFeedback(); started=Date.now(); await key('c'); await verify('renderer write unavailable',marker,started);
    await client.eval(`require('electron').clipboard.writeText=window.__savedClipboardWrite`);
    // Hold the actual Windows clipboard: bounded failure must be visible, then a new copy recovers.
    await select(card,marker); await resetFeedback(); const unlock=await lockClipboard();
    try { started=Date.now(); await key('c'); await waitExpr(`document.getElementById('hub-copy-feedback')?.dataset.state==='error'`);
      result.cases.push({label:'Windows clipboard held',errorShown:true,elapsedMs:Date.now()-started}); console.log('PASS locked clipboard reports failure');
    } finally { await unlock(); }
    await resetFeedback(); started=Date.now(); await key('c'); await verify('copy after lock released',marker,started);
    await select(card,marker); await resetFeedback(); const unlockRetry=await lockClipboard();
    try { started=Date.now(); await key('c'); await _waitMs(100); await unlockRetry();
      await verify('Windows lock released during retry',marker,started);
    } finally { await unlockRetry(); }
    const markdown=path.join(TEMP,'20261015-copy-preview.md'); const previewMarker='预览文字复制 中文 123'; remember(previewMarker);
    fs.writeFileSync(markdown,`# 预览复制验收\n\n${previewMarker}\n`,'utf8');
    await client.eval(`window.openPreviewPanel(${JSON.stringify(markdown)})`);
    await waitExpr(`document.querySelector('#preview-body .preview-markdown')`);
    await select('#preview-body .preview-markdown',previewMarker); await resetFeedback(); started=Date.now(); await key('c'); await verify('Markdown preview Ctrl+C',previewMarker,started);
    await select('#preview-body .preview-markdown',previewMarker); await resetFeedback(); await click('#preview-body .preview-markdown p','right');
    await waitExpr(`document.getElementById('card-selection-context-menu').style.display==='block'`);
    started=Date.now(); await click('#card-selection-context-menu [data-action="copy"]'); await verify('Markdown preview right-click Copy',previewMarker,started);
    const shot=await client.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
    fs.writeFileSync(path.join(OUTPUT,`${RUN}.png`),Buffer.from(shot.data,'base64'));
    const htmlPath=path.join(TEMP,'20261015-copy-preview.html'), htmlMarker='HTML 页面复制 中文'; remember(htmlMarker);
    fs.writeFileSync(htmlPath,`<!doctype html><meta charset="utf-8"><p><strong>${htmlMarker}</strong></p>`,'utf8');
    await client.eval(`window.openPreviewPanel(${JSON.stringify(htmlPath)},{pinned:true})`);
    await waitExpr(`document.querySelector('#preview-body webview')?.getWebContentsId?.()>0`);
    await resetFeedback(); started=Date.now();
    await client.eval(`(async () => { const guest=document.querySelector('#preview-body webview');
      await guest.executeJavaScript("(() => {const r=document.createRange();r.selectNodeContents(document.querySelector('p')); const s=window.getSelection();s.removeAllRanges();s.addRange(r);})()",true);
      guest.focus(); guest.sendInputEvent({type:'keyDown',keyCode:'C',modifiers:['control']});guest.sendInputEvent({type:'keyUp',keyCode:'C',modifiers:['control']});return true; })()`);
    await verify('HTML webview Ctrl+C',htmlMarker,started);
    await resetFeedback(); started=Date.now();
    await client.eval(`(async () => {const guest=document.querySelector('#preview-body webview');guest.focus();return guest.executeJavaScript("document.execCommand('copy')",true);})()`);
    await verify('HTML native Copy',htmlMarker,started);
    const rich=await client.eval(`require('electron').clipboard.readHTML()`); assert.match(rich,/<strong>/i);
    result.richTextPreserved=true;
    await resetFeedback();
    await client.eval(`(async () => {const guest=document.querySelector('#preview-body webview');guest.focus();
      const p=await guest.executeJavaScript("(() => {const r=document.querySelector('strong').getBoundingClientRect();return {x:Math.round(r.x+12),y:Math.round(r.y+r.height/2)};})()");
      guest.sendInputEvent({type:'mouseDown',button:'right',clickCount:1,...p});guest.sendInputEvent({type:'mouseUp',button:'right',clickCount:1,...p});return true;})()`);
    await waitExpr(`document.getElementById('card-selection-context-menu').style.display==='block'`);
    started=Date.now(); await click('#card-selection-context-menu [data-action="copy"]'); await verify('HTML webview right-click Copy',htmlMarker,started);

    await client.eval(`closePreviewPanel(); window.__hubE2E.selectSession('title-codex');`);
    await waitExpr(`terminalCache.get('title-codex')?.terminal && document.querySelector('.floating-input-bar[data-session-id="title-codex"] .floating-input-box')`);
    const composer='.floating-input-bar[data-session-id="title-codex"] .floating-input-box';
    const composerMarker='真实会话输入框 复制验收'; remember(composerMarker);
    await client.eval(`document.querySelector(${JSON.stringify(composer)}).textContent=${JSON.stringify(composerMarker)}`);
    await select(composer,composerMarker); await resetFeedback(); started=Date.now(); await key('c'); await verify('session composer Ctrl+C',composerMarker,started);
    const longText=Array.from({length:3000},(_,i)=>`第 ${i+1} 行：复制长文本必须保留原文和中文。`).join('\n'); remember(longText);
    await client.eval(`require('electron').ipcRenderer.invoke('clipboard:write-text',${JSON.stringify(longText)})`);
    await client.eval(`(() => {const box=document.querySelector(${JSON.stringify(composer)});box.textContent='';box.focus();})()`);
    await key('v'); await waitExpr(`document.querySelector(${JSON.stringify(composer+' .fi-paste-chip')})`);
    const selectChip = () => client.eval(`(() => {const box=document.querySelector(${JSON.stringify(composer)});box.focus();const range=document.createRange();range.selectNodeContents(box);const s=window.getSelection();s.removeAllRanges();s.addRange(range);})()`);
    await selectChip(); await resetFeedback(); started=Date.now(); await key('c'); await verify('3000-line paste chip Ctrl+C',longText,started);
    await selectChip(); await resetFeedback(); started=Date.now(); await client.eval(`document.execCommand('copy')`); await verify('3000-line paste chip native Copy',longText,started);
    await selectChip(); await resetFeedback(); await click(composer+' .fi-paste-chip','right');
    await waitExpr(`document.getElementById('card-selection-context-menu').style.display==='block'`);
    started=Date.now(); await click('#card-selection-context-menu [data-action="copy"]'); await verify('3000-line paste chip right-click Copy',longText,started);
    await client.eval(`document.querySelector(${JSON.stringify(composer)}).textContent=''`);
    await click('#btn-backstage');
    const termMarker='  TERMINAL_COPY_EXACT  '; remember(termMarker);
    await client.eval(`new Promise(resolve=>{const c=terminalCache.get('title-codex');c.container.dataset.copyTestTerminal='1';c.terminal.write(${JSON.stringify(termMarker+'\r\n')},resolve);})`);
    const selectTerm = async () => {
      const selected=await client.eval(`(() => {const t=terminalCache.get('title-codex').terminal;const row=window.__hubE2E.terminalFindLastLine('title-codex','TERMINAL_COPY_EXACT');t.select(0,row-1,${termMarker.length});t.focus();return t.getSelection();})()`);
      assert.equal(selected,termMarker);
    };
    await selectTerm(); await resetFeedback(); started=Date.now(); await key('c'); await verify('terminal selection Ctrl+C',termMarker,started);
    await selectTerm(); await resetFeedback(); await click('[data-copy-test-terminal="1"] .xterm-screen','right');
    await waitExpr(`document.getElementById('terminal-context-menu').style.display==='block'`);
    started=Date.now(); await click('#terminal-context-menu [data-action="copy"]'); await verify('terminal right-click Copy keeps spaces',termMarker,started);
    await client.eval(`window.__originalSend=ipcRenderer.send; ipcRenderer.send=function(channel,payload){if(channel==='terminal-input'&&payload?.sessionId==='title-codex'){window.__interruptSent=payload.data;return;}return window.__originalSend.apply(this,arguments);}; const t=terminalCache.get('title-codex').terminal;t.clearSelection();t.focus();`);
    try { await key('c'); await waitExpr(`window.__interruptSent==='\\x03'`); result.terminalInterruptPreserved=true; }
    finally { await client.eval(`ipcRenderer.send=window.__originalSend`); }
    result.success=true;
  } catch (error) {
    result.error=error.stack || error.message; process.exitCode=1; console.error(result.error);
    if (client) { try { const shot=await client.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(OUTPUT,`${RUN}-failed.png`),Buffer.from(shot.data,'base64'));
      result.failedUi=await client.eval(`({selection:window.getSelection()?.toString(),menu:document.getElementById('card-selection-context-menu')?.outerHTML})`);
    } catch(captureError) { result.captureError=captureError.message; } }
  }
  finally {
    if (client) await client.close();
    if (hub) { try { result.teardown=await gracefulQuit(hub); } catch(error) {result.teardownError=error.stack;process.exitCode=1;} }
    if (backupReady && knownFiles.length) {
      try { result.restore=ps('clipboard-guard.ps1',['restore',path.join(TEMP,'clipboard-backup'),'-TextFile',knownFiles.join(';')]);
        if (result.restore.startsWith('RESTORED')) result.restoreVerification=ps('clipboard-guard.ps1',['verify',path.join(TEMP,'clipboard-backup')]);
      } catch(error) {result.restoreError=error.message;process.exitCode=1;}
    }
    fs.writeFileSync(path.join(OUTPUT,`${RUN}.json`),JSON.stringify(result,null,2),'utf8');
    console.log(JSON.stringify(result,null,2));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
