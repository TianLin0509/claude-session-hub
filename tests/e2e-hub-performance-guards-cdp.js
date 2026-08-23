'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port');
}

async function waitForEval(client, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(200);
  }
  throw new Error(`timeout waiting for ${expression}`);
}

(async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const dataDir = path.join(os.tmpdir(), `claude-session-hub-perf-e2e-${stamp}`);
  const port = await availablePort(Number(process.env.HUB_PERF_E2E_PORT || 19491));
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'hub-performance-guards',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1365, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await waitForEval(client, 'window.__hubE2E && window.__hubE2E.terminalCacheStats && window.__hubE2E.sidebarRenderCoalescerStats && window.MeetingRoom');

    const result = await client.eval(`(async () => {
      const api = window.__hubE2E;
      const initial = api.terminalCacheStats();
      const replayProbe = await api.probeTerminalReplayResponsiveness();
      const now = Date.now();
      const electronIpc = require('electron').ipcRenderer;
      const bulkSidebar = api.addFakeSessions(Array.from({ length: 900 }, (_, i) => ({
        id: 'perf-old-' + i,
        kind: i % 3 === 0 ? 'codex' : 'claude',
        title: 'Old session ' + i,
        status: 'dormant',
        createdAt: now - (4 * 86400000) - i,
        lastMessageTime: now - (4 * 86400000) - i,
      })));
      api.addFakeSession({ id: 'perf-status-burst', kind: 'claude', title: 'Status burst', status: 'idle', createdAt: now, lastMessageTime: now });
      const renderStatsBeforeBurst = api.sidebarRenderCoalescerStats();
      for (let i = 0; i < 200; i++) {
        electronIpc.emit('status-event', {}, { sessionId: 'perf-status-burst', contextPct: i % 100, contextUsed: i * 100 });
      }
      await new Promise(resolve => setTimeout(resolve, 200));
      const renderStatsAfterBurst = api.sidebarRenderCoalescerStats();
      api.addFakeSession({
        id: 'perf-state-burst', kind: 'codex', title: 'State burst', status: 'idle',
        createdAt: now, lastMessageTime: now,
      });
      const semanticStatsBefore = api.sidebarRenderCoalescerStats();
      for (let i = 0; i < 100; i++) {
        const eventAt = now + 10_000 + (i * 2);
        electronIpc.emit('prompt-submitted-event', {}, {
          hubSessionId: 'perf-state-burst', kind: 'codex', text: 'prompt ' + i,
          submittedAt: eventAt, turnId: 'turn-' + i,
        });
        electronIpc.emit('turn-complete-event', {}, {
          hubSessionId: 'perf-state-burst', kind: 'codex', text: 'done ' + i,
          completedAt: eventAt + 1, turnId: 'turn-' + i,
        });
      }
      await new Promise(resolve => setTimeout(resolve, 200));
      const semanticStatsAfter = api.sidebarRenderCoalescerStats();
      const completedState = { ...sessions.get('perf-state-burst') };
      const sectionForSession = (sessionId) => {
        let current = '';
        for (const node of document.querySelectorAll('#session-list > *')) {
          if (node.classList.contains('session-sec-header')) {
            current = (node.querySelector('span') || node).textContent.trim();
          } else if (node.dataset && node.dataset.sessionId === sessionId) {
            return current;
          }
        }
        return '';
      };
      const completedSection = sectionForSession('perf-state-burst');
      electronIpc.emit('prompt-submitted-event', {}, {
        hubSessionId: 'perf-state-burst', kind: 'codex', text: 'new live turn',
        submittedAt: now + 20_000, turnId: 'turn-live',
      });
      electronIpc.emit('turn-complete-event', {}, {
        hubSessionId: 'perf-state-burst', kind: 'codex', text: 'stale old result',
        completedAt: now + 19_000, turnId: 'turn-old',
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      const staleProtectedState = { ...sessions.get('perf-state-burst') };
      const staleProtectedSection = sectionForSession('perf-state-burst');
      for (let i = 0; i < 20; i++) {
        electronIpc.emit('session-created', {}, { session: {
          id: 'perf-member-created-' + i,
          kind: i % 2 ? 'codex' : 'claude',
          title: 'Perf member ' + i,
          status: 'idle',
          meetingId: 'perf-created-room',
          createdAt: now,
          lastMessageTime: now,
        }});
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      const afterMeetingSessionEvents = api.terminalCacheStats();
      for (let i = 0; i < 8; i++) {
        api.addFakeSession({
          id: 'perf-shell-' + i,
          kind: i % 2 ? 'codex' : 'claude',
          title: 'Perf shell ' + i,
          status: 'idle',
          createdAt: now + i,
          lastMessageTime: now + i,
        });
        await api.selectSession('perf-shell-' + i);
        await new Promise(resolve => setTimeout(resolve, 45));
      }
      const afterShells = api.terminalCacheStats();
      electronIpc.emit('terminal-data', {}, {
        sessionId: 'perf-shell-0',
        data: '\\r\\nHIDDEN_XTERM_BUFFER_SURVIVES\\r\\n',
        seq: 9001,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      const hiddenBufferHasMarker = api.terminalBufferText('perf-shell-0').includes('HIDDEN_XTERM_BUFFER_SURVIVES');
      await api.selectSession('perf-shell-0');
      await new Promise(resolve => setTimeout(resolve, 100));
      const afterRestore = api.terminalCacheStats();
      const restoredBufferHasMarker = api.terminalBufferText('perf-shell-0').includes('HIDDEN_XTERM_BUFFER_SURVIVES');

      const sids = ['perf-dormant-1', 'perf-dormant-2', 'perf-dormant-3'];
      sids.forEach((sid, i) => api.addFakeSession({
        id: sid,
        kind: i === 1 ? 'codex' : 'claude',
        title: sid,
        status: 'dormant',
        meetingId: 'perf-serial-meeting',
        createdAt: now,
        lastMessageTime: now,
      }));
      meetings['perf-serial-meeting'] = {
        id: 'perf-serial-meeting',
        title: 'Perf serial meeting',
        scene: 'general',
        groupChat: true,
        status: 'dormant',
        subSessions: sids,
        participants: [0, 1, 2],
        focusedSub: sids[0],
        serialWorkflow: { enabled: true, steps: [['m1'], ['m2'], ['m3']] },
        createdAt: now,
        updatedAt: now,
        lastMessageTime: now,
      };
      await api.selectMeeting('perf-serial-meeting');
      await new Promise(resolve => setTimeout(resolve, 250));
      const afterMeetingStats = api.terminalCacheStats();
      const meetingPanelVisible = getComputedStyle(document.getElementById('meeting-room-panel')).display !== 'none';
      await api.selectSession('perf-shell-7');
      electronIpc.emit('session-suspended', {}, {
        sessionId: 'perf-shell-7',
        session: {
          id: 'perf-shell-7', kind: 'codex', codexSid: 'perf-native-7',
          title: 'Perf shell 7', status: 'dormant', lastMessageTime: now,
        },
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        initial,
        replayProbe,
        afterMeetingSessionEvents,
        afterShells,
        afterMeeting: afterMeetingStats,
        memberStatuses: sids.map(sid => sessions.get(sid)?.status),
        panelVisible: meetingPanelVisible,
        renderStatsBeforeBurst,
        renderStatsAfterBurst,
        semanticStatsBefore,
        semanticStatsAfter,
        completedState: {
          status: completedState.status,
          attentionState: completedState.attentionState,
          isWaiting: completedState.isWaiting,
          unreadCount: completedState.unreadCount,
        },
        staleProtectedState: {
          status: staleProtectedState.status,
          attentionState: staleProtectedState.attentionState,
          isWaiting: staleProtectedState.isWaiting,
          unreadCount: staleProtectedState.unreadCount,
        },
        completedSection,
        staleProtectedSection,
        sidebarRenderStats: api.sidebarRenderStats(),
        bulkSidebar,
        hiddenBufferHasMarker,
        restoredBufferHasMarker,
        afterRestore,
        suspended: {
          exists: sessions.has('perf-shell-7'),
          status: sessions.get('perf-shell-7')?.status,
          cache: api.terminalCacheStats(),
          bulkActionVisible: !!document.getElementById('options-suspend-idle'),
          emptyStateVisible: getComputedStyle(document.getElementById('empty-state')).display !== 'none',
        },
      };
    })()`);

    assert.strictEqual(result.initial.size, 0, 'isolated Hub should start without eager xterms');
    assert.ok(result.replayProbe.bytes > 2 * 1024 * 1024, JSON.stringify(result.replayProbe));
    assert.ok(result.replayProbe.heartbeatCount >= 3, JSON.stringify(result.replayProbe));
    assert.ok(result.replayProbe.maxHeartbeatDelayMs < 100,
      `large terminal replay blocked renderer for ${result.replayProbe.maxHeartbeatDelayMs}ms`);
    assert.strictEqual(result.afterMeetingSessionEvents.size, 0, 'meeting session-created events must not warm hidden xterms');
    assert.strictEqual(result.initial.policy, 'session-lifecycle');
    assert.strictEqual(result.initial.max, null, 'live xterms must not have an arbitrary count limit');
    assert.strictEqual(result.afterShells.size, 8, 'every explicitly opened live session must retain its xterm');
    assert.deepStrictEqual(result.afterShells.ids, Array.from({ length: 8 }, (_, i) => `perf-shell-${i}`));
    assert.strictEqual(result.afterShells.rendererSurfaces, 1, 'only the visible xterm may retain a Canvas/WebGL surface');
    assert.strictEqual(result.hiddenBufferHasMarker, true, 'hidden xterm must keep parsing live PTY output');
    assert.strictEqual(result.restoredBufferHasMarker, true, 'reloading the renderer surface must preserve xterm history');
    assert.strictEqual(result.afterRestore.size, 8, 'restoring a surface must not recreate or evict the xterm');
    assert.strictEqual(result.afterRestore.rendererSurfaces, 1, 'restored visible xterm should own the sole renderer surface');
    assert.strictEqual(result.afterMeeting.size, 8, 'opening a serial room must not create or evict hidden xterms');
    assert.strictEqual(result.afterMeeting.rendererSurfaces, 0, 'meeting/home views should release every hidden terminal surface');
    assert.deepStrictEqual(result.memberStatuses, ['dormant', 'dormant', 'dormant']);
    assert.strictEqual(result.panelVisible, true, 'serial meeting UI should remain usable');
    assert.strictEqual(result.renderStatsAfterBurst.requests - result.renderStatsBeforeBurst.requests, 200, 'all status events should request a coalesced render');
    assert.ok(result.renderStatsAfterBurst.renders - result.renderStatsBeforeBurst.renders <= 3, JSON.stringify(result));
    assert.strictEqual(result.semanticStatsAfter.requests - result.semanticStatsBefore.requests, 200,
      'every semantic transition should request a coalesced sidebar render');
    assert.ok(result.semanticStatsAfter.renders - result.semanticStatsBefore.renders <= 3,
      JSON.stringify({ before: result.semanticStatsBefore, after: result.semanticStatsAfter }));
    assert.deepStrictEqual(result.completedState, {
      status: 'idle', attentionState: 'reply-ready', isWaiting: false, unreadCount: 1,
    });
    assert.deepStrictEqual(result.staleProtectedState, {
      status: 'running', attentionState: 'none', isWaiting: false, unreadCount: 0,
    });
    assert.strictEqual(result.completedSection, '✓ 已完成未读');
    assert.strictEqual(result.staleProtectedSection, '运行中');
    assert.strictEqual(result.bulkSidebar.count, 900, JSON.stringify(result.bulkSidebar));
    assert.ok(result.bulkSidebar.renderMs < 250, `900-session sidebar render took ${result.bulkSidebar.renderMs}ms`);
    assert.ok(result.sidebarRenderStats.maxMs < 250, JSON.stringify(result.sidebarRenderStats));
    assert.strictEqual(result.suspended.exists, true);
    assert.strictEqual(result.suspended.status, 'dormant');
    assert.strictEqual(result.suspended.cache.size, 7);
    assert.deepStrictEqual(result.suspended.cache.ids, Array.from({ length: 7 }, (_, i) => `perf-shell-${i}`));
    assert.strictEqual(result.suspended.bulkActionVisible, true);
    assert.strictEqual(result.suspended.emptyStateVisible, true,
      'session-suspended must retain the card while releasing its cached xterm');

    console.log(JSON.stringify({ ok: true, pid: hub.pid, port, result }, null, 2));
  } catch (err) {
    console.error(err.stack || err.message);
    if (hub) console.error(hub.log().slice(-50).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) { try { client.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('claude-session-hub-perf-e2e-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})();
