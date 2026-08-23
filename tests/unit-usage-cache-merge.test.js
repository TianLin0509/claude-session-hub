'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  mergeUsageCacheSnapshots,
  writeMergedUsageCacheFile,
} = require('../main/usage/usage-cache-merge.js');

test('non-expired app-server Codex usage survives a newer incompatible JSONL snapshot', () => {
  const now = 1_800_000_000_000;
  const live = {
    codex: {
      usage5h: null,
      usage7d: { pct: 7, resetsAt: now + 6 * 86400_000 },
      observedAt: now - 30_000,
      source: 'app-server',
      scopeKey: 'subscription:default:main',
    },
  };
  const fallback = {
    codex: {
      usage5h: { pct: 0, resetsAt: now + 300 * 60_000 },
      usage7d: { pct: 0, resetsAt: now + 7 * 86400_000 },
      observedAt: now,
      source: 'jsonl',
      scopeKey: 'subscription:default:main',
    },
  };
  assert.deepEqual(mergeUsageCacheSnapshots(live, fallback, now).codex, live.codex);
});

test('expired app-server data yields to a newer local reset window', () => {
  const now = 1_800_000_000_000;
  const live = {
    codex: {
      usage7d: { pct: 99, resetsAt: now - 1 },
      observedAt: now - 60_000,
      source: 'app-server',
      scopeKey: 'subscription:default:main',
    },
  };
  const next = {
    codex: {
      usage7d: { pct: 1, resetsAt: now + 7 * 86400_000 },
      observedAt: now,
      source: 'jsonl',
      scopeKey: 'subscription:default:main',
    },
  };
  assert.deepEqual(mergeUsageCacheSnapshots(live, next, now).codex, next.codex);
});

test('other providers merge by observation time', () => {
  const merged = mergeUsageCacheSnapshots(
    { kimi: { observedAt: 200, value: 'newer' }, claude: { ts: 100, value: 'old' } },
    { kimi: { observedAt: 100, value: 'old' }, claude: { ts: 300, value: 'newer' } },
  );
  assert.equal(merged.kimi.value, 'newer');
  assert.equal(merged.claude.value, 'newer');
});

test('concurrent cache writers preserve official Codex usage and unrelated providers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-usage-cache-merge-'));
  const file = path.join(root, 'usage-cache.json');
  const now = 1_800_000_000_000;
  const live = {
    usage7d: { pct: 9, resetsAt: now + 6 * 86400_000 },
    observedAt: now - 30_000,
    source: 'app-server',
    scopeKey: 'subscription:default:main',
  };
  fs.writeFileSync(file, JSON.stringify({ codex: live }), 'utf8');
  try {
    await Promise.all([
      writeMergedUsageCacheFile(file, {
        codex: {
          usage5h: { pct: 0, resetsAt: now + 300 * 60_000 },
          usage7d: { pct: 0, resetsAt: now + 7 * 86400_000 },
          observedAt: now,
          source: 'jsonl',
          scopeKey: 'subscription:default:main',
        },
      }, { now }),
      writeMergedUsageCacheFile(file, { kimi: { observedAt: now, value: 'kimi' } }, { now }),
      writeMergedUsageCacheFile(file, { claude: { observedAt: now, value: 'claude' } }, { now }),
    ]);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(stored.codex, live);
    assert.equal(stored.kimi.value, 'kimi');
    assert.equal(stored.claude.value, 'claude');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
