'use strict';
// B2 + B3 真实 Hub E2E（2026-07-29 道雪）
//
// B2：turn-complete 早于 watcher 订阅 → 整轮永久「思考中」
// B3：CLI 未就绪的成员被静默跳过、气泡凭空消失
//
// 场景刻意还原用户现场：一个成员的 CLI 迟迟不就绪，把发送阶段拖到 60s，
//   期间已经答完的成员的 turn-complete 在老实现里会掉进「已发未监听」窗口。
//   成员：claude / codex / kimi（真答）+ deepseek（隔离数据目录里没有 API key，
//   大概率起不来 → 正好当"未就绪成员"的真样本；起来了就当普通成员，不影响其他断言）。
//
// 铁律：CLAUDE_HUB_DATA_DIR 隔离 + 独立 CDP 端口 + 剥离嵌套 CLAUDECODE env。

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
const DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR || 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-fix-b23';
const WORK_DIR = process.env.GC_B23_WORKDIR || 'C:\\Vibe\\_scratch\\gccard-b23';
const PREFERRED_PORT = Number(process.env.GC_B23_PORT || 9239);
const OUT = path.join(ARTIFACT_DIR, 'b2-b3-e2e-result.json');

const MEMBER_KINDS = ['claude', 'codex', 'kimi', 'deepseek'];
const PROMPT = '一句话回答：2 的 10 次方是多少？只回答数字和一句话解释，不要写文件、不要调用任何工具。';

const j = (v) => JSON.stringify(v);

function canListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function availablePort(p) {
  for (let port = p; port < p + 20; port += 1) if (await canListen(port)) return port;
  throw new Error('no free port');
}
async function waitFor(cdp, expr, label, ms = 60000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { try { if (await cdp.eval(expr)) return true; } catch {} await _waitMs(250); }
  throw new Error('timeout waiting for ' + label);
}
async function shoot(cdp, name) {
  await cdp.send('Page.bringToFront').catch(() => {});
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const f = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return { file: f, bytes: fs.statSync(f).size };
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const port = await availablePort(PREFERRED_PORT);
  let hub = null; let cdp = null;
  const result = { ok: false, port, dataDir: DATA_DIR };
  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port, label: 'b2b3', extraEnv: { CLAUDE_HUB_E2E: '1' } });
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer ready');

    // 抓后端真正广播的 turn-targets / partial-update（B3 的关键证据）
    await cdp.eval(`(() => {
      window.__evt = { targets: [], partials: [], complete: [] };
      const ipc = require('electron').ipcRenderer;
      ipc.on('groupchat-turn-targets', (_e, p) => window.__evt.targets.push(p));
      ipc.on('groupchat-partial-update', (_e, p) => window.__evt.partials.push({ sid: p.sid, status: p.status, reason: p.reason, len: (p.text||'').length, at: Date.now() }));
      ipc.on('groupchat-turn-complete', (_e, p) => window.__evt.complete.push({ turnNum: p.turnNum, results: (p.results||[]).map(r => ({ sid: r.sid, status: r.status, len: (r.text||'').length, reason: r.reason })) }));
      return true;
    })()`);

    const meeting = await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('create-meeting', {
      title: 'B2+B3 修复验证', scene: 'general', workspace: ${j(WORK_DIR)} }))()`);
    const meetingId = meeting.id;
    const sidByKind = {};
    for (const kind of MEMBER_KINDS) {
      const r = await cdp.eval(`(async () => {
        const r = await require('electron').ipcRenderer.invoke('add-meeting-sub', {
          meetingId: ${j(meetingId)}, kind: ${j(kind)}, opts: { cwd: ${j(WORK_DIR)} } });
        return { ok: !!(r && r.session), sid: r && r.session && r.session.id };
      })()`).catch(e => ({ ok: false, err: String(e && e.message) }));
      if (!r.ok) { console.error(`[e2e] add-meeting-sub failed for ${kind}: ${r.err || ''}`); continue; }
      sidByKind[kind] = r.sid;
      console.error(`[e2e] member ${kind} -> ${r.sid}`);
      await _waitMs(1500);
    }
    const sids = Object.values(sidByKind);
    result.meetingId = meetingId; result.sidByKind = sidByKind;

    await cdp.eval(`(async () => {
      localStorage.setItem('mr-group-chat-view-mode', 'chat');
      const all = await require('electron').ipcRenderer.invoke('get-meetings');
      window.MeetingRoom.openMeeting(${j(meetingId)}, all.find(x => x.id === ${j(meetingId)}));
      return true;
    })()`);
    await waitFor(cdp, "!!document.querySelector('.mr-gc-shell')", 'group chat shell', 30000);

    // --- B3 根因验证：codex 到底多久 ready（修复前实测 240s 仍 false）---
    const readyTimeline = [];
    const t0 = Date.now();
    let readyMap = {};
    const readyDeadline = Date.now() + 120000;
    while (Date.now() < readyDeadline) {
      readyMap = await cdp.eval(`(async () => {
        const ipc = require('electron').ipcRenderer; const r = {};
        for (const [k, s] of Object.entries(${j(sidByKind)})) r[k] = await ipc.invoke('cli-ready-status', s);
        return r;
      })()`);
      readyTimeline.push({ t: Math.round((Date.now() - t0) / 1000), ...readyMap });
      if (readyMap.codex && readyMap.claude && readyMap.kimi) break;
      await _waitMs(2000);
    }
    result.readyTimeline = readyTimeline;
    result.codexReadyAtSec = (readyTimeline.find(x => x.codex) || {}).t ?? null;
    result.readyMapAtSend = readyMap;
    console.error('[e2e] readyMap at send:', JSON.stringify(readyMap), 'codexReadyAtSec=', result.codexReadyAtSec);

    // --- 发一轮真实提问 ---
    const sendTs = Date.now();
    await cdp.eval(`(() => {
      const box = document.getElementById('mr-input-box');
      box.textContent = ${j(PROMPT)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('mr-send-btn').click();
      return true;
    })()`);

    // 等整轮收敛（后端 currentMode 回 idle 且 DOM 无 pending）
    let converged = false;
    let midShot = null;
    const pollDeadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < pollDeadline) {
      const st = await cdp.eval(`(async () => {
        const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} });
        return { mode: r && r.currentMode, cur: r && r.currentTurn,
          byStatus: (r && r.turns || []).filter(t => t.n === (r && r.currentTurn)).map(t => t.byStatus)[0] || null,
          pendingDom: document.querySelectorAll('.mr-gc-msg.pending').length,
          bubbles: document.querySelectorAll('.mr-gc-msg.ai').length };
      })()`).catch(() => null);
      if (!midShot && st && st.pendingDom > 0 && Math.round((Date.now() - sendTs) / 1000) > 25) {
        midShot = await shoot(cdp, 'b2b3-during-turn.png');
      }
      if (st && st.mode === 'idle' && st.pendingDom === 0 && st.byStatus) { converged = true; break; }
      await _waitMs(2000);
    }
    result.convergedSec = Math.round((Date.now() - sendTs) / 1000);
    result.converged = converged;

    await _waitMs(2000);
    const finalShot = await shoot(cdp, 'b2b3-after-turn.png');

    const evt = await cdp.eval('window.__evt');
    result.turnTargets = evt.targets;
    result.turnComplete = evt.complete;
    result.notReadyPartials = evt.partials.filter(p => p.status === 'cli_not_ready');

    // 消息 id 两种形态：settle 后 `a<turn>-<memberId>`，pending 期 `pending-<sid>`。
    //   （memberId = m<在 meeting.subSessions 里的序号+1>，不是 sid —— 早期版本按 sid 后缀
    //    匹配，settle 之后永远找不到元素，那是脚本 bug 不是产品 bug。）
    const orderedSids = await cdp.eval(`(async () => {
      const all = await require('electron').ipcRenderer.invoke('get-meetings');
      return (all.find(x => x.id === ${j(meetingId)}) || {}).subSessions || [];
    })()`);
    const lastTurnNum = (evt.complete[evt.complete.length - 1] || {}).turnNum || 1;
    const candIdsByKind = {};
    for (const [k, sid] of Object.entries(sidByKind)) {
      candIdsByKind[k] = [`a${lastTurnNum}-m${orderedSids.indexOf(sid) + 1}`, `pending-${sid}`];
    }
    result.orderedSids = orderedSids;
    const dom = await cdp.eval(`(() => {
      const candsByKind = ${j(candIdsByKind)};
      const out = {};
      for (const [k] of Object.entries(${j(sidByKind)})) {
        let el = null;
        for (const id of candsByKind[k]) { const e = document.querySelector('[data-gc-msg-id="' + id + '"]'); if (e) el = e; }
        out[k] = el ? {
          present: true,
          msgId: el.getAttribute('data-gc-msg-id'),
          gcStatus: el.getAttribute('data-gc-status') || '',
          pending: el.classList.contains('pending'),
          metaText: (el.querySelector('.mr-gc-meta') || {}).innerText || '',
          textLen: (el.innerText || '').length,
          head: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
          placeholder: el.querySelectorAll('.mr-gc-empty-placeholder').length,
        } : { present: false };
      }
      out.__lane = [...document.querySelectorAll('.mr-turn-lane-item')].map(e => e.innerText.replace(/\\s+/g,' ').trim());
      out.__laneSummary = (document.querySelector('.mr-turn-lane-head span') || {}).innerText || '';
      out.__aiBubbles = document.querySelectorAll('.mr-gc-msg.ai').length;
      return out;
    })()`);
    result.dom = dom;

    const gcState = await cdp.eval(`(async () => {
      const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} });
      const cur = r && r.currentTurn;
      const t = (r && r.turns || []).find(x => x.n === cur) || {};
      return { currentTurn: cur, currentMode: r && r.currentMode, byStatus: t.byStatus || {},
        byLen: Object.fromEntries(Object.entries(t.by || {}).map(([k,v]) => [k, String(v||'').length])),
        msgs: (r && r.messages || []).filter(m => m.turnNum === cur).map(m => ({ sid: m.sid, role: m.role, status: m.status, len: (m.content||'').length })) };
    })()`);
    result.gcState = gcState;
    result.screenshots = { midShot, finalShot };

    // ---------------- 断言 ----------------
    const errs = [];
    const participants = Object.keys(sidByKind);
    if (!converged) errs.push('整轮未收敛（10 分钟内 currentMode 没回 idle 或 DOM 仍有 pending）—— B2 回归');
    const lastTargets = evt.targets[evt.targets.length - 1];
    if (!lastTargets) errs.push('没有收到 groupchat-turn-targets');
    else if (lastTargets.sids.length !== participants.length) {
      errs.push(`turn-targets 名单 ${lastTargets.sids.length} 位 ≠ 勾选 ${participants.length} 位（B3：成员被静默丢弃）`);
    }
    for (const [k, sid] of Object.entries(sidByKind)) {
      if (!dom[k] || !dom[k].present) errs.push(`成员 ${k} 的气泡在 UI 上不存在（B3：凭空消失）`);
      else if (dom[k].pending) errs.push(`成员 ${k} 的气泡仍停在 pending（永久思考中）`);
      if (!gcState.byStatus[sid]) errs.push(`成员 ${k} 在轮记录里没有任何状态`);
    }
    const answered = Object.entries(sidByKind).filter(([, sid]) => (gcState.byLen[sid] || 0) > 0).map(([k]) => k);
    result.answeredMembers = answered;
    if (answered.length === 0) errs.push('没有任何成员拿到回答（B2 回归：turn-complete 全丢）');
    result.assertErrors = errs;
    result.ok = errs.length === 0;

    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    console.log('===B2B3_RESULT===');
    console.log(JSON.stringify({
      ok: result.ok, converged, convergedSec: result.convergedSec,
      codexReadyAtSec: result.codexReadyAtSec, readyMapAtSend: readyMap,
      turnTargets: evt.targets, notReadyPartials: result.notReadyPartials,
      byStatus: gcState.byStatus, byLen: gcState.byLen,
      dom, answered, errs, screenshots: result.screenshots,
    }, null, 2));
    if (errs.length) process.exitCode = 1;
  } catch (err) {
    result.error = String(err && err.stack || err);
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    if (hub && typeof hub.log === 'function') console.error(hub.log().slice(-60).join('\n'));
    throw err;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub, { timeoutMs: 20000 }).catch(() => {});
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
