'use strict';
// Real isolated Hub; provider responses come from the native protocol fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-preview-return-'));
const workspace = path.join(temp, 'workspace');
const output = path.join(root, 'output', 'playwright', 'preview-return-path-menu');
fs.mkdirSync(workspace); fs.mkdirSync(output, { recursive: true });
const reportPath = path.join(workspace, '报告 with spaces.md');
fs.writeFileSync(reportPath, '# 预览返回验收\n\n正文。\n', 'utf8');
fs.writeFileSync(path.join(workspace, 'card-delivery.html'), '<!doctype html><meta charset="utf-8"><p>交付文件</p>', 'utf8');
async function reservePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
async function main() {
  let hub, client;
  const results = [];
  let passed = false;
  const ev = code => client.eval(code);
  async function wait(code) {
    const end = Date.now() + 25000;
    while (Date.now() < end) { if (await ev(code)) return; await _waitMs(100); }
    throw new Error('Timeout: ' + code);
  }
  async function click(selector, button = 'left') {
    await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    const p = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getClientRects()[0];const x=r.left+Math.min(r.width/2,80),y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);if(hit!==e&&!e.contains(hit))throw Error('click covered '+${JSON.stringify(selector)}+' at '+x+','+y+' by '+hit?.outerHTML.slice(0,180));return {x,y}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, ...p, button, clickCount: 1 });
  }
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port: await reservePort(), windowMode: 'hidden', label: 'preview-return', extraEnv: {
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(root, 'tests/fixtures/codex-app-server.js'),
    } });
    client = await connectFirstPage(hub);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1450, height: 800, deviceScaleFactor: 1, mobile: false });
    await wait('!!window.MeetingRoom');
    const invoke = (channel, payload) => ev(`ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
    const model = { kind: 'codex', model: 'gpt-6-astra', effort: 'high', mcpProfile: 'none' };
    const ordinary = await invoke('create-session', { kind: 'codex', opts: { ...model, cwd: workspace } });
    const group = await invoke('create-meeting', { title: '预览返回验收', scene: 'general', workspace, slots: [model] });
    await wait(`${JSON.stringify(group.subSessions)}.every(id=>!!sessions.get(id)?.nativeRuntime?.threadId)`);
    for (const mode of ['ordinary', 'group']) {
      const isGroup = mode === 'group';
      const container = isGroup ? '.mr-gc-messages' : '#msg-overlay';
      const input = isGroup ? '#mr-input-box' : '.floating-input-box';
      const send = isGroup ? '#mr-send-btn' : '.floating-input-send';
      await click(isGroup ? `[data-meeting-id="${group.id}"]` : `[data-session-id="${ordinary.id}"]`);
      await wait(`document.querySelector(${JSON.stringify(input)})?.getBoundingClientRect().height>0`);
      for (let i = 0; i < 2; i++) {
        await click(input);
        await client.send('Input.insertText', { text: `fixture:card-details 验收 ${i}\n[本地报告](<${reportPath}>)\n[文件URL](${pathToFileURL(reportPath).href})\n[相对报告](<./报告 with spaces.md>)\nhttps://example.com/docs\n` + '用于形成足够长的会话内容。\n'.repeat(35) });
        await click(send);
        await wait(`document.querySelectorAll(${JSON.stringify(container + ' .turn-delivery-summary')}).length>=${i + 1}`);
      }
      const state = () => ev(`(()=>{const e=document.querySelector(${JSON.stringify(container)});return {gap:e.scrollHeight-e.clientHeight-e.scrollTop,following:e._cardFollowController.isFollowing()}})()`);
      for (const layout of ['full', 'split']) {
        const point = await ev(`(()=>{const r=document.querySelector(${JSON.stringify(container)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -10000 });
        await wait(`(()=>{const e=document.querySelector(${JSON.stringify(container)});return e.scrollHeight-e.clientHeight-e.scrollTop>50 && !e._cardFollowController.isFollowing()})()`);
        await ev(`window.openPathInHub(${JSON.stringify(reportPath)},{cwd:${JSON.stringify(workspace)}})`);
        await wait(`document.querySelector('#preview-body').textContent.includes('预览返回验收')`);
        if (layout === 'split') await click('#preview-layout-split');
        await click('#preview-close');
        await wait(`(()=>{const e=document.querySelector(${JSON.stringify(container)});return e.scrollHeight-e.clientHeight-e.scrollTop<8 && e._cardFollowController.isFollowing()})()`);
        results.push({ mode, layout, ...await state() });
      }
      const readingPoint = await ev(`(()=>{const r=document.querySelector(${JSON.stringify(container)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
      await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...readingPoint, deltaX: 0, deltaY: -10000 });
      await wait(`!document.querySelector(${JSON.stringify(container)})._cardFollowController.isFollowing()`);
      for (const label of [reportPath, pathToFileURL(reportPath).href, './card-delivery.html']) {
        const selector = await ev(`(()=>{const a=[...document.querySelectorAll(${JSON.stringify(container + ' a')})].find(a=>a.textContent===${JSON.stringify(label)} && a.getBoundingClientRect().height>0 && !a.closest('details:not([open])' ));if(!a)throw Error('missing link: '+${JSON.stringify(label)});a.id='preview-menu-target';return '#preview-menu-target'})()`);
        await click(selector, 'right');
        await wait(`document.querySelector('#path-link-context-menu').style.display==='block'`);
        await click('#path-link-context-menu [data-action="open-file-manager"]');
        await wait(`window.FileManagerPanel?.isOpen()===true`);
        const fm = await ev(`({root:document.querySelector('#file-manager-root-path').textContent})`);
        assert.equal(path.resolve(fm.root), workspace);
        assert.equal(await ev(`document.querySelector('#preview-panel').style.display`), 'none');
        results.push({ mode, label, root: fm.root });
        if (label === './card-delivery.html') {
          const shot = await client.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(output, mode + '-file-manager.png'), Buffer.from(shot.data, 'base64'));
        }
        await ev(`document.querySelector('#preview-menu-target').removeAttribute('id');window.FileManagerPanel.close()`);
      }
    }
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, 'verified.png'), Buffer.from(shot.data, 'base64'));
    passed = true;
    console.log(JSON.stringify({ passed, results }, null, 2));
  } catch (error) {
    if (client) {
      console.log(await ev(`(()=>{const e=document.querySelector('#preview-menu-target');return e?{html:e.outerHTML,parent:e.parentElement.outerHTML.slice(0,2000),scroll:document.querySelector('#msg-overlay')._cardFollowController.capture()}:null})()`));
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(output, 'failure.png'), Buffer.from(shot.data, 'base64'));
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed, results }, null, 2));
    if (client) client.close();
    if (hub) await gracefulQuit(hub);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
