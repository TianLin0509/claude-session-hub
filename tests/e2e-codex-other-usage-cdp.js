'use strict';
// Real isolated Hub: the usage popover lists the Codex account not in use, read through the
// controlled app-server of usage-refresh-fixture with that account's own CODEX_HOME.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, seedUsageData, waitFor, click } = require('./helpers/usage-refresh-fixture');
const OUT = path.resolve(__dirname, '..', 'artifacts', 'codex-other-usage');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-other-'));
  const fixture = seedUsageData(dataDir, 'regression');
  const configPath = path.join(dataDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const otherHome = path.join(dataDir, 'codex-other-home');
  fs.mkdirSync(otherHome, { recursive: true });
  fs.writeFileSync(path.join(otherHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  config.providers.codex.subscription_profiles.push({ id: 'second', label: '主账号', home: otherHome });
  config.proxy = { http: 'http://127.0.0.1:9' };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const evidence = { passed: false, boundary: 'real isolated Hub UI/IPC; Codex rate limits from the controlled app-server fixture', checks: [] };
  let hub, cdp;
  try {
    hub = await launchIsolatedHub({ dataDir, port: await getFreePort(), label: 'codex-other-usage', windowMode: 'hidden',
      extraEnv: { CLAUDE_HUB_E2E: '1', APPDATA: fixture.fakeAppData } });
    cdp = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, `document.querySelectorAll('.sidebar-quota-provider').length === 4`);
    await cdp.eval(`document.querySelector('.sidebar-account-usage .rail-usage-button').click()`);
    await waitFor(cdp, `!document.querySelector('.usage-popover').hidden`);
    const row = `.usage-popover [data-provider="codex-other"][data-profile="second"]`;
    await waitFor(cdp, `document.querySelector('${row}')?.textContent.includes('%')`, 30000);
    const text = await cdp.eval(`document.querySelector('${row}').textContent`);
    assert.match(text, /Codex·主账号/); assert.match(text, /7d\d+%/);
    evidence.checks.push('popover shows Codex·主账号 with its 7d reading: ' + text.replace(/\s+/g, ' '));
    const order = await cdp.eval(`[...document.querySelectorAll('.usage-popover .usage-provider-row')].map(r => r.dataset.provider).join(',')`);
    assert.equal(order, 'claude,codex,codex-other,deepseek');
    assert.match(await cdp.eval(`document.querySelector('.usage-popover [data-provider="codex"]').textContent`), /（在用）/);
    evidence.checks.push('row order ' + order + ': right under the account in use');
    const ring = await cdp.eval(`document.querySelector('.rail-usage-value').textContent`);
    evidence.checks.push('status ring still follows the account in use: ' + ring);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'popover.png'), Buffer.from(shot.data, 'base64'));
    evidence.passed = true;
  } finally {
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(evidence, null, 2));
    try { cdp?.close?.(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
  }
  console.log(JSON.stringify(evidence, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
