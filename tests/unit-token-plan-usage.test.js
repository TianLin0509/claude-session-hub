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
  const month = parseTokenPlanUsage(JSON.stringify({ per1MonthPercentage: 0.005811098666666666, per1MonthResetTime: 1791820800000 }), 7);
  assert.equal(month.usage30d.pct.toFixed(4), '0.5811');
  assert.equal(month.usage30d.resetsAt, 1791820800000);
  assert.equal(month.usage7d, undefined);
  const both = parseTokenPlanUsage(JSON.stringify({ per1WeekPercentage: 0.5, per1MonthPercentage: 0.25 }), 8);
  assert.equal(both.usage7d.pct, 50);
  assert.equal(both.usage30d.pct, 25);
  for (const bad of [{}, { per1WeekPercentage: 'x' }, { per1MonthPercentage: 2 }, { per1WeekPercentage: -0.1, per1MonthPercentage: 'x' }]) {
    assert.throws(() => parseTokenPlanUsage(JSON.stringify(bad), 1));
  }
  const envelope = JSON.stringify({ code: '200', successResponse: true,
    data: { success: true, DataV2: { data: { code: 'SUCCESS', data: { per1MonthPercentage: 0.25, per1MonthResetTime: 1791820800000 } } } } });
  assert.equal(parseTokenPlanUsage(envelope, 9).usage30d.pct, 25);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-plan-unit-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    let time = 1, calls = 0, callback;
    const service = createTokenPlanUsageService({ configDir: dir, cliPath: __filename, now: () => time,
      execute(node, args, options, cb) {
        calls++; callback = cb;
        assert.equal(args[0], __filename);
        assert.deepEqual(args.slice(1, 3), ['console', 'call']);
        assert(args.includes('zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'));
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
    const intervalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-plan-interval-'));
    try {
      fs.writeFileSync(path.join(intervalDir, 'config.json'), '{}');
      let clock = 1;
      const spawn = (opts) => {
        let calls = 0, cb;
        const svc = createTokenPlanUsageService({ configDir: intervalDir, cliPath: __filename,
          now: () => clock, execute(node, args, options, c) { calls++; cb = c; }, ...opts });
        return { svc, fire: value => cb(null, value), count: () => calls };
      };
      const custom = spawn({ backgroundIntervalMs: 10000 });
      let pending = custom.svc.refresh(); custom.fire(raw); await pending;
      clock += 9000; await custom.svc.refresh(); assert.equal(custom.count(), 1);
      clock += 2000; pending = custom.svc.refresh(); custom.fire(raw); await pending;
      assert.equal(custom.count(), 2);
      const defaulted = spawn({});
      pending = defaulted.svc.refresh(); defaulted.fire(raw); await pending;
      clock += 60000; await defaulted.svc.refresh(); assert.equal(defaulted.count(), 1);
      clock += 250000; pending = defaulted.svc.refresh(); defaulted.fire(raw); await pending;
      assert.equal(defaulted.count(), 2);
    } finally { fs.rmSync(intervalDir, { recursive: true, force: true }); }
    console.log('PASS token-plan: ratios, malformed data, read-only command, coalescing, cooldown, stale retention, auth pause, account switch race, background interval');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
