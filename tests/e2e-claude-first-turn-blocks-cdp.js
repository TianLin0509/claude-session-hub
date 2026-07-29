'use strict';
// B1 真实 AI 实测（2026-07-29 道雪）——「全新 Claude session 的第 1 轮就要拿到 transcript blocks」
//
// 复现的 bug：JsonlTail 只在 notifyStop（Stop hook）里创建，Stop hook 只在本轮结束才响
//   → 全新会话首轮 _streamingBuf 结构性恒空 → 群聊 partial.source 恒为 'placeholder'、
//   blockCount 恒 0、卡片恒「💭 思考中…」，而同期 transcript jsonl 里 thinking + 工具调用
//   + 正文早就写好了。
//
// 本脚本只验第 1 轮（额度敏感，默认只发 1 条 prompt）：
//   起隔离 Hub → 建群（唯一成员 = 全新 claude，**不是 resume**）→ 装 partial-update
//   录音机 → 发一条必然触发工具调用的问题 → **在本轮 settle 之前**断言
//   partial.source === 'tap' 且 blocks.length > 0 → 截图群聊里出现真卡片。
//
// 铁律：CLAUDE_HUB_DATA_DIR 隔离 + 独立 CDP 端口 + PID 白名单（hub-launcher 内置），
//       剥离嵌套 CLAUDECODE env（否则 spawn 的 claude 自认嵌套子会话、不写 transcript
//       jsonl，会得到假的"修复无效"结论）。

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
  || 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-fix-b1';
const WORK_DIR = process.env.B1_WORKDIR || 'C:\\Vibe\\_scratch\\b1-firstturn';
const PREFERRED_PORT = Number(process.env.B1_E2E_PORT || 9238);
const PROMPT = process.env.B1_PROMPT
  || '请在当前目录新建 b1.txt 并写入一行 "first turn ok"，然后读回来确认内容，最后用一句话说明你做了什么。';

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

// renderer 侧录音机：把每条 groupchat-partial-update 的 source / blocks 形态记下来。
// 这是"卡片层有没有米下锅"的第一手证据，比 DOM 更贴近 tap 的输出。
const RECORDER = `
(() => {
  const { ipcRenderer } = require('electron');
  window.__b1 = { t0: Date.now(), events: [], firstTapAtMs: null, firstTapEvent: null };
  ipcRenderer.on('groupchat-partial-update', (_e, p) => {
    const blocks = Array.isArray(p.blocks) ? p.blocks : [];
    const rec = {
      atMs: Date.now() - window.__b1.t0,
      sid: p.sid, status: p.status, source: p.source || null,
      blockCount: blocks.length,
      blockTypes: blocks.map(b => b && b.type),
      toolNames: blocks.filter(b => b && b.type === 'tool_use').map(b => b.name),
      textLen: (p.text || '').length,
    };
    window.__b1.events.push(rec);
    if (!window.__b1.firstTapAtMs && rec.source === 'tap' && rec.blockCount > 0) {
      window.__b1.firstTapAtMs = rec.atMs;
      window.__b1.firstTapEvent = rec;
    }
  });
  return true;
})()`;

// 群聊气泡结构快照（沿用 e2e-groupchat-real-ai-cards-cdp.js 的选择器口径）
const SNAP_FN = `
window.__b1Snap = function (sid) {
  const arts = [...document.querySelectorAll('.mr-gc-msg')].filter(
    a => (a.getAttribute('data-gc-msg-id') || '').endsWith(sid));
  const el = arts[arts.length - 1] || null;
  const card = el ? el.querySelector('.turn-card') : null;
  const body = card ? card.querySelector('.turn-body') : null;
  return {
    article: !!el,
    msgId: el ? el.getAttribute('data-gc-msg-id') : null,
    pending: el ? el.classList.contains('pending') : null,
    cards: el ? el.querySelectorAll('.turn-card').length : 0,
    thinking: el ? el.querySelectorAll('.turn-thinking').length : 0,
    toolClusters: el ? el.querySelectorAll('.tc-cluster').length : 0,
    toolRows: el ? el.querySelectorAll('.tc-row-name').length : 0,
    placeholder: el ? el.querySelectorAll('.mr-gc-empty-placeholder, .mr-ft-thinking-placeholder').length : 0,
    bodyLen: body ? (body.innerText || '').length : 0,
    bodyHead: body ? (body.innerText || '').slice(0, 120) : '',
  };
};
true;`;

