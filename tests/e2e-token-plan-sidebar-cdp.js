'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, seedUsageData, waitFor, click } = require('./helpers/usage-refresh-fixture');
const { setStaticSidebarLayout } = require('./helpers/sidebar-quota-geometry');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-token-plan-'));
  const dataDir = path.join(root, 'data');
  const fixture = seedUsageData(dataDir, 'regression');
  const out = path.resolve(__dirname, '../artifacts/token-plan-sidebar');
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'bailian'));
  fs.writeFileSync(path.join(dataDir, 'bailian/config.json'), '{}');
  const control = path.join(root, 'quota.json');
  fs.writeFileSync(control, JSON.stringify({ ratio: 0.453284435, code: 0 }));
  const cli = path.join(fixture.fakeAppData, 'npm/node_modules/bailian-cli/dist/bailian.mjs');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, `import fs from 'node:fs';
    const args=process.argv.slice(2);
    if(args.join(' ')!=='usage token-plan --output json --console-region cn-beijing --console-site domestic --timeout 15')process.exit(99);
    fs.appendFileSync(${JSON.stringify(control + '.calls')},'quota-only\\n');
    const c=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
    if(c.code)process.exit(c.code);
    console.error('harmless CLI warning');
    console.log(JSON.stringify({per1WeekPercentage:c.ratio,per1WeekResetTime:1789754700000}));`);
  let hub, cdp;
  const result = { dataDir, checks: [], modelCalls: 0, fixture: 'Controlled CLI at real executable boundary; actual isolated Hub, service, IPC and UI' };
  const check = (name, passed) => { assert(passed, name); result.checks.push(name); console.log('PASS', name); };
  const value = `document.querySelector('.sidebar-quota-provider[data-provider="tokenPlan"] .sidebar-quota-value')`;
  const button = '.sidebar-quota-provider[data-provider="tokenPlan"] .sidebar-quota-refresh';
  try {
    hub = await launchIsolatedHub({ dataDir, port: await getFreePort(), windowMode: 'hidden',
      extraEnv: { APPDATA: fixture.fakeAppData, CLAUDE_HUB_E2E: '1' } });
    result.pid = hub.pid;
    cdp = await connectFirstPage(hub);
    await waitFor(cdp, `${value}?.textContent === '54.67%'`);
    check('first load displays actual parsed quota without opening settings or switching sessions', true);
    check('hook server listening', hub.log().some(s => s.includes('hook server listening')));
    check('reset tooltip includes Beijing time', await cdp.eval(`document.querySelector('.sidebar-quota-provider[data-provider="tokenPlan"]').title.includes('北京时间')`));
    result.geometry = [];
    for (const width of [280, 380]) for (const zoom of [1, 1.25]) {
      await setStaticSidebarLayout(cdp, width, zoom);
      const geometry = await cdp.eval(`(() => {
        const row=document.querySelector('.sidebar-quota-provider[data-provider="tokenPlan"]');
        const r=row.getBoundingClientRect(),pair=document.querySelector('.sidebar-quota-pair').getBoundingClientRect(),resources=document.querySelector('#sidebar-strip').getBoundingClientRect();
        return {ordered:pair.bottom<=r.top+1 && r.bottom<=resources.top+1,overflow:[...row.children].some(e=>e.getBoundingClientRect().right>r.right+1),text:row.innerText};
      })()`);
      check('ordered and no overflow at ' + width + '/' + zoom, geometry.ordered && !geometry.overflow);
      result.geometry.push({ width, zoom, ...geometry });
    }
    await setStaticSidebarLayout(cdp, 380, 1);
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'normal.png'), Buffer.from(shot.data, 'base64'));
    // Real pointer activation, once the production 30-second manual cooldown expires.
    fs.writeFileSync(control, JSON.stringify({ code: 6 }));
    await waitFor(cdp, `Date.now()-accountUsageController.getSnapshot().tokenPlan.observedAt > 31000`, 45000);
    await click(cdp, button);
    await waitFor(cdp, `!!accountUsageController.getSnapshot().refresh.providers.tokenPlan.error`);
    check('failure keeps previous value and marks it stale', await cdp.eval(`${value}.textContent === '54.67%' && ${value}.closest('.sidebar-quota-provider').dataset.freshness === 'stale'`));
    // A changed console account must discard the previous account's quota.
    fs.writeFileSync(path.join(dataDir, 'bailian/config.json'), '{"account":"other"}');
    fs.writeFileSync(control, JSON.stringify({ code: 3 }));
    await waitFor(cdp, `${value}.textContent === '需登录'`);
    check('account switch clears quota; missing authentication is visible', true);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'needs-login.png'), Buffer.from(shot.data, 'base64'));
    result.queryCalls = fs.readFileSync(control + '.calls', 'utf8').trim().split('\n').length;
    result.passed = true;
  } catch (e) { result.error = e.stack; throw e; }
  finally {
    if (hub) fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n'));
    if (cdp) await cdp.close();
    if (hub) result.teardown = await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
