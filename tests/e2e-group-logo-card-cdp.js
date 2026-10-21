'use strict';
// Real isolated Hub navigation; model replies come from the native test fixture.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const json = JSON.stringify;
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-group-logo-'));
  const workspace = path.join(root, 'workspace');
  const out = path.resolve('artifacts/20261021-group-logo-codex1/gui-' + Date.now());
  for (const dir of [workspace, out]) fs.mkdirSync(dir, { recursive: true });
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  let hub, c;
  const evidence = { root, out, checks: [], passed: false };
  const wait = async (expr, label) => { const deadline = Date.now() + 30000; while (Date.now() < deadline) {
    if (await c.eval(expr)) return; await _waitMs(100);
  } throw new Error('Timeout: ' + label); };
  const invoke = (channel, value) => c.eval(`ipcRenderer.invoke(${json(channel)},${json(value)})`);
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${json(selector)});if(!e)throw new Error('Missing '+${json(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`);
    assert(p.w > 0 && p.h > 0, selector);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', {
      type, x: p.x, y: p.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
    await _waitMs(550);
  };
  const shot = async name => {
    for (const height of [901, 900]) { await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height, deviceScaleFactor: 1, mobile: false }); await _waitMs(100); }
    const result = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(result.data, 'base64'));
  };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, label: 'group-logo-card', extraEnv: {
      CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), AI_HUB_WORKSPACE_ROOT: root,
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_STORE: path.join(root, 'store.json'),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait('typeof sessions!=="undefined" && typeof ipcRenderer!=="undefined"', 'renderer');
    const model = { kind: 'codex', model: 'gpt-6-astra', effort: 'high', mcpProfile: 'none' };
    const standalone = await invoke('create-session', { kind: 'codex', opts: { ...model, cwd: workspace, title: '对照会话' } });
    const group = await invoke('create-meeting', { title: 'Logo 跳转验证', workspace, slots: [model, model] });
    const [a, b] = group.subSessions;
    const row = `[data-meeting-id="${group.id}"]`;
    const logo = id => row + ` .sl-group-logos [data-sub-id="${id}"]`;
    await wait(`${json(group.subSessions)}.every(id=>sessions.get(id)?.nativeRuntime?.threadId)`, 'native members');
    await wait(`document.querySelector(${json(row)})`, 'group row');
    assert.equal(await c.eval(`document.querySelectorAll(${json(row + ' .sl-group-logos [data-sub-id]')}).length`), 2);
    await click(`[data-session-id="${standalone.id}"]`);
    const turn = await invoke('groupchat:turn', { meetingId: group.id, userInput: 'fixture:normal', turnTimeoutMs: 20000 });
    assert.equal(turn.status, 'completed');
    await wait(`meetingUnread.getMeetingUnreadMemberIds(meetings[${json(group.id)}],sessions).size===2`, 'both unread');
    await shot('01-two-logo-shortcuts');
    await click(logo(a));
    await wait(`activeSessionId===${json(a)} && !activeMeetingId && currentView==='card' && !MeetingRoom.getActiveMeetingId()`, 'first logo opens member card');
    assert.deepEqual(await c.eval(`[...meetingUnread.getMeetingUnreadMemberIds(meetings[${json(group.id)}],sessions)]`), [b]);
    assert.notEqual(await c.eval(`getComputedStyle(document.querySelector('#msg-overlay')).display`), 'none');
    evidence.checks.push('Physical first-logo click opens that member card, closes group navigation, and clears only its unread');
    await click('#btn-backstage');
    await wait(`currentView==='pty'`, 'explicit backstage');
    await click(logo(a));
    await wait(`activeSessionId===${json(a)} && currentView==='card'`, 'logo returns from backstage to card');
    await click(logo(b));
    await wait(`activeSessionId===${json(b)} && currentView==='card' && !activeMeetingId`, 'second logo opens its member');
    await shot('02-second-member-card');
    evidence.checks.push('Both overlapping logos map to their own member; repeated logo click returns from backstage to card');
    for (const [id, key, code] of [[a, 'Enter', 'Enter'], [b, ' ', 'Space']]) {
      await c.eval(`document.querySelector(${json(logo(id))}).focus()`);
      const title = 'Logo 重绘验证 ' + code;
      await invoke('update-meeting-sync', { meetingId: group.id, fields: { title } });
      await wait(`document.querySelector(${json(row + ' .sl-title')})?.textContent===${json(title)} && document.activeElement?.dataset.sidebarControl===${json('group-logo-' + id)}`, 'logo focus survives redraw');
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
      await wait(`activeSessionId===${json(id)} && currentView==='card'`, 'keyboard member shortcut');
      // Finish the existing selection autofocus before focusing the next logo.
      await _waitMs(100);
    }
    evidence.checks.push('Logo focus survives a real group-title redraw; Enter and Space open the corresponding member card');
    await click(`[data-session-id="${standalone.id}"]`);
    for (const id of [a, b]) assert.equal((await invoke('suspend-session', { sessionId: id })).ok, true);
    await wait(`${json([a, b])}.every(id=>sessions.get(id)?.status==='dormant')`, 'dormant members');
    await click(logo(a));
    await wait(`activeSessionId===${json(a)} && sessions.get(${json(a)})?.status!=='dormant' && !sessions.get(${json(a)})?._resumePending && currentView==='card'`, 'logo wakes selected member');
    assert.equal(await c.eval(`sessions.get(${json(b)}).status`), 'dormant');
    evidence.checks.push('Dormant logo wakes only its own member and opens cards');
    await click(row + ' .sl-title');
    await wait(`activeMeetingId===${json(group.id)} && !activeSessionId`, 'title still opens group');
    evidence.checks.push('Group-title click retains group navigation');
    evidence.passed = true;
  } finally {
    if (c) { if (!evidence.passed) { try { await shot('failure'); evidence.debug = await c.eval(`({activeSessionId,activeMeetingId,currentView,focused:document.activeElement?.outerHTML?.slice(0,500)})`); } catch {} } await c.close(); }
    if (hub) { if (!evidence.passed) evidence.hubLog = hub.log().slice(-30); await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
