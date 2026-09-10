'use strict';
// Real isolated Hub + real Codex PTYs. Only the external company bridge response
// is controlled; its insertion/ack controller and the file-manager IPC are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-group-composer-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), CODEX = path.join(ROOT, 'codex');
const ART = path.resolve(__dirname, '../output/playwright', `group-composer-${Date.now()}`);
const baseline = process.argv.includes('--baseline');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(e => e ? reject(e) : resolve(port)); });
});

async function run() {
  let hub, cdp;
  const evidence = { checks: [], root: ROOT, artifacts: ART, baseline,
    boundaries: 'Real Hub/UI/IPC/Codex model switching; controlled company bridge response; no model prompt submitted.' };
  const ok = (label, condition) => { assert(condition, label); evidence.checks.push(label); console.log('PASS ' + label); };
  for (const dir of [DATA, WORK, CODEX, ART]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  const sourceHome = process.env.HUB_COMPOSER_CODEX_SOURCE || path.join(os.homedir(), '.codex');
  try {
    for (const name of ['auth.json', 'models_cache.json']) fs.copyFileSync(path.join(sourceHome, name), path.join(CODEX, name));
    hub = await launchIsolatedHub({ dataDir: DATA, port: await freePort(), windowMode: 'hidden',
      ...(process.env.HUB_COMPOSER_ENTRY ? { entryPath: process.env.HUB_COMPOSER_ENTRY } : {}),
      extraEnv: { AI_HUB_WORKSPACE_ROOT: WORK, CODEX_HOME: CODEX, CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude') } });
    evidence.pid = hub.pid; evidence.port = hub.port;
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    const wait = async (fn, label, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const v = await fn(); if (v) return v;
        if (label.includes('confirmation')) {
          const error = await cdp.eval("document.querySelector('.model-picker-menu [data-state=error]')?.textContent");
          if (typeof error === 'string' && error) throw new Error(error);
        }
        await sleep(150);
      }
      throw new Error('Timeout: ' + label);
    };
    const invoke = (channel, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
    const click = async selector => {
      const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('Missing '+${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y))) throw Error('Not clickable '+${JSON.stringify(selector)});return {x,y};})()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
    };
    const shot = async name => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(s.data, 'base64')); };
    const type = async text => {
      await cdp.eval("(()=>{const b=document.getElementById('mr-input-box');b.focus();const r=document.createRange();r.selectNodeContents(b);const s=getSelection();s.removeAllRanges();s.addRange(r);})()");
      await cdp.send('Input.insertText', { text });
    };
    await wait(() => cdp.eval('!!window.MeetingRoom && !!window.FileManagerPanel'), 'UI ready');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
    // Let one actual CLI initialize its fresh SQLite home before two group
    // members start concurrently. Otherwise the CLI's queue DB migration races.
    const warm = await invoke('create-session', { kind: 'codex', opts: { cwd: WORK, title: '验收环境初始化' } });
    await wait(() => cdp.eval(`terminalActivityMonitor.extractLiveScreenLines(${JSON.stringify(warm.id)}).some(line=>/^›\\s*Ask Codex to do anything\\s*$/.test(line.trim()))`), 'single CLI initializes isolated home', 60000);
    await cdp.eval("openMeetingCreateModal('group')");
    await click('[data-mcm-scene="dev"]');
    await cdp.eval(`(()=>{const s=document.querySelector('.mcm-slot[data-slot="0"] .mcm-ai-select');s.value='codex';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click('#meeting-create-modal .mcm-create');
    const created = await wait(async () => (await invoke('get-meetings')).find(m => m.scene === 'dev' && m.subSessions.length === 2 && m.serialWorkflow?.fileFlowVersion === 2), 'real UI creates dev group');
    const id = created.id, [sid, second] = created.subSessions;
    assert(id && sid && second, 'two real Codex members created');
    evidence.meetingId = id; evidence.members = created.subSessions;
    await cdp.eval(`selectMeeting(${JSON.stringify(id)})`);
    await wait(() => cdp.eval("!!document.querySelector('[data-file-docs]')"), 'group UI');
    await shot('initial');
    if (baseline) {
      evidence.baseline = await cdp.eval(`({oldButtons:!!document.getElementById('mr-input-history-btn')&&!!document.getElementById('mr-input-expand-btn'), newControls:!!document.getElementById('mr-input-tuning')})`);
      ok('baseline reproduces missing controls and two old buttons', evidence.baseline.oldButtons && !evidence.baseline.newControls);
      return;
    }
    ok('group has model/effort controls for two distinct members and no old buttons', await cdp.eval(`document.querySelectorAll('.mr-input-member-tuning').length===2 && !document.getElementById('mr-input-history-btn') && !document.getElementById('mr-input-expand-btn')`));
    const member = `.mr-input-member-tuning[data-sid="${sid}"]`;
    await wait(async () => {
      const snapshot = await invoke('get-session-buffer-snapshot', sid);
      const output = JSON.stringify(snapshot || '');
      return /gpt-/.test(output) && /›/.test(output);
    }, 'real Codex ready', 60000);
    ok('member terminal has never been opened in a session tab', await cdp.eval(`!terminalCache.get(${JSON.stringify(sid)})?.opened`));
    await cdp.eval(`(()=>{const ipc=require('electron').ipcRenderer, original=ipc.invoke;window.__modelConfirmations=[];ipc.invoke=function(channel,...args){const result=original.call(this,channel,...args);if(channel==='confirm-session-model-switch') result.then(response=>window.__modelConfirmations.push({args,response}));return result;};})()`);
    const firstBefore = await cdp.eval(`({effort:sessions.get(${JSON.stringify(sid)}).effort,model:sessions.get(${JSON.stringify(sid)}).currentModel.id})`);
    const secondBefore = await cdp.eval(`({effort:sessions.get(${JSON.stringify(second)}).effort,model:sessions.get(${JSON.stringify(second)}).currentModel.id})`);
    const targetEffort = firstBefore.effort === 'high' ? 'xhigh' : 'high';
    const targetModel = firstBefore.model === 'gpt-5.6-sol' ? 'gpt-6-astra' : 'gpt-5.6-sol';
    evidence.tuning = { firstBefore, secondBefore, targetEffort, targetModel };
    await click(member + ' .composer-thinking');
    await wait(() => cdp.eval(`!!document.querySelector('.effort-picker-menu [data-effort=${targetEffort}]')`), 'effort menu');
    evidence.screenBefore = await cdp.eval(`(()=>{const t=terminalCache.get(${JSON.stringify(sid)}).terminal,b=t.buffer.active;return {cols:t.cols,rows:t.rows,baseY:b.baseY,lines:Array.from({length:t.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true))};})()`);
    const nativeGeometry = await invoke('get-session-buffer-snapshot', sid);
    ok('unopened member reader uses native snapshot geometry', evidence.screenBefore.cols === nativeGeometry.cols && evidence.screenBefore.rows === nativeGeometry.rows);
    await click(`.effort-picker-menu [data-effort=${targetEffort}]`);
    await wait(() => cdp.eval(`sessions.get(${JSON.stringify(sid)}).effort===${JSON.stringify(targetEffort)} && !sessions.get(${JSON.stringify(sid)})._modelSwitchPending && window.__modelConfirmations.some(c=>c.args[0].sessionId===${JSON.stringify(sid)} && c.response.ok)`), 'real effort confirmation', 45000);
    ok('real Codex effort changed only for selected member and chip refreshed', await cdp.eval(`document.querySelector(${JSON.stringify(member + ' .composer-thinking .composer-chip-label')}).textContent===${JSON.stringify(targetEffort)} && sessions.get(${JSON.stringify(second)}).effort===${JSON.stringify(secondBefore.effort)}`));
    await wait(() => cdp.eval("!document.querySelector('.effort-picker-menu')"), 'effort menu closes');
    await click(member + ' .composer-model');
    await wait(() => cdp.eval(`!!document.querySelector('.model-picker-menu [data-model-id="${targetModel}"]')`), 'model menu');
    await click(`.model-picker-menu [data-model-id="${targetModel}"]`);
    await wait(() => cdp.eval(`sessions.get(${JSON.stringify(sid)}).currentModel.id===${JSON.stringify(targetModel)} && !sessions.get(${JSON.stringify(sid)})._modelSwitchPending && window.__modelConfirmations.some(c=>c.args[0].modelId===${JSON.stringify(targetModel)} && c.response.ok)`), 'real model confirmation', 45000);
    ok('real model changed only for selected member and group stayed open', await cdp.eval(`sessions.get(${JSON.stringify(second)}).currentModel.id===${JSON.stringify(secondBefore.model)} && MeetingRoom.getActiveMeetingId()===${JSON.stringify(id)} && !terminalCache.get(${JSON.stringify(sid)})?.opened`));
    await wait(() => cdp.eval("!document.querySelector('.model-picker-menu')"), 'model menu closes');
    await shot('model-changed');

    // B1: exercise the advanced panel and return from its real » prompt without
    // opening the member's terminal tab. Metadata alone is not a confirmation.
    const nativeLines = () => cdp.eval(`(()=>{const t=terminalCache.get(${JSON.stringify(sid)}).terminal,b=t.buffer.active;return Array.from({length:t.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)||'');})()`);
    const nativePrompt = async () => (await nativeLines()).map(line => line.trim()).filter(line => /^[›»]\s/.test(line)).at(-1);
    const changeEffort = async effort => {
      const before = await cdp.eval('window.__modelConfirmations.length');
      await click(member + ' .composer-thinking');
      await wait(() => cdp.eval(`!!document.querySelector('.effort-picker-menu [data-effort=${effort}]')`), 'advanced effort option');
      await click(`.effort-picker-menu [data-effort=${effort}]`);
      await wait(() => cdp.eval(`sessions.get(${JSON.stringify(sid)}).effort===${JSON.stringify(effort)} && !sessions.get(${JSON.stringify(sid)})._modelSwitchPending && window.__modelConfirmations.length>${before} && window.__modelConfirmations.at(-1).response.ok`), 'advanced effort confirmation ' + effort, 45000);
      await wait(() => cdp.eval("!document.querySelector('.effort-picker-menu')"), 'advanced effort menu closes');
      const lines = await nativeLines();
      (evidence.advancedTransitions ||= []).push({ effort, lines });
      ok('advanced effort round trip ' + effort, await cdp.eval(`sessions.get(${JSON.stringify(second)}).effort===${JSON.stringify(secondBefore.effort)} && document.querySelector(${JSON.stringify(member + ' .composer-thinking .composer-chip-label')}).textContent===${JSON.stringify(effort)}`));
    };
    for (const effort of ['max', 'ultra', 'low', 'ultra']) await changeEffort(effort);
    ok('ultra uses the actual double-chevron empty prompt', await nativePrompt() === '» Ask Codex to do anything');

    // Emulate typing into the native input, without Enter or a submitted prompt.
    const draft = 'b1_native_draft';
    await cdp.eval(`require('electron').ipcRenderer.send('terminal-input',{sessionId:${JSON.stringify(sid)},data:${JSON.stringify(draft)}})`);
    await wait(async () => (await nativePrompt()) === '» ' + draft, 'native draft appears');
    const guardedCount = await cdp.eval('window.__modelConfirmations.length');
    await click(member + ' .composer-thinking');
    await click('.effort-picker-menu [data-effort=high]');
    await wait(() => cdp.eval("document.querySelector('.effort-picker-menu [data-state=error]')?.textContent.includes('未发送内容')"), 'native draft guard');
    ok('ultra draft refuses tuning and preserves native input', await nativePrompt() === '» ' + draft && await cdp.eval(`sessions.get(${JSON.stringify(sid)}).effort==='ultra' && window.__modelConfirmations.length===${guardedCount} && !sessions.get(${JSON.stringify(sid)})._modelSwitchPending`));
    evidence.guardedNativeLines = await nativeLines();
    await shot('ultra-draft-guard');
    await click('.mr-gc-empty-title');
    await cdp.eval(`require('electron').ipcRenderer.send('terminal-input',{sessionId:${JSON.stringify(sid)},data:'\\x15'})`);
    await wait(async () => (await nativePrompt()) === '» Ask Codex to do anything', 'native draft cleared by Ctrl+U');

    const modelCount = await cdp.eval('window.__modelConfirmations.length');
    await click(member + ' .composer-model');
    await wait(() => cdp.eval(`!!document.querySelector('.model-picker-menu [data-model-id="${firstBefore.model}"]')`), 'model option from ultra');
    await click(`.model-picker-menu [data-model-id="${firstBefore.model}"]`);
    await wait(() => cdp.eval(`sessions.get(${JSON.stringify(sid)}).currentModel.id===${JSON.stringify(firstBefore.model)} && !sessions.get(${JSON.stringify(sid)})._modelSwitchPending && window.__modelConfirmations.length>${modelCount} && window.__modelConfirmations.at(-1).response.ok`), 'model confirmation from ultra', 45000);
    await wait(() => cdp.eval("!document.querySelector('.model-picker-menu')"), 'ultra model menu closes');
    ok('model switches from ultra while retaining effort and member isolation', await cdp.eval(`sessions.get(${JSON.stringify(sid)}).effort==='ultra' && sessions.get(${JSON.stringify(second)}).currentModel.id===${JSON.stringify(secondBefore.model)}`));
    await changeEffort('high');
    ok('ultra round trips keep the group open and member terminal unopened', await cdp.eval(`MeetingRoom.getActiveMeetingId()===${JSON.stringify(id)} && !terminalCache.get(${JSON.stringify(sid)})?.opened`));
    await shot('ultra-roundtrip-complete');
    evidence.modelConfirmations = await cdp.eval('window.__modelConfirmations');
    const state = await invoke('dev-file:status', { meetingId: id });
    ok('task directory initially absent', !fs.existsSync(state.dir));
    await click('[data-file-docs]');
    await wait(() => cdp.eval(`FileManagerPanel.isOpenFor(${JSON.stringify(state.dir)}) && !document.querySelector('#file-manager-status').textContent.includes('失败')`), 'internal task directory');
    ok('task button creates and opens actual task directory', fs.existsSync(state.dir));
    fs.writeFileSync(path.join(state.dir, '验收任务.md'), '# 任务文件\n\n内部预览中文正常。\n', 'utf8');
    await click('#file-manager-refresh');
    await wait(() => cdp.eval("[...document.querySelectorAll('[data-fm-node]')].some(e=>e.textContent.includes('验收任务.md'))"), 'task file tree');
    await shot('task-files');
    const refreshed = (await invoke('get-meetings')).find(m => m.id === id);
    await cdp.eval(`MeetingRoom.updateMeetingData(${JSON.stringify(id)}, ${JSON.stringify(refreshed)})`);
    ok('meeting refresh retains task directory', await cdp.eval(`FileManagerPanel.isOpenFor(${JSON.stringify(state.dir)})`));
    await click('#file-manager-close');

    // Control only the external provider boundary; execute the actual pull/ack controller.
    await cdp.eval(`(()=>{const ipc=require('electron').ipcRenderer;window.__composerOriginalInvoke=ipc.invoke;window.__bridgeCalls=[];window.__bridgeResult={ok:true,new:true,content:'来自公司\\n— 保留换行\\n1. 核对任务',message_ids:['company-1']};ipc.invoke=function(channel,...args){if(channel==='chatgpt-bridge:pull-for-input'){window.__bridgeCalls.push({channel});return window.__bridgePending || Promise.resolve(window.__bridgeResult);}if(channel==='chatgpt-bridge:ack'){window.__bridgeCalls.push({channel,args,text:document.getElementById('mr-input-box').innerText});return Promise.resolve({ok:true});}return window.__composerOriginalInvoke.call(this,channel,...args);};})()`);
    await type('原有草稿\n第二行');
    await click('#mr-input-tuning .fi-bridge-pull');
    const expected = '原有草稿\n第二行\n\n来自公司\n— 保留换行\n1. 核对任务';
    await wait(() => cdp.eval("!document.querySelector('#mr-input-tuning .fi-bridge-pull').disabled"), 'pull completes');
    ok('pull preserves multiline draft; ack occurs after insertion', await cdp.eval(`document.getElementById('mr-input-box').innerText===${JSON.stringify(expected)} && window.__bridgeCalls.find(c=>c.channel==='chatgpt-bridge:ack')?.text===${JSON.stringify(expected)}`));
    ok('pull does not send a group message', (await invoke('groupchat:get-state', { meetingId: id })).messages.length === 0);
    await cdp.eval("window.__bridgeResult={ok:false,error:'测试拉取失败'}");
    await click('#mr-input-tuning .fi-bridge-pull');
    await wait(() => cdp.eval("!document.querySelector('#mr-input-tuning .fi-bridge-pull').disabled"), 'pull failure completes');
    ok('pull error is visible and leaves draft intact', await cdp.eval(`document.getElementById('chatgpt-bridge-status').textContent.includes('测试拉取失败') && document.getElementById('mr-input-box').innerText===${JSON.stringify(expected)}`));
    const other = await invoke('create-meeting', { mode: 'general', title: '切房保护', workspace: WORK });
    await cdp.eval("window.__bridgePending=new Promise(r=>window.__resolveBridge=r);window.__bridgeCalls=[]");
    await click('#mr-input-tuning .fi-bridge-pull');
    await cdp.eval(`selectMeeting(${JSON.stringify(other.id)})`);
    await type('另一个群的草稿');
    await cdp.eval("window.__resolveBridge({ok:true,new:true,content:'过期回包',message_ids:['stale']})");
    await wait(() => cdp.eval("!document.querySelector('#mr-input-tuning .fi-bridge-pull').disabled"), 'stale pull settles');
    ok('switching rooms during pull cannot overwrite new room or ack content', await cdp.eval("document.getElementById('mr-input-box').innerText==='另一个群的草稿' && !window.__bridgeCalls.some(c=>c.channel==='chatgpt-bridge:ack')"));
    await cdp.eval(`selectMeeting(${JSON.stringify(id)})`);
    ok('returning to original room restores its exact draft', await cdp.eval(`document.getElementById('mr-input-box').innerText===${JSON.stringify(expected)}`));
    await cdp.eval("require('electron').ipcRenderer.invoke=window.__composerOriginalInvoke");
    for (const width of [1500, 1000, 760]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: false });
      await sleep(250);
      const geometry = await cdp.eval(`(()=>{const row=document.querySelector('.mr-group-composer'),rr=row.getBoundingClientRect();return [...row.querySelectorAll('button:not([hidden])')].filter(e=>e.offsetWidth).map(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {text:e.textContent,x:r.x,y:r.y,width:r.width,height:r.height,rowBottom:rr.bottom,hit:hit?.outerHTML?.slice(0,200),ok:r.left>=rr.left&&r.right<=rr.right+1&&r.bottom<=rr.bottom+1&&e.contains(hit)};});})()`);
      (evidence.geometry ||= {})[width] = geometry;
      ok(`composer buttons visible and hit-testable at ${width}px`, geometry.every(item => item.ok));
      await shot('composer-' + width);
    }
    evidence.ok = true;
  } catch (error) {
    evidence.ok = false; evidence.error = error.stack;
    if (cdp) {
      try {
        evidence.ui = await cdp.eval("({text:document.body.innerText.slice(-6000),composer:document.querySelector('#mr-input-row')?.outerHTML})");
        if (evidence.members?.[0]) evidence.screenAfter = await cdp.eval(`(()=>{const t=terminalCache.get(${JSON.stringify(evidence.members[0])})?.terminal;if(!t)return null;const b=t.buffer.active;return {cols:t.cols,rows:t.rows,baseY:b.baseY,lines:Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)).slice(-65)};})()`);
        const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, 'failure.png'), Buffer.from(s.data, 'base64'));
      } catch (captureError) { evidence.captureError = captureError.message; }
    }
    throw error;
  } finally {
    if (hub) fs.writeFileSync(path.join(ART, 'hub.log'), hub.log().join('\n'), 'utf8');
    try {
      try { if (cdp) await cdp.close(); } finally { if (hub) await gracefulQuit(hub); }
    } catch (error) {
      evidence.ok = false; evidence.cleanupError = error.stack;
      throw error;
    } finally {
      fs.rmSync(path.join(CODEX, 'auth.json'), { force: true });
      fs.writeFileSync(path.join(ART, 'checks.json'), JSON.stringify(evidence, null, 2), 'utf8');
      console.log('ARTIFACT_ROOT ' + ART);
    }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
