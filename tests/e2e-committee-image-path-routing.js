'use strict';

// Focused E2E: isolated Electron Hub + real create-meeting/groupchat:turn IPC.
// Verifies a pasted local image path is routed into committee checkup progress
// without surfacing the LLM router prompt as a visible user turn.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ARTIFACT_DIR = 'C:\\Users\\lintian\\hub-committee-artifacts';
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const DATA_DIR = path.join(os.tmpdir(), `hub-committee-image-route-${RUN_ID}`);
const CDP_PORT = Number(process.env.COMMITTEE_IMAGE_ROUTE_CDP_PORT || 9268);
const IMAGE_PATH = process.env.COMMITTEE_IMAGE_ROUTE_PATH
  || 'C:\\Users\\lintian\\.claude-session-hub\\images\\20260613063837-7ebbfa.png';

function ensure(cond, msg) {
  if (!cond) throw new Error(msg);
}

function logLine(file, text) {
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`, 'utf8');
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  ensure(fs.existsSync(IMAGE_PATH), `image not found: ${IMAGE_PATH}`);

  const logPath = path.join(ARTIFACT_DIR, `committee-image-route-${RUN_ID}.log`);
  const summaryPath = path.join(ARTIFACT_DIR, `committee-image-route-${RUN_ID}.json`);
  const shotPath = path.join(ARTIFACT_DIR, `committee-image-route-${RUN_ID}.png`);

  logLine(logPath, `start image route E2E image=${IMAGE_PATH}`);
  logLine(logPath, `dataDir=${DATA_DIR}`);

  const hub = await launchIsolatedHub({
    dataDir: DATA_DIR,
    port: CDP_PORT,
    label: 'committee-image-route',
    extraEnv: {
      COMMITTEE_DISABLE_LLM_ROUTER: '',
      CLAUDE_HUB_MOBILE_ENABLED: '',
      CLAUDE_HUB_MOBILE_ISOLATED_OPTIN: '',
    },
  });
  let cdp = null;
  try {
    cdp = await connectFirstPage(hub);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const created = await cdp.eval(`
      (async () => {
        const { ipcRenderer } = require('electron');
        const meeting = await ipcRenderer.invoke('create-meeting', {
          title: 'IMAGE 路由 E2E ${RUN_ID}',
          mode: 'committee',
          scene: 'committee',
          groupChat: true,
          groupMode: 'deliberation',
          groupRecentRawN: 5,
          slots: [
            { kind: 'deepseek', model: 'deepseek-v4-pro[1m]' },
            { kind: 'claude', model: 'claude-opus-4-8[1m]' },
            { kind: 'codex', model: 'gpt-5.5' },
            { kind: 'codex', model: 'gpt-5.5' },
            { kind: 'claude', model: 'claude-opus-4-8[1m]' },
          ],
        });
        return {
          id: meeting && meeting.id,
          scene: meeting && meeting.scene,
          subSessions: meeting && meeting.subSessions,
        };
      })()
    `);
    ensure(created && created.id, 'create-meeting returned no id');
    ensure(created.scene === 'committee', `scene mismatch: ${created.scene}`);
    ensure(Array.isArray(created.subSessions) && created.subSessions.length === 5,
      `expected 5 subSessions, got ${created.subSessions && created.subSessions.length}`);
    logLine(logPath, `created meeting ${created.id}`);

    await _waitMs(12000);

    const probe = await cdp.eval(`
      (async () => {
        const { ipcRenderer } = require('electron');
        const meetingId = ${JSON.stringify(created.id)};
        const imagePath = ${JSON.stringify(IMAGE_PATH)};
        const progress = [];
        const onProgress = (_event, payload) => {
          if (payload && payload.meetingId === meetingId) progress.push(String(payload.text || ''));
        };
        ipcRenderer.on('committee-progress', onProgress);
        const turnPromise = ipcRenderer.invoke('groupchat:turn', { meetingId, userInput: imagePath })
          .then(turn => ({ status: 'resolved', turn }))
          .catch(err => ({ status: 'rejected', reason: err && err.message }));
        window.__committeeImageRouteTurnPromise = turnPromise;
        const started = Date.now();
        while (Date.now() - started < 20000) {
          if (progress.some(x => x.includes('持仓识别') && x.includes(imagePath))) break;
          await new Promise(r => setTimeout(r, 250));
        }
        ipcRenderer.removeListener('committee-progress', onProgress);
        const maybeDone = await Promise.race([
          turnPromise,
          new Promise(resolve => setTimeout(() => resolve({ status: 'still_running' }), 10)),
        ]);
        return { progress, maybeDone };
      })()
    `);

    ensure(Array.isArray(probe.progress), 'progress missing');
    ensure(probe.progress.some(x => x.includes('持仓识别') && x.includes(IMAGE_PATH)),
      `no checkup progress for bare image path: ${JSON.stringify(probe.progress)}`);
    ensure(!probe.progress.some(x => x.includes('立项路由')),
      `LLM router leaked into image route progress: ${JSON.stringify(probe.progress)}`);

    const meetingPath = path.join(DATA_DIR, 'meetings', `${created.id}.json`);
    const stateProbe = fs.existsSync(meetingPath)
      ? JSON.parse(fs.readFileSync(meetingPath, 'utf8'))
      : null;
    const messages = stateProbe && Array.isArray(stateProbe.messages) ? stateProbe.messages : [];
    const userContents = messages.filter(m => m && m.role === 'user').map(m => String(m.content || ''));
    ensure(!userContents.some(x => x.includes('投委会 · 立项路由')),
      'visible state contains internal LLM router prompt');

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

    const summary = {
      ok: true,
      runId: RUN_ID,
      imagePath: IMAGE_PATH,
      dataDir: DATA_DIR,
      cdpPort: CDP_PORT,
      meeting: created,
      progress: probe.progress,
      maybeDone: probe.maybeDone,
      visibleUserMessages: userContents,
      screenshot: shotPath,
      log: logPath,
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    logLine(logPath, `ok progress=${JSON.stringify(probe.progress)}`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    await gracefulQuit(hub, { timeoutMs: 8000 });
  }
})().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
