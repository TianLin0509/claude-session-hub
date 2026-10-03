'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = path.resolve(__dirname, '..');
const output = path.join(ROOT, 'artifacts', 'preview-immersive');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-immersive-'));
const md = path.join(temp, '沉浸阅读.md');
const html = path.join(temp, '沉浸网页.html');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(md, '# 沉浸式预览\n\n' + Array.from({ length: 180 }, (_, i) => `第 ${i + 1} 段：整屏阅读，退出后继续会话。\n`).join('\n'));
fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#edf4f6;font:24px sans-serif;padding:60px}input{font-size:24px}</style><h1>沉浸式 HTML 预览</h1><input id="draft" placeholder="页面状态保持"><div style="height:3000px">按 Esc 回到 Hub 预览</div>');
let hub, client;
const checks = [];
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) { if (await client.eval(expression)) return; await _waitMs(100); }
  throw new Error('UI condition timed out: ' + expression);
}
async function click(id) {
  const point = await client.eval(`(() => {const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function enter() {
  await click('preview-layout-immersive');
  await waitFor(`document.body.classList.contains('preview-immersive-active')`);
  const geometry = await client.eval(`(() => {const r=document.getElementById('preview-panel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,header:getComputedStyle(document.querySelector('.preview-header')).display,tabs:getComputedStyle(document.querySelector('.preview-tabs-row')).display}})()`);
  assert.equal(geometry.x, 0);
  assert.equal(geometry.y, 0);
  assert.ok(Math.abs(geometry.width - geometry.vw) < 1 && Math.abs(geometry.height - geometry.vh) < 1, JSON.stringify(geometry));
  assert.equal(geometry.header, 'none');
  assert.equal(geometry.tabs, 'none');
}
async function escape() {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(`!document.body.classList.contains('preview-immersive-active')`);
}
async function capture(name) {
  const image = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(image.data, 'base64'));
}
async function main() {
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port: Number(process.env.HUB_IMMERSIVE_PORT || 19941), label: 'immersive-preview', extraEnv: { CLAUDE_HUB_E2E: '1' } });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url));
    await client.send('Page.enable');
    await waitFor('!!window.openPreviewPanel');
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79 });
    await waitFor(`document.activeElement?.id === 'preview-quick-open-input'`);
    await client.send('Input.insertText', { text: md });
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(`document.getElementById('preview-panel').style.display === 'flex' && document.getElementById('preview-quick-open').style.display === 'none'`);
    await click('preview-layout-split');
    await client.eval(`document.getElementById('preview-body').scrollTop=600`);
    const scroll = await client.eval(`document.getElementById('preview-body').scrollTop`);
    await capture('normal');
    await enter();
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 400 });
    await _waitMs(180);
    assert.equal(await client.eval(`getComputedStyle(document.getElementById('preview-immersive-exit')).opacity`), '0');
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20 });
    await waitFor(`getComputedStyle(document.getElementById('preview-immersive-exit')).opacity === '1'`);
    await capture('markdown-hover-exit');
    await click('preview-immersive-exit');
    await waitFor(`!document.body.classList.contains('preview-immersive-active')`);
    assert.equal(await client.eval(`document.getElementById('preview-layout-split').getAttribute('aria-pressed')`), 'true');
    assert.equal(await client.eval(`document.getElementById('preview-body').scrollTop`), scroll);
    checks.push('Markdown covers viewport; hidden toolbar; hover exit; restore split and scroll');
    await click('preview-layout-full');
    await enter();
    await escape();
    assert.equal(await client.eval(`document.getElementById('preview-layout-full').getAttribute('aria-pressed')`), 'true');
    assert.equal(await client.eval(`document.getElementById('preview-panel').style.display`), 'flex');
    checks.push('Esc restores workspace full preview without closing document');
    await client.eval(`window.openPreviewPanel(${JSON.stringify(html)})`);
    await waitFor(`!!document.querySelector('#preview-body webview')?.getWebContentsId()`);
    await _waitMs(300);
    await client.eval(`document.querySelector('#preview-body webview').executeJavaScript("document.getElementById('draft').value='保留输入';window.scrollTo(0,300);true")`);
    const guestId = await client.eval(`document.querySelector('#preview-body webview').getWebContentsId()`);
    await enter();
    await capture('html-immersive');
    // Focus and press Escape inside the actual guest, not the host document.
    await client.eval(`document.querySelector('#preview-body webview').focus();document.querySelector('#preview-body webview').executeJavaScript("document.getElementById('draft').focus();true")`);
    await escape();
    assert.equal(await client.eval(`document.querySelector('#preview-body webview').getWebContentsId()`), guestId);
    assert.equal(await client.eval(`document.querySelector('#preview-body webview').executeJavaScript("document.getElementById('draft').value")`), '保留输入');
    checks.push('HTML guest focused Esc exits; guest process and form input survive');
    await enter();
    await client.eval(`document.getElementById('preview-close').click()`);
    await waitFor(`!document.body.classList.contains('preview-immersive-active') && document.getElementById('preview-panel').style.display==='none'`);
    checks.push('Closing preview exits immersive');
    await client.eval(`window.openPreviewPanel(${JSON.stringify(md)})`);
    await enter();
    await client.eval(`document.getElementById('btn-home').click()`);
    await waitFor(`!document.body.classList.contains('preview-immersive-active')`);
    checks.push('Navigating away exits immersive');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, nativeFullscreen: 'Background Hub protects desktop by suppressing setFullScreen; native transition tested separately.' }, null, 2));
    console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
  } catch (error) {
    if (hub) fs.writeFileSync(path.join(output, 'hub-failure.log'), hub.log().join('\n'));
    throw error;
  } finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
