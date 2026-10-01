'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', 'home-welcome-c');
fs.mkdirSync(out, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(error => error ? reject(error) : resolve(value));
    });
  });
}

async function waitFor(cdp, expression) {
  for (let i = 0; i < 100; i += 1) {
    if (await cdp.eval(expression)) return;
    await _waitMs(100);
  }
  throw new Error(`Timed out: ${expression}`);
}

async function click(cdp, selector) {
  const point = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    return { x, y, hit: el === document.elementFromPoint(x, y) || el.contains(document.elementFromPoint(x, y)) };
  })()`);
  assert.equal(point?.hit, true, `${selector} should be clickable`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-home-c-'));
  const dataDir = path.join(temp, 'data');
  const workDir = path.join(temp, 'work');
  fs.mkdirSync(dataDir); fs.mkdirSync(workDir);
  let hub;
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'home-welcome-c',
      windowMode: 'background', extraEnv: { AI_HUB_WORKSPACE_ROOT: workDir } });
    const cdp = await connectFirstPage(hub);
    await waitFor(cdp, "document.querySelector('#empty-state')?.dataset.homeReady === 'true'");
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['dark', 'light']) {
      await cdp.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      const state = await cdp.eval(`(() => {
        const root = document.querySelector('#empty-state');
        const buttons = [...root.querySelectorAll('.home-welcome-portal')];
        return { title: root.querySelector('h1').textContent.trim(), background: getComputedStyle(root).backgroundColor,
          columns: getComputedStyle(root.querySelector('.home-welcome-portals')).gridTemplateColumns.split(' ').length,
          visible: getComputedStyle(root).display !== 'none',
          buttons: buttons.map(el => ({text: el.textContent.trim(), width: Math.round(el.getBoundingClientRect().width)})) };
      })()`);
      assert.equal(state.title, '选择协作方式');
      assert.equal(state.background, 'rgb(11, 33, 52)');
      assert.equal(state.columns, 2);
      assert.equal(state.visible, true);
      assert.equal(state.buttons.length, 2);
      assert(state.buttons.every(button => button.width >= 280), JSON.stringify(state));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(out, `home-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
    const compact = await cdp.eval(`(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
      columns: getComputedStyle(document.querySelector('.home-welcome-portals')).gridTemplateColumns.split(' ').length,
      cards: [...document.querySelectorAll('.home-welcome-portal')].map(el => el.getBoundingClientRect().width) }))()`);
    assert(compact.width <= compact.viewport && compact.columns === 2 && compact.cards.every(width => width > 200), JSON.stringify(compact));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
    for (const [selector, intent] of [['#home-create-session', 'session'], ['#home-create-group', 'group']]) {
      await click(cdp, selector);
      await waitFor(cdp, "getComputedStyle(document.querySelector('#new-session-menu')).display !== 'none'");
      const active = await cdp.eval(`document.querySelector('#new-session-menu .launch-center-intent[aria-selected="true"]')?.dataset.launchIntent || ''`);
      assert.equal(active, intent);
      await _waitMs(100);
      await click(cdp, '#new-session-close');
      await waitFor(cdp, "getComputedStyle(document.querySelector('#new-session-menu')).display === 'none'");
    }
    console.log('C welcome: dark/light visual, two cards, session/group launch passed');
  } finally {
    if (hub) await gracefulQuit(hub);
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
