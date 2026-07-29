'use strict';
// AI 群聊卡片复用 —— **真实 AI 成员** E2E（2026-07-29）
//
// 与 tests/e2e-groupchat-card-reuse-cdp.js 的区别：那个用 PowerShell 假成员 + 手工注入
// transcript-tap 形状的 blocks（渲染链路真、blocks 生产环节是替身）。本脚本把最后一环
// 也换成真的：Claude Code / Codex CLI / Kimi Code 三家真 CLI，真提问、真 transcript、
// 真 transcript-tap 解析（三家解析器不同：core/claude-transcript-parser.js /
// codex-transcript-parser.js / kimi-transcript-parser.js）。
//
// 阶段：
//   --phase=1  起隔离 Hub → 建群（3 家真 CLI）→ 发一轮 → 流式期间高频快照 + 截图
//              → 等三家 settle → 完成态截图 → 存 state → 优雅退出
//   --phase=2  用**同一隔离数据目录**重启 → 打开同一群聊 → 断言历史轮的降级形态
//              → 截图 → 再点进各成员子 session 的卡片视图做对照 → 截图
//
// 铁律：CLAUDE_HUB_DATA_DIR 隔离 + 独立 CDP 端口 + PID 白名单（hub-launcher 内置），
//       剥离嵌套 CLAUDECODE env（否则 spawn 的 claude 自认嵌套子会话、不写 transcript
//       jsonl，transcript-tap 拿不到 blocks → 假的"渲染失败"结论）。

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
const DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR
  || 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-real-gccard';
const WORK_DIR = process.env.GC_REAL_WORKDIR || 'C:\\Vibe\\_scratch\\gccard-realtest';
const PREFERRED_PORT = Number(process.env.GC_REAL_E2E_PORT || 9237);
const STATE_FILE = path.join(ARTIFACT_DIR, 'real-gccard-state.json');
const PHASE = (process.argv.find(a => a.startsWith('--phase=')) || '--phase=1').split('=')[1];

const MEMBER_KINDS = ['claude', 'codex', 'kimi'];
const PROMPT = '请在当前目录建一个 hello.txt 写入一行 "gccard ok"，然后读回来确认，并用一小段代码说明你做了什么。';

