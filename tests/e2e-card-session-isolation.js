'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-card-session-isolation-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const ROLLOUT_ROOT = path.join(TEMP_ROOT, 'codex-sessions');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'card-session-isolation');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `card-session-isolation-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `card-session-isolation-${RUN_ID}.json`);
const PORT = Number(process.env.HUB_CARD_E2E_PORT || 9376);

function writeRollout({ sid, threadSource, source, userMessage, answer }) {
  const startAt = new Date();
  const dayDir = path.join(
    ROLLOUT_ROOT,
    String(startAt.getFullYear()),
    String(startAt.getMonth() + 1).padStart(2, '0'),
    String(startAt.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(dayDir, { recursive: true });
  const stamp = startAt.toISOString().replace(/[:.]/g, '-').replace('Z', '').slice(0, 19);
  const rolloutPath = path.join(dayDir, `rollout-${stamp}-${sid}.jsonl`);
  const records = [
    {
      timestamp: startAt.toISOString(),
      type: 'session_meta',
      payload: {
        id: sid,
        session_id: threadSource === 'subagent' ? '019f-parent-0000-7000-8000-000000000000' : sid,
        timestamp: startAt.toISOString(),
        cwd: TEMP_ROOT,
        originator: 'codex-tui',
        thread_source: threadSource,
        source,
        ...(threadSource === 'subagent' ? { agent_path: '/root/audit' } : {}),
      },
    },
    {
      timestamp: new Date(startAt.getTime() + 100).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: userMessage },
    },
    {
      timestamp: new Date(startAt.getTime() + 200).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: answer, duration_ms: 100 },
    },
  ];
  fs.writeFileSync(rolloutPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return rolloutPath;
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const topLevelPath = writeRollout({
    sid: '019faaaa-2222-7000-8000-000000000013',
    threadSource: 'user',
    source: 'cli',
    userMessage: 'E2E top-level question',
    answer: 'E2E top-level answer',
  });
  const subagentPath = writeRollout({
    sid: '019fbbbb-2222-7000-8000-000000000014',
    threadSource: 'subagent',
    source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
    userMessage: 'SUBAGENT MUST NEVER RENDER',
    answer: 'SUBAGENT ANSWER MUST NEVER RENDER',
  });

  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port: PORT, topLevelPath, subagentPath };
  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: PORT, label: 'card-session-isolation' });
    await _waitMs(1200);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));

    result.fixtureOwnership = await client.eval(`(async () => {
      const overlay = document.getElementById('msg-overlay');
      currentView = 'card';
      overlay.classList.remove('hidden');

      sessions.set('e2e-top-level', {
        id: 'e2e-top-level', kind: 'codex', title: 'E2E Top Level', cwd: ${JSON.stringify(TEMP_ROOT)},
        codexSid: '019faaaa-2222-7000-8000-000000000013', transcriptPath: ${JSON.stringify(topLevelPath)},
        status: 'idle', lastMessageTime: Date.now(), lastOutputPreview: ''
      });
      activeSessionId = 'e2e-top-level';
      const top = await window._loadSessionHistoryToOverlay('e2e-top-level', { forceScrollBottom: true });
      const topText = overlay.innerText;

      sessions.set('e2e-subagent', {
        id: 'e2e-subagent', kind: 'codex', title: 'E2E Subagent Rejection', cwd: ${JSON.stringify(TEMP_ROOT)},
        codexSid: '019fbbbb-2222-7000-8000-000000000014', transcriptPath: ${JSON.stringify(subagentPath)},
        status: 'idle', lastMessageTime: Date.now(), lastOutputPreview: ''
      });
      activeSessionId = 'e2e-subagent';
      const sub = await window._loadSessionHistoryToOverlay('e2e-subagent');
      const subText = overlay.innerText;

      activeSessionId = 'e2e-top-level';
      await window._loadSessionHistoryToOverlay('e2e-top-level', { forceScrollBottom: true });
      return {
        top,
        sub,
        topHasExpected: topText.includes('E2E top-level question') && topText.includes('E2E top-level answer'),
        subagentLeaked: subText.includes('SUBAGENT MUST NEVER RENDER') || subText.includes('SUBAGENT ANSWER MUST NEVER RENDER'),
      };
    })()`);
    assert.equal(result.fixtureOwnership.top.error, null);
    assert.equal(result.fixtureOwnership.topHasExpected, true);
    assert.equal(result.fixtureOwnership.subagentLeaked, false);
    assert.equal(result.fixtureOwnership.sub.error, 'codex rollout not found');

    result.incrementalRace = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      const overlay = document.getElementById('msg-overlay');
      let resolveOld;
      ipcRenderer.invoke = (channel, args) => {
        if (channel === 'parse-session-transcript' && args && args.hubSessionId === 'race-old') {
          return new Promise(resolve => { resolveOld = resolve; });
        }
        return originalInvoke(channel, args);
      };
      try {
        sessions.set('race-old', { id: 'race-old', kind: 'codex', title: 'Old', cwd: ${JSON.stringify(TEMP_ROOT)}, status: 'idle' });
        sessions.set('race-new', { id: 'race-new', kind: 'codex', title: 'New', cwd: ${JSON.stringify(TEMP_ROOT)}, status: 'idle' });
        currentView = 'card';
        activeSessionId = 'race-old';
        const pending = window._loadSessionHistoryToOverlay('race-old', { incremental: true });
        await new Promise(resolve => setTimeout(resolve, 0));
        activeSessionId = 'race-new';
        overlay.innerHTML = '<div class="turn-card" data-session-id="race-new" data-turn-id="race-new-sentinel"><div class="turn-body">NEW SESSION SENTINEL</div></div>';
        resolveOld({
          turns: [{ id: 'race-old-turn', role: 'assistant', text: 'OLD SESSION MUST NOT APPEAR', ts: Date.now() }],
          transcriptPath: null,
          error: null,
        });
        const loadResult = await pending;
        return {
          loadResult,
          hasOld: overlay.innerText.includes('OLD SESSION MUST NOT APPEAR'),
          hasNew: overlay.innerText.includes('NEW SESSION SENTINEL'),
          sessionIds: Array.from(overlay.querySelectorAll('.turn-card')).map(el => el.dataset.sessionId),
        };
      } finally {
        ipcRenderer.invoke = originalInvoke;
      }
    })()`);
    assert.equal(result.incrementalRace.loadResult.error, 'stale load');
    assert.equal(result.incrementalRace.hasOld, false);
    assert.equal(result.incrementalRace.hasNew, true);

    result.turnCompleteRace = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      const overlay = document.getElementById('msg-overlay');
      let resolveOld;
      ipcRenderer.invoke = (channel, args) => {
        if (channel === 'parse-session-transcript' && args && args.hubSessionId === 'race-complete-old') {
          return new Promise(resolve => { resolveOld = resolve; });
        }
        return originalInvoke(channel, args);
      };
      try {
        sessions.set('race-complete-old', { id: 'race-complete-old', kind: 'codex', title: 'Old Complete', cwd: ${JSON.stringify(TEMP_ROOT)}, status: 'running' });
        sessions.set('race-complete-new', { id: 'race-complete-new', kind: 'codex', title: 'New Complete', cwd: ${JSON.stringify(TEMP_ROOT)}, status: 'idle' });
        currentView = 'card';
        activeSessionId = 'race-complete-old';
        _cardHistoryHydratedSid = 'race-complete-old';
        ipcRenderer.emit('turn-complete-event', {}, {
          hubSessionId: 'race-complete-old', transcriptPath: null,
          text: 'OLD COMPLETE FALLBACK MUST NOT APPEAR', completedAt: Date.now(), meetingId: null, kind: 'codex'
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        activeSessionId = 'race-complete-new';
        overlay.innerHTML = '<div class="turn-card" data-session-id="race-complete-new" data-turn-id="race-complete-new-sentinel"><div class="turn-body">NEW COMPLETE SENTINEL</div></div>';
        resolveOld({
          turns: [{ id: 'race-complete-old-turn', role: 'assistant', text: 'OLD COMPLETE MUST NOT APPEAR', ts: Date.now() }],
          transcriptPath: null,
          error: null,
        });
        await new Promise(resolve => setTimeout(resolve, 80));
        return {
          hasOld: overlay.innerText.includes('OLD COMPLETE MUST NOT APPEAR') || overlay.innerText.includes('OLD COMPLETE FALLBACK MUST NOT APPEAR'),
          hasNew: overlay.innerText.includes('NEW COMPLETE SENTINEL'),
          sessionIds: Array.from(overlay.querySelectorAll('.turn-card')).map(el => el.dataset.sessionId),
        };
      } finally {
        ipcRenderer.invoke = originalInvoke;
      }
    })()`);
    assert.equal(result.turnCompleteRace.hasOld, false);
    assert.equal(result.turnCompleteRace.hasNew, true);

    await client.eval(`(async () => {
      const overlay = document.getElementById('msg-overlay');
      for (const sid of [
        'e2e-subagent',
        'race-old', 'race-new',
        'race-complete-old', 'race-complete-new',
      ]) sessions.delete(sid);
      currentView = 'card';
      activeSessionId = 'e2e-top-level';
      await window._loadSessionHistoryToOverlay('e2e-top-level', { forceScrollBottom: true });
      renderSessionList();
      applyViewMode('card');
      const header = document.querySelector('.terminal-title');
      if (header) header.textContent = 'E2E · Codex card session isolation passed';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise(resolve => setTimeout(resolve, 250));
      return true;
    })()`);
    await client.send('Page.bringToFront');
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    result.screenshotPath = SCREENSHOT_PATH;
    result.hubPid = hub.pid;
    const logTail = hub.log().slice(-30);
    const hookLine = logTail.find(line => line.includes('hook server listening on')) || '';
    const hookPortMatch = hookLine.match(/:(\d+)/);
    result.runtime = {
      devToolsReady: logTail.some(line => line.includes(`127.0.0.1:${PORT}/devtools/browser/`)),
      hookPort: hookPortMatch ? Number(hookPortMatch[1]) : null,
      hookPortFallbackUsed: logTail.some(line => line.includes('EADDRINUSE')),
    };
    fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log('[PASS] card session isolation E2E');
    console.log(JSON.stringify({ screenshotPath: SCREENSHOT_PATH, resultPath: RESULT_PATH }));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    if (TEMP_ROOT.startsWith(os.tmpdir())) {
      await fs.promises.rm(TEMP_ROOT, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error('[FAIL] card session isolation E2E');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
