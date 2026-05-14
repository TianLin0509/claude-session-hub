// Verify a resumed Claude session can render card history from an explicit
// transcriptPath without needing a live Claude CLI process.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const TEMP_ROOT = path.join(os.tmpdir(), `hub-claude-card-resume-${Date.now()}`);
const DATA_DIR = path.join(TEMP_ROOT, 'data');
const TRANSCRIPT_DIR = path.join(TEMP_ROOT, 'claude-project');
const TRANSCRIPT_PATH = path.join(TRANSCRIPT_DIR, '11111111-1111-4111-8111-111111111111.jsonl');

function writeFakeTranscript() {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const lines = [
    {
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-05-14T00:00:00.000Z',
      cwd: TEMP_ROOT,
      message: { role: 'user', content: 'E2E resume question' },
    },
    {
      type: 'assistant',
      uuid: 'a-1',
      timestamp: '2026-05-14T00:00:01.000Z',
      cwd: TEMP_ROOT,
      message: {
        role: 'assistant',
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'E2E resume answer from transcriptPath' }],
      },
    },
  ];
  fs.writeFileSync(TRANSCRIPT_PATH, lines.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
}

async function main() {
  writeFakeTranscript();
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({ dataDir: DATA_DIR, port: 9397, label: 'claude-card-resume' });
    await _waitMs(2000);
    client = await connectFirstPage(hub);
    const result = await client.eval(`(async () => {
      const sid = 'e2e-claude-resume-transcriptpath';
      sessions.set(sid, {
        id: sid,
        kind: 'claude-resume',
        title: 'E2E Claude Resume',
        status: 'idle',
        cwd: ${JSON.stringify(TEMP_ROOT)},
        ccSessionId: '11111111-1111-4111-8111-111111111111',
        transcriptPath: ${JSON.stringify(TRANSCRIPT_PATH)},
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
    assert.ok(result.text.includes('E2E resume question'), 'user card text missing');
    assert.ok(result.text.includes('E2E resume answer from transcriptPath'), 'assistant card text missing');
    assert.strictEqual(result.placeholder, false, 'placeholder should be gone after cards mount');
    console.log('[PASS] e2e-claude-card-resume-transcriptpath', JSON.stringify(result.loadResult));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}

main().catch((err) => {
  console.error('[FAIL] e2e-claude-card-resume-transcriptpath');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
