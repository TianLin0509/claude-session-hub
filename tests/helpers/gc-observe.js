'use strict';
// 附着到已运行的隔离测试 Hub，持续观测群聊气泡结构（流式期高频快照 + 峰值汇总 + 截图），
// 直到本轮 settle 或超时。不启动、不关闭任何进程。
//
//   node tests/helpers/gc-observe.js <meetingId> <sid1,sid2,...> [maxMinutes]

const fs = require('fs');
const path = require('path');
const http = require('http');
const { connectCDP } = require('./cdp-client');

const PORT = Number(process.env.GC_REAL_E2E_PORT || 9237);
const ARTIFACT_DIR = path.resolve(__dirname, '..', '..', 'artifacts');
const SNAP_FN = fs.readFileSync(path.join(__dirname, 'gc-snap-fn.js'), 'utf8');

const [meetingId, sidCsv, maxMin] = process.argv.slice(2);
const sids = String(sidCsv || '').split(',').filter(Boolean);
const DEADLINE = Date.now() + (Number(maxMin || 12) * 60 * 1000);

const wait = (ms) => new Promise(r => setTimeout(r, ms));
function httpJson(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); })
      .on('error', () => resolve(null));
  });
}

const NUM = ['hosts', 'cards', 'thinking', 'toolClusters', 'toolRows', 'codeBlocks',
  'codeTokens', 'metaPills', 'bodyLen', 'fallbackHosts', 'preTags'];

(async () => {
  const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const t = (targets || []).find(x => x.type === 'page' && /renderer[\\/]index\.html/i.test(x.url || ''));
  if (!t) throw new Error('找不到 renderer page target（测试 Hub 已退出？）');
  const cdp = await connectCDP(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.eval(SNAP_FN);

  const peak = {};
  const timeline = [];
  const shots = {};
  const t0 = Date.now();
  let settled = false;

  const shoot = async (name) => {
    await cdp.send('Page.bringToFront').catch(() => {});
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(ARTIFACT_DIR, name);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    return { file: f, bytes: fs.statSync(f).size };
  };

  while (Date.now() < DEADLINE) {
    const s = await cdp.eval(`window.__gcSnap(${JSON.stringify(sids)})`);
    const tick = { t: Math.round((Date.now() - t0) / 1000) };
    for (const sid of sids) {
      const c = s[sid] || {};
      if (!peak[sid]) peak[sid] = { firstCardSec: null, everWaiting: false, statuses: [] };
      const a = peak[sid];
      for (const k of NUM) a[k] = Math.max(a[k] || 0, c[k] || 0);
      if (c.waiting > 0) a.everWaiting = true;
      if (c.gcStatus && !a.statuses.includes(c.gcStatus)) a.statuses.push(c.gcStatus);
      if ((c.cards || 0) > 0 && a.firstCardSec == null) a.firstCardSec = tick.t;
      if ((c.bodyHead || '').length > (a.bodyHead || '').length) a.bodyHead = c.bodyHead;
      tick[sid.slice(0, 4)] = `c${c.cards || 0}/th${c.thinking || 0}/tl${c.toolRows || 0}/cb${c.codeBlocks || 0}/L${c.bodyLen || 0}${c.pending ? '/P' : ''}${c.waiting ? '/W' : ''}`;
    }
    timeline.push(tick);

    const live = sids.filter(sid => (s[sid] || {}).cards > 0 && (s[sid] || {}).pending).length;
    if (!shots.first && live > 0) shots.first = await shoot('real-groupchat-streaming-first-card.png');
    if (!shots.two && live >= 2) shots.two = await shoot('real-groupchat-streaming-two-live.png');
    if (!shots.three && live >= 3) shots.three = await shoot('real-groupchat-streaming-all-three.png');
    if (!shots.allCards && sids.every(sid => (s[sid] || {}).cards > 0)) {
      shots.allCards = await shoot('real-groupchat-streaming-all-three-cards.png');
    }

    const st = await cdp.eval(`(async () => {
      const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${JSON.stringify(meetingId)} });
      const cur = r && r.currentTurn;
      return { cur, done: [...new Set((r && r.messages || []).filter(m => m && m.turnNum === cur && m.sid).map(m => m.sid))] };
    })()`).catch(() => null);
    tick.done = st ? st.done.length : -1;
    if (st && sids.every(x => st.done.includes(x)) && (s.__global || {}).gcPending === 0) { settled = true; break; }
    await wait(2000);
  }

  await wait(2000);
  const final = await cdp.eval(`window.__gcSnap(${JSON.stringify(sids)})`);
  shots.done = await shoot('real-groupchat-completed-before-restart.png');
  const gcState = await cdp.eval(`(async () => {
    const r = await require('electron').ipcRenderer.invoke('groupchat:get-state', { meetingId: ${JSON.stringify(meetingId)} });
    return { currentTurn: r && r.currentTurn, messages: (r && r.messages || []).map(m => ({
      id: m.id, sid: m.sid, turnNum: m.turnNum, role: m.role, status: m.status,
      len: (m.content || '').length, head: String(m.content || '').slice(0, 120) })) };
  })()`);

  console.log(JSON.stringify({ settled, elapsedSec: Math.round((Date.now() - t0) / 1000),
    peakDuringStreaming: peak, finalSnapshot: final, gcState, shots,
    timeline: timeline.slice(-80) }, null, 2));
  await cdp.close().catch(() => {});
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
