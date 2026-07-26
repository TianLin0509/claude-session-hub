'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexJsonlUsageService } = require('../main/usage/codex-jsonl-usage-service.js');

test('Codex JSONL usage scanning runs in a worker and coalesces concurrent scans', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-usage-worker-'));
  const now = new Date();
  const dir = path.join(
    root,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'rollout-worker-test.jsonl');
  const tokenEvent = {
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 42.4, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        secondary: { used_percent: 11.8, resets_at: Math.floor(Date.now() / 1000) + 86400 },
      },
    },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(tokenEvent)}\n${'x'.repeat(2 * 1024 * 1024)}\n`, 'utf8');
  const service = new CodexJsonlUsageService();
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let eventLoopTicked = false;
  setImmediate(() => { eventLoopTicked = true; });
  const first = service.scan(root);
  const second = service.scan(root);
  assert.strictEqual(first, second, 'identical in-flight scans should share one promise');
  const result = await first;
  assert.equal(eventLoopTicked, true);
  assert.ok(result.meta.workerThreadId > 0, JSON.stringify(result.meta));
  assert.equal(result.data.usage5h.pct, 42);
  assert.equal(result.data.usage7d.pct, 12);
  assert.equal(service.getStats().coalesced, 1);
});
