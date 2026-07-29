'use strict';
// AI 群聊「复用各成员 session 真实卡片」压力测试（2026-07-29 验收）
//
// 三个阶段：
//   --phase=live     真实 CLI（Claude + Codex + Kimi）多成员并发。
//                    R1 富提问 → 抓「多家同时渲染各自 session 真卡片」的佐证截图
//                    R2..R4 连续多轮不重启（DOM/内存膨胀 + 卡片归属）
//                    R5→R6 运行中追加提问（superseded）
//                    R7 运行中 ⏹ 停止本轮（interrupted 收敛）
//   --phase=restart  同数据目录重启，断言历史轮正文完整、卡片外壳在
//   --phase=fake     PowerShell 假成员拉到 8 位（零真实额度），看 DOM 膨胀与渲染耗时
//
// 铁律：CLAUDE_HUB_DATA_DIR 隔离 + 独立 CDP 端口 + PID 白名单（hub-launcher 内置）+
//       剥离嵌套 CLAUDECODE env（否则 spawn 的 claude 不写 transcript jsonl → 假失败）。

const fs = require('fs');
const net = require('net');
const path = require('path');

for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID']) {
  delete process.env[k];
}

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'artifacts');
const PHASE = (process.argv.find(a => a.startsWith('--phase=')) || '--phase=live').split('=')[1];
const DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR
  || 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-stress-gccard';
const WORK_DIR = process.env.GC_STRESS_WORKDIR || 'C:\\Vibe\\_scratch\\gccard-stress';
const PREFERRED_PORT = Number(process.env.GC_STRESS_PORT || 9240);
const STATE_FILE = path.join(ARTIFACT_DIR, 'stress-gccard-state.json');
const OUT_FILE = path.join(ARTIFACT_DIR, `stress-gccard-${PHASE}.json`);

const MEMBER_KINDS = (process.env.GC_STRESS_KINDS || 'claude,codex,kimi').split(',');
const j = (v) => JSON.stringify(v);

// ------------------------------------------------------------------ 提问集（额度控制）
const P_RICH = '请在当前目录建一个文件 note-<你的名字>.txt，写入一行“<你的名字> 到场”，然后读回来确认。'
  + '最后用一小段带代码块的 markdown 说明你做了什么（3 行以内，别啰嗦）。';
const P_SHORT = [
  '一句话：2 的 8 次方等于多少？',
  '一句话：3 的 5 次方等于多少？',
  '一句话：7 乘以 13 等于多少？',
];
const P_SUPERSEDE_A = '数一下 1 到 30 之间有几个质数，只报一个数字。';
const P_SUPERSEDE_B = '忽略上一条。一个词回答：中国的首都是哪里？';
const P_STOP = '一句话：12 的平方等于多少？';

// ------------------------------------------------------------------ 基础设施
function canListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(() => resolve(true)); });
    s.listen(port, '127.0.0.1');
  });
}
async function availablePort(preferred) {
  for (let p = preferred; p < preferred + 40; p += 1) if (await canListen(p)) return p;
  throw new Error(`No free CDP port from ${preferred}`);
}
async function waitFor(cdp, expr, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { if (await cdp.eval(expr)) return true; } catch (e) { last = e; }
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}
async function shoot(cdp, name, { expand = false } = {}) {
  if (expand) {
    // 只展开工具簇：把「N 个工具调用」摊成逐行 Read/Bash/Write —— 这是"真卡片"最硬的证据。
    //   thinking <details> 正文动辄上千字，一起展开会把三家挤出视口。
    await cdp.eval(`(() => { document.querySelectorAll('.mr-gc-messages details.tc-cluster').forEach(d => d.open = true); return true; })()`).catch(() => {});
    await _waitMs(300);
  }
  await cdp.eval(`(() => { const m = document.querySelector('.mr-gc-messages'); if (m) m.scrollTop = m.scrollHeight; return true; })()`).catch(() => {});
  await _waitMs(150);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const f = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return { file: f, bytes: fs.statSync(f).size };
}

