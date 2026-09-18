'use strict';
// 群聊压力验证：多轮长回答 + 反复分支 + 多群聊并发 + 成员增删 + 重启，
// 全程跑在隔离 Hub 上，成员由 Codex App Server fixture 扮演（不花钱、不碰生产）。
//
// 它要回答的问题不是「功能能不能用一次」，而是：在连续使用、并发派发和
// 成员变动之后，群聊的账本还对不对——
//   · 每一轮都有全员答复，没有静默丢人
//   · prompt 不随历史无限膨胀（预算规则在长会话下真的生效）
//   · 多个群聊并发时不串台（每个群聊只出现自己的成员）
//   · 记录 md 始终能和权威消息流对上
//   · 重启之后一切照旧
//
// 跑法：node tests/e2e-groupchat-fork-stress-cdp.js
//       GC_STRESS_ROUNDS=8 加大轮数；证据落 artifacts/groupchat-fork-stress/

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify;
const pause = ms => new Promise(r => setTimeout(r, ms));
const ROUNDS = Math.max(3, Number(process.env.GC_STRESS_ROUNDS) || 6);

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gcstress-'));
  const out = path.resolve(process.env.GC_STRESS_EVIDENCE_DIR || 'artifacts/groupchat-fork-stress');
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
  const evidence = { rounds: ROUNDS, checks: [], stats: {}, passed: false };
  const check = (name, pass, detail) => {
    assert(pass, name + ': ' + j(detail));
    evidence.checks.push({ name, detail: detail === undefined ? null : detail });
    console.log('PASS ' + name);
  };
  const invoke = (channel, payload) => c.eval(`ipcRenderer.invoke(${j(channel)}, ${j(payload)})`);
  const statePath = id => path.join(dataDir, 'arena-prompts', `${id}-groupchat.json`);
  const stateOf = id => JSON.parse(fs.readFileSync(statePath(id), 'utf8'));
  const transcriptOf = id => fs.readFileSync(path.join(dataDir, 'arena-prompts', `${id}-transcript.md`), 'utf8');
  const finalAnswers = (id, turnNum) => (stateOf(id).messages || []).filter(m => m.role === 'assistant'
    && Number(m.turnNum) === turnNum && m.status !== 'progress_update' && String(m.content || '').trim());

  // 一轮走真实派发链路（groupchat:turn），等这一轮真的结算完，而不是等 UI 出现气泡。
  const runTurn = async (meetingId, text, expected, label) => {
    const turn = await invoke('groupchat:turn', { meetingId, userInput: text });
    if (!turn || turn.status === 'error') throw new Error(`${label} 派发失败：${j(turn)}`);
    const turnNum = Number(turn.turnNum) || Number(stateOf(meetingId).currentTurn);
    const end = Date.now() + 180000;
    while (Date.now() < end) {
      const state = stateOf(meetingId);
      if (finalAnswers(meetingId, turnNum).length >= expected && state.currentMode === 'idle') {
        return { turnNum, answers: finalAnswers(meetingId, turnNum) };
      }
      await pause(250);
    }
    throw new Error(`${label} 超时：第 ${turnNum} 轮只等到 ${finalAnswers(meetingId, turnNum).length}/${expected} 条`);
  };
  const promptsOfTurn = (meetingId, turnNum) => (stateOf(meetingId).messages || [])
    .filter(m => m.role === 'assistant' && Number(m.turnNum) === turnNum && m.sourcePrompt)
    .map(m => String(m.sourcePrompt));

  try {
    hub = await launchIsolatedHub({
      dataDir, port, windowMode: 'hidden', label: 'groupchat-fork-stress',
      extraEnv: {
        CODEX_HOME: home,
        CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
      },
    });
    evidence.pid = hub.pid;
    c = await connectFirstPage(hub);
    // 渲染层未捕获错误的探针。页面重载会把它冲掉，所以重载前先收一次、重载后重新装。
    const installErrorProbe = () => c.eval('window.__stressErrors=[];window.addEventListener("error",e=>window.__stressErrors.push(String(e.message)));'
      + 'window.addEventListener("unhandledrejection",e=>window.__stressErrors.push("rejection: "+String(e.reason&&e.reason.message||e.reason)));true');
    const collectErrors = async () => (await c.eval('Array.isArray(window.__stressErrors)?window.__stressErrors:["probe-missing"]')) || [];
    const seenErrors = [];
    await installErrorProbe();
    await (async () => {
      const end = Date.now() + 60000;
      while (Date.now() < end) { if (await c.eval('typeof sessions!=="undefined" && !!window.__hubE2E')) return; await pause(150); }
      throw new Error('timeout: renderer');
    })();

    const slot = { kind: 'codex', model: 'gpt-6-astra', effort: 'high', mcpProfile: 'none', codexSpeedTier: 'standard' };
    const group = await c.eval(`ipcRenderer.invoke('create-meeting', ${j({
      title: '压力群', groupChat: true, scene: 'general', workspace: cwd, slots: [slot, slot, slot],
    })})`);
    evidence.group = group.id;

    // ── 1. 连续多轮长回答 ─────────────────────────────────────────────────
    const promptLengths = [];
    for (let i = 1; i <= ROUNDS; i += 1) {
      const { turnNum } = await runTurn(group.id,
        `fixture:conversation\n第 ${i} 轮压力提问：请给出足够长的完整回答。`, 3, `第 ${i} 轮`);
      const lengths = promptsOfTurn(group.id, turnNum).map(p => p.length);
      promptLengths.push(Math.max(...lengths));
    }
    evidence.stats.promptLengths = promptLengths;
    check(`连续 ${ROUNDS} 轮，每轮三位成员都有答复`,
      Array.from({ length: ROUNDS }, (_, i) => finalAnswers(group.id, i + 1).length).every(n => n === 3),
      Array.from({ length: ROUNDS }, (_, i) => finalAnswers(group.id, i + 1).length));
    // 历史越滚越多，但每轮 prompt 只带增量，不该跟着线性膨胀。
    // 第一轮没有历史、天然最短，所以基准取第二轮（第一次带上队友发言的那一轮）。
    const steady = promptLengths.slice(1);
    check('多轮之后 prompt 仍然有界（增量 + 预算规则生效）',
      promptLengths[promptLengths.length - 1] < 80000
      && Math.max(...steady) <= Math.min(...steady) * 1.5,
      { all: promptLengths });

    const md = transcriptOf(group.id);
    const state = stateOf(group.id);
    const recorded = state.messages.filter(m => m.status !== 'progress_update'
      && (m.role === 'assistant' || m.role === 'user')).length;
    check('记录 md 与权威消息流条数一致', (md.match(/^### #\d+ /gm) || []).length === recorded,
      { md: (md.match(/^### #\d+ /gm) || []).length, state: recorded });

    // ── 2. 成员增删 + 参与者子集 ──────────────────────────────────────────
    const added = await invoke('add-meeting-sub', { meetingId: group.id, kind: 'codex' });
    await runTurn(group.id, `fixture:conversation\n第 ${ROUNDS + 1} 轮：新成员加入后的一轮。`, 4, '加人后');
    check('加入第四位成员后，四位全部答复', finalAnswers(group.id, ROUNDS + 1).length === 4);

    const removed = await invoke('remove-meeting-sub', { meetingId: group.id, sessionId: added.session.id });
    check('移除成员成功且不影响剩余成员', removed.ok === true && removed.meeting.subSessions.length === 3, removed.reason);
    await invoke('groupchat:set-participants', { meetingId: group.id, participants: [0, 2] });
    const subset = await runTurn(group.id, `fixture:conversation\n第 ${ROUNDS + 2} 轮：只问其中两位。`, 2, '子集轮');
    check('只勾选两位时只有两位发言', subset.answers.length === 2, subset.answers.length);
    await invoke('groupchat:set-participants', { meetingId: group.id, participants: [0, 1, 2] });
    const backAll = await runTurn(group.id, `fixture:conversation\n第 ${ROUNDS + 3} 轮：恢复全员。`, 3, '恢复全员');
    // 上一轮没被勾选的那位，这一轮必须补上它没看到的提问和队友发言。
    const skippedSid = stateOf(group.id).messages.find(m => m.role === 'assistant'
      && Number(m.turnNum) === subset.turnNum) ? null : null;
    const catchUp = promptsOfTurn(group.id, backAll.turnNum)
      .find(p => p.includes(`第 ${ROUNDS + 2} 轮：只问其中两位。`));
    check('被跳过的成员回来时补到了它错过的提问', !!catchUp, { skippedSid, hasCatchUp: !!catchUp });

    // ── 3. 反复分支 + 分支的分支 ─────────────────────────────────────────
    const forks = [];
    for (let i = 0; i < 3; i += 1) {
      const sourceId = i === 2 ? forks[0].meeting.id : group.id; // 第三次是「分支的分支」
      const result = await invoke('groupchat:fork-meeting', { meetingId: sourceId });
      assert(result.ok, `第 ${i + 1} 次分支失败：${result.message}`);
      forks.push(result);
    }
    evidence.stats.forks = forks.map(f => ({ id: f.meeting.id, title: f.meeting.title, members: f.meeting.subSessions.length }));
    check('连续三次分支（含分支的分支）都成功且成员齐全',
      forks.every(f => f.meeting.subSessions.length === 3), evidence.stats.forks);
    check('分支群聊各有独立标题与独立状态文件',
      new Set(forks.map(f => f.meeting.id)).size === 3
      && forks.every(f => fs.existsSync(statePath(f.meeting.id))),
      forks.map(f => f.meeting.title));

    // ── 4. 多群聊并发派发，互不串台 ───────────────────────────────────────
    const arenas = [group.id, forks[0].meeting.id, forks[1].meeting.id];
    const concurrent = await Promise.all(arenas.map((id, index) =>
      runTurn(id, `fixture:conversation\n并发压力 ${index}：同时开跑。`, 3, `并发群 ${index}`)));
    check('三个群聊同时派发，每个都完整结算', concurrent.every(r => r.answers.length === 3),
      concurrent.map(r => r.answers.length));
    // 串台的判据是「A 群聊的卡片指向 B 群聊里活着的会话」。分支时已退群成员的历史
    // 发言会带 fork-orphan: 前缀，它指向的是「已经不在了」，不算串台。
    // 只把「指向别的群聊里仍然活着的会话」算作串台：被移除成员留在原群聊里的历史发言
    // 指向的是一个已经关掉的会话，那是既有行为，不是串台。
    const memberOwner = await c.eval('(()=>{const map={};for(const m of Object.values(meetings||{}))for(const sid of (m.subSessions||[]))map[sid]=m.id;return map;})()');
    const ownership = arenas.map((id) => {
      const live = Object.entries(memberOwner).filter(([, mid]) => mid === id).map(([sid]) => sid);
      const speaking = [...new Set(stateOf(id).messages.filter(m => m.role === 'assistant').map(m => m.sid))];
      const foreign = speaking.filter(sid => memberOwner[sid] && memberOwner[sid] !== id);
      return { id, live, speaking, foreign };
    });
    check('并发之后没有串台：每个群聊的发言只来自它自己的成员',
      ownership.every(o => o.foreign.length === 0),
      ownership.map(o => ({ live: o.live.length, speaking: o.speaking.length, foreign: o.foreign })));

    // ── 5. 中途插话 + 中断 ────────────────────────────────────────────────
    const supplement = await invoke('groupchat:user-supplement', { meetingId: group.id, text: '压力插话：注意这条补充。' });
    check('中途插话被受理并记账', supplement && supplement.ok === true, supplement && supplement.reason);
    const afterSupplement = await runTurn(group.id, 'fixture:conversation\n插话之后的一轮。', 3, '插话后');
    check('插话内容随下一轮送到成员手里',
      promptsOfTurn(group.id, afterSupplement.turnNum).every(p => p.includes('压力插话：注意这条补充。')));

    // ── 6. 重启之后一切照旧 ───────────────────────────────────────────────
    const beforeReload = stateOf(group.id).messages.length;
    seenErrors.push(...await collectErrors());
    await c.send('Page.reload');
    await (async () => {
      const end = Date.now() + 60000;
      while (Date.now() < end) { if (await c.eval('typeof window.MeetingRoom!=="undefined" && typeof sessions!=="undefined"')) return; await pause(200); }
      throw new Error('timeout: reload');
    })();
    await installErrorProbe();
    const afterReload = await runTurn(group.id, 'fixture:conversation\n重启之后继续。', 3, '重启后');
    check('界面重载后群聊照常继续', afterReload.answers.length === 3
      && stateOf(group.id).messages.length > beforeReload,
      { beforeReload, after: stateOf(group.id).messages.length });

    seenErrors.push(...await collectErrors());
    check('全程没有渲染层未捕获错误', seenErrors.length === 0, seenErrors.slice(0, 5));
    const hubErrors = hub.log().filter(line => /transcript write failed|state-import-failed|Unhandled|TypeError|ReferenceError/.test(line));
    check('主进程日志没有与本次改动相关的异常', hubErrors.length === 0, hubErrors.slice(0, 5));

    evidence.stats.finalMessages = stateOf(group.id).messages.length;
    evidence.passed = true;
  } catch (error) {
    evidence.error = error.stack;
    throw error;
  } finally {
    if (c) { try { await c.close(); } catch {} }
    if (hub) {
      fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n'));
      evidence.exit = await gracefulQuit(hub);
    }
    fs.writeFileSync(path.join(out, 'evidence.json'), j(evidence, null, 2));
    console.log(j({ passed: evidence.passed, checks: evidence.checks.length, stats: evidence.stats, exit: evidence.exit }));
    try { if (root.startsWith(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
