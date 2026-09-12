'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { launchIsolatedHub, gracefulQuit, _waitMs, _verifyCdpPortOwner } = require('./helpers/hub-launcher.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-logo-launch-'));
const dataDir = path.join(root, 'data');
const output = path.resolve(__dirname, '..', 'output', 'playwright', `hub-logo-launch-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });

async function waitFor(label, fn, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await _waitMs(150);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function click(client, selector) {
  await client.send('Page.bringToFront');
  const point = await client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    return { x, y, hit: el.contains(document.elementFromPoint(x, y)), region: getComputedStyle(el).webkitAppRegion };
  })()`);
  assert.equal(point.hit, true, `${selector} must be visible and unobscured`);
  if (selector === '#btn-new-hub') assert.equal(point.region, 'no-drag');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

function readControl(pid) { return JSON.parse(fs.readFileSync(path.join(dataDir, 'control', `${pid}.json`), 'utf8')); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function screenshot(client, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name), Buffer.from(shot.data, 'base64'));
}
async function ready(client) {
  await waitFor('renderer ready', () => client.eval(`!!(window.LaunchCenter && document.readyState === 'complete' && document.getElementById('hub-pid').textContent)`));
}

async function main() {
  let hub, parent, childClient, child;
  const result = { output, dataDir };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'prepared-projects.json'), JSON.stringify({ schemaVersion: 1, projects: [], migrations: [] }), 'utf8');
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'logo-parent', extraEnv: { CLAUDE_HUB_E2E: '1' } });
    parent = await connectFirstPage(hub);
    await ready(parent);
    assert.deepEqual(await parent.eval(`require('electron').ipcRenderer.invoke('get-meetings')`), []);
    const history = { kind: 'codex', model: 'test-model', effort: 'high', mcpProfile: 'none', codexSpeedTier: 'inherit', ts: Date.now(), workspace: { path: root, label: '测试项目' } };
    for (const value of [null, JSON.stringify(history), '{malformed']) {
      await parent.eval(`localStorage.${value === null ? "removeItem('hub.launch.last')" : `setItem('hub.launch.last', ${JSON.stringify(value)})`}; window.dispatchEvent(new Event('focus'))`);
      assert.equal(await parent.eval(`document.querySelector('#btn-new .btn-label').textContent`), '启动');
      await click(parent, '#btn-new');
      await waitFor('launch center opened', () => parent.eval(`document.getElementById('new-session-menu').style.display === 'flex'`));
      assert.deepEqual(await parent.eval(`require('electron').ipcRenderer.invoke('get-sessions')`), []);
      await click(parent, '#new-session-close');
    }
    await parent.eval(`localStorage.setItem('hub.launch.last', ${JSON.stringify(JSON.stringify(history))})`);
    const timeOrigin = await parent.eval('performance.timeOrigin');
    await parent.send('Page.reload');
    await waitFor('reload', () => parent.eval(`performance.timeOrigin !== ${timeOrigin} && !!window.LaunchCenter`));
    await ready(parent);
    assert.equal(await parent.eval(`document.querySelector('#btn-new .btn-label').textContent`), '启动');
    await click(parent, '#btn-new');
    await waitFor('center after reload', () => parent.eval(`document.getElementById('new-session-menu').style.display === 'flex'`));
    await click(parent, '#new-session-close');
    await screenshot(parent, 'parent.png');

    // Observe trusted DOM input; do not replace IPC, spawn, or creation behavior.
    await parent.eval(`document.getElementById('btn-new-hub').addEventListener('click', e => { window.__logoClickTrusted = e.isTrusted; })`);
    await click(parent, '#btn-new-hub');
    assert.equal(await parent.eval('window.__logoClickTrusted'), true);
    child = await waitFor('new process control file', () => {
      const controls = fs.readdirSync(path.join(dataDir, 'control')).filter(file => /^\d+\.json$/.test(file)).map(file => readControl(Number(file.slice(0, -5))));
      return controls.find(control => control.pid !== hub.pid && control.cdpPort);
    });
    assert.equal(path.resolve(child.dataDir), path.resolve(dataDir));
    assert.notEqual(child.cdpPort, hub.port);
    assert.equal(await _verifyCdpPortOwner(child.cdpPort, child.pid), true);
    assert.notEqual(child.hookPort, readControl(hub.pid).hookPort);
    childClient = await connectFirstPage({ cdpHttpBase: `http://127.0.0.1:${child.cdpPort}`, label: 'logo-child' });
    await ready(childClient);
    assert.match(await childClient.eval('location.href'), /renderer\/index\.html/);
    assert.match(await childClient.eval(`document.getElementById('hub-pid').textContent`), new RegExp(String(child.pid)));
    assert.equal(await childClient.eval(`process.env.CLAUDE_HUB_HOME_DIR`), path.join(dataDir, 'isolated-home'));
    await screenshot(childClient, 'child.png');
    result.parentPid = hub.pid;
    result.childPid = child.pid;
    result.parentPort = hub.port;
    result.childPort = child.cdpPort;
    result.hookPorts = [readControl(hub.pid).hookPort, child.hookPort];
    result.version = await childClient.eval(`document.getElementById('hub-version').textContent`);
    result.trustedClick = true;
    // The child must stay usable after the original Hub closes.
    await parent.close(); parent = null;
    result.parentExit = await gracefulQuit(hub); hub = null;
    assert.equal(alive(child.pid), true);
    await click(childClient, '#btn-new');
    await waitFor('independent child center', () => childClient.eval(`document.getElementById('new-session-menu').style.display === 'flex'`));
    result.childSurvivedParent = true;
  } catch (error) {
    result.error = error.stack;
    if (hub) result.logTail = hub.log().slice(-40);
    if (parent) await screenshot(parent, 'failure.png');
    throw error;
  } finally {
    try {
      if (childClient) {
        await childClient.eval(`require('electron').ipcRenderer.invoke('debug:agent-league-explicit-quit')`);
        await childClient.close();
        await waitFor('child clean exit', () => !alive(child.pid));
        const heartbeat = JSON.parse(fs.readFileSync(path.join(dataDir, 'diagnostics', `process-lifecycle-${child.pid}.heartbeat.json`), 'utf8'));
        assert.equal(heartbeat.cleanExit, true);
        result.childCleanExit = true;
      }
      if (parent) await parent.close();
      if (hub) result.parentExit = await gracefulQuit(hub);
    } catch (error) { result.teardownError = error.stack; throw error; }
    finally { fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8'); }
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
