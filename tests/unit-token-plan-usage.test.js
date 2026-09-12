'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseTokenPlanUsage, createTokenPlanUsageService } = require('../main/usage/token-plan-usage');

async function main() {
  const raw = JSON.stringify({ per1WeekPercentage: 0.453284435, per1WeekResetTime: 1789754700000 });
  assert.equal((100 - parseTokenPlanUsage(raw, 1).usage7d.pct).toFixed(2), '54.67');
  for (const ratio of [null, undefined, false, '0.4', -0.1, 1.1]) {
    assert.throws(() => parseTokenPlanUsage(JSON.stringify({ per1WeekPercentage: ratio }), 1));
  }
  assert.throws(() => parseTokenPlanUsage('{', 1));
  for (const ratio of [0, 1]) assert.equal(parseTokenPlanUsage(JSON.stringify({ per1WeekPercentage: ratio }), 1).usage7d.pct, ratio * 100);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-plan-unit-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    let time = 1, calls = 0, callback;
    const service = createTokenPlanUsageService({ configDir: dir, cliPath: __filename, now: () => time,
      execute(node, args, options, cb) {
        calls++; callback = cb;
        assert.equal(args[0], __filename);
        assert.deepEqual(args.slice(1, 3), ['usage', 'token-plan']);
        // The executable path may itself contain "chat" (for example a
        // chatgpt worktree); only CLI arguments describe requested actions.
        assert(!args.slice(1).some(a => /chat|api-key|mcp/.test(a)));
        assert.equal(options.windowsHide, true);
        assert.equal(options.env.BAILIAN_CONFIG_DIR, dir);
        assert.equal(options.timeout, 20000);
      } });
    const first = service.refresh();
    assert.equal(service.refresh(true), first);
    callback(null, raw, 'harmless runtime warning'); await first;
    assert.equal(service.snapshot().observedAt, 1);
    time += 1000; await service.refresh(true); assert.equal(calls, 1);
    time += 31000;
    const failed = service.refresh(true); callback({ code: 6, stderr: 'secret must not leak' });
    await assert.rejects(failed, e => !e.message.includes('secret'));
    assert.equal(service.snapshot().observedAt, 1);
    assert.equal(service.snapshot().usage7d.pct, 45.3284435);
    time += 31000;
    const auth = service.refresh(true); callback({ code: 3 }); await assert.rejects(auth);
    const count = calls; time += 600000;
    await assert.rejects(service.refresh()); assert.equal(calls, count);
    fs.writeFileSync(path.join(dir, 'config.json'), '{"account":"new"}');
    assert.equal(service.snapshot().usage7d, undefined);
    const changed = service.refresh();
    fs.writeFileSync(path.join(dir, 'config.json'), '{"account":"third"}');
    callback(null, raw); await assert.rejects(changed);
    assert.equal(service.snapshot().usage7d, undefined);
    const recovered = service.refresh(); callback(null, raw); await recovered;
    assert.equal(service.snapshot().needsLogin, false);
    assert.equal(service.snapshot().error, null);
    assert.equal(service.snapshot().observedAt, time);
    console.log('PASS token-plan: ratios, malformed data, read-only command, coalescing, cooldown, stale retention, auth pause, account switch race');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