// ------------------------------------------------------------------ 逐成员快照
// 注意 msgId 形态：pending 气泡是 `pending-<sid>`，**落库后是 `a<turnNum>-m<成员序号>`**
//   （不含 sid！）。所以按 sid 定位只对 pending 有效；settled 必须由调用方从
//   groupchat:get-state 取回 message.id 再传进来（idBySid）。
const SNAP_FN = `
window.__ss = function (sids, idBySid) {
  const pick = (sid) => {
    const want = idBySid && idBySid[sid];
    if (want) {
      const hit = document.querySelector('.mr-gc-msg[data-gc-msg-id=' + JSON.stringify(want) + ']');
      if (hit) return hit;
    }
    const pend = document.querySelector('.mr-gc-msg[data-gc-msg-id=' + JSON.stringify('pending-' + sid) + ']');
    if (pend) return pend;
    const arts = [...document.querySelectorAll('.mr-gc-msg')].filter(
      a => (a.getAttribute('data-gc-msg-id') || '').endsWith(sid));
    return arts[arts.length - 1] || null;
  };
  const out = {};
  for (const sid of sids) {
    const el = pick(sid);
    const card = el ? el.querySelector('.turn-card') : null;
    const body = card ? card.querySelector('.turn-body') : null;
    out[sid] = {
      article: !!el,
      msgId: el ? el.getAttribute('data-gc-msg-id') : null,
      gcStatus: el ? (el.getAttribute('data-gc-status') || '') : null,
      pending: el ? el.classList.contains('pending') : null,
      cards: el ? el.querySelectorAll('.turn-card').length : 0,
      thinkingDetails: el ? el.querySelectorAll('details.turn-thinking').length : 0,
      toolCluster: el ? el.querySelectorAll('.tc-cluster').length : 0,
      toolRows: el ? el.querySelectorAll('.tc-row-name').length : 0,
      codeBlocks: el ? el.querySelectorAll('.code-block-wrap').length : 0,
      codeTokens: el ? el.querySelectorAll('.code-block-wrap .token').length : 0,
      metaPills: el ? el.querySelectorAll('.turn-meta-pills .pill').length : 0,
      cardHosts: el ? el.querySelectorAll('.mr-gc-card-host').length : 0,
      cardFallback: el ? el.querySelectorAll('.mr-gc-card-fallback').length : 0,
      placeholder: el ? el.querySelectorAll('.mr-gc-empty-placeholder, .mr-gc-waiting').length : 0,
      waiting: el ? el.querySelectorAll('.mr-gc-waiting').length : 0,
      cardSessionId: card ? (card.dataset.sessionId || null) : null,
      bodyLen: body ? (body.innerText || '').length : 0,
      bodyHead: body ? (body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120) : '',
    };
  }
  out.__global = {
    turnCards: document.querySelectorAll('.turn-card').length,
    gcMsgs: document.querySelectorAll('.mr-gc-msg').length,
    gcAiMsgs: document.querySelectorAll('.mr-gc-msg.ai').length,
    pendingBubbles: document.querySelectorAll('.mr-gc-msg.pending').length,
    waitingShells: document.querySelectorAll('.mr-gc-waiting').length,
    thinkingCards: document.querySelectorAll('.mr-gc-msg.pending .mr-gc-waiting').length,
    cardHosts: document.querySelectorAll('.mr-gc-card-host').length,
    domNodes: document.getElementsByTagName('*').length,
    overlayCards: document.querySelectorAll('#msg-overlay .turn-card').length,
    overlayIndicators: document.querySelectorAll('#msg-overlay .streaming-indicator').length,
    sessionTurnsSize: (window._sessionTurns && window._sessionTurns.size) || 0,
  };
  return out;
};
// 卡片归属全景：每张群聊卡片的 (msgId, cardSessionId) 对，用来查"卡片挂错轮次/挂错人"
window.__cardMap = function () {
  return [...document.querySelectorAll('.mr-gc-msg')].map(a => {
    const c = a.querySelector('.turn-card');
    return {
      msgId: a.getAttribute('data-gc-msg-id') || '',
      status: a.getAttribute('data-gc-status') || '',
      cardSid: c ? (c.dataset.sessionId || null) : null,
      cards: a.querySelectorAll('.turn-card').length,
      len: (a.innerText || '').length,
    };
  });
};
true;`;

const snap = (cdp, sids, idBySid) => cdp.eval(`window.__ss(${j(sids)}, ${j(idBySid || null)})`);
const cardMap = (cdp) => cdp.eval('window.__cardMap()');

// 从持久化 state 里取「某轮 · 某成员」的正式消息 id（a<turn>-m<N>），给 __ss 定位用。
function idBySidForTurn(state, turnNum) {
  const m = {};
  for (const msg of ((state && state.messages) || [])) {
    if (msg.role === 'assistant' && msg.sid && Number(msg.turnNum) === Number(turnNum)) m[msg.sid] = msg.id;
  }
  return m;
}
// 卡片归属真值表：DOM 里每张卡的 cardSid 必须等于「该气泡 id 对应的持久化 message.sid」。
function ownershipViolations(cm, state) {
  const sidById = {};
  for (const msg of ((state && state.messages) || [])) if (msg.id) sidById[msg.id] = msg.sid || null;
  return cm.filter((x) => {
    if (!x.cardSid) return false;
    if (x.msgId.startsWith('pending-')) return x.msgId !== `pending-${x.cardSid}`;
    const owner = sidById[x.msgId];
    return owner ? owner !== x.cardSid : true;   // 认不出归属的卡片同样算违规
  });
}

