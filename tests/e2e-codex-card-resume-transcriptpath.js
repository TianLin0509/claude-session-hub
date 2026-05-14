// Verify a resumed Codex session can render card history from an explicit
// rollout/transcriptPath without waiting for CodexTap to rediscover the file.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const TEMP_ROOT = path.join(os.tmpdir(), `hub-codex-card-resume-${Date.now()}`);
const DATA_DIR = path.join(TEMP_ROOT, 'data');
const ROLLOUT_DIR = path.join(TEMP_ROOT, 'codex-sessions', '2026', '05', '14');
const CODEX_SID = '019faaaa-bbbb-7ccc-8ddd-123456789abc';
const ROLLOUT_PATH = path.join(ROLLOUT_DIR, `rollout-2026-05-14T00-00-00-${CODEX_SID}.jsonl`);

function writeFakeRollout() {
  fs.mkdirSync(ROLLOUT_DIR, { recursive: true });
  const lines = [
    {
      timestamp: '2026-05-14T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: CODEX_SID,
        timestamp: '2026-05-14T00:00:00.000Z',
        cwd: TEMP_ROOT,
        originator: 'codex_cli_rs',
      },
    },
    {
      timestamp: '2026-05-14T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'E2E Codex resume question' },
    },
    {
      timestamp: '2026-05-14T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        last_agent_message: 'E2E Codex resume answer from rollout path',
        duration_ms: 321,
      },
    },
  ];
  fs.writeFileSync(ROLLOUT_PATH, lines.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
}

async function main() {
  writeFakeRollout();
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: 9398, label: 'codex-card-resume' });
    await _waitMs(2000);
    client = await connectFirstPage(hub);
    const result = await client.eval(`(async () => {
      const sid = 'e2e-codex-resume-transcriptpath';
      sessions.set(sid, {
        id: sid,
        kind: 'codex',
        title: 'E2E Codex Resume',
        status: 'idle',
        cwd: ${JSON.stringify(TEMP_ROOT)},
        codexSid: ${JSON.stringify(CODEX_SID)},
        transcriptPath: ${JSON.stringify(ROLLOUT_PATH)},
        lastMessageTime: Date.now(),
        lastOutputPreview: '',
      });
      activeSessionId = sid;
      activeMeetingId = null;
      if (emptyStateEl) emptyStateEl.style.display = 'none';
      if (terminalPanelEl) terminalPanelEl.style.display = '';
      applyViewMode('card');
      const loadResult = await window._loadSessionHistoryToOverlay(sid, { forceScrollBottom: true });
      const cards = Array.from(document.querySelectorAll('#msg-overlay .turn-card')).map(el => el.innerText);
      return {
        loadResult,
        cardCount: cards.length,
        text: cards.join('\\n---\\n'),
        placeholder: !!document.querySelector('#msg-overlay .msg-overlay-placeholder'),
      };
    })()`);
    assert.ok(result, 'no E2E result returned');
    assert.strictEqual(result.loadResult.error, null, `load error: ${JSON.stringify(result.loadResult)}`);
    assert.ok(result.cardCount >= 2, `expected user + assistant cards, got ${result.cardCount}`);
    assert.ok(result.text.includes('E2E Codex resume question'), 'user card text missing');
    assert.ok(result.text.includes('E2E Codex resume answer from rollout path'), 'assistant card text missing');
    assert.strictEqual(result.placeholder, false, 'placeholder should be gone after cards mount');
    console.log('[PASS] e2e-codex-card-resume-transcriptpath', JSON.stringify(result.loadResult));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}

main().catch((err) => {
  console.error('[FAIL] e2e-codex-card-resume-transcriptpath');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
