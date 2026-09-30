'use strict';
// Isolated Electron and real renderer interactions; Codex output is a controlled fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-card-e2-'));
  const out = path.resolve('artifacts/card-e2-' + Date.now());
  const home = path.join(root, 'codex'), cwd = path.join(root, 'workspace');
  for (const dir of [out, home, cwd]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'card-delivery.html'), '<!doctype html><meta charset="utf-8"><p>隔离验收产物</p>', 'utf8');
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "low"\n');
  let hub, cdp;
  const evidence = { out, fixture: 'fixture:card-details', passed: false };
  const until = async (expression, label) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await cdp.eval(expression)) return;
      await sleep(150);
    }
    throw Error('timeout: ' + label);
  };
  const click = async selector => {
    const rect = await cdp.eval(`(() => { const el = document.querySelector(${j(selector)});
      if (!el) throw Error('missing: ' + ${j(selector)});
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height }; })()`);
    assert(rect.width && rect.height, 'visible: ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    }
  };
  const shot = async name => {
    const png = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
    return file;
  };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await reservePort(), windowMode: 'hidden', label: 'card E2', extraEnv: {
      CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CLAUDE_HUB_AGENT_RUNTIME: 'native',
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_STORE: path.join(root, 'native-store.json'),
    } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && typeof ipcRenderer !== "undefined"', 'renderer');
    const session = await cdp.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codex', opts: {
      cwd, model: 'gpt-6-astra', effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit',
    } })})`);
    const sid = session.id;
    await until(`document.querySelector('.session-item[data-session-id="${sid}"]')`, 'session row');
    await click(`.session-item[data-session-id="${sid}"]`);
    await until('!!document.querySelector(".floating-input-box")', 'composer');
    if (!await cdp.eval("document.querySelector('#terminal-panel').classList.contains('card-view-active')")) await click('#btn-backstage');
    await cdp.eval("document.querySelector('.floating-input-box').focus()");
    await cdp.send('Input.insertText', { text: 'fixture:card-details\n请展示本轮结果' });
    await click('.floating-input-send');
    const final = '#msg-overlay .turn-card[data-phase="final_answer"]';
    await until(`document.querySelector('${final} .turn-result-glance') && document.querySelector('${final} .turn-delivery-summary')`, 'E2 result card');
    const wide = await cdp.eval(`(() => { const card = document.querySelector('${final}');
      const body = card.querySelector('.turn-primary-copy').getBoundingClientRect();
      const aside = card.querySelector('.turn-result-glance').getBoundingClientRect();
      return { cardWidth: card.getBoundingClientRect().width, bodyRight: body.right, asideLeft: aside.left,
        glance: card.querySelector('.turn-result-glance').innerText,
        deliveryOpen: card.querySelector('.turn-delivery-summary').open }; })()`);
    assert(wide.cardWidth > 650 && wide.asideLeft > wide.bodyRight, j(wide));
    assert.match(wide.glance, /2\s*文件记录/);
    assert.match(wide.glance, /27\s*验证记录/);
    assert.match(wide.glance, /1\s*交付产物/);
    assert.equal(wide.deliveryOpen, false);
    await cdp.eval(`document.querySelector('${final}').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    evidence.wide = wide;
    evidence.wideScreenshot = await shot('wide-card');
    await click(final + ' .turn-delivery-summary > summary');
    assert.equal(await cdp.eval(`document.querySelector('${final} .turn-delivery-summary').open`), true);
    assert.equal(await cdp.eval(`document.querySelectorAll('${final} .turn-delivery-check.status-failed').length`), 1);
    evidence.openScreenshot = await shot('delivery-open');
    await click(final + ' .turn-delivery-summary > summary');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    const narrow = await cdp.eval(`(() => { const card = document.querySelector('${final}');
      const body = card.querySelector('.turn-primary-copy').getBoundingClientRect();
      const aside = card.querySelector('.turn-result-glance').getBoundingClientRect();
      const viewport = document.getElementById('msg-overlay').getBoundingClientRect();
      return { cardWidth: card.getBoundingClientRect().width, bodyBottom: body.bottom, asideTop: aside.top,
        asideRight: aside.right, viewportRight: viewport.right }; })()`);
    assert(narrow.asideTop >= narrow.bodyBottom && narrow.asideRight <= narrow.viewportRight + 1, j(narrow));
    await cdp.eval(`document.querySelector('${final}').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    evidence.narrow = narrow;
    evidence.narrowScreenshot = await shot('narrow-card');
    evidence.passed = true;
  } catch (error) { evidence.error = error.stack; throw error; }
  finally {
    if (cdp) await cdp.close();
    if (hub) { evidence.hubLog = path.join(out, 'hub.log'); fs.writeFileSync(evidence.hubLog, hub.log().join('\n')); evidence.exit = await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out, 'evidence.json'), j(evidence, null, 2));
    console.log(j({ out, passed: evidence.passed, error: evidence.error, wide: evidence.wide, narrow: evidence.narrow }, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