async function run(cdp) {
  await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer ready', 60000);
  await cdp.eval(SNAP_FN);
  await cdp.eval(RECORDER);
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const meeting = await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('create-meeting', {
    title: 'B1 首轮 blocks 验证', scene: 'general', workspace: ${j(WORK_DIR)}
  }))()`);
  if (!meeting || !meeting.id) throw new Error('create-meeting 失败');
  const meetingId = meeting.id;

  // 唯一成员：kind='claude' —— 全新会话（不带 resumeCCSessionId / useContinue）
  const added = await cdp.eval(`(async () => {
    const r = await require('electron').ipcRenderer.invoke('add-meeting-sub', {
      meetingId: ${j(meetingId)}, kind: 'claude', opts: { cwd: ${j(WORK_DIR)} } });
    return { ok: !!(r && r.session), sid: r && r.session && r.session.id,
             kind: r && r.session && r.session.kind, cwd: r && r.session && r.session.cwd,
             ccSessionId: r && r.session && (r.session.ccSessionId || null),
             transcriptPath: r && r.session && (r.session.transcriptPath || null) };
  })()`);
  if (!added.ok) throw new Error('add-meeting-sub 失败');
  const sid = added.sid;
  if (added.ccSessionId || added.transcriptPath) {
    throw new Error(`这不是全新会话：ccSessionId=${added.ccSessionId} transcriptPath=${added.transcriptPath}`);
  }
  console.error(`[setup] claude member sid=${sid} cwd=${added.cwd}（全新会话，无 ccSessionId/transcriptPath）`);

  await cdp.eval(`(async () => {
    localStorage.setItem('mr-group-chat-view-mode', 'chat');
    const ipc = require('electron').ipcRenderer;
    const all = await ipc.invoke('get-meetings');
    window.MeetingRoom.openMeeting(${j(meetingId)}, all.find(x => x.id === ${j(meetingId)}));
    return true;
  })()`);
  await waitFor(cdp, "!!document.querySelector('.mr-gc-shell')", 'group chat shell', 30000);

  // 等 CLI ready（真 CLI 冷启动 10-40s）
  const readyDeadline = Date.now() + 240000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    ready = await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('cli-ready-status', ${j(sid)}))()`);
    if (ready) break;
    await _waitMs(2000);
  }

  // tap 在"还没发第一条 prompt"时的状态 —— 用来证明起点确实是空的
  const tapBefore = await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('groupchat-claude-debug-state'))()`)
    .catch(() => null);

  const sendTs = Date.now();
  await cdp.eval(`(() => {
    const box = document.getElementById('mr-input-box');
    box.textContent = ${j(PROMPT)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('mr-send-btn').click();
    return true;
  })()`);

  // --- 第 1 轮流式期高频采样 ---
  const timeline = [];
  let firstCardShot = null;
  let tapProof = null;      // 首个 source==='tap' && blockCount>0 的 partial（settle 之前）
  let tapProofSnap = null;
  let tapProofTapState = null;
  let settled = false;
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    const s = await cdp.eval(`window.__b1Snap(${j(sid)})`);
    const rec = await cdp.eval(`({
      firstTapAtMs: window.__b1.firstTapAtMs,
      firstTapEvent: window.__b1.firstTapEvent,
      last: window.__b1.events[window.__b1.events.length - 1] || null,
      n: window.__b1.events.length,
      sources: [...new Set(window.__b1.events.map(e => e.source))],
      maxBlocks: window.__b1.events.reduce((m, e) => Math.max(m, e.blockCount), 0),
    })`);
    timeline.push({
      t: Math.round((Date.now() - sendTs) / 1000),
      src: rec.last && rec.last.source, blocks: rec.last && rec.last.blockCount,
      cards: s.cards, think: s.thinking, tools: s.toolRows, len: s.bodyLen, pending: s.pending,
    });

    // 关键取证：本轮还 pending（未 settle）时就已经拿到 tap blocks
    if (!tapProof && rec.firstTapEvent && s.pending) {
      tapProof = rec.firstTapEvent;
      tapProofSnap = s;
      tapProofTapState = await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('groupchat-claude-debug-state'))()`)
        .catch(() => null);
    }
    if (!firstCardShot && s.cards > 0 && s.pending) {
      firstCardShot = await shoot(cdp, 'b1-first-turn-live-card.png');
    }

    const st = await cdp.eval(`(async () => {
      const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} });
      const cur = r && r.currentTurn;
      const done = (r && r.messages || []).filter(m => m && m.turnNum === cur && m.sid).map(m => m.sid);
      return { currentTurn: cur, done: [...new Set(done)] };
    })()`).catch(() => null);
    if (st && st.done.includes(sid)) {
      const pend = await cdp.eval("document.querySelectorAll('.mr-gc-msg.pending').length");
      if (pend === 0) { settled = true; break; }
    }
    await _waitMs(1200);
  }

  await _waitMs(2000);
  const finalSnap = await cdp.eval(`window.__b1Snap(${j(sid)})`);
  const doneShot = await shoot(cdp, 'b1-first-turn-settled.png');
  const events = await cdp.eval('window.__b1.events');
  const tapAfter = await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('groupchat-claude-debug-state'))()`)
    .catch(() => null);

  const asserts = [];
  const check = (name, ok, detail) => { asserts.push({ name, ok: !!ok, detail }); };
  check('CLI ready', ready, { ready });
  check('第 1 轮流式期 partial.source === "tap"', !!tapProof && tapProof.source === 'tap', tapProof);
  check('第 1 轮流式期 blockCount > 0', !!tapProof && tapProof.blockCount > 0, tapProof && tapProof.blockCount);
  check('取证时刻卡片仍是 pending（确实是本轮流式过程中，不是 settle 后补的）',
    !!tapProofSnap && tapProofSnap.pending === true, tapProofSnap);
  check('群聊里出现真卡片（cards > 0）而不是思考中占位',
    !!tapProofSnap && tapProofSnap.cards > 0, tapProofSnap && { cards: tapProofSnap.cards, placeholder: tapProofSnap.placeholder });
  check('本轮 settle', settled, { settled });

  const failed = asserts.filter(a => !a.ok);
  const out = {
    ok: failed.length === 0,
    dataDir: DATA_DIR, workDir: WORK_DIR, meetingId, sid, prompt: PROMPT,
    freshSession: { ccSessionId: added.ccSessionId, transcriptPath: added.transcriptPath },
    tapStateBeforePrompt: tapBefore,
    tapStateAtProof: tapProofTapState,
    tapStateAfterTurn: tapAfter,
    firstTapProof: tapProof,
    firstTapAfterSendSec: tapProof ? Math.round(tapProof.atMs / 1000) : null,
    domAtProof: tapProofSnap,
    finalSnapshot: finalSnap,
    partialEventStats: {
      total: events.length,
      sources: [...new Set(events.map(e => e.source))],
      maxBlockCount: events.reduce((m, e) => Math.max(m, e.blockCount), 0),
      allToolNames: [...new Set(events.flatMap(e => e.toolNames || []))],
      firstTen: events.slice(0, 10),
    },
    screenshots: { firstCardShot, doneShot },
    timeline: timeline.slice(0, 200),
    asserts,
  };
  console.log('===B1_RESULT===');
  console.log(JSON.stringify(out, null, 2));
  if (failed.length) throw new Error('B1 断言失败：' + failed.map(f => f.name).join(' | '));
  return out;
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await availablePort(PREFERRED_PORT);
  let hub = null, cdp = null;
  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port, label: 'b1-firstturn', extraEnv: { CLAUDE_HUB_E2E: '1' } });
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
    await run(cdp);
  } catch (err) {
    if (hub && typeof hub.log === 'function') {
      console.error('--- isolated hub log tail ---');
      console.error(hub.log().slice(-80).join('\n'));
    }
    throw err;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub, { timeoutMs: 20000 }).catch(() => {});
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