async function perfMetrics(cdp) {
  try {
    const r = await cdp.send('Performance.getMetrics');
    const m = {};
    for (const x of (r.metrics || [])) m[x.name] = x.value;
    return {
      jsHeapMB: m.JSHeapUsedSize ? +(m.JSHeapUsedSize / 1048576).toFixed(1) : null,
      nodes: m.Nodes || null,
      layoutCount: m.LayoutCount || null,
      recalcStyleCount: m.RecalcStyleCount || null,
      layoutDurationMs: m.LayoutDuration ? +(m.LayoutDuration * 1000).toFixed(0) : null,
      recalcStyleDurationMs: m.RecalcStyleDuration ? +(m.RecalcStyleDuration * 1000).toFixed(0) : null,
      scriptDurationMs: m.ScriptDuration ? +(m.ScriptDuration * 1000).toFixed(0) : null,
    };
  } catch { return null; }
}

async function gcState(cdp, meetingId) {
  return cdp.eval(`(async () => {
    const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} });
    return {
      currentTurn: r && r.currentTurn, currentMode: r && r.currentMode,
      messages: (r && r.messages || []).map(m => ({ id: m.id, sid: m.sid, turnNum: m.turnNum,
        role: m.role, status: m.status, len: (m.content || '').length,
        head: String(m.content || '').replace(/\\s+/g,' ').slice(0, 80) })),
    };
  })()`).catch(() => null);
}

// 打开群聊 —— 走侧栏点击命中的同一个 selectMeeting（它才会把主区让给 meeting-room-panel；
//   只调 MeetingRoom.openMeeting 会把群聊塞进右侧窄坞，主区还停在 landing 空态）。
async function openMeetingLikeUser(cdp, meetingId) {
  const how = await cdp.eval(`(async () => {
    localStorage.setItem('mr-group-chat-view-mode', 'chat');
    const ipc = require('electron').ipcRenderer;
    const all = await ipc.invoke('get-meetings');
    const m = all.find(x => x.id === ${j(meetingId)});
    if (!m) throw new Error('找不到该群聊');
    if (window.__hubE2E && window.__hubE2E.selectMeeting) {
      window.__hubE2E.selectMeeting(${j(meetingId)});
      return 'selectMeeting';
    }
    window.MeetingRoom.openMeeting(${j(meetingId)}, m);
    return 'openMeeting';
  })()`);
  await waitFor(cdp, "!!document.querySelector('.mr-gc-shell')", 'group chat shell', 40000);
  await _waitMs(800);
  return how;
}

async function sendPrompt(cdp, text) {
  return cdp.eval(`(() => {
    const box = document.getElementById('mr-input-box');
    if (!box) throw new Error('no mr-input-box');
    box.textContent = ${j(text)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.getElementById('mr-send-btn');
    if (!btn) throw new Error('no mr-send-btn');
    btn.click();
    return true;
  })()`);
}

// 收敛判定：orchestrator 已为本轮每位成员落下 assistant 消息，且 DOM 无 pending 气泡
async function waitSettled(cdp, meetingId, sids, timeoutMs, onTick) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  while (Date.now() < deadline) {
    const st = await gcState(cdp, meetingId);
    const cur = st && st.currentTurn;
    const done = new Set((st && st.messages || [])
      .filter(m => m && m.role === 'assistant' && m.turnNum === cur && m.sid).map(m => m.sid));
    if (onTick) await onTick({ st, cur, done, elapsed: Date.now() - t0 });
    if (sids.every(s => done.has(s))) {
      const pend = await cdp.eval("document.querySelectorAll('.mr-gc-msg.pending').length");
      if (pend === 0) return { settled: true, sec: Math.round((Date.now() - t0) / 1000), turn: cur };
    }
    await _waitMs(900);
  }
  return { settled: false, sec: Math.round((Date.now() - t0) / 1000) };
}

