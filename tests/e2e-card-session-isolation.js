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
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port: PORT,
      label: 'card-session-isolation',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: path.join(TEMP_ROOT, 'home'),
        DEEPSEEK_API_KEY: '',
      },
    });
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

    result.unboundLiveRefresh = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      const overlay = document.getElementById('msg-overlay');
      const sid = 'unbound-live-refresh';
      let parseCalls = 0;
      ipcRenderer.invoke = (channel, args) => {
        if (channel === 'parse-session-transcript' && args && args.hubSessionId === sid) {
          parseCalls += 1;
          if (parseCalls < 3) {
            return Promise.resolve({ turns: [], transcriptPath: null, error: 'transcript not found yet' });
          }
          return Promise.resolve({
            turns: [{
              id: 'unbound-live-answer',
              role: 'assistant',
              text: 'UNBOUND LIVE REFRESH APPEARED',
              ts: Date.now(),
              kind: 'codex',
            }],
            transcriptPath: null,
            error: null,
          });
        }
        return originalInvoke(channel, args);
      };
      try {
        sessions.set(sid, {
          id: sid,
          kind: 'codex',
          title: 'Unbound live refresh',
          cwd: 'C:/tmp',
          status: 'running',
          // Deliberately omit transcriptPath / ccSessionId / codexSid. Main's
          // transcript router may already know more than this renderer snapshot.
        });
        currentView = 'card';
        activeSessionId = sid;
        _cardHistoryHydratedSid = sid;
        overlay.innerHTML = '';
        window._sessionTurns.clear();
        let scheduledCount = 0;
        for (let index = 0; index < 1000; index += 1) {
          if (window.__hubE2E.cardLiveRefresh.noteOutput(sid)) scheduledCount += 1;
        }
        const deadline = Date.now() + 5000;
        while (!overlay.innerText.includes('UNBOUND LIVE REFRESH APPEARED') && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        const state = window.__hubE2E.cardLiveRefresh.state(sid);
        window.__hubE2E.cardLiveRefresh.dispose(sid);
        const disposedState = window.__hubE2E.cardLiveRefresh.state(sid);
        return {
          scheduledCount,
          parseCalls,
          appeared: overlay.innerText.includes('UNBOUND LIVE REFRESH APPEARED'),
          state,
          disposedState,
        };
      } finally {
        window.__hubE2E.cardLiveRefresh.dispose(sid);
        sessions.delete(sid);
        ipcRenderer.invoke = originalInvoke;
      }
    })()`);
    assert.equal(result.unboundLiveRefresh.scheduledCount, 1000);
    assert.equal(result.unboundLiveRefresh.parseCalls, 3, JSON.stringify(result.unboundLiveRefresh));
    assert.equal(result.unboundLiveRefresh.appeared, true);
    assert.equal(result.unboundLiveRefresh.state.reload.lastReason, 'stream-settle-2500ms');
    assert.equal(result.unboundLiveRefresh.state.settle.pending, true);
    assert.deepEqual(result.unboundLiveRefresh.disposedState, { reload: null, settle: null });

    result.sameSessionHydrationRace = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      const overlay = document.getElementById('msg-overlay');
      const sid = 'same-sid-hydration-race';
      let resolveFull;
      let resolveIncremental;
      ipcRenderer.invoke = (channel, args) => {
        if (channel === 'parse-session-transcript' && args && args.hubSessionId === sid) {
          if (args.opts && args.opts.limit === 1) {
            return new Promise(resolve => { resolveIncremental = resolve; });
          }
          return new Promise(resolve => { resolveFull = resolve; });
        }
        return originalInvoke(channel, args);
      };
      try {
        sessions.set(sid, {
          id: sid, kind: 'codex', title: 'Same-session hydration race',
          cwd: ${JSON.stringify(TEMP_ROOT)}, transcriptPath: 'race-rollout.jsonl', status: 'running'
        });
        currentView = 'card';
        activeSessionId = sid;
        _cardHistoryHydratedSid = null;

        const fullPending = window._loadSessionHistoryToOverlay(sid);
        await new Promise(resolve => setTimeout(resolve, 0));
        const duringFull = overlay.innerText;
        const incrementalPending = window._loadSessionHistoryToOverlay(sid, {
          incremental: true,
          parseOpts: { limit: 1, fromTail: true },
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        resolveFull({
          turns: [
            { id: 'same-old-user', role: 'user', text: 'SAME OLD USER', ts: 1 },
            { id: 'same-old-answer', role: 'assistant', text: 'SAME OLD ANSWER', ts: 2 },
            { id: 'same-latest-user', role: 'user', text: 'SAME LATEST USER', ts: 3 },
            { id: 'same-latest-answer', role: 'assistant', text: 'SAME LATEST ANSWER', ts: 4 },
          ],
          transcriptPath: 'race-rollout.jsonl',
          error: null,
        });
        const fullResult = await fullPending;
        const afterFull = overlay.innerText;

        resolveIncremental({
          turns: [{ id: 'same-latest-answer', role: 'assistant', text: 'SAME LATEST ANSWER', ts: 4 }],
          transcriptPath: 'race-rollout.jsonl',
          error: null,
        });
        const incrementalResult = await incrementalPending;
        const finalText = overlay.innerText;
        return {
          duringFull,
          afterFull,
          fullResult,
          incrementalResult,
          finalText,
          placeholder: overlay.querySelector('.msg-overlay-placeholder')?.innerText || null,
          cardCount: overlay.querySelectorAll('.turn-card').length,
          hydratedSid: _cardHistoryHydratedSid,
        };
      } finally {
        ipcRenderer.invoke = originalInvoke;
      }
    })()`);
    assert.match(result.sameSessionHydrationRace.duringFull, /正在加载历史卡片/);
    assert.equal(result.sameSessionHydrationRace.fullResult.error, null);
    assert.equal(result.sameSessionHydrationRace.fullResult.mounted, 4);
    assert.equal(result.sameSessionHydrationRace.incrementalResult.error, null);
    assert.equal(result.sameSessionHydrationRace.placeholder, null);
    assert.equal(result.sameSessionHydrationRace.cardCount, 4);
    assert.match(result.sameSessionHydrationRace.finalText, /SAME OLD USER/);
    assert.match(result.sameSessionHydrationRace.finalText, /SAME OLD ANSWER/);
    assert.match(result.sameSessionHydrationRace.finalText, /SAME LATEST USER/);
    assert.match(result.sameSessionHydrationRace.finalText, /SAME LATEST ANSWER/);
    assert.equal(result.sameSessionHydrationRace.hydratedSid, 'same-sid-hydration-race');

    result.sameSessionReverseRace = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      const overlay = document.getElementById('msg-overlay');
      const sid = 'same-sid-reverse-race';
      let resolveFull;
      let resolveIncremental;
      ipcRenderer.invoke = (channel, args) => {
        if (channel === 'parse-session-transcript' && args && args.hubSessionId === sid) {
          if (args.opts && args.opts.limit === 1) {
            return new Promise(resolve => { resolveIncremental = resolve; });
          }
          return new Promise(resolve => { resolveFull = resolve; });
        }
        return originalInvoke(channel, args);
      };
      try {
        sessions.set(sid, {
          id: sid, kind: 'codex', title: 'Same-session reverse race',
          cwd: ${JSON.stringify(TEMP_ROOT)}, transcriptPath: 'reverse-race-rollout.jsonl', status: 'running'
        });
        currentView = 'card';
        activeSessionId = sid;
        _cardHistoryHydratedSid = null;

        const fullPending = window._loadSessionHistoryToOverlay(sid);
        await new Promise(resolve => setTimeout(resolve, 0));
        const incrementalPending = window._loadSessionHistoryToOverlay(sid, {
          incremental: true,
          parseOpts: { limit: 1, fromTail: true },
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        resolveIncremental({
          turns: [{ id: 'reverse-latest', role: 'assistant', text: 'REVERSE LATEST ANSWER', ts: 3 }],
          transcriptPath: 'reverse-race-rollout.jsonl',
          error: null,
        });
        const incrementalResult = await incrementalPending;
        const afterIncremental = overlay.innerText;

        // The older full snapshot deliberately does not include reverse-latest.
        resolveFull({
          turns: [
            { id: 'reverse-old-user', role: 'user', text: 'REVERSE OLD USER', ts: 1 },
            { id: 'reverse-old-answer', role: 'assistant', text: 'REVERSE OLD ANSWER', ts: 2 },
          ],
          transcriptPath: 'reverse-race-rollout.jsonl',
          error: null,
        });
        const fullResult = await fullPending;
        return {
          incrementalResult,
          fullResult,
          afterIncremental,
          finalText: overlay.innerText,
          ids: Array.from(overlay.querySelectorAll(':scope > .turn-card')).map(card => card.dataset.turnId),
          placeholder: overlay.querySelector('.msg-overlay-placeholder')?.innerText || null,
          cardCount: overlay.querySelectorAll(':scope > .turn-card').length,
          mapHasLatest: window._sessionTurns.has('reverse-latest'),
          hydratedSid: _cardHistoryHydratedSid,
        };
      } finally {
        ipcRenderer.invoke = originalInvoke;
      }
    })()`);
    assert.equal(result.sameSessionReverseRace.incrementalResult.mounted, 1);
    assert.match(result.sameSessionReverseRace.afterIncremental, /REVERSE LATEST ANSWER/);
    assert.equal(result.sameSessionReverseRace.fullResult.mounted, 2);
    assert.equal(result.sameSessionReverseRace.placeholder, null);
    assert.equal(result.sameSessionReverseRace.cardCount, 3);
    assert.deepEqual(result.sameSessionReverseRace.ids, [
      'reverse-old-user', 'reverse-old-answer', 'reverse-latest',
    ]);
    assert.match(result.sameSessionReverseRace.finalText, /REVERSE OLD USER/);
    assert.match(result.sameSessionReverseRace.finalText, /REVERSE OLD ANSWER/);
    assert.match(result.sameSessionReverseRace.finalText, /REVERSE LATEST ANSWER/);
    assert.equal(result.sameSessionReverseRace.mapHasLatest, true);
    assert.equal(result.sameSessionReverseRace.hydratedSid, 'same-sid-reverse-race');

    await client.eval(`(async () => {
      const overlay = document.getElementById('msg-overlay');
      for (const sid of [
        'e2e-subagent',
        'race-old', 'race-new',
        'race-complete-old', 'race-complete-new',
        'unbound-live-refresh',
        'same-sid-hydration-race',
        'same-sid-reverse-race',
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
