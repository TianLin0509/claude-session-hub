'use strict';

// Real isolated UI: group/member context menu, picker, paste and explicit Send.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./e2e-session-reference-cdp');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve('artifacts/20261021-group-reference-codex1', String(Date.now()));
const j = JSON.stringify;
const groupId = 'e2e-reference-group-0001', groupTitle = '调度算法评审群';
const memberId = fixture.SOURCE_HUB_ID, peerId = 'hub-gemini-group-reference';
let hub, c;
const evidence = { checks: [], boundary: '真实隔离 Hub 界面与提交管道，CLI 为本地夹具，未调用云端模型。' };
async function wait(expr) {
  for (let i = 0; i < 200; i++) {
    const value = await c.eval(`(${expr}) || false`);
    if (value) return value;
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error('Timed out: ' + expr);
}
async function click(selector, button = 'left') {
  await wait(`!!document.querySelector(${j(selector)})`);
  const p = await c.eval(`(() => { const el=document.querySelector(${j(selector)});el.scrollIntoView({block:'nearest'});
    const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    if(!r.width||!r.height||!el.contains(document.elementFromPoint(x,y)))throw Error('Covered '+${j(selector)});
    return {x,y};})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button, clickCount: 1 });
}
async function main() {
  fixture.writeFakeCli(); fixture.writeFixtures(); fs.mkdirSync(out, { recursive: true });
  const stateFile = path.join(fixture.DATA_DIR, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const targetId = state.sessions.find(s => s.kind === 'claude').hubId;
  state.sessions.find(s => s.hubId === memberId).meetingId = groupId;
  state.sessions.push({ schemaVersion: 1, hubId: peerId, kind: 'gemini', title: 'Gemini 1', meetingId: groupId, cwd: fixture.WORK_DIR });
  state.sessions.forEach(s => { s.pinned = true; });
  state.meetings[0].subSessions = [memberId, peerId]; state.meetings[0].pinned = true;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const groupFile = path.join(fixture.DATA_DIR, 'arena-prompts', `${groupId}-groupchat.json`);
  const group = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
  group.messages.forEach(m => { if (m.sid) m.sid = memberId; });
  group.messages.push({ seq: 4, role: 'assistant', sid: peerId, speaker: 'Gemini', content: 'GEMINI_ONLY 正式回答', createdAt: Date.now() });
  fs.writeFileSync(groupFile, JSON.stringify(group));
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'Path';
  try {
    hub = await launchIsolatedHub({ dataDir: fixture.DATA_DIR, port: await fixture.reservePort(), label: 'group-reference', extraEnv: {
      [pathKey]: `${fixture.FAKE_BIN_DIR}${path.delimiter}${process.env[pathKey] || ''}`,
      CLAUDE_CONFIG_DIR: path.join(fixture.TEMP_ROOT, 'claude-config'), CODEX_HOME: fixture.CODEX_HOME,
      AI_HUB_WORKSPACE_ROOT: fixture.WORK_DIR,
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(__dirname, 'fixtures/claude-stream.js'),
      HUB_CLAUDE_BACKEND: 'subscription', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: 'e2e',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: fixture.CLAUDE_ROOT, HUB_SESSION_SEARCH_CODEX_ROOTS: fixture.CODEX_ROOT,
      HUB_SESSION_SEARCH_KIMI_ROOTS: path.join(fixture.TEMP_ROOT, 'empty-kimi'),
      HUB_SESSION_SEARCH_GEMINI_ROOTS: path.join(fixture.TEMP_ROOT, 'empty-gemini'),
    } });
    c = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await wait(`typeof sessions!=='undefined' && sessions.has(${j(peerId)})`);
    await click('[data-session-days="pinned"]');
    const before = await c.eval(`({active:activeSessionId,status:[sessions.get(${j(memberId)}).status,sessions.get(${j(peerId)}).status]})`);
    const copied = [];
    for (const [id, isGroup, included, excluded] of [[groupId, true, 'GEMINI_ONLY', 'GROUP_PROGRESS_MARKER'],
      [memberId, false, 'GROUP_ANSWER_MARKER', 'GEMINI_ONLY'], [peerId, false, 'GEMINI_ONLY', 'GROUP_ANSWER_MARKER']]) {
      await click(isGroup ? `[data-meeting-id="${id}"] .sl-title` : `[data-session-id="${id}"] .sl-title`, 'right');
      await click('#context-menu [data-action="reference"]');
      const text = await wait(`require('electron').clipboard.readText()!==${j(copied.at(-1) || '')} && require('electron').clipboard.readText().includes(${j(isGroup ? '【引用群聊】' : '【引用会话】')}) && require('electron').clipboard.readText()`);
      const mdPath = text.split('聊天记录：')[1].split('\n')[0].trim();
      const md = fs.readFileSync(mdPath, 'utf8');
      assert.ok(md.includes('GROUP_QUESTION_MARKER') && md.includes(included));
      assert.ok(!md.includes(excluded));
      copied.push(text); evidence.checks.push('右键引用成功：' + id);
    }
    assert.deepEqual(await c.eval(`({active:activeSessionId,status:[sessions.get(${j(memberId)}).status,sessions.get(${j(peerId)}).status]})`), before);
    evidence.checks.push('引用不切换会话、不唤醒成员');
    await click(`[data-session-id="${targetId}"] .sl-title`);
    await wait('!!document.querySelector(".fi-bridge-reference")');
    await c.eval(`window.__groupSends=[];const original=ipcRenderer.invoke.bind(ipcRenderer);
      ipcRenderer.invoke=async(channel,...args)=>{const result=await original(channel,...args);if(channel==='session:send-prompt')window.__groupSends.push({args,result});return result;}`);
    await click('.fi-bridge-reference');
    await click('[data-gc-picker-filter]');
    await c.send('Input.insertText', { text: groupTitle });
    await wait(`document.querySelectorAll('#gc-fork-picker [data-gc-picker-row]').length===3`);
    await click(`[data-gc-picker-row="${peerId}"]`);
    await wait('readContenteditablePlainText(document.querySelector(".floating-input-box")).includes("【引用会话】")');
    assert.equal(await c.eval('window.__groupSends.length'), 0);
    evidence.checks.push('按群名筛选可找到整个群和两名成员，点击仅插入不发送');
    await c.eval(`(() => {const dt=new DataTransfer();dt.setData('text/plain',${j(copied[0])});document.querySelector('.floating-input-box').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
    await click('.floating-input-send');
    const sent = await wait('window.__groupSends.length && window.__groupSends');
    assert.equal(sent.length, 1); assert.equal(sent[0].result.ok, true);
    assert.ok(JSON.stringify(sent[0].args).includes('【引用群聊】') && JSON.stringify(sent[0].args).includes('【引用会话】'));
    evidence.checks.push('用户点击发送后，群和成员引用经过真实提交管道');
    evidence.ok = true;
  } catch (error) { evidence.error = error.stack; process.exitCode = 1; }
  finally {
    if (c) { const shot=await c.send('Page.captureScreenshot',{format:'png'}).catch(()=>null);if(shot)fs.writeFileSync(path.join(out,'20261021-group-reference-codex1.png'),Buffer.from(shot.data,'base64'));await c.close(); }
    if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out,'20261021-group-reference-codex1.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence)); console.log(out);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
