'use strict';
// B3 真实 UI E2E（2026-07-29 道雪）：CLI 真的起不来的成员，在群聊里长什么样
//
// 怎么造出"真·未就绪成员"而不作假：给隔离 Hub 的 PATH 去掉 npm 全局 bin 目录
//   （codex 就装在那里；claude 在 ~/.local/bin、kimi 由绝对路径解析，都不受影响）。
//   Hub 的每个成员都是 `powershell.exe` 里 type 一条 CLI 命令启动的（codex 走 ` codex ...`
//   裸命令 → PATH 查找），PATH 里没有 codex 就会打 "无法将...识别为 cmdlet"，
//   ring buffer 里永远不会出现 `Context ` 页脚
//   → cli-ready-detector 判 not ready → waitCliReady 等满 60s → sendToPty 返回 false。
//   这是用户装漏 CLI / CLI 挂掉时命中的**同一条真实代码路径**，从 PTY 到 renderer 全真，
//   而且未就绪的正是用户现场里那位 Codex。
//
// 顺带这也是 B2 的真实现场：那位成员把发送阶段整整拖住 60s，claude/codex 在这 60s 之内
//   就答完了。老实现要等 `Promise.all(全部 sendToPty)` 之后才挂 watcher，这些回答会掉进
//   「已发出但没人监听」的窗口永久丢失。脚本用事件时间戳直接断言：
//   **completed 的 partial-update 早于 turn-targets（= 全部 send 结束）到达。**

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
const OUT = path.join(ARTIFACT_DIR, 'b3-cli-not-ready-result.json');

const MEMBER_KINDS = ['claude', 'codex', 'kimi'];   // codex 会因为 PATH 缺失起不来
const PROMPT = '一句话回答：3 的 5 次方是多少？只回答数字加一句解释，不要写文件、不要调用工具。';

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

