'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort } = require('./helpers/usage-refresh-fixture');
const j = JSON.stringify, ROOT = path.resolve(__dirname, '..');
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-notice-'));
  const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
  const out = path.join(ROOT, 'artifacts/search-notice', String(Date.now())); fs.mkdirSync(out, { recursive: true });
  const result = { out, checks: [], scope: 'Real isolated Hub, CDP input and protocol fixture replies' };
  let hub, c;
  async function until(label, fn, budget = 30000) {
    const end = Date.now() + budget;
    while (Date.now() < end) { if (await fn()) return; await _waitMs(100); }
    throw Error('Timeout: ' + label);
  }
  const invoke = (name, payload) => c.eval(`ipcRenderer.invoke(${j(name)},${j(payload)})`);
  async function click(selector) {
    const p = await c.eval(`(() => { const e=document.querySelector(${j(selector)}); if(!e)throw Error('Missing '+${j(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); if(!r.width||!r.height)throw Error('Hidden '+${j(selector)}); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  }
  async function key(key, code, modifiers = 0) {
    const vk = key === 'Escape' ? 27 : key === 'Enter' ? 13 : key.toUpperCase().charCodeAt(0);
    for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode: vk });
  }
  async function search(text) {
    await key('f', 'KeyF', 2);
    await until('search focused', () => c.eval('document.activeElement?.id==="terminal-search-input"'));
    await key('a', 'KeyA', 2); await c.send('Input.insertText', { text });
    await until('search count', () => c.eval('!!document.querySelector("#terminal-search-count").textContent'));
  }
  const count = () => c.eval('document.querySelector("#terminal-search-count").textContent');
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port: await getFreePort(), windowMode: 'hidden', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: temp,
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(ROOT, 'tests/fixtures/claude-stream.js'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(ROOT, 'tests/fixtures/codex-app-server.js'),
    } });
    c = await connectFirstPage(hub); await c.send('Page.bringToFront');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('renderer', () => c.eval('!!window.WorkspaceController'));
    const s = await invoke('create-session', { kind: 'claude', opts: { cwd: workspace, title: 'Search Claude', mcpProfile: 'none' } });
    await until('session row', () => c.eval(`!!document.querySelector('[data-session-id="${s.id}"]')`));
    await click(`[data-session-id="${s.id}"]`);
    assert.equal((await invoke('session:send-prompt', { sessionId: s.id, text: 'fixture:search' })).ok, true);
    await until('answer', () => c.eval('document.querySelector("#msg-overlay")?.textContent.includes("融合最后一处")'));
    await c.eval(`window.searchKeys=[]; document.querySelector('#terminal-search-input').addEventListener('keydown', e=>searchKeys.push({key:e.key,keyCode:e.keyCode,composing:e.isComposing,count:document.querySelector('#terminal-search-count').textContent}));`);
    await search('融合'); assert.equal(await count(), '1 / 3');
    assert.equal(await c.eval(`(() => {const b=document.querySelector('#terminal-search-next'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`), true, 'search controls above question directory');
    assert.equal(await c.eval('CSS.highlights.get("session-find-all").size'), 3);
    await key('Enter', 'Enter'); result.keyTrace = await c.eval('searchKeys'); assert.equal(await count(), '2 / 3');
    assert.equal(await c.eval('[...CSS.highlights.get("session-find-current")][0].toString()'), '融合');
    await key('Enter', 'Enter'); assert.equal(await count(), '3 / 3');
    const bounds = await c.eval(`(() => { const r=[...CSS.highlights.get('session-find-current')][0].getBoundingClientRect();const b=document.querySelector('#msg-overlay').getBoundingClientRect();return {top:r.top,bottom:r.bottom,min:b.top,max:b.bottom}; })()`);
    assert.ok(bounds.top >= bounds.min && bounds.bottom <= bounds.max, j(bounds));
    await shot('claude-search-last');
    await key('Enter', 'Enter', 8); assert.equal(await count(), '2 / 3');
    await search('ABSENT'); assert.equal(await count(), '0 / 0');
    await key('Escape', 'Escape');
    assert.equal(await c.eval('CSS.highlights.has("session-find-all")'), false);
    result.checks.push('Claude Ctrl+F: Chinese, inline Markdown, exact count, next/previous, last match scroll, missing text, Escape cleanup');

    const group = await invoke('create-meeting', { title: 'Search group', groupChat: true, scene: 'general', workspace, slots: [{ kind: 'claude', mcpProfile: 'none' }] });
    await until('group row', () => c.eval(`!!document.querySelector('[data-meeting-id="${group.id}"]')`));
    await click(`[data-meeting-id="${group.id}"]`);
    const turn = await invoke('groupchat:turn', { meetingId: group.id, userInput: 'fixture:search', turnTimeoutMs: 20000 });
    assert.equal(turn.status, 'completed');
    await until('group answer', () => c.eval('document.querySelector(".mr-gc-messages")?.textContent.includes("融合最后一处")'));
    await search('融合'); assert.equal(await count(), '1 / 3');
    await key('Enter', 'Enter'); await key('Enter', 'Enter');
    assert.equal(await c.eval(`(() => {const r=[...CSS.highlights.get('session-find-current')][0].getBoundingClientRect(),b=document.querySelector('.mr-gc-messages').getBoundingClientRect();return r.height>0&&r.top>=b.top&&r.bottom<=b.bottom;})()`), true, 'group last match visible');
    await shot('group-search-last');
    await key('Escape', 'Escape');
    result.checks.push('Group transcript uses its own search root');

    const other = await invoke('create-session', { kind: 'codex', opts: { cwd: workspace, title: 'Search Codex', mcpProfile: 'none' } });
    await until('Codex row', () => c.eval(`!!document.querySelector('[data-session-id="${other.id}"]')`));
    await click(`[data-session-id="${other.id}"]`);
    await invoke('session:send-prompt', { sessionId: other.id, text: 'fixture:normal' });
    await until('Codex reply', () => c.eval('document.querySelector("#msg-overlay")?.textContent.includes("原生回答")'));
    await search('原生回答'); assert.equal(await count(), '1 / 1'); await key('Escape', 'Escape');
    await click('[data-session-layout="two"]');
    await click(`[data-session-id="${s.id}"]`);
    await until('secondary', () => c.eval(`sessionSplit.secondary()?.sessionId===${j(s.id)} && !!document.querySelector('.split-secondary .turn-card.assistant')`));
    await click('.split-secondary .floating-input-box');
    await search('融合'); assert.equal(await count(), '1 / 3');
    assert.equal(await c.eval(`document.querySelector('.split-secondary').contains([...CSS.highlights.get('session-find-current')][0].startContainer)`), true);
    await shot('split-search'); await key('Escape', 'Escape');
    await click('[data-session-layout="single"]');
    result.checks.push('Codex and focused secondary Claude search their own visible transcript');

    await click(`[data-session-id="${s.id}"]`);
    await until('composer', () => c.eval('!!document.querySelector("#terminal-panel .floating-input-box")'));
    await click('#terminal-panel .floating-input-box');
    await c.send('Input.insertText', { text: 'fixture:unconfirmed' });
    await click('#terminal-panel .floating-input-send');
    await until('unknown submission', () => c.eval(`sessions.get(${j(s.id)}).nativeRuntime.state==='unknown'`), 75000);
    result.unknown = await c.eval(`({runtime:sessions.get(${j(s.id)}).nativeRuntime,controls:document.querySelector('.claude-native-controls')?.outerHTML})`);
    const shown = await c.eval('!!document.querySelector(".claude-native-controls:not([hidden]) .native-dismissible-notice:not([hidden])")');
    assert.equal(shown, false, 'existing quiet recovery suppresses duplicate timeout notice');
    result.checks.push('Real unconfirmed submission keeps unknown state and existing quiet recovery; no duplicate banner');

    // Component interaction matrix, deliberately separate from protocol E2E.
    // Mount the real controls with explicit error/request snapshots, never
    // overwrite a live session or manufacture a completion IPC.
    for (const backend of ['claude-stream-json', 'codex-app-server', 'acp']) {
      await c.eval(`(() => {
        const host=document.createElement('div');host.id='notice-component-test';host.style.cssText='position:fixed;inset:120px 180px auto 360px;z-index:9999;background:#20242c;padding:20px';document.body.append(host);
        const backend=${j(backend)};
        const request=backend==='claude-stream-json'?{id:'ask',epoch:1,submissionId:'test',method:'claude/requestUserInput',params:{questions:[{question:'保留这个问题'}]}}:{id:'ask',method:'item/tool/requestUserInput',params:{questions:[{id:'q',question:'保留这个问题'}]}};
        const session={id:'notice-component',kind:backend==='claude-stream-json'?'claude':'codex',runtimeBackend:backend,nativeActionError:'Claude 未确认本条输入，提交状态待核对',nativeRuntime:{epoch:1,turnId:'notice-turn',state:'waiting',connection:'connected',requests:[request]}};
        let calls=0;
        const make=()=>{const control=backend==='claude-stream-json'?require('./claude-native-controls').createClaudeNativeControls({sessionId:session.id,ipcRenderer:{invoke:()=>{calls++;throw Error('ignore must not invoke')}}}):require('./codex-native-controls').createCodexNativeControls({sessionId:session.id,document,invoke:()=>{calls++;throw Error('ignore must not invoke')}});control.element.style.position='static';return control;};
        const controls=make();host.append(controls.element);controls.update(session);
        window.noticeProbe={host,session,controls,make,calls:()=>calls,before:JSON.stringify(session)};
      })()`);
      await shot(backend + '-notice');
      await click('#notice-component-test .native-notice-dismiss');
      assert.equal(await c.eval('JSON.stringify(noticeProbe.session)===noticeProbe.before && noticeProbe.calls()===0'), true);
      assert.equal(await c.eval('!!document.querySelector("#notice-component-test form") && !noticeProbe.controls.element.hidden'), true, 'request preserved');
      await c.eval('noticeProbe.controls.update(noticeProbe.session)');
      assert.equal(await c.eval('!!document.querySelector("#notice-component-test .native-dismissible-notice:not([hidden])")'), false);
      await c.eval('noticeProbe.controls.element.remove();noticeProbe.controls=noticeProbe.make();noticeProbe.host.append(noticeProbe.controls.element);noticeProbe.controls.update(noticeProbe.session)');
      assert.equal(await c.eval('!!document.querySelector("#notice-component-test .native-dismissible-notice:not([hidden])")'), false, 'remount respects ignore');
      await c.eval('noticeProbe.session.nativeRuntime.epoch++;noticeProbe.controls.update(noticeProbe.session)');
      assert.equal(await c.eval('!!document.querySelector("#notice-component-test .native-dismissible-notice:not([hidden])")'), true, 'new epoch error visible');
      await c.eval('noticeProbe.host.remove()');
      result.checks.push(backend + ': component ignore preserves requests/runtime, stays dismissed on update/remount, shows new error epoch');
    }
    result.passed = true;
  } finally {
    if (c) { if (!result.passed) { try { result.debug = await c.eval('({focus:document.activeElement?.id,count:document.querySelector("#terminal-search-count")?.textContent,search:document.querySelector("#terminal-search-input")?.value})'); await shot('failure'); } catch (e) { result.screenshotError = e.message; } } await c.close(); }
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(j(result));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
