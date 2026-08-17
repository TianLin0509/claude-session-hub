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

  // S2: missing -> null
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

  // S7: markDirtySync - immediate persist, no debounce
  {
    sessionStore.markDirtySync('h4', { kind: 'codex', title: 'C4', codexSid: 'sid-immediate', updatedAt: 4000 });
    const loaded = sessionStore.loadSessionFile('h4');
    assert.ok(loaded);
    assert.strictEqual(loaded.codexSid, 'sid-immediate');
    console.log('PASS S7 markDirtySync');
  }

  // S8: Codex card-view resume metadata survives per-session persistence.
  {
    const transcriptPath = path.join(TEMP, 'profiles', 'second', 'sessions', 'rollout-demo.jsonl');
    const codexSessionsRoot = path.join(TEMP, 'profiles', 'second', 'sessions');
    sessionStore.saveSessionFile('h5', {
      kind: 'codex',
      title: 'Codex 2',
      cwd: path.join(TEMP, 'groupchat', 'meeting-1'),
      transcriptPath,
      codexSid: '019e2772-1ba9-7440-afef-3f767ad02765',
      codexSessionsRoot,
      codexAllowMtimeFallback: true,
      currentModel: { id: 'gpt-5.6-sol' },
      effort: 'max',
      mcpProfile: 'none',
      codexSpeedTier: 'inherit',
      contextMax: 1_000_000,
      updatedAt: 5000,
    });
    const loaded = sessionStore.loadSessionFile('h5');
    assert.ok(loaded);
    assert.strictEqual(loaded.transcriptPath, transcriptPath);
    assert.strictEqual(loaded.codexSessionsRoot, codexSessionsRoot);
    assert.strictEqual(loaded.codexAllowMtimeFallback, true);
    assert.strictEqual(loaded.effort, 'max');
    assert.strictEqual(loaded.mcpProfile, 'none');
    assert.strictEqual(loaded.codexSpeedTier, 'inherit', 'explicit inherit must survive resume persistence');
    assert.strictEqual(loaded.contextMax, 1_000_000);
    console.log('PASS S8 codex card metadata');
  }

  // S9: Legacy branch titles are canonicalized at the per-session authority.
  // Renderer-only migration can be overwritten by a live main-process echo;
  // the JSON itself must no longer preserve the old suffix form.
  {
    sessionStore.saveSessionFile('legacy-branch', {
      kind: 'codex', title: 'Codex 2 · 分支', userRenamed: true, updatedAt: 6000,
    });
    const loaded = sessionStore.loadSessionFile('legacy-branch');
    const raw = JSON.parse(fs.readFileSync(path.join(TEMP, 'sessions', 'legacy-branch.json'), 'utf8'));
    assert.strictEqual(loaded.title, '分支: Codex 2');
    assert.strictEqual(raw.title, '分支: Codex 2', 'disk payload must use the canonical front-loaded marker');
    console.log('PASS S9 legacy branch title canonicalized on disk');
  }

  // S10: automatic hibernation metadata and unread state survive self-heal backup.
  {
    sessionStore.saveSessionFile('auto-sleep', {
      kind: 'codex', title: 'Auto sleeping', codexSid: 'native-auto',
      unreadCount: 4, suspendedAt: 7000, suspendReason: 'idle-timeout', updatedAt: 7001,
    });
    const loaded = sessionStore.loadSessionFile('auto-sleep');
    assert.strictEqual(loaded.unreadCount, 4);
    assert.strictEqual(loaded.suspendedAt, 7000);
    assert.strictEqual(loaded.suspendReason, 'idle-timeout');
    console.log('PASS S10 auto-sleep metadata');
  }

  // S11: provider/session behavior survives recovery from the per-id authority.
  {
    sessionStore.saveSessionFile('resume-policy', {
      kind: 'codex', title: 'Policy', codexSid: 'native-policy',
      codexProfile: 'work', mcpProfile: 'browser', effort: 'high',
      userRenamed: true, branchSourceSessionId: 'parent', contextPct: 37,
      updatedAt: 8000,
    });
    const loaded = sessionStore.loadSessionFile('resume-policy');
    assert.strictEqual(loaded.codexProfile, 'work');
    assert.strictEqual(loaded.mcpProfile, 'browser');
    assert.strictEqual(loaded.effort, 'high');
    assert.strictEqual(loaded.userRenamed, true);
    assert.strictEqual(loaded.branchSourceSessionId, 'parent');
    assert.strictEqual(loaded.contextPct, 37);
    console.log('PASS S11 resume policy metadata');
  }

  console.log('\n[ALL session-store tests PASSED]');
})();
