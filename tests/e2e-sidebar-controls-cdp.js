'use strict';
// Real isolated Hub UI, persisted records and native protocol fixture.
// No renderer session-state injection and no paid model run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
delete process.env.ELECTRON_RUN_AS_NODE;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sidebar-controls-'));
const data = path.join(root, 'data');
const out = path.resolve(__dirname, '../artifacts/sidebar-controls');
const runId = `${Date.now()}-${process.pid}`;
fs.mkdirSync(data); fs.mkdirSync(out, { recursive: true });
for (const name of ['claude-projects', 'codex-sessions', 'kimi-sessions', 'gemini-sessions']) fs.mkdirSync(path.join(root, name));
const now = Date.now(), day = 86400000, nativeId = randomUUID(), groupNativeId = randomUUID();
const nativeStore = path.join(root, 'native-store.json');
fs.writeFileSync(nativeStore, JSON.stringify([nativeId, groupNativeId].map(id => [id, { id, cwd: root, path: null, status: { type: 'idle' }, turns: [], model: 'gpt-6-astra', reasoningEffort: 'high' }])));
const record = (hubId, age, extra = {}) => ({ hubId, kind: 'codex', title: hubId, cwd: root,
  status: 'dormant', lastMessageTime: now - age, lastCompletedAt: now - age, createdAt: now - age,
  currentModel: { id: 'gpt-6-astra', displayName: 'Astra High' }, effort: 'high', ...extra });
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true,
  sessions: [record('pin-codex', 7 * 60000, { pinned: true }), record('sleep-3h', 3 * 3600000),
    record('sleep-2d', 2 * day, { kind: 'claude' }), record('sleep-6d', 6 * day, { kind: 'deepseek' }),
    record('history-nine-days', 9 * day, { codexSid: nativeId, title: 'HistoryUniqueNineDays' }),
    record('group-codex', 3 * 3600000, { meetingId: 'mixed' }),
    record('group-claude', 3 * 3600000, { kind: 'claude', meetingId: 'mixed' }),
    record('history-group-child', 9 * day, { meetingId: 'history-group', codexSid: groupNativeId })],
  meetings: [{ id: 'mixed', title: 'MixedGroup', groupChat: true, status: 'dormant', subSessions: ['group-codex', 'group-claude'], participants: [0, 1], createdAt: now - 3 * 3600000, lastMessageTime: now - 3 * 3600000 },
    { id: 'history-group', title: 'HistoryGroupUnique', groupChat: true, status: 'dormant', subSessions: ['history-group-child'], participants: [0], createdAt: now - 9 * day, lastMessageTime: now - 9 * day }], immersiveByMeeting: {} }));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
