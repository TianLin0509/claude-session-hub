'use strict';
// B3 诊断 v2：把 codex 的完整 ring buffer 落盘，并逐条复算 cli-ready 三道门
//   （blocker / marker / 静默期），定位到底是哪一道判 false。

const fs = require('fs');
const net = require('net');
const path = require('path');

for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID']) {
  delete process.env[k];
}

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const detector = require('../core/group-chat-cli-ready-detector.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'artifacts');
const DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR || 'C:\\Users\\lintian\\AppData\\Local\\Temp\\hub-fix-b23';
const WORK_DIR = process.env.GC_PROBE_WORKDIR || 'C:\\Vibe\\_scratch\\gccard-b23';
const PREFERRED_PORT = Number(process.env.GC_PROBE_PORT || 9239);
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
  throw new Error('timeout: ' + label);
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const port = await availablePort(PREFERRED_PORT);
  let hub = null; let cdp = null;
  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port, label: 'codex-probe2', extraEnv: { CLAUDE_HUB_E2E: '1' } });
    cdp = await connectFirstPage(hub, (t) => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await cdp.send('Runtime.enable');
    await waitFor(cdp, "document.readyState === 'complete' && !!window.MeetingRoom", 'renderer');

    const meeting = await cdp.eval(`(async () => await require('electron').ipcRenderer.invoke('create-meeting', {
      title: 'B3 codex ready 取证2', scene: 'general', workspace: ${j(WORK_DIR)} }))()`);
    const meetingId = meeting.id;
    const r = await cdp.eval(`(async () => {
      const r = await require('electron').ipcRenderer.invoke('add-meeting-sub', {
        meetingId: ${j(meetingId)}, kind: 'codex', opts: { cwd: ${j(WORK_DIR)} } });
      return { sid: r && r.session && r.session.id };
    })()`);
    const sid = r.sid;
    console.error('[probe2] codex sid =', sid);

    // 轮询到 ready 或超时（默认 240s —— 现场就是"240s 仍 false"）
    const maxTicks = Math.ceil(Number(process.env.GC_PROBE_MS || 240000) / 3000);
    let last = null;
    for (let i = 0; i < maxTicks; i += 1) {
      await _waitMs(3000);
      last = await cdp.eval(`(async () => {
        const ipc = require('electron').ipcRenderer;
        const buf = await ipc.invoke('get-ring-buffer', ${j(sid)});
        return { buf: buf || '', ready: await ipc.invoke('cli-ready-status', ${j(sid)}) };
      })()`);
      console.error(`[probe2] t=${(i + 1) * 3}s ready=${last.ready} bufLen=${last.buf.length}`);
      if (last.ready) break;
    }

    const buf = last.buf;
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'codex-ringbuffer-raw.txt'), buf, 'utf8');
    const tail2000 = buf.slice(-2000);
    const blockerHits = (detector.BLOCKERS.codex || [])
      .map(re => ({ re: String(re), hitInTail2000: re.test(tail2000), hitAnywhere: re.test(buf) }));
    const markerHits = (detector.MARKERS.codex || []).map(m => ({ m, hit: buf.includes(m) }));
    const verdict = {
      ready: last.ready,
      bufLen: buf.length,
      minBufLen: detector.MIN_BUF_LEN,
      bufLenGate: buf.length >= detector.MIN_BUF_LEN,
      markerHits,
      blockerHits,
      // 复算：blocker 命中 → 直接 false（且清 stableState，永远进不了静默期）
      failingGate: blockerHits.some(b => b.hitInTail2000) ? 'BLOCKER'
        : (!markerHits.some(x => x.hit) ? 'MARKER'
          : (buf.length < detector.MIN_BUF_LEN ? 'MIN_BUF_LEN' : 'STABLE_WINDOW_or_none')),
      tail2000: tail2000,
    };
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'codex-ready-verdict.json'), JSON.stringify(verdict, null, 2), 'utf8');
    console.log('===VERDICT===');
    console.log(JSON.stringify({ ...verdict, tail2000: undefined }, null, 2));
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub, { timeoutMs: 20000 }).catch(() => {});
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
