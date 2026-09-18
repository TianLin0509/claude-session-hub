'use strict';
// 真实隔离 Hub + Codex App Server fixture：群聊记录 md、加入已有会话、整群分支。
// 不碰生产数据，不花钱（成员全部由 stdio fixture 扮演）。
//
// 跑法：node tests/e2e-groupchat-transcript-fork-cdp.js
// 证据：artifacts/groupchat-fork/{evidence.json,hub.log,*.png}

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify;
const pause = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gcfork-'));
  const out = path.resolve(process.env.GC_FORK_EVIDENCE_DIR || 'artifacts/groupchat-fork');
  fs.mkdirSync(out, { recursive: true });
  const dataDir = path.join(root, 'data');
  const cwd = path.join(root, 'workspace');
  const home = path.join(root, 'codex');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n');
  const port = await new Promise((res, rej) => {
    const s = net.createServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => res(n)); });
  });

  let hub; let c;
  const evidence = { checks: [], passed: false };
  const check = (name, pass, detail) => {
    assert(pass, name + ': ' + j(detail));
    evidence.checks.push({ name, detail: detail === undefined ? null : detail });
    console.log('PASS ' + name);
  };
  const until = async (expr, label, ms = 90000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await c.eval(expr)) return; await pause(150); }
    throw new Error('timeout: ' + label);
  };
  const invoke = (channel, payload) => c.eval(`ipcRenderer.invoke(${j(channel)}, ${j(payload)})`);
  const click = async (selector) => {
    await until(`(()=>{const e=document.querySelector(${j(selector)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0;})()`, 'clickable ' + selector);
    const pos = await c.eval(`(()=>{const r=document.querySelector(${j(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pos });
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, ...pos, button: 'left', clickCount: 1 });
    }
    await pause(120);
  };
  const shot = async (name) => {
    const s = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64'));
  };
  const openMeeting = async (meetingId) => {
    await until(`!!document.querySelector('[data-meeting-id="${meetingId}"]')`, 'sidebar ' + meetingId);
    await click(`[data-meeting-id="${meetingId}"]`);
    await until('!!document.getElementById("mr-input-box")', 'composer');
  };
  const sendInRoom = async (text) => {
    await c.eval(`(()=>{const e=document.getElementById('mr-input-box');e.textContent=${j(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();})()`);
    await click('#mr-send-btn');
  };
  const stateOf = (meetingId) => JSON.parse(fs.readFileSync(path.join(dataDir, 'arena-prompts', `${meetingId}-groupchat.json`), 'utf8'));
  const transcriptOf = (meetingId) => fs.readFileSync(path.join(dataDir, 'arena-prompts', `${meetingId}-transcript.md`), 'utf8');
  const answersInTurn = (meetingId, turnNum) => {
    let state;
    try { state = stateOf(meetingId); } catch { return []; }
    return (state.messages || []).filter(m => m.role === 'assistant' && Number(m.turnNum) === turnNum
      && m.status !== 'progress_update' && String(m.content || '').trim());
  };
  const waitAnswers = async (meetingId, turnNum, count, label) => {
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      if (answersInTurn(meetingId, turnNum).length >= count) return;
      await pause(300);
    }
    throw new Error(`timeout: ${label}（第 ${turnNum} 轮只等到 ${answersInTurn(meetingId, turnNum).length}/${count} 条答复）`);
  };
  const promptOf = (meetingId, turnNum, sid) => {
    const state = stateOf(meetingId);
    const message = (state.messages || []).find(m => m.role === 'assistant' && Number(m.turnNum) === turnNum && m.sid === sid);
    return String((message && message.sourcePrompt) || '');
  };

  try {
    hub = await launchIsolatedHub({
      dataDir, port, windowMode: 'hidden', label: 'groupchat-fork',
      extraEnv: {
        CODEX_HOME: home,
        CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
      },
    });
    evidence.pid = hub.pid;
    c = await connectFirstPage(hub);
    await c.send('Page.enable');
    await until('typeof sessions!=="undefined" && !!window.__hubE2E', 'renderer');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1550, height: 1080, deviceScaleFactor: 1, mobile: false });

    const slot = { kind: 'codex', model: 'gpt-6-astra', effort: 'high', mcpProfile: 'none', codexSpeedTier: 'standard' };
    const group = await c.eval(`ipcRenderer.invoke('create-meeting', ${j({
      title: '分支验证群', groupChat: true, scene: 'general', workspace: cwd, slots: [slot, slot],
    })})`);
    evidence.group = group.id;
    await openMeeting(group.id);

    // ── 1. 群聊记录 md ────────────────────────────────────────────────────
    await sendInRoom('第一问：这个架构的主要风险在哪？');
    await waitAnswers(group.id, 1, 2, '第一轮两位成员答复');
    const md1 = transcriptOf(group.id);
    check('群聊记录 md 随对话落盘，含提问与两条答复', md1.includes('第一问：这个架构的主要风险在哪？')
      && (md1.match(/### #\d+ /g) || []).length >= 3 && md1.includes('## 第 1 轮'),
      { headings: (md1.match(/### #\d+ /g) || []).length });

    // ── 2. 中途加入的新成员拿得到历史 ──────────────────────────────────────
    const added = await invoke('add-meeting-sub', { meetingId: group.id, kind: 'codex' });
    const newSid = added.session.id;
    await sendInRoom('第二问：新人怎么看前面的结论？');
    await waitAnswers(group.id, 2, 3, '第二轮三位成员答复');
    const newcomerPrompt = promptOf(group.id, 2, newSid);
    check('新成员的第一条 prompt 带历史提问、队友答复和记录路径',
      newcomerPrompt.includes('第一问：这个架构的主要风险在哪？')
      && newcomerPrompt.includes('## 群聊记录')
      && newcomerPrompt.includes(`${group.id}-transcript.md`)
      && newcomerPrompt.includes('## 规则'),
      { length: newcomerPrompt.length });
    const oldMemberSid = stateOf(group.id).messages.find(m => m.role === 'assistant' && m.turnNum === 1).sid;
    const oldMemberPrompt = promptOf(group.id, 2, oldMemberSid);
    check('老成员这一轮仍然只拿到增量，不被重灌历史',
      !oldMemberPrompt.includes('## 规则') && !oldMemberPrompt.includes('第一问：这个架构的主要风险在哪？'),
      { length: oldMemberPrompt.length });
    await shot('group-before-fork');

    // ── 3. 整群分支 ───────────────────────────────────────────────────────
    const before = stateOf(group.id);
    const forked = await invoke('groupchat:fork-meeting', { meetingId: group.id });
    check('整群分支成功并复制了全部成员', forked.ok === true
      && forked.meeting.subSessions.length === 3
      && Object.keys(forked.sidMap).length === 3, forked.message || forked.meeting.title);
    const forkState = stateOf(forked.meeting.id);
    const forkSids = new Set(Object.values(forked.sidMap));
    check('分支群聊继承了完整记录，且发言已改挂到新成员',
      forkState.messages.length === before.messages.length + 1 // +1 是那条"分支自…"的系统说明
      && forkState.messages.filter(m => m.role === 'assistant').every(m => forkSids.has(m.sid))
      && forkState.forkedFrom.meetingId === group.id
      && Object.keys(forkState.attempts).length === 0,
      { source: before.messages.length, forked: forkState.messages.length });
    check('分支群聊自己的 md 也生成了', transcriptOf(forked.meeting.id).includes('第一问：这个架构的主要风险在哪？'));

    // ── 4. 分支之后两边互不影响 ────────────────────────────────────────────
    await openMeeting(forked.meeting.id);
    await sendInRoom('分支后第三问：只在分支里继续。');
    await waitAnswers(forked.meeting.id, 3, 3, '分支群聊的新一轮');
    const forkPrompts = [...forkSids].map(sid => promptOf(forked.meeting.id, 3, sid));
    check('分支成员继承了已读游标：不重发群规、不重灌历史',
      forkPrompts.every(p => p && !p.includes('## 规则') && !p.includes('第一问：这个架构的主要风险在哪？')),
      forkPrompts.map(p => p.length));
    const sourceAfter = stateOf(group.id);
    check('源群聊没有被分支影响',
      sourceAfter.messages.length === before.messages.length && Number(sourceAfter.currentTurn) === 2,
      { messages: sourceAfter.messages.length, currentTurn: sourceAfter.currentTurn });

    // ── 5. 把已有的独立会话分支进群聊 ──────────────────────────────────────
    const standalone = await c.eval(`ipcRenderer.invoke('create-session', ${j({
      kind: 'codex', opts: { title: '独立调研会话', cwd, model: 'gpt-6-astra', effort: 'high', mcpProfile: 'none' },
    })})`);
    await invoke('session:send-prompt', { sessionId: standalone.id, text: '这是独立会话里的一轮，用来拿到原生会话 ID。' });
    // eval 里不能直接写 await（表达式不是 async 函数体），要自己包一层。
    await until(`(async()=>{const rows=await ipcRenderer.invoke('groupchat:forkable-sessions',{});return rows.some(r=>r.id===${j(standalone.id)});})()`,
      '独立会话拿到原生会话 ID');
    const joined = await invoke('groupchat:add-existing-session', { meetingId: forked.meeting.id, sessionId: standalone.id });
    check('已有会话分支加入群聊成功，且是分支而不是搬迁', joined.ok === true
      && joined.meeting.subSessions.length === 4
      && joined.session.id !== standalone.id, joined.message || joined.session.title);
    check('原会话仍然独立存在，没有被拉进群聊',
      await c.eval(`(()=>{const s=sessions.get(${j(standalone.id)});return !!s && !s.meetingId;})()`));

    await openMeeting(forked.meeting.id);
    await sendInRoom('第四问：新加入的成员请先复述一下我们前面的结论。');
    await waitAnswers(forked.meeting.id, 4, 4, '加入成员后的一轮');
    const joinedPrompt = promptOf(forked.meeting.id, 4, joined.session.id);
    check('分支加入的成员同样拿到群规、历史和记录路径',
      joinedPrompt.includes('## 规则') && joinedPrompt.includes('## 群聊记录')
      && joinedPrompt.includes('第一问：这个架构的主要风险在哪？'),
      { length: joinedPrompt.length });
    await shot('forked-room');

    // ── 6. 从已有会话直接建群 ─────────────────────────────────────────────
    const born = await invoke('groupchat:create-from-sessions', { sessionIds: [standalone.id], title: '从会话建的群' });
    check('从已有会话新建群聊成功', born.ok === true && born.meeting.subSessions.length === 1
      && born.meeting.title === '从会话建的群', born.message);
    await openMeeting(born.meeting.id);
    await sendInRoom('新群第一问：继续我们刚才在独立会话里聊的内容。');
    await waitAnswers(born.meeting.id, 1, 1, '新群聊的第一轮');
    check('新群聊的成员能正常答复', answersInTurn(born.meeting.id, 1).length === 1);

    // ── 7. 拒绝路径要说得清 ───────────────────────────────────────────────
    const devMeeting = await c.eval(`ipcRenderer.invoke('create-meeting', ${j({
      title: '开发群', groupChat: true, mode: 'dev', workspace: cwd, slots: [slot, slot],
    })})`);
    const devFork = await invoke('groupchat:fork-meeting', { meetingId: devMeeting.id });
    check('开发群聊明确拒绝分支并给出原因', devFork.ok === false && devFork.error === 'dev-meeting-unsupported', devFork.message);
    const dup = await invoke('groupchat:add-existing-session', { meetingId: forked.meeting.id, sessionId: joined.session.id });
    check('已是成员的会话不会被重复加入', dup.ok === false && dup.error === 'already-member', dup.message);

    evidence.passed = true;
  } catch (error) {
    evidence.error = error.stack;
    throw error;
  } finally {
    if (c) { try { await shot('last'); } catch {} await c.close(); }
    if (hub) {
      fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n'));
      evidence.exit = await gracefulQuit(hub);
    }
    fs.writeFileSync(path.join(out, 'evidence.json'), j(evidence, null, 2));
    console.log(j({ passed: evidence.passed, checks: evidence.checks.length, exit: evidence.exit }));
    try { if (root.startsWith(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
