'use strict';
// Real renderer interactions with isolated, deterministic native providers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { connectFirstPage } = require('./helpers/cdp-client');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fixed-layout-'));
const OUT = path.resolve(process.env.HUB_LAYOUT_OUT || 'artifacts/session-ui-bounds/fixed-layout');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
async function until(label, fn) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (await fn()) return;
    await _waitMs(100);
  }
  throw new Error('Timed out: ' + label);
}
async function click(client, selector) {
  const point = await client.eval(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)});
    if(!e)throw new Error('missing click target');
    e.scrollIntoView({block:'nearest'});
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    if(!r.height || !e.contains(document.elementFromPoint(x,y)))throw new Error('occluded click target');
    return {x,y};
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  }
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const workspace = path.join(TEMP, 'project');
  fs.mkdirSync(workspace);
  let hub, client;
  const result = { passed: false, checks: [] };
  const model = { kind: 'codex', model: 'gpt-6-astra', effort: 'high', mcpProfile: 'none' };
  const invoke = (channel, arg) => client.eval(`ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(arg)})`);
  const frames = () => client.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const probe = (group = false) => client.eval(`(() => {
    const group=${group};
    const input=document.querySelector(group?'#mr-input-box':'.floating-input-box');
    const nav=document.querySelector(group?'#mr-question-nav':'#card-question-nav');
    const bar=document.querySelector(group?'.mr-group-composer':'.floating-input-bar');
    const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}};
    const s=getComputedStyle(input);
    return {bar:rect(bar),nav:rect(nav),input:rect(input),client:input.clientHeight,
      scroll:input.scrollHeight,line:parseFloat(s.lineHeight),padding:parseFloat(s.paddingTop)+parseFloat(s.paddingBottom),text:input.innerText};
  })()`);
  async function draftCheck(label, group = false) {
    const selector = group ? '#mr-input-box' : '.floating-input-box';
    await frames();
    const before = await probe(group);
    assert.equal(Math.round(before.bar.height), 212, label + ' composer height');
    assert(Math.abs(before.client - before.padding - 2 * before.line) < 2, label + ' two text lines');
    await click(client, selector);
    await client.send('Input.insertText', { text: Array.from({ length: 12 }, (_, i) => `draft line ${i}`).join('\n') });
    await until(label + ' draft rendered', async () => (await probe(group)).text.includes('draft line 11'));
    await frames();
    const after = await probe(group);
    assert.deepEqual(after.bar, before.bar, label + ' stable composer');
    assert.deepEqual(after.nav, before.nav, label + ' stable directory');
    assert.deepEqual(after.input, before.input, label + ' stable input');
    assert(after.scroll > after.client, label + ' internal draft scrolling');
    result.checks.push({ label, before, after });
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, `${label}.png`), Buffer.from(shot.data, 'base64'));
  }
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(TEMP, 'data'), port: await freePort(), windowMode: 'hidden',
      extraEnv: { AI_HUB_WORKSPACE_ROOT: TEMP, CODEX_HOME: path.join(TEMP, 'codex'), CLAUDE_CONFIG_DIR: path.join(TEMP, 'claude'),
        CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(ROOT, 'tests/fixtures/claude-stream.js'),
        CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(ROOT, 'tests/fixtures/codex-app-server.js') } });
    client = await connectFirstPage(hub);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('renderer', () => client.eval('!!window.LaunchCenter'));
    for (const kind of ['codex', 'claude']) {
      const session = await invoke('create-session', { kind, opts: { cwd: workspace, model: kind === 'claude' ? 'claude-opus-5[1m]' : model.model, effort: 'high', mcpProfile: 'none' } });
      await until(kind + ' input', () => client.eval(`document.querySelector('.floating-input-bar')?.dataset.sessionId===${JSON.stringify(session.id)}`));
      await click(client, '.floating-input-box');
      await client.send('Input.insertText', { text: 'fixture:card-details' });
      await click(client, '.floating-input-send');
      await until(kind + ' answer', () => client.eval(`activeSessionId===${JSON.stringify(session.id)} && !!document.querySelector('#msg-overlay .turn-card.assistant') && !document.getElementById('card-question-nav').hidden`));
      await draftCheck(kind);
    }
    const group = await invoke('create-meeting', { title: 'Fixed layout group', scene: 'general', workspace, slots: [model] });
    await until('group ready', () => client.eval(`${JSON.stringify(group.subSessions)}.every(id=>!!sessions.get(id)?.nativeRuntime?.threadId)`));
    await click(client, `[data-meeting-id="${group.id}"]`);
    await until('group input', () => client.eval('!!document.querySelector(".mr-group-composer")'));
    await click(client, '#mr-input-box');
    await client.send('Input.insertText', { text: 'fixture:card-details' });
    await click(client, '#mr-send-btn');
    await until('group reply', async () => {
      const state = await invoke('groupchat:get-state', { meetingId: group.id });
      return state?.currentMode === 'idle' && state.messages?.some(m => m.role === 'assistant');
    });
    await until('group directory', () => client.eval('!!document.querySelector("#mr-question-nav .card-question-nav-item")'));
    await draftCheck('group', true);
    await click(client, `#session-list [data-sub-id="${group.subSessions[0]}"]`);
    await until('member composer', () => client.eval(`activeSessionId===${JSON.stringify(group.subSessions[0])} && !!document.querySelector('.floating-input-box')`));
    await draftCheck('member');
    result.passed = true;
  } finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
