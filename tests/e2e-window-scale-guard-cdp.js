'use strict';
// 窗口缩放兜底（core/window-scale-guard.js，2026-10-19）真实端到端：
//   node tests/e2e-window-scale-guard-cdp.js [--out <结果目录>]
// 两台隔离 Hub（后台窗口，不打断使用者），都显式打开兜底（CLAUDE_HUB_E2E_SCALE_GUARD=1）：
//   A. 正常启动：窗口显示后只记一条读数（scale-probe，mismatch 为 null），没有任何动作；
//   B. 模拟不一致：CLAUDE_HUB_E2E_SCALE_PROBE 把页面缩放读数改成 0.5（和显示器不一致），兜底动作一次（setBounds），
//      1 秒后按真实读数复查一致。
// 不接 CDP 的设备模拟（那会改页面缩放）；结果从数据目录的 logs/window-events.log 读。
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');

const argv = process.argv.slice(2);
const repo = path.resolve(__dirname, '..');
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(repo, 'artifacts', '20261019-window-scale-guard-claude1'));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const events = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { const m = /^(\S+) (\S+) (.*)$/.exec(l); return m ? { at: m[1], event: m[2], detail: JSON.parse(m[3]) } : null; }).filter(Boolean); } catch { return []; } };

async function run(root, label, extraEnv) {
  const data = path.join(root, label);
  const hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label, allowExternalState: true,
    extraEnv: { CLAUDE_HUB_E2E: '1', DEEPSEEK_API_KEY: '', CLAUDE_HUB_E2E_SCALE_GUARD: '1', HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), ...extraEnv } });
  const file = path.join(data, 'logs', 'window-events.log');
  try {
    let list = [];
    for (const end = Date.now() + 60000; Date.now() < end; await _waitMs(500)) {
      list = events(file).filter(e => /^scale-/.test(e.event));
      if (list.some(e => e.event === 'scale-probe') && (!extraEnv.CLAUDE_HUB_E2E_SCALE_PROBE || list.some(e => e.event === 'scale-recheck'))) break;
    }
    await _waitMs(4000); // 再等一会儿，确认没有多余的动作
    return events(file).filter(e => /^scale-/.test(e.event));
  } finally { await gracefulQuit(hub).catch(e => console.warn('quit', e.message)); }
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || 'D:/Temp', 'hub-scale-guard-'));
  const result = { passed: false, root, out, checks: [], scope: '真实 Electron 隔离实例 ×2（后台窗口）；模拟不一致靠覆盖页面缩放读数，复查用真实读数' };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); console.log('✔ ' + label); };
  try {
    const normal = await run(root, 'normal', {});
    result.normal = normal;
    const probe = normal.find(e => e.event === 'scale-probe');
    check(probe && probe.detail.mismatch === null && probe.detail.displayScale > 0, `正常启动：窗口显示后记一条读数（显示器 ${probe && probe.detail.displayScale}，页面 ${probe && probe.detail.windowScale}），判为一致`);
    check(!normal.some(e => /^scale-(mismatch|fix|recheck)/.test(e.event)), '正常启动：兜底没有任何动作');
    const sim = await run(root, 'simulated', { CLAUDE_HUB_E2E_SCALE_PROBE: JSON.stringify({ windowScale: 0.5 }) });
    result.simulated = sim;
    const fixed = sim.find(e => e.event === 'scale-mismatch-fixed');
    check(fixed && fixed.detail.reasons.includes('scale') && ['setbounds', 'remaximize'].includes(fixed.detail.action), '模拟不一致：兜底动作一次（' + (fixed && fixed.detail.action) + '）');
    const recheck = sim.find(e => e.event === 'scale-recheck');
    check(recheck && recheck.detail.ok === true, '动作后按真实读数复查：一致');
    check(sim.filter(e => e.event === 'scale-mismatch-fixed').length === 1, '只动作了一次');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    console.error(result.error);
  } finally {
    fs.writeFileSync(path.join(out, '20261019-window-scale-guard-result-claude1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : null }));
    if (!result.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