// ================================================================== PHASE live
async function phaseLive(cdp, hub, port) {
  const R = { phase: 'live', port, dataDir: DATA_DIR, workDir: WORK_DIR, realRounds: 0, scenarios: {} };
  await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer ready', 60000);
  await cdp.eval(SNAP_FN);
  const seam = await cdp.eval("({ mount: typeof window._mountSessionTurnCard })");
  if (seam.mount !== 'function') throw new Error('window._mountSessionTurnCard 不可用');
  fs.mkdirSync(WORK_DIR, { recursive: true });

  // ---- 建群 + 真实 CLI 成员 ----
  const meeting = await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('create-meeting', {
    title: '卡片复用压力测试', scene: 'general', workspace: ${j(WORK_DIR)} }))()`);
  if (!meeting || !meeting.id) throw new Error('create-meeting 失败');
  const meetingId = meeting.id;
  R.meetingId = meetingId;

  for (const kind of MEMBER_KINDS) {
    const r = await cdp.eval(`(async () => {
      const r = await require('electron').ipcRenderer.invoke('add-meeting-sub', {
        meetingId: ${j(meetingId)}, kind: ${j(kind)}, opts: { cwd: ${j(WORK_DIR)} } });
      return { ok: !!(r && r.session), sid: r && r.session && r.session.id };
    })()`);
    if (!r.ok) throw new Error(`add-meeting-sub 失败：${kind}`);
    console.error(`[setup] ${kind} -> ${r.sid}`);
    await _waitMs(1500);
  }

  const fresh = await cdp.eval(`(async () => {
    const all = await require('electron').ipcRenderer.invoke('get-meetings');
    return all.find(x => x.id === ${j(meetingId)});
  })()`);
  const sids = ((fresh && fresh.subSessions) || []).slice();
  if (sids.length !== MEMBER_KINDS.length) throw new Error(`成员数不对：${sids.length}`);
  const kindBySid = await cdp.eval(`(async () => {
    const all = await require('electron').ipcRenderer.invoke('get-sessions');
    const m = {};
    for (const s of (all || [])) if (${j(sids)}.includes(s.id)) m[s.id] = s.kind;
    return m;
  })()`);
  R.sids = sids; R.kindBySid = kindBySid;
  const nameOf = (sid) => kindBySid[sid] || sid.slice(0, 8);

  R.openedVia = await openMeetingLikeUser(cdp, meetingId);

  // ---- 等三家 CLI ready ----
  const readyT0 = Date.now();
  let readyMap = {};
  const readyDeadline = Date.now() + 240000;
  while (Date.now() < readyDeadline) {
    readyMap = await cdp.eval(`(async () => {
      const ipc = require('electron').ipcRenderer; const r = {};
      for (const s of ${j(sids)}) r[s] = await ipc.invoke('cli-ready-status', s);
      return r;
    })()`);
    if (sids.every(s => readyMap[s])) break;
    await _waitMs(2000);
  }
  R.cliReady = {};
  for (const s of sids) R.cliReady[nameOf(s)] = !!readyMap[s];
  R.cliReadySec = Math.round((Date.now() - readyT0) / 1000);
  R.notReady = sids.filter(s => !readyMap[s]).map(nameOf);

  // ================= 场景 A：佐证截图轮（R1 富提问） =================
  const A = { round: 1, prompt: P_RICH };
  const t0 = Date.now();
  await sendPrompt(cdp, P_RICH); R.realRounds += 1;
  let best = { score: -1 }, shots = {}, lastShotAt = 0;
  const timeline = [];
  const peak = {};
  const settleA = await waitSettled(cdp, meetingId, sids, 12 * 60 * 1000, async ({ st }) => {
    const ids = idBySidForTurn(st, 1);
    const s = await snap(cdp, sids, ids);
    // 记录峰值
    for (const sid of sids) {
      const c = s[sid] || {}; const p = peak[sid] || (peak[sid] = {});
      for (const k of ['cards', 'thinkingDetails', 'toolCluster', 'toolRows', 'codeBlocks',
        'codeTokens', 'metaPills', 'bodyLen', 'cardFallback']) p[k] = Math.max(p[k] || 0, c[k] || 0);
      if (c.cardSessionId) p.cardSessionId = c.cardSessionId;
      if (c.bodyHead && c.bodyHead.length > (p.bodyHead || '').length) p.bodyHead = c.bodyHead;
    }
    const tick = { t: Math.round((Date.now() - t0) / 1000) };
    for (const sid of sids) {
      const c = s[sid] || {};
      tick[nameOf(sid)] = `c${c.cards || 0}/th${c.thinkingDetails || 0}/tr${c.toolRows || 0}/cb${c.codeBlocks || 0}/L${c.bodyLen || 0}${c.pending ? '/P' : ''}${c.waiting ? '/W' : ''}`;
    }
    timeline.push(tick);
    // 「多家同时各自渲染真卡片」的评分：有内容的成员数为主，工具/代码为辅
    const contentful = sids.filter(sid => {
      const c = s[sid] || {};
      return c.cards > 0 && (c.bodyLen > 0 || c.thinkingDetails > 0 || c.toolRows > 0);
    });
    const tr = sids.reduce((a, sid) => a + ((s[sid] || {}).toolRows || 0), 0);
    const cb = sids.reduce((a, sid) => a + ((s[sid] || {}).codeBlocks || 0), 0);
    const bl = sids.reduce((a, sid) => a + ((s[sid] || {}).bodyLen || 0), 0);
    const anyPending = sids.some(sid => (s[sid] || {}).pending);
    const score = contentful.length * 10000 + Math.min(tr, 40) * 100 + cb * 60 + Math.min(bl / 40, 60)
      + (anyPending ? 500 : 0);
    if (contentful.length >= 2 && score > best.score && Date.now() - lastShotAt > 1200) {
      lastShotAt = Date.now();
      best = { score, contentful: contentful.map(nameOf), anyPending, at: Math.round((Date.now() - t0) / 1000), snap: s };
      shots.live = await shoot(cdp, 'stress-multi-member-live.png');
      shots.liveExpanded = await shoot(cdp, 'stress-multi-member-live-expanded.png', { expand: true });
      best.perMember = {};
      const s2 = await snap(cdp, sids, ids);
      for (const sid of sids) best.perMember[nameOf(sid)] = { sid, ...(s2[sid] || {}) };
      best.global = s2.__global;
    }
  });
  A.settle = settleA;
  A.timeline = timeline;
  A.peakPerMember = {};
  for (const sid of sids) A.peakPerMember[nameOf(sid)] = { sid, ...(peak[sid] || {}) };
  A.bestLiveMoment = best.score >= 0 ? { score: best.score, atSec: best.at, contentful: best.contentful, anyPending: best.anyPending, perMember: best.perMember, global: best.global } : null;

  await _waitMs(3000);
  const stateA = await gcState(cdp, meetingId);
  const finalA = await snap(cdp, sids, idBySidForTurn(stateA, 1));
  shots.settled = await shoot(cdp, 'stress-multi-member-settled.png');
  shots.settledExpanded = await shoot(cdp, 'stress-multi-member-settled-expanded.png', { expand: true });
  A.settledPerMember = {};
  for (const sid of sids) A.settledPerMember[nameOf(sid)] = { sid, ...(finalA[sid] || {}) };
  A.settledGlobal = finalA.__global;
  A.screenshots = shots;
  // 卡片归属断言：每张卡的 cardSessionId 必须等于其气泡所属成员的 sid
  A.ownershipViolations = ownershipViolations(await cardMap(cdp), stateA);
  A.perf = await perfMetrics(cdp);
  R.scenarios.evidence = A;
  console.error(`[A] settled=${settleA.settled} best=${JSON.stringify(best.contentful || [])}`);

  // ================= 场景 1：连续多轮不重启 =================
  const S1 = { rounds: [], prompts: P_SHORT };
  for (let i = 0; i < P_SHORT.length; i++) {
    const turnNum = 2 + i;
    const rt0 = Date.now();
    await sendPrompt(cdp, P_SHORT[i]); R.realRounds += 1;
    const st = await waitSettled(cdp, meetingId, sids, 5 * 60 * 1000);
    await _waitMs(2000);
    const stNow = await gcState(cdp, meetingId);
    const s = await snap(cdp, sids, idBySidForTurn(stNow, turnNum));
    const per = {};
    for (const sid of sids) per[nameOf(sid)] = { sid, ...(s[sid] || {}) };
    const cm = await cardMap(cdp);
    S1.rounds.push({
      turnNum, settled: st.settled, sec: Math.round((Date.now() - rt0) / 1000),
      perMember: per, global: s.__global, perf: await perfMetrics(cdp),
      ownershipViolations: ownershipViolations(cm, stNow),
      // 串轮检查：本轮气泡里出现了别的轮次的 id
      msgIds: cm.map(x => x.msgId),
    });
    console.error(`[S1] turn ${turnNum} settled=${st.settled} turnCards=${s.__global.turnCards} nodes=${s.__global.domNodes}`);
  }
  // 每轮 turn-card 总数应线性、不失控
  const cards = S1.rounds.map(r => r.global.turnCards);
  S1.turnCardGrowth = cards;
  S1.domNodeGrowth = S1.rounds.map(r => r.global.domNodes);
  S1.heapGrowthMB = S1.rounds.map(r => r.perf && r.perf.jsHeapMB);
  R.scenarios.multiRound = S1;

  // ================= 场景 2：运行中追加提问（superseded） =================
  const S2 = { promptA: P_SUPERSEDE_A, promptB: P_SUPERSEDE_B };
  try {
    const turnA = 5, turnB = 6;
    await sendPrompt(cdp, P_SUPERSEDE_A); R.realRounds += 1;
    // 等到至少一位成员进入 pending（真的在跑）
    await waitFor(cdp, "document.querySelectorAll('.mr-gc-msg.pending').length > 0", 'turnA pending', 60000);
    S2.pendingAtInterject = await cdp.eval("document.querySelectorAll('.mr-gc-msg.pending').length");
    await _waitMs(1200);
    S2.duringA = await snap(cdp, sids, idBySidForTurn(await gcState(cdp, meetingId), turnA));
    await sendPrompt(cdp, P_SUPERSEDE_B); R.realRounds += 1;
    const stB = await waitSettled(cdp, meetingId, sids, 5 * 60 * 1000);
    await _waitMs(2500);
    const stateAfter = await gcState(cdp, meetingId);
    S2.settled = stB;
    S2.turnAStatuses = (stateAfter.messages || []).filter(m => m.turnNum === turnA && m.role === 'assistant')
      .map(m => ({ who: nameOf(m.sid), status: m.status, len: m.len }));
    S2.turnBStatuses = (stateAfter.messages || []).filter(m => m.turnNum === turnB && m.role === 'assistant')
      .map(m => ({ who: nameOf(m.sid), status: m.status, len: m.len }));
    const sA = await snap(cdp, sids, idBySidForTurn(stateAfter, turnA));
    const sB = await snap(cdp, sids, idBySidForTurn(stateAfter, turnB));
    S2.domTurnA = {}; S2.domTurnB = {};
    for (const sid of sids) { S2.domTurnA[nameOf(sid)] = sA[sid]; S2.domTurnB[nameOf(sid)] = sB[sid]; }
    const cm = await cardMap(cdp);
    S2.ownershipViolations = ownershipViolations(cm, stateAfter);
    // 卡片挂错轮次：turnA 的气泡里出现 turnB 的内容 —— 用 msgId 前缀分组统计卡片数
    S2.cardsByTurn = cm.reduce((a, x) => {
      const m = /^a(\d+)-/.exec(x.msgId); const k = m ? `turn${m[1]}` : (x.msgId.startsWith('pending-') ? 'pending' : 'user');
      a[k] = (a[k] || 0) + x.cards; return a;
    }, {});
    S2.global = sB.__global;
    S2.shot = await shoot(cdp, 'stress-superseded-after.png');
  } catch (e) { S2.error = String(e && e.message || e); }
  R.scenarios.supersede = S2;
  console.error(`[S2] ${JSON.stringify(S2.turnAStatuses || S2.error)}`);

  // ================= 场景 3：运行中 ⏹ 停止本轮 =================
  const S3 = { prompt: P_STOP };
  try {
    const turnC = 7;
    await sendPrompt(cdp, P_STOP); R.realRounds += 1;
    await waitFor(cdp, "document.querySelectorAll('.mr-gc-msg.pending').length > 0", 'turnC pending', 60000);
    S3.pendingBeforeStop = await cdp.eval("document.querySelectorAll('.mr-gc-msg.pending').length");
    await _waitMs(600);
    S3.stopEntry = await cdp.eval(`(() => {
      const chip = document.querySelector('[data-gc-stop-turn]');
      if (chip) { chip.click(); return 'ui-chip'; }
      return null;
    })()`);
    if (!S3.stopEntry) {
      await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('groupchat:interrupt', { meetingId: ${j(meetingId)} }))()`);
      S3.stopEntry = 'ipc-fallback';
    }
    // 收敛：不再有 pending / 思考中
    const stopT0 = Date.now();
    let conv = false;
    while (Date.now() - stopT0 < 90000) {
      const g = await cdp.eval(`({
        pendingBubbles: document.querySelectorAll('.mr-gc-msg.pending').length,
        thinkingCards: document.querySelectorAll('.mr-gc-waiting').length })`);
      if (g.pendingBubbles === 0 && g.thinkingCards === 0) { conv = true; break; }
      await _waitMs(800);
    }
    S3.convergedSec = Math.round((Date.now() - stopT0) / 1000);
    S3.converged = conv;
    await _waitMs(2500);
    const stC = await gcState(cdp, meetingId);
    const sC = await snap(cdp, sids, idBySidForTurn(stC, turnC));
    S3.perMember = {};
    for (const sid of sids) S3.perMember[nameOf(sid)] = { sid, ...(sC[sid] || {}) };
    S3.global = sC.__global;
    S3.turnCStatuses = (stC.messages || []).filter(m => m.turnNum === turnC && m.role === 'assistant')
      .map(m => ({ who: nameOf(m.sid), status: m.status, len: m.len }));
    S3.shot = await shoot(cdp, 'stress-interrupted-after.png');
  } catch (e) { S3.error = String(e && e.message || e); }
  R.scenarios.stopTurn = S3;
  console.error(`[S3] ${JSON.stringify(S3.turnCStatuses || S3.error)}`);

  // ================= 收尾快照 =================
  R.finalPerf = await perfMetrics(cdp);
  R.finalGlobal = (await snap(cdp, sids)).__global;
  R.finalCardMap = await cardMap(cdp);
  R.finalState = await gcState(cdp, meetingId);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ meetingId, sids, kindBySid, dataDir: DATA_DIR }, null, 2));
  return R;
}

