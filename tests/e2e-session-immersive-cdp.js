'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, click, key, waitFor } = require('./helpers/usage-refresh-fixture');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-immersive-'));
const output = path.resolve('artifacts/session-immersive');
fs.mkdirSync(output, { recursive: true });
const checks = [];
let hub, c;
const wait = condition => waitFor(c, condition);
const active = `document.body.classList.contains('session-immersive-active')`;
async function shot(name) {
  const result = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
}
async function enter(selector = '#terminal-panel') {
  await click(c, '#btn-session-immersive');
  await wait(active);
  const b = await c.eval(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight}})()`);
  assert.equal(b.x, 0); assert.equal(b.y, 0);
  assert.ok(Math.abs(b.w - b.vw) < 1 && Math.abs(b.h - b.vh) < 1, JSON.stringify(b));
}
async function prompt(text) {
  await click(c, '#terminal-panel .floating-input-box');
  await c.send('Input.insertText', { text });
  await click(c, '#terminal-panel .floating-input-send');
}
(async () => {
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await getFreePort(), label: 'session-immersive', extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve('tests/fixtures/codex-app-server.js'),
      CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.resolve('tests/fixtures/claude-stream.js'), CLAUDE_HUB_CLAUDE_FIXTURE_MODE: 'normal',
    } });
    c = await connectFirstPage(hub);
    await wait('!!window.LaunchCenter');
    assert.equal(await c.eval(`document.getElementById('btn-session-immersive').hidden`), false);
    const session = await c.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${JSON.stringify(root)},model:'gpt-6-astra',effort:'low',mcpProfile:'none'}})`);
    await wait(`activeSessionId===${JSON.stringify(session.id)} && !!document.querySelector('#terminal-panel .floating-input-box') && !document.getElementById('btn-session-immersive').hidden`);
    for (const width of [1500, 1000, 760]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 0, mobile: false });
      await new Promise(resolve => setTimeout(resolve, 150));
      const geometry = await c.eval(`(() => {const a=document.getElementById('btn-backstage').getBoundingClientRect(),b=document.getElementById('btn-session-immersive').getBoundingClientRect(),w=document.getElementById('toolbar-window-controls').getBoundingClientRect();return {a:a.right,b:b.left,right:b.right,controls:w.left,controlsRight:w.right,vw:innerWidth}})()`);
      assert.ok(geometry.a <= geometry.b && geometry.right <= geometry.controls && geometry.controlsRight <= geometry.vw + 1, JSON.stringify(geometry));
    }
    checks.push('1500/1000/760px: immersive button immediately right of backstage');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 0, mobile: false });
    await prompt('fixture:card-details 会话沉浸验收');
    await wait(`document.querySelectorAll('#terminal-panel .turn-card').length >= 2`);
    await c.eval(`document.querySelector('#terminal-panel .floating-input-box').textContent='未发送草稿😀'`);
    await shot('cards-normal');
    const identity = await c.eval(`(window.__immersiveCard=document.querySelector('#terminal-panel .turn-card'),{view:currentView})`);
    await enter();
    assert.equal(await c.eval('currentView'), 'card');
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20 });
    await wait(`getComputedStyle(document.querySelector('.session-immersive-exit')).opacity==='1'`);
    await shot('cards-immersive');
    await click(c, '.session-immersive-exit');
    await wait(`!${active}`);
    assert.equal(await c.eval(`document.querySelector('#terminal-panel .floating-input-box').textContent`), '未发送草稿😀');
    assert.equal(await c.eval('currentView'), identity.view);
    assert.equal(await c.eval(`document.querySelector('#terminal-panel .turn-card')===window.__immersiveCard`), true);
    checks.push('Card immersion: full viewport, hover exit, view and unsent draft retained');
    const previewFile = path.join(root, 'immersive-note.md');
    fs.writeFileSync(previewFile, '# 沉浸中的文件预览\n\n文件链接仍然可用。');
    await enter();
    await c.eval(`openPreviewPanel(${JSON.stringify(previewFile)})`);
    await wait(`!${active} && document.getElementById('preview-panel').style.display==='flex'`);
    await click(c, '#preview-close');
    checks.push('Opening a file preview exits session immersion; preview remains reachable');
    await click(c, '#btn-backstage');
    await wait(`currentView==='pty'`);
    assert.equal(await c.eval(`document.querySelectorAll('.pty-output-heading').length`), 0);
    assert.equal(await c.eval(`document.querySelectorAll('#terminal-panel > .terminal-metrics').length`), 0);
    await shot('backstage-normal');
    await enter();
    await shot('backstage-immersive');
    await key(c, 'Escape', 'Escape', 27);
    await wait(`!${active}`);
    assert.equal(await c.eval('currentView'), 'pty');
    checks.push('Backstage immersion: Esc exits, original mode retained; duplicate heading and metrics removed');
    await click(c, '#btn-backstage');
    const second = await c.eval(`ipcRenderer.invoke('create-session',{kind:'claude',opts:{cwd:${JSON.stringify(root)},mcpProfile:'none'}})`);
    await wait(`!!document.querySelector('.session-item[data-session-id="${second.id}"]')`);
    await click(c, `.session-item[data-session-id="${session.id}"]`);
    await wait(`activeSessionId===${JSON.stringify(session.id)}`);
    await click(c, '[data-session-layout="two"]');
    await click(c, `.session-item[data-session-id="${second.id}"]`);
    await wait(`sessionSplit.secondary()?.sessionId===${JSON.stringify(second.id)} && sessionSplit.isSecondaryFocused()`);
    await enter('.split-secondary');
    await key(c, 'Escape', 'Escape', 27);
    await wait(`!${active}`);
    assert.equal(await c.eval(`sessionSplit.secondary().sessionId`), second.id);
    assert.equal(await c.eval(`document.querySelector('.session-workspace').classList.contains('is-split')`), true);
    checks.push('Focused secondary session immerses; split layout and session restored');
    await enter('.split-secondary');
    await c.eval(`document.getElementById('btn-home').click()`);
    await wait(`!${active}`);
    checks.push('Navigation exits immersion automatically');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, boundary: 'Real isolated Hub + protocol fixtures; native fullscreen is suppressed by desktop protection.' }, null, 2));
    console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
  } catch (error) {
    if (c) { await shot('failure'); console.error(await c.eval(`({primary:activeSessionId,secondary:sessionSplit.secondary()?.sessionId,focused:sessionSplit.isSecondaryFocused(),split:document.querySelector('.session-workspace').className})`)); }
    throw error;
  } finally {
    if (c) await c.close();
    if (hub) await gracefulQuit(hub);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
