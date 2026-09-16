'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
async function until(name, read, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100); } throw Error('Timeout: ' + name); }
async function click(c, selector) {
  const rect = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const hit = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),hit=document.elementFromPoint(${rect.x},${rect.y});return {valid:!!hit&&e.contains(hit),target:hit?.outerHTML.slice(0,180)}})()`);
  assert(hit.valid, `obscured click target ${selector}: ${JSON.stringify(hit)}`);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-split-'));
  const out = path.resolve('artifacts/session-split/' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const dataDir = path.join(root, 'data'), workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'prepared-projects.json'), JSON.stringify({ schemaVersion: 1, projects: [], migrations: [] }));
  const env = { CLAUDE_HUB_E2E: '1', CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve('tests/fixtures/codex-app-server.js'),
    CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.resolve('tests/fixtures/claude-stream.js'), CLAUDE_HUB_CLAUDE_FIXTURE_MODE: 'normal',
    CLAUDE_HUB_FIXTURE_CONFIG_DIR: path.join(root, 'launch-config'), CLAUDE_HUB_NATIVE_FIXTURE_STORE: path.join(root, 'threads.json'),
    CLAUDE_HUB_NATIVE_FIXTURE_TRACE: path.join(root, 'trace.jsonl') };
  let hub, c, passed = false; const checks = [], ids = {};
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await port(), label: 'session-split', extraEnv: env, windowMode: 'hidden' });
    c = await connectFirstPage(hub);
    await until('renderer initialized', () => c.eval('typeof sessionSplit!=="undefined" && !!sessionSplit'));
    assert.equal(await c.eval("document.querySelector('.session-workspace').classList.contains('is-split')"), false);
    assert.equal(await c.eval('sessionSplit.secondary()'), null);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (const kind of ['codex', 'claude']) {
      const cwd = path.join(workspace, kind); fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, 'split-review.txt'), kind + ' workspace');
      const session = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind, opts: { cwd, mcpProfile: 'none', ...(kind === 'codex' ? { model: 'gpt-6-astra' } : {}) } })})`);
      ids[kind] = session.id;
      await until(kind + ' native ready', () => c.eval(`sessions.get(${JSON.stringify(session.id)})?.nativeRuntime?.connection==='connected'`));
    }
    await click(c, `.session-item[data-session-id="${ids.codex}"]`);
    await until('primary Codex', () => c.eval(`activeSessionId===${JSON.stringify(ids.codex)} && !!document.querySelector('#terminal-panel .floating-input-box')`));
    assert.equal(await c.eval("document.querySelector('.session-workspace').classList.contains('is-split')"), false);
    assert.equal(await c.eval("document.querySelector('[data-session-layout=single]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await c.eval("document.querySelector('.session-pane-right').getBoundingClientRect().width"), 0);
    assert.equal(await c.eval('document.querySelectorAll(".floating-input-bar").length'), 1);
    checks.push('startup and ordinary session selection remain single until the SVG split button is clicked');
    await shot('default-single');
    await click(c, '[data-session-layout="two"]');
    await until('split visible', () => c.eval("document.querySelector('.session-workspace').classList.contains('is-split')"));
    await click(c, `.session-item[data-session-id="${ids.claude}"]`);
    await until('secondary Claude', () => c.eval(`sessionSplit.secondary()?.sessionId===${JSON.stringify(ids.claude)} && !!document.querySelector('.split-secondary .floating-input-box')`));
    assert.equal(await c.eval('activeSessionId'), ids.codex);
    checks.push('SVG layout button opens two panes; sidebar targets focused right pane');
    assert.equal(await c.eval('getActiveCompletionNotificationTarget()?.id'), ids.claude);
    assert.equal(await c.eval('getActivePreviewCwd()'), path.join(workspace, 'claude'));
    assert.equal(await c.eval('getActiveFileManagerContext()?.cwd'), path.join(workspace, 'claude'));
    checks.push('global notification and file contexts follow the focused secondary session');
    await until('right toolbar ready', () => c.eval(`document.querySelector('#toolbar-crumb').dataset.signature==='session:'+${JSON.stringify(ids.claude)}`));
    await click(c, '.btn-file-manager-toggle');
    await until('right directory visible', () => c.eval(`fileManagerPanel.isOpenFor(${JSON.stringify(path.join(workspace, 'claude'))}) && !!document.querySelector('.fm-node-button[data-type="file"]')`));
    await click(c, '.fm-node-button[data-type="file"]');
    await until('right file preview', () => c.eval("document.querySelector('#preview-body').innerText.includes('claude workspace')"));
    await until('fullscreen preview hides workspace', () => c.eval("document.querySelector('.session-workspace').hidden"));
    assert.equal(await c.eval('getActiveCompletionNotificationTarget()?.id'), ids.claude);
    await click(c, '#file-manager-close');
    await until('file manager closed', () => c.eval('!fileManagerPanel.isOpen()'));
    await click(c, '#preview-layout-split');
    await until('preview half layout', () => c.eval("document.querySelector('#preview-panel').classList.contains('preview-split') && document.querySelector('.session-workspace').getBoundingClientRect().width>0"));
    const previewRatio = await c.eval("(()=>{const w=document.querySelector('.session-workspace').getBoundingClientRect().width,p=document.querySelector('#preview-panel').getBoundingClientRect().width;return w/(w+p)})()");
    assert(Math.abs(previewRatio - 0.5) < 0.03, `half preview must give half the width to the whole session workspace, got ${previewRatio}`);
    await shot('split-with-preview');
    await click(c, '#preview-close');
    await until('preview closed', () => c.eval("document.querySelector('#preview-panel').style.display==='none'"));
    await until('split after file preview', () => c.eval("document.querySelector('.session-workspace').classList.contains('is-split') && document.querySelector('#terminal-panel .floating-input-box').getBoundingClientRect().width>0"));
    checks.push('actual right toolbar opens its workspace file and returns to split after preview');
    await click(c, '#terminal-panel .floating-input-box'); await c.send('Input.insertText', { text: '左屏独立消息 A' });
    await click(c, '.split-secondary .floating-input-box'); await c.send('Input.insertText', { text: '右屏独立消息 B' });
    assert.equal(await c.eval("document.querySelector('#terminal-panel .floating-input-box').innerText"), '左屏独立消息 A');
    await click(c, '.split-secondary .floating-input-send');
    await click(c, '#terminal-panel .floating-input-send');
    for (const [kind, selector, expected] of [['codex', '#terminal-panel', '左屏独立消息 A'], ['claude', '.split-secondary', '右屏独立消息 B']]) {
      await until(kind + ' completed', () => c.eval(`sessions.get(${JSON.stringify(ids[kind])})?.nativeRuntime?.state==='completed'`));
      await until(kind + ' authoritative user card', () => c.eval(`Array.from(document.querySelectorAll('${selector} .turn-card.user:not([data-optimistic="true"])')).some(e=>e.textContent.includes(${JSON.stringify(expected)}))`));
      const transcript = await c.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${JSON.stringify(ids[kind])}})`);
      assert(JSON.stringify(transcript).includes(expected));
      assert(!JSON.stringify(transcript).includes(kind === 'codex' ? '右屏独立消息 B' : '左屏独立消息 A'));
    }
    await until('secondary answer while primary focused', () => c.eval("!!document.querySelector('.split-secondary .turn-card.assistant')"));
    checks.push('both native providers send through actual composer; authoritative history and responses stay in owning pane');
    await click(c, '.split-secondary .turn-card.assistant .card-actions-more');
    await click(c, '.split-secondary .card-actions-menu[open] [data-action="multi-select"]');
    assert.equal(await c.eval("document.querySelector('.split-secondary .msg-overlay').classList.contains('multi-select-active')"), true);
    assert.equal(await c.eval("document.querySelector('#msg-overlay').classList.contains('multi-select-active')"), false);
    await click(c, '.split-secondary [data-multi="exit"]');
    checks.push('right message multi-select and exit operate only on the right cards');
    await click(c, '#terminal-panel .floating-input-box'); await c.send('Input.insertText', { text: '左屏未发送草稿' });
    await click(c, '.split-secondary .floating-input-box'); await c.send('Input.insertText', { text: '右屏未发送草稿' });
    await click(c, `.session-item[data-session-id="${ids.codex}"]`);
    await until('existing session focused', () => c.eval(`sessionSplit.focusedId()===${JSON.stringify(ids.codex)}`));
    assert.equal(await c.eval('sessionSplit.focusedId()'), ids.codex);
    assert.equal(await c.eval('document.querySelectorAll(".floating-input-bar").length'), 2);
    checks.push('selecting already visible session focuses it without duplicate composer');
    await shot('two-panes');
    const nativeId = await c.eval(`sessions.get(${JSON.stringify(ids.claude)}).ccSessionId`);
    await click(c, '.split-secondary .floating-input-box'); await click(c, '[data-session-layout="single"]');
    await until('right moves to single', () => c.eval(`activeSessionId===${JSON.stringify(ids.claude)} && !document.querySelector('.session-workspace').classList.contains('is-split')`));
    await until('draft survives', () => c.eval("document.querySelector('#terminal-panel .floating-input-box')?.innerText==='右屏未发送草稿'"));
    assert.equal(await c.eval(`sessions.get(${JSON.stringify(ids.claude)}).ccSessionId`), nativeId);
    checks.push('single-screen retains focused session, draft and native identity');
    await click(c, '[data-session-layout="two"]'); await click(c, `.session-item[data-session-id="${ids.codex}"]`);
    await until('Codex right draft restored', () => c.eval("document.querySelector('.split-secondary .floating-input-box')?.innerText==='左屏未发送草稿'"));
    const before = await c.eval("document.querySelector('.session-pane-left').getBoundingClientRect().width");
    await click(c, '.session-pane-divider'); await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await until('keyboard divider', () => c.eval(`document.querySelector('.session-pane-left').getBoundingClientRect().width>${before}`));
    checks.push('switching sides restores each draft; divider supports keyboard resizing');
    await click(c, '.split-secondary .floating-input-box'); await c.send('Input.insertText', { text: '\nfixture:scroll' });
    await click(c, '.split-secondary .floating-input-send');
    await until('right stream visible', () => c.eval("document.querySelector('.split-secondary .msg-overlay').innerText.includes('正在持续输出验证信息')"));
    await click(c, '#terminal-panel .floating-input-box');
    await until('right stream grows while left focused', () => c.eval("document.querySelector('.split-secondary .msg-overlay').innerText.includes('第 10 步')"));
    const scrollRect = await c.eval("(()=>{const r=document.querySelector('.split-secondary .msg-overlay').getBoundingClientRect();return{x:r.x+100,y:r.y+100}})()");
    const beforeWheel = await c.eval('sessionSplit.secondary().overlay.scrollTop');
    const beforeScroll = await c.eval('(()=>{const e=sessionSplit.secondary().overlay;return {top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,follow:e._cardFollowController.capture(),visible:e.getBoundingClientRect().toJSON()}})()');
    fs.writeFileSync(path.join(out, 'before-scroll.json'), JSON.stringify(beforeScroll, null, 2));
    console.log('scroll before', JSON.stringify(beforeScroll));
    // The gesture command acknowledges completion, unlike dispatchMouseEvent.
    // A pending layout scrollend can fire before a dispatched wheel is applied.
    await c.send('Input.synthesizeScrollGesture', { ...scrollRect, yDistance: 500, speed: 1000, gestureSourceType: 'mouse' });
    await until('right following paused', () => c.eval("!sessionSplit.secondary().overlay._cardFollowController.isFollowing()"));
    const anchor = await c.eval('sessionSplit.secondary().overlay._cardFollowController.capture()');
    assert.notEqual(await c.eval(`sessions.get(${JSON.stringify(ids.codex)}).nativeRuntime.state`), 'completed', 'reading must be tested while output is still running');
    await until('stream final', () => c.eval("document.querySelector('.split-secondary .msg-overlay').innerText.includes('滚动验收结束')"));
    const finalAnchor = await c.eval('sessionSplit.secondary().overlay._cardFollowController.capture()');
    fs.writeFileSync(path.join(out, 'scroll-evidence.json'), JSON.stringify({ beforeWheel, anchor, finalAnchor }, null, 2));
    assert.equal(finalAnchor.anchorId, anchor.anchorId);
    assert(Math.abs(finalAnchor.anchorOffset - anchor.anchorOffset) < 3, `reading anchor moved: ${JSON.stringify({anchor,finalAnchor})}`);
    checks.push('right native stream grows while left focused; scrolling up remains stable through final response');
    await click(c, '.split-secondary .floating-input-box'); await c.send('Input.insertText', { text: 'fixture:approval' });
    await click(c, '.split-secondary .floating-input-send');
    await until('right approval', () => c.eval("!!document.querySelector('.split-secondary .codex-native-controls button')"));
    const rejectIndex = await c.eval("Array.from(document.querySelectorAll('.split-secondary .codex-native-controls button')).findIndex(b=>b.textContent.includes('拒绝'))");
    assert(rejectIndex >= 0);
    const rejectRect = await c.eval(`(()=>{const r=document.querySelectorAll('.split-secondary .codex-native-controls button')[${rejectIndex}].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rejectRect, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rejectRect, button: 'left', clickCount: 1 });
    await until('right approval completes', () => c.eval(`sessions.get(${JSON.stringify(ids.codex)}).nativeRuntime.state==='completed'`));
    checks.push('right native approval controls complete the exact session request');
    await click(c, '.split-secondary .floating-input-box'); await c.send('Input.insertText', { text: 'fixture:hold' });
    await click(c, '.split-secondary .floating-input-send');
    await until('right native turn running', () => c.eval(`sessions.get(${JSON.stringify(ids.codex)}).nativeRuntime.state==='running' && !document.querySelector('.split-secondary .floating-input-stop').hidden`));
    await click(c, '.split-secondary .floating-input-stop');
    await until('right native turn interrupted', () => c.eval(`sessions.get(${JSON.stringify(ids.codex)}).nativeRuntime.state==='interrupted'`));
    assert.equal(await c.eval(`sessions.get(${JSON.stringify(ids.claude)}).nativeRuntime.state`), 'completed');
    checks.push('right stop interrupts only the right native turn');
    await click(c, '.split-secondary .floating-input-box'); await c.send('Input.insertText', { text: '右屏休眠恢复草稿' });
    const codexNative = await c.eval(`sessions.get(${JSON.stringify(ids.codex)}).codexSid`);
    await until('toolbar targets right', () => c.eval(`document.querySelector('#toolbar-crumb').dataset.signature==='session:'+${JSON.stringify(ids.codex)}`));
    await click(c, '.btn-close-session');
    await until('right sleeps', () => c.eval(`sessions.get(${JSON.stringify(ids.codex)}).status==='dormant' && !sessionSplit.secondary()`));
    assert.equal(await c.eval('activeSessionId'), ids.claude);
    await click(c, '.session-pane-right');
    await click(c, `.session-item[data-session-id="${ids.codex}"]`);
    await until('right resumes draft', () => c.eval("document.querySelector('.split-secondary .floating-input-box')?.innerText==='右屏休眠恢复草稿'"));
    assert.equal(await c.eval('activeSessionId'), ids.claude);
    assert.equal(await c.eval(`sessions.get(${JSON.stringify(ids.codex)}).codexSid`), codexNative);
    checks.push('closing right preserves left; dormant right resumes native identity and saved draft without stealing primary');
    await shot('restored-panes');
    await click(c, '#btn-backstage');
    await until('right backstage only', () => c.eval("sessionSplit.secondary().mode()==='pty' && currentView==='card' && document.querySelector('.split-secondary .msg-overlay').classList.contains('hidden')"));
    await click(c, '#btn-backstage');
    await until('right card mode restored', () => c.eval("sessionSplit.secondary().mode()==='card'"));
    checks.push('global backstage button changes only the focused right view');
    await click(c, '#btn-home');
    await until('home hides split', () => c.eval("!document.querySelector('.session-workspace').classList.contains('is-split') && document.querySelector('#session-layout-buttons').hidden"));
    await click(c, `.session-item[data-session-id="${ids.claude}"]`);
    await until('return from home', () => c.eval(`activeSessionId===${JSON.stringify(ids.claude)} && document.querySelector('.session-workspace').classList.contains('is-split') && !!document.querySelector('.split-secondary .floating-input-box')`));
    assert.equal(await c.eval("document.querySelector('.split-secondary .floating-input-box').innerText"), '右屏休眠恢复草稿');
    checks.push('home navigation restores split and secondary draft');
    await click(c, '#terminal-panel .floating-input-box');
    await until('toolbar targets primary', () => c.eval(`document.querySelector('#toolbar-crumb').dataset.signature==='session:'+${JSON.stringify(ids.claude)}`));
    await click(c, '.btn-close-session');
    await until('closing primary promotes right', () => c.eval(`activeSessionId===${JSON.stringify(ids.codex)} && !document.querySelector('.session-workspace').classList.contains('is-split') && document.querySelector('#terminal-panel .floating-input-box')?.innerText==='右屏休眠恢复草稿'`));
    assert.equal(await c.eval(`sessions.get(${JSON.stringify(ids.codex)}).codexSid`), codexNative);
    checks.push('closing primary promotes the other session to single view with its draft and identity');
    await click(c, '[data-session-layout="two"]');
    await click(c, `.session-item[data-session-id="${ids.claude}"]`);
    await until('two before restart', () => c.eval(`sessionSplit.secondary()?.sessionId===${JSON.stringify(ids.claude)}`));
    await c.close(); c = null;
    await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, 'before-restart.log'), hub.log().join('\n'));
    hub = await launchIsolatedHub({ dataDir, port: await port(), label: 'session-split-restart', extraEnv: env, windowMode: 'hidden' });
    c = await connectFirstPage(hub);
    await until('restarted renderer ready', () => c.eval(`typeof sessionSplit!=="undefined" && !!sessionSplit && sessions.has(${JSON.stringify(ids.codex)})`));
    assert.equal(await c.eval("document.querySelector('.session-workspace').classList.contains('is-split')"), false);
    assert.equal(await c.eval('sessionSplit.secondary()'), null);
    await click(c, `.session-item[data-session-id="${ids.codex}"]`);
    await until('restored single session', () => c.eval(`activeSessionId===${JSON.stringify(ids.codex)} && !!document.querySelector('#terminal-panel .floating-input-box')`));
    assert.equal(await c.eval("document.querySelector('.session-workspace').classList.contains('is-split')"), false);
    assert.equal(await c.eval('document.querySelectorAll(".floating-input-bar").length'), 1);
    checks.push('restart after two-pane use defaults to single and resumes a session without opening another pane');
    await shot('restart-single');
    passed = true;
  } finally {
    if (c) { if (!passed) {
      await shot('failure').catch(error => console.error('Screenshot failed', error.message));
      const diagnostic = await c.eval('(()=>{const e=sessionSplit.secondary()?.overlay;return e?{top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,follow:e._cardFollowController.capture()}:null})()');
      fs.writeFileSync(path.join(out, 'failure-scroll.json'), JSON.stringify(diagnostic, null, 2));
    } await c.close(); }
    if (hub) { if (hub.isAlive()) await gracefulQuit(hub); fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); }
    const head = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, checks, ids, root, head, controlledProtocol: true, realModel: false }, null, 2));
    console.log(JSON.stringify({ out, passed, checks }));
  }
}
main().catch(error => { console.error(error.stack); if (error.logTail) console.error(error.logTail); process.exitCode = 1; });