let hub, cdp;
const windowMode = process.env.HUB_SIDEBAR_TEST_HIDDEN === '1' ? 'hidden' : 'visible';
const result = { runId, root, windowMode, candidateSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim(), checks: [], screenshots: [], errors: [] };
async function until(expression, timeout = 20000) {
  const start = Date.now();
  while (!await cdp.eval(`(async()=>Boolean(await (${expression})))()`)) {
    if (Date.now() - start > timeout) throw new Error('timeout: ' + expression);
    await _waitMs(100);
  }
}
async function click(selector) {
  console.log('click', selector);
  await until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e && !(e.closest('.session-search-dialog')?.getAnimations() || []).some(a=>a.playState==='running')})()`);
  const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw new Error('hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, ...(type === 'mouseMoved' ? {} : { button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) });
}
async function key(key, code = key, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key, code, modifiers });
}
async function select(selector, index) {
  // Real keyboard navigation on a focused native select; each change follows
  // the production listener, including list rebuilds and restored focus.
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await key('Home');
  for (let i = 0; i < index; i++) await key('ArrowDown');
}
async function shot(label) {
  for (const height of [901, 900]) { await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height, deviceScaleFactor: 1, mobile: false }); await _waitMs(150); }
  const file = path.join(out, `${runId}-${label}.png`);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); result.screenshots.push(file);
}
async function start() {
  hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode, label: 'sidebar-controls', extraEnv: {
    CLAUDE_HUB_E2E: '1',
    CODEX_HOME: path.join(root, 'codex-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'),
    CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
    CLAUDE_HUB_NATIVE_FIXTURE_STORE: nativeStore,
    HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'claude-projects'),
    HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'codex-sessions'),
    HUB_SESSION_SEARCH_KIMI_ROOTS: path.join(root, 'kimi-sessions'),
    HUB_SESSION_SEARCH_GEMINI_ROOTS: path.join(root, 'gemini-sessions'),
  } });
  result.pid = hub.pid;
  cdp = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url));
  cdp.ws.on('message', bytes => {
    const e = JSON.parse(String(bytes));
    if (e.method === 'Runtime.exceptionThrown') result.errors.push(e.params.exceptionDetails);
    if (e.method === 'Page.javascriptDialogOpening') {
      result.errors.push({ dialog: e.params.message });
      cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(error => result.errors.push({ dialogClose: error.message }));
    }
  });
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(`document.querySelector('.sec-dormant-range')`);
}
const row = id => `#session-list [data-session-id="${id}"]`;
async function main() {
  try {
    await start();
    await until(`document.querySelector(${JSON.stringify(row('pin-codex'))})`);
    assert.equal(await cdp.eval(`document.querySelector(${JSON.stringify(row('pin-codex') + ' .sl-time')}).textContent`), '7分钟前');
    assert.equal(await cdp.eval(`document.querySelector(${JSON.stringify(row('sleep-3h') + ' .sl-time')}).textContent`), '3小时前');
    assert.equal(await cdp.eval(`document.querySelectorAll('#session-list .sec-collapse').length`), 4);
    await select('.sec-dormant-range', 1);
    await until(`document.querySelector(${JSON.stringify(row('sleep-2d'))})`);
    assert.equal(await cdp.eval(`!!document.querySelector(${JSON.stringify(row('sleep-6d'))})`), false);
    await select('.sec-dormant-range', 2);
    await until(`document.querySelector(${JSON.stringify(row('sleep-6d'))})`);
    assert.equal(await cdp.eval(`!!document.querySelector(${JSON.stringify(row('history-nine-days'))})`), false);
    result.checks.push('real keyboard selects 24h/3d/7d; rows reflect persisted ages; minute/hour/day labels');
    await click('.sec-dormant .sec-collapse');
    assert.equal(await cdp.eval(`!!document.querySelector(${JSON.stringify(row('sleep-3h'))})`), false);
    await click('.sec-dormant .sec-collapse');
    await click('#btn-session-details');
    await select('#session-model-filter', 1);
    await until(`document.querySelector(${JSON.stringify(row('group-claude'))})`);
    assert.equal(await cdp.eval(`!!document.querySelector(${JSON.stringify(row('group-codex'))})`), false);
    await select('#session-model-filter', 3);
    await until(`document.querySelector(${JSON.stringify(row('sleep-6d'))})`);
    assert.equal(await cdp.eval(`!!document.querySelector('#session-list [data-meeting-id="mixed"]')`), false);
    await select('#session-model-filter', 0);
    for (const width of [280, 340, 440]) {
      await cdp.eval(`document.querySelector('.session-sidebar').style.width='${width}px';document.querySelector('.session-sidebar').style.flex='0 0 ${width}px'`);
      const fits = await cdp.eval(`(()=>{const sidebar=document.querySelector('.session-sidebar').getBoundingClientRect();return [...document.querySelectorAll('#session-list .sec-collapse,#session-list .sec-dormant-range,#session-model-filter,#btn-session-details')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=sidebar.left&&r.right<=sidebar.right})})()`);
      assert.equal(fits, true, `controls overflow sidebar at ${width}`);
    }
    await cdp.eval(`document.querySelector('.session-sidebar').style.width='280px';document.querySelector('.session-sidebar').style.flex='0 0 280px'`);
    await shot('controls');
    result.checks.push('physical collapse/expand and model filtering; mixed group contains matching members only');
    // Group navigation is checked before native card interaction; the known
    // baseline native-card -> search crash has a separate reproduction artifact.
    await click('#btn-global-search');
    await click('#search-query');
    await until(`document.activeElement === document.getElementById('search-query')`);
    await cdp.eval(`document.getElementById('search-query').select()`);
    await cdp.send('Input.insertText', { text: 'HistoryGroupUnique' });
    assert.equal(await cdp.eval(`document.getElementById('search-query').value`), 'HistoryGroupUnique');
    await until(`document.querySelector('[data-search-action="open"]')?.textContent === '打开群聊'`);
    await _waitMs(800);
    assert.equal(await cdp.eval(`meetings['history-group'].lastMessageTime`), now - 9 * day);
    await click('[data-search-action="open"]');
    await until(`activeMeetingId === 'history-group' && meetings['history-group'].lastMessageTime > ${now}`);
    assert.equal(await cdp.eval(`document.querySelector('#session-list [data-meeting-id="history-group"] .sl-time').textContent`), '刚刚');
    result.checks.push('physical Open Group updates activity; group preview leaves previous time intact; 280/340/440px controls fit');
    // Test search entry scenarios independently; retain the separate baseline
    // reproduction of repeated search after entering a card/meeting view.
    await _waitMs(800);
    await cdp.close(); cdp = null; await gracefulQuit(hub); hub = null;
    await start();
    assert.ok(await cdp.eval(`meetings['history-group'].lastMessageTime`) > now);
    // Preview must not bump old metadata; actual continue must restore via native IPC.
    await select('#session-model-filter', 1);
    await click('.sec-today .sec-collapse');
    await click('#btn-global-search');
    await click('#search-query');
    await until(`document.activeElement === document.getElementById('search-query')`);
    await cdp.eval(`document.getElementById('search-query').select()`);
    await cdp.send('Input.insertText', { text: 'HistoryUniqueNineDays' });
    assert.equal(await cdp.eval(`document.getElementById('search-query').value`), 'HistoryUniqueNineDays');
    await until(`document.querySelector('[data-search-action="open"]')`);
    await _waitMs(800);
    await until(`document.querySelector('.session-search-preview-heading h3')?.textContent === 'HistoryUniqueNineDays'`);
    assert.equal(await cdp.eval(`sessions.get('history-nine-days').lastMessageTime`), now - 9 * day);
    await click('[data-search-action="open"]');
    await until(`sessions.get('history-nine-days')?.nativeRuntime?.state === 'idle'`);
    await until(`document.querySelector(${JSON.stringify(row('history-nine-days'))}) && sessions.get('history-nine-days').lastMessageTime > ${now}`);
    assert.equal(await cdp.eval(`document.querySelector('#session-model-filter').value`), 'all');
    assert.equal(await cdp.eval(`document.querySelector(${JSON.stringify(row('history-nine-days') + ' .sl-time')}).textContent`), '刚刚');
    const openedAt = await cdp.eval(`sessions.get('history-nine-days').lastMessageTime`);
    await until(`(async()=>{const r=await ipcRenderer.invoke('get-dormant-sessions');return r.sessions.find(s=>s.hubId==='history-nine-days')?.lastMessageTime >= ${openedAt}})()`);
    result.checks.push('search preview leaves time unchanged; physical Continue resumes existing native ID, clears conflicting filter, expands section and persists open time');
    await _waitMs(100);
    result.receipt = await cdp.eval(`ipcRenderer.invoke('session:send-prompt', {sessionId:'history-nine-days',text:'fixture:usage'})`);
    assert.equal(result.receipt?.ok, true, JSON.stringify(result.receipt));
    await until(`sessions.get('history-nine-days').lastCompletedAt > ${openedAt}`);
    result.checks.push('real prompt submission pipeline plus native protocol fixture advances activity after opening');
    // Save preferences across a full process restart, not just a renderer redraw.
    await click('.sec-pinned .sec-collapse');
    await select('.sec-dormant-range', 2);
    await select('#session-model-filter', 2);
    await _waitMs(800);
    await shot('history-opened');
    await cdp.close(); cdp = null; await gracefulQuit(hub); hub = null;
    await start();
    assert.equal(await cdp.eval(`document.querySelector('.sec-dormant-range').value`), '7');
    assert.equal(await cdp.eval(`document.querySelector('#session-model-filter').value`), 'codex');
    assert.equal(await cdp.eval(`document.querySelector('.sec-pinned .sec-collapse').getAttribute('aria-expanded')`), 'false');
    await until(`document.querySelector(${JSON.stringify(row('history-nine-days'))})`);
    assert.ok(await cdp.eval(`sessions.get('history-nine-days').lastMessageTime`) >= openedAt);
    result.checks.push('full restart retains collapse/range and history-open activity; session remains in sidebar');
    await shot('restarted');
    assert.deepEqual(result.errors, []);
    result.ok = true;
  } catch (error) {
    result.error = error.stack;
    if (hub) result.hubLog = hub.log();
    if (cdp) result.sessionAtFailure = await cdp.eval(`sessions.get('history-nine-days')`).catch(() => null);
    if (cdp) { try { await shot('failure'); } catch (captureError) { result.captureError = captureError.message; } }
    throw error;
  } finally {
    try {
      if (cdp) await cdp.close();
      if (hub) await gracefulQuit(hub);
    } catch (error) { result.ok = false; result.teardownError = error.stack; throw error; }
    finally {
      const file = path.join(out, `${runId}-evidence.json`);
      fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8'); console.log(file);
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