const j = (v) => JSON.stringify(v);

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(() => resolve(true)); });
    server.listen(port, '127.0.0.1');
  });
}
async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 40; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No free CDP port from ${preferred}`);
}

async function waitFor(cdp, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { if (await cdp.eval(expression)) return true; } catch (err) { last = err; }
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function shoot(cdp, name) {
  await cdp.send('Page.bringToFront').catch(() => {});
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const f = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return { file: f, bytes: fs.statSync(f).size };
}

// 每个成员气泡的结构化快照。pending 消息 id 是 `pending-<sid>`，settle 后是 `a<turn>-<sid>`，
//   两者都以 sid 结尾 → 用 [data-gc-msg-id$=...] 统一取。
const SNAP_FN = `
window.__gcSnap = function (sids) {
  const out = {};
  for (const sid of sids) {
    const arts = [...document.querySelectorAll('.mr-gc-msg')].filter(
      a => (a.getAttribute('data-gc-msg-id') || '').endsWith(sid));
    const el = arts[arts.length - 1] || null;
    const card = el ? el.querySelector('.turn-card') : null;
    const body = card ? card.querySelector('.turn-body') : null;
    out[sid] = {
      article: !!el,
      msgId: el ? el.getAttribute('data-gc-msg-id') : null,
      gcStatus: el ? (el.getAttribute('data-gc-status') || '') : null,
      pending: el ? el.classList.contains('pending') : null,
      hosts: el ? el.querySelectorAll('.mr-gc-card-host').length : 0,
      fallbackHosts: el ? el.querySelectorAll('.mr-gc-card-fallback').length : 0,
      cards: el ? el.querySelectorAll('.turn-card').length : 0,
      thinking: el ? el.querySelectorAll('.turn-thinking').length : 0,
      toolClusters: el ? el.querySelectorAll('.tc-cluster').length : 0,
      toolRows: el ? el.querySelectorAll('.tc-row-name').length : 0,
      codeBlocks: el ? el.querySelectorAll('.code-block-wrap').length : 0,
      codeTokens: el ? el.querySelectorAll('.code-block-wrap .token').length : 0,
      preTags: el ? el.querySelectorAll('pre').length : 0,
      metaPills: el ? el.querySelectorAll('.turn-meta-pills .pill').length : 0,
      avatar: el ? el.querySelectorAll('.mr-gc-avatar, .mr-gc-msg > .mr-gc-avatar-wrap, [class*="avatar"]').length : 0,
      waiting: el ? el.querySelectorAll('.mr-gc-waiting').length : 0,
      placeholder: el ? el.querySelectorAll('.mr-gc-empty-placeholder, .mr-ft-thinking-placeholder').length : 0,
      cardSessionId: card ? (card.dataset.sessionId || null) : null,
      bodyLen: body ? (body.innerText || '').length : 0,
      bodyHead: body ? (body.innerText || '').slice(0, 140) : '',
      articleTextLen: el ? (el.innerText || '').length : 0,
    };
  }
  out.__global = {
    overlayCards: document.querySelectorAll('#msg-overlay .turn-card').length,
    overlayIndicators: document.querySelectorAll('#msg-overlay .streaming-indicator').length,
    sessionTurnsSize: (window._sessionTurns && window._sessionTurns.size) || 0,
    gcMessages: document.querySelectorAll('.mr-gc-msg').length,
    turnDividers: document.querySelectorAll('.mr-gc-turn-divider, .mr-gc-turn-sep, [class*="turn-divider"]').length,
  };
  return out;
};
true;`;

function snap(cdp, sids) { return cdp.eval(`window.__gcSnap(${j(sids)})`); }

function mergeMax(acc, s, sids) {
  const NUM = ['hosts', 'cards', 'thinking', 'toolClusters', 'toolRows', 'codeBlocks',
    'codeTokens', 'metaPills', 'bodyLen', 'fallbackHosts'];
  for (const sid of sids) {
    const cur = s[sid]; if (!cur) continue;
    if (!acc[sid]) acc[sid] = { firstCardAtMs: null, everWaiting: false, statuses: new Set() };
    const a = acc[sid];
    for (const k of NUM) a[k] = Math.max(a[k] || 0, cur[k] || 0);
    if (cur.waiting > 0) a.everWaiting = true;
    if (cur.gcStatus) a.statuses.add(cur.gcStatus);
    if (cur.cards > 0 && a.firstCardAtMs == null) a.firstCardAtMs = Date.now();
    if (cur.bodyHead && (cur.bodyHead.length > (a.bodyHead || '').length)) a.bodyHead = cur.bodyHead;
  }
  return acc;
}

// ---------------------------------------------------------------- phase 1
async function phase1(cdp, hub, port) {
  await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer ready', 60000);
  await cdp.eval(SNAP_FN);

  const seam = await cdp.eval("({ mount: typeof window._mountSessionTurnCard, load: typeof window._loadSessionHistoryToOverlay })");
  if (seam.mount !== 'function') throw new Error('window._mountSessionTurnCard 不可用');

  fs.mkdirSync(WORK_DIR, { recursive: true });

  // 建群（先空群，再逐个加成员——每次 add-meeting-sub 都是独立 IPC，
  //   避免一次调用里 spawn 3 个真 CLI 撞上 CDP 30s eval 超时）
  const meeting = await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('create-meeting', {
    title: '真实AI卡片复用验证', scene: 'general', workspace: ${j(WORK_DIR)}
  }))()`);
  if (!meeting || !meeting.id) throw new Error('create-meeting 失败');
  const meetingId = meeting.id;

  for (const kind of MEMBER_KINDS) {
    const r = await cdp.eval(`(async () => {
      const r = await require('electron').ipcRenderer.invoke('add-meeting-sub', {
        meetingId: ${j(meetingId)}, kind: ${j(kind)}, opts: { cwd: ${j(WORK_DIR)} } });
      return { ok: !!(r && r.session), sid: r && r.session && r.session.id,
               kind: r && r.session && r.session.kind, cwd: r && r.session && r.session.cwd,
               subs: r && r.meeting && (r.meeting.subSessions || []).length };
    })()`);
    if (!r.ok) throw new Error(`add-meeting-sub 失败：${kind}`);
    console.error(`[setup] member ${kind} -> ${r.sid} cwd=${r.cwd} subs=${r.subs}`);
    await _waitMs(1500);
  }

  const fresh = await cdp.eval(`(async () => {
    const all = await require('electron').ipcRenderer.invoke('get-meetings');
    return all.find(x => x.id === ${j(meetingId)});
  })()`);
  const sids = ((fresh && fresh.subSessions) || []).slice();
  if (sids.length !== 3) throw new Error(`期望 3 位成员，实际 ${sids.length}：${JSON.stringify(sids)}`);

  const kindBySid = await cdp.eval(`(async () => {
    const all = await require('electron').ipcRenderer.invoke('get-sessions');
    const m = {};
    for (const s of (all || [])) if (${j(sids)}.includes(s.id)) m[s.id] = { kind: s.kind, cwd: s.cwd, title: s.title };
    return m;
  })()`);

  await cdp.eval(`(async () => {
    localStorage.setItem('mr-group-chat-view-mode', 'chat');
    const ipc = require('electron').ipcRenderer;
    const all = await ipc.invoke('get-meetings');
    window.MeetingRoom.openMeeting(${j(meetingId)}, all.find(x => x.id === ${j(meetingId)}));
    return true;
  })()`);
  await waitFor(cdp, "!!document.querySelector('.mr-gc-shell')", 'group chat shell', 30000);

  // 等三家 CLI ready（真 CLI 冷启动慢：claude/kimi ~10-30s，codex 可能更久）
  const readyDeadline = Date.now() + 240000;
  let readyMap = {};
  while (Date.now() < readyDeadline) {
    readyMap = await cdp.eval(`(async () => {
      const ipc = require('electron').ipcRenderer; const r = {};
      for (const s of ${j(sids)}) r[s] = await ipc.invoke('cli-ready-status', s);
      return r;
    })()`);
    if (sids.every(s => readyMap[s])) break;
    await _waitMs(2000);
  }
  const notReady = sids.filter(s => !readyMap[s]);

  // 发一轮（真实 UI 路径）
  const sendTs = Date.now();
  await cdp.eval(`(() => {
    const box = document.getElementById('mr-input-box');
    box.textContent = ${j(PROMPT)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('mr-send-btn').click();
    return true;
  })()`);

  // --- 流式期间高频快照 ---
  const peak = {};
  const timeline = [];
  let liveShot = null, richShot = null;
  const pollDeadline = Date.now() + 15 * 60 * 1000;
  let settled = false;
  while (Date.now() < pollDeadline) {
    const s = await snap(cdp, sids);
    mergeMax(peak, s, sids);
    const tick = { t: Math.round((Date.now() - sendTs) / 1000) };
    for (const sid of sids) {
      const c = s[sid] || {};
      tick[kindBySid[sid] ? kindBySid[sid].kind : sid] =
        `c${c.cards || 0}/th${c.thinking || 0}/tc${c.toolRows || 0}/cb${c.codeBlocks || 0}/len${c.bodyLen || 0}/${c.pending ? 'P' : '-'}${c.waiting ? 'W' : ''}`;
    }
    timeline.push(tick);

    // 第一次出现"任一家有卡片且还在 pending" → 流式截图
    const anyLiveCard = sids.some(sid => (s[sid] || {}).cards > 0 && (s[sid] || {}).pending);
    if (!liveShot && anyLiveCard) liveShot = await shoot(cdp, 'real-groupchat-streaming-first-card.png');
    // 三家都有卡片且仍在 pending → 最有价值的"正在输出中"截图
    const allLiveCards = sids.every(sid => (s[sid] || {}).cards > 0);
    const anyPending = sids.some(sid => (s[sid] || {}).pending);
    if (!richShot && allLiveCards && anyPending) richShot = await shoot(cdp, 'real-groupchat-streaming-all-three.png');

    // 收敛判定：orchestrator 持久化里本轮已为每位成员落下 assistant 消息，且 DOM 无 pending
    const st = await cdp.eval(`(async () => {
      const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} });
      const cur = r && r.currentTurn;
      const done = (r && r.messages || []).filter(m => m && m.turnNum === cur && m.sid).map(m => m.sid);
      return { currentTurn: cur, doneSids: [...new Set(done)], msgs: (r && r.messages || []).length };
    })()`).catch(() => null);
    tick.done = st ? st.doneSids.length : -1;
    if (st && sids.every(s => st.doneSids.includes(s))) {
      const pend = await cdp.eval("document.querySelectorAll('.mr-gc-msg.pending').length");
      if (pend === 0) { settled = true; break; }
    }
    await _waitMs(1500);
  }

  await _waitMs(2500);
  const finalSnap = await snap(cdp, sids);
  const doneShot = await shoot(cdp, 'real-groupchat-completed-before-restart.png');

  const gcState = await cdp.eval(`(async () => {
    const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} });
    return { currentTurn: r && r.currentTurn,
      messages: (r && r.messages || []).map(m => ({ id: m.id, sid: m.sid, turnNum: m.turnNum,
        status: m.status, role: m.role, len: (m.content || '').length,
        head: String(m.content || '').slice(0, 100) })) };
  })()`);

  const peakOut = {};
  for (const sid of sids) {
    const p = peak[sid] || {};
    peakOut[(kindBySid[sid] || {}).kind || sid] = {
      sid, ...p, statuses: [...(p.statuses || [])],
      firstCardAfterSendSec: p.firstCardAtMs ? Math.round((p.firstCardAtMs - sendTs) / 1000) : null,
    };
    delete peakOut[(kindBySid[sid] || {}).kind || sid].firstCardAtMs;
  }
  const result = {
    phase: 1, ok: true, port, dataDir: DATA_DIR, workDir: WORK_DIR, meetingId, sids, kindBySid,
    cliReady: readyMap, notReady, settled,
    peakDuringStreaming: peakOut,
    finalSnapshot: finalSnap,
    gcState,
    screenshots: { liveShot, richShot, doneShot },
    timeline: timeline.filter((_, i) => i % 2 === 0).slice(0, 120),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify({ meetingId, sids, kindBySid, dataDir: DATA_DIR }, null, 2));
  console.log('===PHASE1_RESULT===');
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ---------------------------------------------------------------- phase 2
async function phase2(cdp) {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const { meetingId, sids, kindBySid } = saved;

  await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer ready', 60000);
  await cdp.eval(SNAP_FN);

  // 真实 UI 路径：selectMeeting（侧栏点群聊时走的同一个函数）
  await cdp.eval(`(async () => {
    localStorage.setItem('mr-group-chat-view-mode', 'chat');
    if (window.__hubE2E && window.__hubE2E.selectMeeting) { window.__hubE2E.selectMeeting(${j(meetingId)}); return 'selectMeeting'; }
    const all = await require('electron').ipcRenderer.invoke('get-meetings');
    const m = all.find(x => x.id === ${j(meetingId)});
    if (!m) throw new Error('重启后找不到该群聊');
    window.MeetingRoom.openMeeting(${j(meetingId)}, m);
    return 'openMeeting';
  })()`);
  await waitFor(cdp, "!!document.querySelector('.mr-gc-shell')", 'group chat shell (after restart)', 40000);
  await waitFor(cdp, "document.querySelectorAll('.mr-gc-msg').length > 0", 'history messages rendered', 30000);
  await _waitMs(2500);

  const afterRestart = await snap(cdp, sids);
  const shotHistory = await shoot(cdp, 'real-groupchat-history-after-restart.png');

  // 外壳细节：头像 / 成员名 / 轮次分组
  const shell = await cdp.eval(`(() => {
    const out = {};
    for (const sid of ${j(sids)}) {
      const arts = [...document.querySelectorAll('.mr-gc-msg')].filter(a => (a.getAttribute('data-gc-msg-id')||'').endsWith(sid));
      const el = arts[arts.length - 1];
      if (!el) { out[sid] = { found: false }; continue; }
      const av = el.querySelector('.mr-gc-avatar, .mr-gc-av, img, .mr-gc-msg-avatar');
      const meta = el.querySelector('.mr-gc-meta, .mr-gc-msg-meta, .mr-gc-name');
      out[sid] = {
        found: true,
        classes: el.className,
        avatarHtml: av ? av.outerHTML.slice(0, 120) : null,
        metaText: meta ? meta.innerText.replace(/\\s+/g,' ').slice(0, 80) : null,
        hasCardShell: !!el.querySelector('.turn-card'),
        bubbleHasCard: !!el.querySelector('.mr-gc-bubble.has-card'),
        actions: {
          copy: !!el.querySelector('.mr-gc-copy-btn'),
          prompt: !!el.querySelector('.mr-gc-prompt-btn'),
          resync: !!el.querySelector('.mr-gc-resync-btn'),
        },
      };
    }
    out.__turnHeaders = [...document.querySelectorAll('.mr-gc-messages [class*="turn"]')]
      .map(e => e.className).filter((v,i,a)=>a.indexOf(v)===i).slice(0, 12);
    out.__userMsgs = document.querySelectorAll('.mr-gc-msg.mine').length;
    out.__aiMsgs = document.querySelectorAll('.mr-gc-msg.ai').length;
    return out;
  })()`);

  // --- 对照：点进各成员子 session 的卡片视图 ---
  const subSessions = {};
  const subShots = {};
  for (const sid of sids) {
    const kind = (kindBySid[sid] || {}).kind || sid;
    await cdp.eval(`(() => {
      // 真实 UI 路径：侧栏展开群聊 → 点子 session。展开按钮找不到时退回全局 selectSession。
      const meetingRow = document.querySelector('.session-item[data-meeting-id=' + JSON.stringify(${j(meetingId)}) + ']');
      const tog = meetingRow && meetingRow.querySelector('[data-action="toggle-expand"]');
      if (tog && !document.querySelector('.session-item.child[data-session-id=' + JSON.stringify(${j(sid)}) + ']')) tog.click();
      return true;
    })()`).catch(() => {});
    await _waitMs(400);
    const clicked = await cdp.eval(`(() => {
      const el = document.querySelector('.session-item.child[data-session-id=' + JSON.stringify(${j(sid)}) + ']');
      if (el) { el.click(); return 'sidebar-click'; }
      // 侧栏未展开时退到 selectSession —— 与侧栏点击命中的是同一个函数
      if (window.__hubE2E && window.__hubE2E.selectSession) { window.__hubE2E.selectSession(${j(sid)}); return 'selectSession'; }
      return null;
    })()`);
    await _waitMs(1200);
    // 切到卡片视图
    await cdp.eval(`(() => {
      const b = document.querySelector('.view-toggle-btn[data-view="card"]');
      if (b) b.click();
      return true;
    })()`);
    // 卡片历史是异步 IPC + transcript parse，给足时间
    let loaded = null;
    try {
      await waitFor(cdp, "document.querySelectorAll('#msg-overlay .turn-card').length > 0",
        `sub-session cards ${kind}`, 45000);
      loaded = 'sidebar-click';
    } catch (e) {
      // 兜底：直接调子 session 卡片视图的加载函数（与 UI 同一函数）
      const r = await cdp.eval(`(async () => {
        if (typeof window._loadSessionHistoryToOverlay !== 'function') return { err: 'no-fn' };
        return await window._loadSessionHistoryToOverlay(${j(sid)});
      })()`).catch(err => ({ err: String(err && err.message) }));
      loaded = 'fallback:_loadSessionHistoryToOverlay ' + JSON.stringify(r);
      await _waitMs(1500);
    }
    const m = await cdp.eval(`(() => {
      const ov = document.getElementById('msg-overlay');
      if (!ov) return { overlay: false };
      const cards = [...ov.querySelectorAll('.turn-card')];
      const asst = cards.filter(c => !c.classList.contains('turn-user'));
      const last = asst[asst.length - 1] || cards[cards.length - 1] || null;
      const body = last ? last.querySelector('.turn-body') : null;
      return {
        overlay: true,
        totalCards: cards.length,
        assistantCards: asst.length,
        thinking: ov.querySelectorAll('.turn-thinking').length,
        toolClusters: ov.querySelectorAll('.tc-cluster').length,
        toolRows: ov.querySelectorAll('.tc-row-name').length,
        codeBlocks: ov.querySelectorAll('.code-block-wrap').length,
        codeTokens: ov.querySelectorAll('.code-block-wrap .token').length,
        metaPills: ov.querySelectorAll('.turn-meta-pills .pill').length,
        placeholder: ov.querySelectorAll('.msg-overlay-placeholder').length,
        placeholderText: (ov.querySelector('.msg-overlay-placeholder') || {}).innerText || '',
        lastBodyLen: body ? (body.innerText || '').length : 0,
        lastBodyHead: body ? (body.innerText || '').slice(0, 140) : '',
        lastCardSid: last ? (last.dataset.sessionId || null) : null,
      };
    })()`);
    subSessions[kind] = { sid, entry: clicked, loaded, ...m };
    subShots[kind] = await shoot(cdp, `real-subsession-after-restart-${kind}.png`);
  }

  const out = {
    phase: 2, ok: true, meetingId, sids, kindBySid,
    afterRestartGroupChat: afterRestart,
    shellDetails: shell,
    subSessionComparison: subSessions,
    screenshots: { history: shotHistory, sub: subShots },
  };
  console.log('===PHASE2_RESULT===');
  console.log(JSON.stringify(out, null, 2));
  return out;
}

// ---------------------------------------------------------------- main
(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await availablePort(PREFERRED_PORT);
  let hub = null, cdp = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port, label: `real-gccard-p${PHASE}`,
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
    if (PHASE === '1') await phase1(cdp, hub, port);
    else await phase2(cdp);
  } catch (err) {
    if (hub && typeof hub.log === 'function') {
      console.error('--- isolated hub log tail ---');
      console.error(hub.log().slice(-60).join('\n'));
    }
    throw err;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    // 优雅退出：走 CDP page close → window-all-closed → before-quit 持久化 flush
    if (hub) await gracefulQuit(hub, { timeoutMs: 20000 }).catch(() => {});
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