// 只摘掉 npm 全局 bin（codex 在那里），claude(~/.local/bin) / kimi(绝对路径解析) 照常可用
function pathWithoutCodex() {
  const key = Object.keys(process.env).find(k => /^path$/i.test(k)) || 'Path';
  const original = process.env[key] || '';
  const hit = (seg) => /AppData[\\/]+Roaming[\\/]+npm/i.test(seg);
  const filtered = original.split(';').filter(seg => !hit(seg)).join(';');
  return { key, original, filtered, removed: original.split(';').filter(hit) };
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const port = await availablePort(PREFERRED_PORT);
  const pathInfo = pathWithoutCodex();
  if (pathInfo.removed.length === 0) throw new Error('PATH 里没找到 npm 全局 bin —— 换一个成员来造"未就绪"');
  let hub = null; let cdp = null;
  const result = { ok: false, port, dataDir: DATA_DIR, pathRemoved: pathInfo.removed };
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port, label: 'b3-notready',
      extraEnv: { CLAUDE_HUB_E2E: '1', [pathInfo.key]: pathInfo.filtered },
    });
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer ready');

    await cdp.eval(`(() => {
      window.__evt = { targets: [], partials: [], complete: [], t0: Date.now() };
      const ipc = require('electron').ipcRenderer;
      ipc.on('groupchat-turn-targets', (_e, p) => window.__evt.targets.push({ ...p, at: Date.now() - window.__evt.t0 }));
      ipc.on('groupchat-partial-update', (_e, p) => window.__evt.partials.push({ sid: p.sid, status: p.status, reason: p.reason, len: (p.text||'').length, at: Date.now() - window.__evt.t0 }));
      ipc.on('groupchat-turn-complete', (_e, p) => window.__evt.complete.push({ turnNum: p.turnNum, at: Date.now() - window.__evt.t0, results: (p.results||[]).map(r => ({ sid: r.sid, status: r.status, len: (r.text||'').length, reason: r.reason })) }));
      return true;
    })()`);

    const meeting = await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('create-meeting', {
      title: 'B3 未就绪成员 UI 验证', scene: 'general', workspace: ${j(WORK_DIR)} }))()`);
    const meetingId = meeting.id;
    const sidByKind = {};
    for (const kind of MEMBER_KINDS) {
      const r = await cdp.eval(`(async () => {
        const r = await require('electron').ipcRenderer.invoke('add-meeting-sub', {
          meetingId: ${j(meetingId)}, kind: ${j(kind)}, opts: { cwd: ${j(WORK_DIR)} } });
        return { ok: !!(r && r.session), sid: r && r.session && r.session.id };
      })()`);
      if (!r.ok) throw new Error('add-meeting-sub failed: ' + kind);
      sidByKind[kind] = r.sid;
      await _waitMs(1500);
    }
    result.meetingId = meetingId; result.sidByKind = sidByKind;
    const orderedSids = await cdp.eval(`(async () => {
      const all = await require('electron').ipcRenderer.invoke('get-meetings');
      const m = all.find(x => x.id === ${j(meetingId)});
      return m.subSessions;
    })()`);
    result.orderedSids = orderedSids;
    const memberIdOf = {};
    for (const [k, sid] of Object.entries(sidByKind)) memberIdOf[k] = 'm' + (orderedSids.indexOf(sid) + 1);
    result.memberIdOf = memberIdOf;

    await cdp.eval(`(async () => {
      localStorage.setItem('mr-group-chat-view-mode', 'chat');
      const all = await require('electron').ipcRenderer.invoke('get-meetings');
      window.MeetingRoom.openMeeting(${j(meetingId)}, all.find(x => x.id === ${j(meetingId)}));
      return true;
    })()`);
    await waitFor(cdp, "!!document.querySelector('.mr-gc-shell')", 'group chat shell', 30000);

    // 等 claude/kimi ready；codex 预期永远不 ready（PATH 里没有它）
    let readyMap = {};
    const dl = Date.now() + 90000;
    while (Date.now() < dl) {
      readyMap = await cdp.eval(`(async () => {
        const ipc = require('electron').ipcRenderer; const r = {};
        for (const [k, s] of Object.entries(${j(sidByKind)})) r[k] = await ipc.invoke('cli-ready-status', s);
        return r;
      })()`);
      if (readyMap.claude && readyMap.kimi) break;
      await _waitMs(2000);
    }
    result.readyMapAtSend = readyMap;
    result.notReadyRingBufferTail = await cdp.eval(`(async () => {
      const b = await require('electron').ipcRenderer.invoke('get-ring-buffer', ${j(sidByKind.codex)});
      return String(b || '').slice(-600);
    })()`);
    console.error('[e2e] readyMap:', JSON.stringify(readyMap));

    // 发送前的预检 chip（应含「未就绪 1」）
    const preflight = await cdp.eval(`(() => {
      const row = document.querySelector('.mr-input-preflight, #mr-input-preflight');
      return { text: row ? row.innerText.replace(/\\s+/g,' ').trim() : null };
    })()`);
    result.preflightBeforeSend = preflight;
    const preShot = await shoot(cdp, 'b3-preflight-not-ready.png');

    const sendTs = Date.now();
    await cdp.eval(`(() => {
      const box = document.getElementById('mr-input-box');
      box.textContent = ${j(PROMPT)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('mr-send-btn').click();
      return true;
    })()`);

    // 发送阶段还没结束（kimi 要等满 60s）时先截一张：此刻 claude/codex 应该已经在答/答完
    let duringShot = null;
    let converged = false;
    const pollDeadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < pollDeadline) {
      const elapsed = Math.round((Date.now() - sendTs) / 1000);
      if (!duringShot && elapsed >= 35) duringShot = await shoot(cdp, 'b3-during-send-block.png');
      const st = await cdp.eval(`(async () => {
        const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} });
        return { mode: r && r.currentMode, cur: r && r.currentTurn, pendingDom: document.querySelectorAll('.mr-gc-msg.pending').length };
      })()`).catch(() => null);
      if (st && st.mode === 'idle' && st.pendingDom === 0) { converged = true; break; }
      await _waitMs(2000);
    }
    result.converged = converged;
    result.convergedSec = Math.round((Date.now() - sendTs) / 1000);
    await _waitMs(2000);
    const finalShot = await shoot(cdp, 'b3-cli-not-ready-final.png');

    const evt = await cdp.eval('window.__evt');
    result.turnTargets = evt.targets;
    result.partials = evt.partials;
    result.turnComplete = evt.complete;

    const turnNum = (evt.complete[evt.complete.length - 1] || {}).turnNum || 1;
    // 消息 id 两种形态：settle 后 `a<turn>-<memberId>`，pending 期 `pending-<sid>`
    const candIdsByKind = {};
    for (const [k, sid] of Object.entries(sidByKind)) {
      candIdsByKind[k] = [`a${turnNum}-${memberIdOf[k]}`, `pending-${sid}`];
    }
    const dom = await cdp.eval(`(() => {
      const candsByKind = ${j(candIdsByKind)};
      const sids = ${j(sidByKind)};
      const out = {};
      for (const k of Object.keys(sids)) {
        const cands = candsByKind[k];
        let el = null;
        for (const id of cands) { const e = document.querySelector('[data-gc-msg-id="' + id + '"]'); if (e) el = e; }
        out[k] = el ? {
          present: true,
          msgId: el.getAttribute('data-gc-msg-id'),
          gcStatus: el.getAttribute('data-gc-status') || '',
          pending: el.classList.contains('pending'),
          meta: (el.querySelector('.mr-gc-meta') || {}).innerText || '',
          placeholderText: (el.querySelector('.mr-gc-empty-placeholder') || {}).innerText || '',
          bodyText: (el.querySelector('.mr-gc-bubble') || {}).innerText || '',
        } : { present: false, tried: cands };
      }
      out.__aiBubbles = document.querySelectorAll('.mr-gc-msg.ai').length;
      out.__preflight = (document.querySelector('.mr-input-preflight, #mr-input-preflight') || {}).innerText || '';
      return out;
    })()`);
    result.dom = dom;

    const gcState = await cdp.eval(`(async () => {
      const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${j(meetingId)} });
      const cur = r && r.currentTurn;
      const t = (r && r.turns || []).find(x => x.n === cur) || {};
      return { currentTurn: cur, currentMode: r && r.currentMode, byStatus: t.byStatus || {},
        byLen: Object.fromEntries(Object.entries(t.by || {}).map(([k,v]) => [k, String(v||'').length])),
        msgs: (r && r.messages || []).filter(m => m.turnNum === cur && m.role === 'assistant').map(m => ({ sid: m.sid, status: m.status, len: (m.content||'').length })) };
    })()`);
    result.gcState = gcState;
    result.screenshots = { preShot, duringShot, finalShot };

    // ---------------- 断言 ----------------
    const errs = [];
    const notReadySid = sidByKind.codex;
    if (readyMap.codex !== false) errs.push('前置条件不成立：codex 竟然 ready 了（PATH 剥离没生效）');
    if (!converged) errs.push('整轮未收敛 —— B2 回归');

    const lastTargets = evt.targets[evt.targets.length - 1];
    if (!lastTargets) errs.push('没有 groupchat-turn-targets');
    else {
      if (lastTargets.sids.length !== 3) errs.push(`turn-targets 名单 ${lastTargets.sids.length} 位 ≠ 勾选 3 位（B3：成员被静默丢弃）`);
      if (!lastTargets.sids.includes(notReadySid)) errs.push('turn-targets 不含未就绪成员 → 前端会删掉它的气泡（B3 原症状）');
      if ((lastTargets.sentSids || []).includes(notReadySid)) errs.push('未就绪成员不该出现在 sentSids');
      if (!(lastTargets.undelivered || []).some(u => u.sid === notReadySid && u.status === 'cli_not_ready')) {
        errs.push('turn-targets.undelivered 没有明确列出未就绪成员');
      }
    }
    if (gcState.byStatus[notReadySid] !== 'cli_not_ready') errs.push(`未就绪成员的轮状态应为 cli_not_ready，实际 ${gcState.byStatus[notReadySid]}`);
    if (!dom.codex || !dom.codex.present) errs.push('未就绪成员的气泡在 UI 上不存在（B3 原症状：凭空消失）');
    else {
      if (dom.codex.gcStatus !== 'cli_not_ready') errs.push(`未就绪成员气泡的 data-gc-status 应为 cli_not_ready，实际 ${dom.codex.gcStatus}`);
      if (dom.codex.pending) errs.push('未就绪成员气泡不该还挂着 pending（闪光标 = 假装在思考）');
      if (!/CLI/.test(dom.codex.placeholderText || '')) errs.push('未就绪成员气泡没有解释性占位文案');
    }
    for (const k of ['claude', 'kimi']) {
      const sid = sidByKind[k];
      if (!(gcState.byLen[sid] > 0)) errs.push(`${k} 没拿到回答（B2 回归：turn-complete 掉进已发未监听窗口）`);
      if (gcState.byStatus[sid] !== 'completed') errs.push(`${k} 状态应为 completed，实际 ${gcState.byStatus[sid]}`);
    }

    // B2 的直接证据：completed 的 partial 早于 turn-targets（= 全部 sendToPty 结束）
    const targetsAt = lastTargets ? lastTargets.at : Infinity;
    const earlyCompleted = evt.partials.filter(p => p.status === 'completed' && p.len > 0 && p.at < targetsAt);
    result.b2Evidence = {
      turnTargetsAtMs: targetsAt,
      completedPartialsBeforeTargets: earlyCompleted,
      allCompletedPartials: evt.partials.filter(p => p.status === 'completed'),
    };
    result.assertErrors = errs;
    result.ok = errs.length === 0;

    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    console.log('===B3_NOT_READY_RESULT===');
    console.log(JSON.stringify({
      ok: result.ok, converged, convergedSec: result.convergedSec, readyMap,
      turnTargets: evt.targets, byStatus: gcState.byStatus, byLen: gcState.byLen,
      dom, b2Evidence: result.b2Evidence, preflight: result.preflightBeforeSend,
      notReadyTail: result.notReadyRingBufferTail, errs, screenshots: result.screenshots,
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