// ================================================================== PHASE restart
async function phaseRestart(cdp) {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const { meetingId, sids, kindBySid } = saved;
  const nameOf = (sid) => kindBySid[sid] || sid.slice(0, 8);
  const R = { phase: 'restart', meetingId, sids, kindBySid };

  await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer ready', 60000);
  await cdp.eval(SNAP_FN);
  const t0 = Date.now();
  R.openedVia = await openMeetingLikeUser(cdp, meetingId);
  await waitFor(cdp, "document.querySelectorAll('.mr-gc-msg').length > 0", 'history rendered', 40000);
  R.openMs = Date.now() - t0;
  await _waitMs(3000);

  const st = await gcState(cdp, meetingId);
  R.persistedTurns = st.currentTurn;
  R.persistedMessages = (st.messages || []).length;
  R.byTurn = {};
  for (const m of (st.messages || [])) {
    const k = `turn${m.turnNum}`;
    (R.byTurn[k] = R.byTurn[k] || []).push({ who: m.role === 'user' ? 'user' : nameOf(m.sid), status: m.status, len: m.len, head: m.head });
  }
  const cm = await cardMap(cdp);
  R.cardMap = cm;
  R.ownershipViolations = ownershipViolations(cm, st);
  R.cardsRendered = cm.reduce((a, x) => a + x.cards, 0);

  // ---- 逐轮 × 逐成员全量审计（重启后历史全在库里，零额度复算 live 阶段的每一轮）----
  R.perTurnPerMember = {};
  const maxTurn = Number(st.currentTurn) || 0;
  for (let t = 1; t <= maxTurn; t++) {
    const ids = idBySidForTurn(st, t);
    const s = await snap(cdp, sids, ids);
    const row = {};
    for (const sid of sids) {
      const c = s[sid] || {};
      row[nameOf(sid)] = {
        msgId: c.msgId, gcStatus: c.gcStatus, cards: c.cards,
        thinkingDetails: c.thinkingDetails, toolCluster: c.toolCluster, toolRows: c.toolRows,
        codeBlocks: c.codeBlocks, cardSessionId: c.cardSessionId, placeholder: c.placeholder,
        bodyLen: c.bodyLen, cardFallback: c.cardFallback,
        // 核心断言：卡片带的 sessionId 必须就是这位成员自己的 sid
        sidMatchesOwner: c.cardSessionId ? c.cardSessionId === sid : null,
      };
    }
    R.perTurnPerMember[`turn${t}`] = row;
  }

  // 逐成员历史轮断言（取每位成员最后一条）
  const sLast = await snap(cdp, sids, idBySidForTurn(st, maxTurn));
  R.perMemberLast = {};
  for (const sid of sids) R.perMemberLast[nameOf(sid)] = { sid, ...(sLast[sid] || {}) };
  R.global = sLast.__global;
  // 正文完整性：DOM 能读到的文本 vs 持久化 content 长度（有内容的轮不得只剩占位/空壳）
  const domBodies = await cdp.eval(`(() => {
    const out = [];
    for (const a of document.querySelectorAll('.mr-gc-msg.ai')) {
      const b = a.querySelector('.turn-body') || a.querySelector('.mr-gc-md');
      out.push({ msgId: a.getAttribute('data-gc-msg-id'), domLen: b ? (b.innerText || '').length : 0,
        hasCard: !!a.querySelector('.turn-card'), placeholder: a.querySelectorAll('.mr-gc-empty-placeholder').length });
    }
    return out;
  })()`);
  const byId = {};
  for (const m of (st.messages || [])) if (m.id) byId[m.id] = m;
  R.bodyIntegrity = domBodies.map((d) => {
    const m = byId[d.msgId] || null;
    return { ...d, who: m && m.sid ? nameOf(m.sid) : null, status: m ? m.status : null,
      persistedLen: m ? m.len : null,
      // 有正文的历史轮必须渲染出卡片、正文基本完整。
      //   容差 0.85：innerText 里不含 markdown 定界符（``` / ` / **），实测比持久化原文短 2-8 字符，
      //   这是"渲染掉了语法字符"不是"吞了内容"。低于 85% 才算真截断。
      ok: m ? (m.len > 0 ? (d.hasCard && d.domLen >= Math.floor(m.len * 0.85))
        : (d.placeholder > 0 || d.domLen === 0)) : false };
  });
  R.bodyIntegrityFailures = R.bodyIntegrity.filter(x => !x.ok);
  R.rendererErrors = await cdp.eval(`(window.__stressErrors || []).slice(0, 20)`).catch(() => null);
  R.perf = await perfMetrics(cdp);
  R.shot = await shoot(cdp, 'stress-after-restart-history.png');
  R.crashed = false;
  return R;
}

