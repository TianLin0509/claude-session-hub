'use strict';
// AI 群聊「卡片复用」真实 AI 续跑 —— 阶段 1b / 阶段 2（2026-07-29）
//
// 前置：tests/e2e-groupchat-real-ai-cards-cdp.js --phase=1 已经用真 CLI（Claude/Codex/Kimi）
//       跑过一轮，artifacts/real-gccard-state.json 里有 meetingId + sids。
//
//   --phase=1b  用同一隔离数据目录重启 Hub → 打开旧群聊 → 对每位成员点「同步」
//               （groupchat-manual-extract，从各自 transcript 真读，不造数据）→
//               让本轮 settle 成正式历史消息 → 记录**同进程内**的历史轮形态 → 优雅退出
//   --phase=2   再次重启 → 打开同一群聊 → 断言重启后历史轮的降级形态
//               → 点进各成员子 session 卡片视图做对照 → 截图
//
// 为什么 1b 用「同步」而不是再发一轮：phase=1 的实测结论是三家里只有 Kimi 走通了
//   streaming tap；Claude 首轮结构性拿不到 blocks（JsonlTail 只在首个 Stop hook 到达后
//   才建立），Codex 压根没被 dispatch（CLI 未 ready）。再发一轮只会重复烧额度而拿不到
//   settle。「同步」读的是**真实 AI 已经写进 transcript 的真回答**，不是伪造数据。

const fs = require('fs');
const path = require('path');

for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID']) {
  delete process.env[k];
}

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'artifacts');
const STATE_FILE = path.join(ARTIFACT_DIR, 'real-gccard-state.json');
const SNAP_FN = fs.readFileSync(path.join(__dirname, 'helpers', 'gc-snap-fn.js'), 'utf8');
const DATA_DIR = 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-real-gccard';
const PORT = Number(process.env.GC_REAL_E2E_PORT || 9237);
const PHASE = (process.argv.find(a => a.startsWith('--phase=')) || '--phase=1b').split('=')[1];

const j = (v) => JSON.stringify(v);

