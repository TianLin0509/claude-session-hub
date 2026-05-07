// tests/unit-session-store.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sstore-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const sessionStore = require('../core/session-store');

(async function run() {
  // S1: round-trip
  {
    sessionStore.saveSessionFile('h1', {
      kind: 'codex', title: 'CodexA', cwd: 'C:/foo',
      ccSessionId: null, codexSid: 'codex-abc', currentModel: { id: 'gpt-5', displayName: 'GPT-5' },
      updatedAt: 1000,
    });
    const loaded = sessionStore.loadSessionFile('h1');
    assert.ok(loaded);
    assert.strictEqual(loaded.hubId, 'h1');
    assert.strictEqual(loaded.codexSid, 'codex-abc');
    assert.strictEqual(loaded.currentModel.id, 'gpt-5');
    console.log('PASS S1 round-trip');
  }

  // S2: missing → null
  {
    assert.strictEqual(sessionStore.loadSessionFile('nonexistent'), null);
    console.log('PASS S2 missing returns null');
  }

  // S3: list + listWithData
  {
    sessionStore.saveSessionFile('h2', { kind: 'gemini', title: 'GemB', geminiChatId: 'chat-xyz', updatedAt: 2000 });
    const ids = sessionStore.listSessionFiles().sort();
    assert.deepStrictEqual(ids, ['h1', 'h2']);
    const data = sessionStore.listSessionFilesWithData().sort((a, b) => a.hubId.localeCompare(b.hubId));
    assert.strictEqual(data.length, 2);
    assert.strictEqual(data[0].codexSid, 'codex-abc');
    assert.strictEqual(data[1].geminiChatId, 'chat-xyz');
    console.log('PASS S3 list / listWithData');
  }

  // S4: corrupt JSON file is skipped
  {
    const corruptPath = path.join(TEMP, 'sessions', 'corrupt.json');
    fs.writeFileSync(corruptPath, 'not json');
    const data = sessionStore.listSessionFilesWithData();
    // corrupt.json shouldn't appear; only h1+h2 do
    const ids = data.map(d => d.hubId).sort();
    assert.deepStrictEqual(ids, ['h1', 'h2'], 'corrupt JSON is skipped');
    console.log('PASS S4 corrupt JSON skipped');
  }

  // S5: deleteSessionFile
  {
    sessionStore.deleteSessionFile('h1');
    assert.strictEqual(sessionStore.loadSessionFile('h1'), null);
    console.log('PASS S5 delete');
  }

  // S6: markDirty + flushAll (debounced)
  {
    sessionStore.markDirty('h3', { kind: 'claude', title: 'C3', updatedAt: 3000 });
    sessionStore.flushAll();
    const loaded = sessionStore.loadSessionFile('h3');
    assert.ok(loaded);
    assert.strictEqual(loaded.title, 'C3');
    console.log('PASS S6 markDirty + flushAll');
  }

  // S7: markDirtySync — 立即落盘，无防抖
  {
    sessionStore.markDirtySync('h4', { kind: 'codex', title: 'C4', codexSid: 'sid-immediate', updatedAt: 4000 });
    const loaded = sessionStore.loadSessionFile('h4');
    assert.ok(loaded);
    assert.strictEqual(loaded.codexSid, 'sid-immediate');
    console.log('PASS S7 markDirtySync');
  }

  console.log('\n[ALL session-store tests PASSED]');
})();