// ================================================================== PHASE fake（零真实额度）
async function phaseFake(cdp) {
  const R = { phase: 'fake', members: [] };
  await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer ready', 60000);
  await cdp.eval(SNAP_FN);
  const N = Number(process.env.GC_STRESS_FAKE_N || 8);
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const meeting = await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('create-meeting', {
    title: '成员数压力（PowerShell 假成员）', scene: 'general', workspace: ${j(WORK_DIR)} }))()`);
  const meetingId = meeting.id;
  R.meetingId = meetingId;

  await openMeetingLikeUser(cdp, meetingId);

  const addTimes = [];
  for (let i = 0; i < N; i++) {
    const a0 = Date.now();
    const r = await cdp.eval(`(async () => {
      const r = await require('electron').ipcRenderer.invoke('add-meeting-sub', {
        meetingId: ${j(meetingId)}, kind: 'powershell', opts: { cwd: ${j(WORK_DIR)} } });
      return r && r.session && r.session.id;
    })()`);
    addTimes.push({ n: i + 1, sid: r, addMs: Date.now() - a0 });
    await _waitMs(500);
  }
  const fresh = await cdp.eval(`(async () => {
    const all = await require('electron').ipcRenderer.invoke('get-meetings');
    return all.find(x => x.id === ${j(meetingId)});
  })()`);
  const sids = ((fresh && fresh.subSessions) || []).slice();
  R.memberCount = sids.length;
  R.addTimes = addTimes;

  await openMeetingLikeUser(cdp, meetingId);
  await _waitMs(1500);

  // 发一轮（PowerShell 永不 emit turn-complete → 全员长期 pending，正合适压 DOM）
  await sendPrompt(cdp, `成员数压力测试：${sids.length} 位成员同时思考`);
  await waitFor(cdp, "document.querySelectorAll('.mr-gc-msg.pending').length > 0", 'fake members thinking', 40000);
  R.perfBeforeBlocks = await perfMetrics(cdp);
  R.beforeBlocks = (await snap(cdp, sids)).__global;

  // 给每位成员推 transcript-tap 同构 blocks（thinking + 3 工具 + 代码块正文）
  const BLOCKS = (n) => ([
    { type: 'thinking', text: `成员 ${n} 的思考：\n1) 读取上下文\n2) 检查渲染链路\n3) 汇报结论\n` + 'x'.repeat(400) },
    { type: 'tool_use', name: 'Read', input: { file_path: `C:\\\\Vibe\\\\_scratch\\\\gccard-stress\\\\f${n}.txt` } },
    { type: 'tool_use', name: 'Bash', input: { command: `echo member-${n}` } },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'mountSessionTurnCard' } },
    { type: 'text', text: `**成员 ${n} 的回答**\n\n压力测试正文。\n\n\`\`\`js\nconst m${n} = mountSessionTurnCard(sid, turn, { container: host });\nconsole.log(m${n});\n\`\`\`\n\n结束。` },
  ]);
  const pushT0 = Date.now();
  for (let i = 0; i < sids.length; i++) {
    await cdp.eval(`(() => {
      require('electron').ipcRenderer.emit('groupchat-partial-update', {}, {
        meetingId: ${j(meetingId)}, sid: ${j(sids[i])}, status: 'streaming',
        text: '压力测试正文。', source: 'tap', cleanBufLen: 800, blocks: ${j(BLOCKS(i + 1))} });
      return true;
    })()`);
  }
  R.pushAllMs = Date.now() - pushT0;
  await _waitMs(2500);

  // 渲染耗时：强制一次全量重渲并计时（真实 UI 路径 refreshGroupChatPanel 由 partial-update 触发，
  //   这里用 openMeeting 重开量"全量重绘 + hydrate N 张卡片"的成本）
  const renderMs = await cdp.eval(`(async () => {
    const ipc = require('electron').ipcRenderer;
    const all = await ipc.invoke('get-meetings');
    const m = all.find(x => x.id === ${j(meetingId)});
    const t0 = performance.now();
    window.MeetingRoom.openMeeting(${j(meetingId)}, m);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round(performance.now() - t0);
  })()`);
  R.fullRerenderMs = renderMs;
  await _waitMs(1500);

  const s = await snap(cdp, sids);
  R.afterBlocks = s.__global;
  R.perMember = {};
  for (let i = 0; i < sids.length; i++) R.perMember[`ps${i + 1}`] = { sid: sids[i], ...(s[sids[i]] || {}) };
  R.perfAfterBlocks = await perfMetrics(cdp);
  R.ownershipViolations = (await cardMap(cdp)).filter(x => x.cardSid && !x.msgId.endsWith(x.cardSid));
  R.shot = await shoot(cdp, 'stress-many-members.png');
  return R;
}

// ================================================================== main
(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await availablePort(PREFERRED_PORT);
  let hub = null, cdp = null, out = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port, label: `stress-gccard-${PHASE}`,
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Performance.enable').catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: Number(process.env.GC_STRESS_W || 1680),
      height: Number(process.env.GC_STRESS_H || 1500),
      deviceScaleFactor: 1, mobile: false,
    });
    if (PHASE === 'live') out = await phaseLive(cdp, hub, port);
    else if (PHASE === 'restart') out = await phaseRestart(cdp);
    else if (PHASE === 'fake') out = await phaseFake(cdp);
    else throw new Error(`unknown phase ${PHASE}`);
    out.hubLogTail = hub.log().slice(-25);
    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`===RESULT=== ${OUT_FILE}`);
    console.log(JSON.stringify(out, null, 2).slice(0, 4000));
  } catch (err) {
    if (hub && typeof hub.log === 'function') {
      console.error('--- isolated hub log tail ---');
      console.error(hub.log().slice(-60).join('\n'));
    }
    if (out) fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    throw err;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub, { timeoutMs: 25000 }).catch(() => {});
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