async function waitFor(cdp, expr, label, ms = 40000) {
  const dl = Date.now() + ms; let last = null;
  while (Date.now() < dl) {
    try { if (await cdp.eval(expr)) return true; } catch (e) { last = e; }
    await _waitMs(300);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function shoot(cdp, name) {
  await cdp.send('Page.bringToFront').catch(() => {});
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return { file: f, bytes: fs.statSync(f).size };
}

async function openMeeting(cdp, meetingId) {
  await cdp.eval(`(async () => {
    localStorage.setItem('mr-group-chat-view-mode', 'chat');
    if (window.__hubE2E && window.__hubE2E.selectMeeting) { window.__hubE2E.selectMeeting(${j(meetingId)}); return 'selectMeeting'; }
    const all = await require('electron').ipcRenderer.invoke('get-meetings');
    const m = all.find(x => x.id === ${j(meetingId)});
    if (!m) throw new Error('找不到该群聊');
    window.MeetingRoom.openMeeting(${j(meetingId)}, m);
    return 'openMeeting';
  })()`);
  await waitFor(cdp, "!!document.querySelector('.mr-gc-shell')", 'group chat shell');
}

// ---------------------------------------------------------------- 1b
async function phase1b(cdp, sids, meetingId, kindBySid) {
  await openMeeting(cdp, meetingId);
  await _waitMs(3000);
  const before = await cdp.eval(`window.__gcSnap(${j(sids)})`);
  const shotBoot = await shoot(cdp, 'real-groupchat-after-restart-unsettled.png');

  // 逐个「同步」（真实 UI 按钮 → groupchat-manual-extract → 读各自 transcript）
  const syncResults = {};
  for (const sid of sids) {
    const kind = (kindBySid[sid] || {}).kind || sid;
    const r = await cdp.eval(`(async () => {
      try {
        const r = await require('electron').ipcRenderer.invoke('groupchat-manual-extract', {
          meetingId: ${j(meetingId)}, sid: ${j(sid)}, turnNum: 1 });
        return { ok: !!(r && r.ok), textLen: r && r.text ? r.text.length : 0,
                 head: r && r.text ? String(r.text).slice(0, 100) : '', raw: r && r.error ? r.error : (r && r.reason) || null };
      } catch (e) { return { ok: false, err: String(e && e.message) }; }
    })()`);
    syncResults[kind] = { sid, ...r };
    await _waitMs(3000);
  }
  await _waitMs(4000);
  await cdp.eval(`(async () => {
    const all = await require('electron').ipcRenderer.invoke('get-meetings');
    const m = all.find(x => x.id === ${j(meetingId)});
    if (m && window.MeetingRoom) window.MeetingRoom.openMeeting(${j(meetingId)}, m);
    return true;
  })()`).catch(() => {});
  await _waitMs(3000);

  const afterSync = await cdp.eval(`window.__gcSnap(${j(sids)})`);
  const shotSettled = await shoot(cdp, 'real-groupchat-settled-same-process.png');
  const gcState = await cdp.eval(`(async () => {
    const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} });
    return { currentTurn: r && r.currentTurn, messages: (r && r.messages || []).map(m => ({
      id: m.id, sid: m.sid, turnNum: m.turnNum, role: m.role, status: m.status,
      len: (m.content || '').length, head: String(m.content || '').slice(0, 120) })) };
  })()`);

  console.log('===PHASE1B_RESULT===');
  console.log(JSON.stringify({ before, syncResults, afterSync, gcState,
    screenshots: { shotBoot, shotSettled } }, null, 2));
}

// ---------------------------------------------------------------- 2
async function phase2(cdp, sids, meetingId, kindBySid) {
  await openMeeting(cdp, meetingId);
  await waitFor(cdp, "document.querySelectorAll('.mr-gc-msg').length > 0", 'history messages', 30000);
  await _waitMs(3500);

  const afterRestart = await cdp.eval(`window.__gcSnap(${j(sids)})`);
  const shotHistory = await shoot(cdp, 'real-groupchat-history-after-restart.png');

  const shell = await cdp.eval(`(() => {
    const out = {};
    for (const sid of ${j(sids)}) {
      const arts = [...document.querySelectorAll('.mr-gc-msg')].filter(a => (a.getAttribute('data-gc-msg-id')||'').endsWith(sid));
      const el = arts[arts.length - 1];
      if (!el) { out[sid] = { found: false }; continue; }
      out[sid] = {
        found: true, classes: el.className,
        avatarImg: !!el.querySelector('.mr-gc-avatar img'),
        name: (el.querySelector('.mr-gc-name') || {}).innerText || null,
        metaText: (el.querySelector('.mr-gc-meta') || {}).innerText ? el.querySelector('.mr-gc-meta').innerText.replace(/\\s+/g,' ').slice(0,90) : null,
        bubbleHasCard: !!el.querySelector('.mr-gc-bubble.has-card'),
        cardHost: !!el.querySelector('.mr-gc-card-host'),
        turnCard: !!el.querySelector('.turn-card'),
        turnHeader: !!el.querySelector('.turn-header, .turn-card-header'),
        actions: { copy: !!el.querySelector('.mr-gc-copy-btn'), prompt: !!el.querySelector('.mr-gc-prompt-btn'),
                   resync: !!el.querySelector('.mr-gc-resync-btn'), anchor: !!el.querySelector('.mr-gc-anchor') },
      };
    }
    out.__turnGroup = {
      dividers: document.querySelectorAll('.mr-gc-turn-sep, .mr-gc-turn-divider, [class*="turn-sep"]').length,
      firstText: (document.querySelector('.mr-gc-messages') || {}).innerText ? document.querySelector('.mr-gc-messages').innerText.slice(0, 60) : '',
      userMsgs: document.querySelectorAll('.mr-gc-msg.mine').length,
      aiMsgs: document.querySelectorAll('.mr-gc-msg.ai').length,
    };
    return out;
  })()`);

  // 对照：点进各成员子 session 的卡片视图
  const sub = {}; const subShots = {};
  for (const sid of sids) {
    const kind = (kindBySid[sid] || {}).kind || sid;
    const entry = await cdp.eval(`(() => {
      const row = document.querySelector('.session-item[data-meeting-id=' + JSON.stringify(${j(meetingId)}) + ']');
      const tog = row && row.querySelector('[data-action="toggle-expand"]');
      if (tog && !document.querySelector('.session-item.child[data-session-id=' + JSON.stringify(${j(sid)}) + ']')) tog.click();
      return true;
    })()`).then(async () => {
      await _waitMs(600);
      return cdp.eval(`(() => {
        const el = document.querySelector('.session-item.child[data-session-id=' + JSON.stringify(${j(sid)}) + ']');
        if (el) { el.click(); return 'sidebar-click'; }
        if (window.__hubE2E && window.__hubE2E.selectSession) { window.__hubE2E.selectSession(${j(sid)}); return 'selectSession'; }
        return null;
      })()`);
    });
    await _waitMs(1500);
    await cdp.eval("(() => { const b = document.querySelector('.view-toggle-btn[data-view=\"card\"]'); if (b) b.click(); return !!b; })()");
    let loaded = 'sidebar+cardview';
    try {
      await waitFor(cdp, "document.querySelectorAll('#msg-overlay .turn-card').length > 0", `sub cards ${kind}`, 40000);
    } catch (e) { loaded = 'timeout:' + e.message.slice(0, 60); }
    const m = await cdp.eval(`(() => {
      const ov = document.getElementById('msg-overlay');
      if (!ov) return { overlay: false };
      const cards = [...ov.querySelectorAll('.turn-card')];
      const last = cards[cards.length - 1] || null;
      const body = last ? last.querySelector('.turn-body') : null;
      return { overlay: true, totalCards: cards.length,
        thinking: ov.querySelectorAll('.turn-thinking').length,
        toolClusters: ov.querySelectorAll('.tc-cluster').length,
        toolRows: ov.querySelectorAll('.tc-row-name').length,
        codeBlocks: ov.querySelectorAll('.code-block-wrap').length,
        codeTokens: ov.querySelectorAll('.code-block-wrap .token').length,
        metaPills: ov.querySelectorAll('.turn-meta-pills .pill').length,
        placeholder: (ov.querySelector('.msg-overlay-placeholder') || {}).innerText || null,
        lastBodyLen: body ? (body.innerText || '').length : 0,
        lastBodyHead: body ? (body.innerText || '').slice(0, 120) : '' };
    })()`);
    sub[kind] = { sid, entry, loaded, ...m };
    subShots[kind] = await shoot(cdp, `real-subsession-after-restart-${kind}.png`);
  }

  console.log('===PHASE2_RESULT===');
  console.log(JSON.stringify({ afterRestartGroupChat: afterRestart, shellDetails: shell,
    subSessionComparison: sub, screenshots: { shotHistory, subShots } }, null, 2));
}

// ---------------------------------------------------------------- main
(async () => {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const { meetingId, sids, kindBySid } = saved;
  let hub = null, cdp = null;
  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: PORT, label: `real-gccard-${PHASE}`,
      extraEnv: { CLAUDE_HUB_E2E: '1' } });
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer ready', 60000);
    await cdp.eval(SNAP_FN);
    if (PHASE === '1b') await phase1b(cdp, sids, meetingId, kindBySid);
    else await phase2(cdp, sids, meetingId, kindBySid);
  } finally {
    // 无论成败都把 Hub 主进程日志落盘 —— settle 链路排查全靠它
    if (hub && typeof hub.log === 'function') {
      fs.writeFileSync(path.join(ARTIFACT_DIR, `real-gccard-hublog-${PHASE}.log`), hub.log().join('\n'), 'utf8');
    }
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub, { timeoutMs: 20000 }).catch(() => {});
  }
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
