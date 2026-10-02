'use strict';
// Real Hub/CDP mouse + keyboard flows. Default provider replies are controlled
// fixtures; --live additionally clicks through the real official Flash API.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort } = require('./helpers/usage-refresh-fixture');
const ROOT = path.resolve(__dirname, '..'), j = JSON.stringify;
const live = process.argv.includes('--live');
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-prompt-polish-'));
  const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
  const out = path.join(ROOT, 'artifacts', '20261001-prompt-polish-codex1', String(Date.now())); fs.mkdirSync(out, { recursive: true });
  const evidence = { scope: 'Real isolated Hub mouse/keyboard flows; CLI sessions use native fixtures', live, checks: [], errors: [] };
  const extraEnv = {
    AI_HUB_WORKSPACE_ROOT: temp, DASHSCOPE_API_KEY: '',
    CODEX_HOME: path.join(temp, 'codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
    CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(ROOT, 'tests/fixtures/claude-stream.js'),
    CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(ROOT, 'tests/fixtures/codex-app-server.js'),
  };
  fs.mkdirSync(extraEnv.CODEX_HOME, { recursive: true });
  fs.mkdirSync(extraEnv.CLAUDE_CONFIG_DIR, { recursive: true });
  if (live) extraEnv.DEEPSEEK_API_KEY = require('../core/hub-config').getConfig().deepseekApiKey;
  let hub, c;
  async function until(label, test) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { if (await test()) return; await _waitMs(60); }
    throw Error('Timeout: ' + label);
  }
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port: await getFreePort(), windowMode: 'background', extraEnv, allowExternalState: live });
    c = await connectFirstPage(hub);
    await until('renderer', () => c.eval('!!window.WorkspaceController'));
    const invoke = (channel, args) => c.eval(`ipcRenderer.invoke(${j(channel)},${j(args)})`);
    const session = await invoke('create-session', { kind: 'claude', opts: { cwd: workspace, title: 'Prompt 整理测试', mcpProfile: 'none' } });
    const codex = await invoke('create-session', { kind: 'codex', opts: { cwd: workspace, title: 'Codex Prompt 整理', mcpProfile: 'none' } });
    const group = await invoke('create-meeting', { title: 'Prompt 整理群聊', groupChat: true, scene: 'general', workspace, slots: [{ kind: 'claude', mcpProfile: 'none' }, { kind: 'codex', mcpProfile: 'none' }] });
    const group2 = await invoke('create-meeting', { title: '独立草稿', groupChat: true, scene: 'general', workspace, slots: [{ kind: 'claude', mcpProfile: 'none' }] });
    async function click(selector) {
      const p = await c.eval(`(() => { const e=document.querySelector(${j(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2; if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('Blocked '+${j(selector)});return {x,y};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    }
    async function fill(selector, text) {
      await click(selector);
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await c.send('Input.insertText', { text });
    }
    const text = '嗯，帮我看看 AI Hub 是否需要这个按钮，对，先讨论必要性，等我确认以后再实现。';
    const edited = '帮我看看 AI Hub 是否需要这个按钮。先讨论必要性，等我确认以后再实现。';
    await c.eval(`window._polishOriginalInvoke=ipcRenderer.invoke; window._polishCalls=[];window._polishSends=[];window._polishMode='success';ipcRenderer.invoke=function(channel,...args){if(channel==='session:send-prompt'||channel==='meeting-append-user-turn')window._polishSends.push(channel);if(channel==='prompt:polish'){window._polishCalls.push(args[0]);return new Promise(resolve=>setTimeout(()=>resolve(window._polishMode==='error'?{ok:false,message:'整理超时，原稿已保留'}:{ok:true,text:${j(edited)}}),window._polishMode==='slow'?600:30));}if(channel==='prompt:polish-cancel')return Promise.resolve({ok:true});return window._polishOriginalInvoke.call(this,channel,...args);};`);
    for (const isGroup of [false, true]) {
      await c.eval(isGroup ? `selectMeeting(${j(group.id)})` : `selectSession(${j(session.id)})`);
      const host = isGroup ? '#mr-input-row' : '#terminal-panel .floating-input-bar';
      const input = isGroup ? '#mr-input-box' : `${host} .floating-input-box`;
      const button = `${host} .prompt-polish-button`, undo = `${host} .prompt-polish-undo`;
      await until('input', () => c.eval(`!!document.querySelector(${j(button)}) && document.querySelector(${j(input)}).getClientRects().length>0`));
      for (const size of [[1440, 1000], [1000, 700]]) {
        await c.send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
        await fill(input, text); await click(button);
        await until('rewrite', () => c.eval(`document.querySelector(${j(input)}).innerText===${j(edited)}`));
        if (isGroup && size[0] === 1440) {
          const image = await c.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(out, '20261001-prompt-polish-group-codex1.png'), Buffer.from(image.data, 'base64'));
        }
        await click(undo); assert.equal(await c.eval(`document.querySelector(${j(input)}).innerText`), text);
        evidence.checks.push({ isGroup, size, check: 'click, rewrite, undo' });
      }
      await c.eval(`window._polishMode='slow'`); await fill(input, text); await click(button);
      await c.send('Input.insertText', { text: ' 保留我的新要求。' });
      await _waitMs(750); assert.equal(await c.eval(`document.querySelector(${j(input)}).innerText`), text + ' 保留我的新要求。');
      evidence.checks.push({ isGroup, check: 'typing during rewrite preserves edits' });
      await fill(input, text); await click(button); await click(button); await _waitMs(750);
      assert.equal(await c.eval(`document.querySelector(${j(input)}).innerText`), text);
      evidence.checks.push({ isGroup, check: 'cancel ignores late result' });
      await c.eval(`window._polishMode='error'`); await click(button); await _waitMs(180);
      assert.equal(await c.eval(`document.querySelector(${j(input)}).innerText`), text);
      evidence.checks.push({ isGroup, check: 'failure preserves draft' });
      await c.eval(`window._polishMode='slow'`); await click(button);
      await c.eval(`selectMeeting(${j(group2.id)})`);
      await fill('#mr-input-box', '另一个群的草稿'); await _waitMs(750);
      assert.equal(await c.eval(`document.querySelector('#mr-input-box').innerText`), '另一个群的草稿');
      evidence.checks.push({ isGroup, check: 'switch preserves other room draft' });
      await c.eval(`window._polishMode='success'`);
    }
    await c.eval(`selectSession(${j(codex.id)})`);
    await fill('#terminal-panel .floating-input-box', text);
    await click('#terminal-panel .prompt-polish-button');
    await until('Codex rewrite', () => c.eval(`document.querySelector('#terminal-panel .floating-input-box').innerText===${j(edited)}`));
    // Undo cannot silently overwrite subsequent manual edits.
    await c.send('Input.insertText', { text: ' 保留我的修改。' });
    await until('hide stale undo', () => c.eval(`document.querySelector('#terminal-panel .prompt-polish-undo').hidden`));
    evidence.checks.push({ check: 'Codex composer + undo protects subsequent edits' });
    assert.deepEqual(await c.eval('window._polishSends'), [], 'draft editing must not submit an Agent turn');
    evidence.checks.push({ check: 'no automatic Agent submission' });
    // The button must edit the expanded paste content, not an internal chip ID.
    await c.eval(`selectSession(${j(session.id)})`);
    const host = '#terminal-panel .floating-input-bar', input = `${host} .floating-input-box`;
    const pasted = Array.from({ length: 12 }, (_, i) => '引用材料 ' + i).join('\n');
    await c.eval(`(() => {const p=require('./composer-paste-chips'),el=document.querySelector(${j(input)});p.renderComposerValue(el,p.MARK_START+p.registerPaste(${j(pasted)})+p.MARK_END,{document});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click(`${host} .prompt-polish-button`); await _waitMs(180);
    assert.equal(await c.eval('window._polishCalls.at(-1).text'), pasted);
    evidence.checks.push({ check: 'expanded paste chip input' });
    await click(`${host} .prompt-polish-undo`);
    assert.equal(await c.eval(`require('./composer-paste-chips').expandPasteMarkers(document.querySelector(${j(input)}).innerText)`), pasted);
    evidence.checks.push({ check: 'paste chip undo restores complete source' });
    await c.eval(`window._polishMode='slow'`); await fill(input, text); await click(`${host} .prompt-polish-button`);
    await click(input);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until('manual send', () => c.eval(`window._polishSends.length>0 && document.querySelector(${j(input)}).innerText===''`));
    await _waitMs(750);
    assert.equal(await c.eval(`document.querySelector(${j(input)}).innerText`), '');
    evidence.checks.push({ check: 'manual send during rewrite ignores late result; Agent uses fixture' });
    if (live) {
      await c.eval(`ipcRenderer.invoke=window._polishOriginalInvoke`);
      await fill(input, text); const start = Date.now(); await click(`${host} .prompt-polish-button`);
      await until('live Flash rewrite', () => c.eval(`document.querySelector(${j(host + ' .prompt-polish-button')}).getAttribute('aria-busy')==='false'`));
      const result = await c.eval(`document.querySelector(${j(input)}).innerText`);
      assert.notEqual(result, text); assert(result.includes('确认')); assert(result.includes('实现'));
      evidence.liveResult = { elapsedMs: Date.now() - start, input: text, output: result, model: 'deepseek-flash' };
      const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261001-prompt-polish-live-codex1.png'), Buffer.from(image.data, 'base64'));
      await click(`${host} .prompt-polish-undo`); assert.equal(await c.eval(`document.querySelector(${j(input)}).innerText`), text);
      evidence.checks.push({ check: 'real Flash API + actual click + undo' });
    }
    fs.writeFileSync(path.join(out, '20261001-prompt-polish-evidence-codex1.json'), JSON.stringify(evidence, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, out, checks: evidence.checks.length, liveResult: evidence.liveResult }));
  } catch (error) {
    evidence.errors.push(error.message); fs.writeFileSync(path.join(out, '20261001-prompt-polish-evidence-codex1.json'), JSON.stringify(evidence, null, 2), 'utf8'); throw error;
  } finally { if (c) await c.close(); if (hub) await gracefulQuit(hub); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
