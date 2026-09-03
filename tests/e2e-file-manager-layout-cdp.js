'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-file-manager-layout-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORK_DIR = path.join(TEMP_ROOT, 'AIWork E2E');
const FAKE_BIN_DIR = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'file-manager');
const TREE_SCREENSHOT = path.join(ARTIFACT_DIR, `file-manager-tree-${RUN_ID}.png`);
const PREVIEW_SCREENSHOT = path.join(ARTIFACT_DIR, `file-manager-preview-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `file-manager-layout-${RUN_ID}.json`);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function clickSelector(client, expression) {
  const point = await client.eval(`(() => {
    const element = ${expression};
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`click target is not visible: ${expression}`);
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

function writeFixtures() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(path.join(WORK_DIR, 'docs'), { recursive: true });
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(WORK_DIR, 'README.md'), '# File Manager E2E\n\nHub markdown preview.\n', 'utf8');
  fs.writeFileSync(path.join(WORK_DIR, 'dashboard.html'), '<!doctype html><meta charset="utf-8"><h1>Dashboard E2E</h1>', 'utf8');
  fs.writeFileSync(path.join(WORK_DIR, 'data.json'), '{"ok":true}\n', 'utf8');
  fs.writeFileSync(path.join(WORK_DIR, 'external-demo.zip'), 'not-a-real-zip', 'utf8');
  fs.writeFileSync(path.join(WORK_DIR, 'docs', 'nested.md'), '# Nested file\n', 'utf8');

  const fakeCli = path.join(FAKE_BIN_DIR, 'fake-codex.js');
  fs.writeFileSync(fakeCli, `'use strict';
process.stdout.write('Fake Codex ready\\r\\n');
process.stdin.resume();
const timer = setInterval(() => {}, 1000);
const stop = () => { clearInterval(timer); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
`, 'utf8');
  fs.writeFileSync(
    path.join(FAKE_BIN_DIR, 'codex.cmd'),
    `@echo off\r\n"${process.execPath}" "${fakeCli}" %*\r\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(CODEX_HOME, 'models_cache.json'), JSON.stringify({
    models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list' }],
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      codex: {
        backend: 'subscription',
        subscription_profile: 'e2e',
        subscription_profiles: [{ id: 'e2e', label: 'E2E', home: CODEX_HOME }],
      },
    },
  }, null, 2), 'utf8');
}

async function main() {
  writeFixtures();
  const port = await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const inheritedPath = process.env[pathKey] || '';
  const result = { runId: RUN_ID, port, screenshots: [TREE_SCREENSHOT, PREVIEW_SCREENSHOT] };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'file-manager-layout',
      extraEnv: {
        [pathKey]: `${FAKE_BIN_DIR}${path.delimiter}${inheritedPath}`,
        CODEX_HOME,
        HUB_CODEX_PROFILE: 'e2e',
        HUB_MODEL_CATALOG_LIVE_E2E: '0',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1680, height: 960, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor('renderer ready', () => client.eval(`document.readyState === 'complete' && !!window.FileManagerPanel`));

    const session = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
      kind: 'codex',
      opts: {
        title: '文件管理布局验收',
        cwd: ${JSON.stringify(WORK_DIR)},
        workspaceLabel: 'AIWork E2E',
        model: 'gpt-5.6-sol',
        codexProfile: 'e2e'
      }
    })`);
    assert.ok(session && session.id, 'isolated Codex session should be created');
    await waitFor('session header', () => client.eval(`activeSessionId === ${JSON.stringify(session.id)} && !!document.querySelector('.terminal-header')`));
    await client.eval(`(() => {
      const current = sessions.get(${JSON.stringify(session.id)});
      current.contextMax = 1000000;
      current.contextEffectiveMax = 828400;
      updateActiveMetricsRow();
      renderAccountUsage();
      return true;
    })()`);

    result.layout = await client.eval(`(() => {
      const pull = document.querySelector('.fi-bridge-pull');
      const branch = document.querySelector('.fi-bridge-fork');
      const cwd = document.querySelector('.metric-cwd');
      const memory = document.querySelector('.terminal-header [data-action="open-memory"]');
      const files = document.querySelector('.terminal-header .btn-file-manager-toggle');
      const ticker = document.getElementById('quota-ticker');
      return {
        ctxRemoved: !document.querySelector('.metric-context-window'),
        roundTotalRemoved: !document.getElementById('recent-turn-copy-total'),
        headerBranchRemoved: !document.querySelector('.btn-fork-session'),
        branchBesidePull: !!pull && !!branch && pull.parentElement === branch.parentElement
          && Array.from(pull.parentElement.children).indexOf(branch) === Array.from(pull.parentElement.children).indexOf(pull) + 1,
        branchText: branch && branch.textContent.trim(),
        cwdTag: cwd && cwd.tagName,
        cwdTitle: cwd && cwd.title,
        cwdText: cwd && cwd.textContent.trim(),
        memoryInHeader: !!memory,
        fileButton: !!files,
        tickerText: ticker && ticker.textContent,
        tickerHasMemo: !!(ticker && ticker.querySelector('[data-action="open-memo"]')),
        tickerHasMemory: !!(ticker && ticker.querySelector('[data-action="open-memory"]')),
      };
    })()`);
    assert.equal(result.layout.ctxRemoved, true);
    assert.equal(result.layout.roundTotalRemoved, true);
    assert.equal(result.layout.headerBranchRemoved, true);
    assert.equal(result.layout.branchBesidePull, true);
    assert.equal(result.layout.branchText, '分支');
    assert.equal(result.layout.cwdTag, 'BUTTON');
    assert.match(result.layout.cwdTitle, /在文件管理中打开/);
    assert.match(result.layout.cwdText, /AIWork E2E/);
    assert.equal(result.layout.memoryInHeader, true);
    assert.equal(result.layout.fileButton, true);
    assert.equal(result.layout.tickerHasMemo, true);
    assert.equal(result.layout.tickerHasMemory, false);

    await clickSelector(client, `document.querySelector('.metric-cwd')`);
    await waitFor('workspace path opens file manager', () => client.eval(`document.getElementById('file-manager-panel').style.display === 'flex' && document.getElementById('file-manager-root-path').textContent === ${JSON.stringify(WORK_DIR)}`));
    result.workspacePathClick = await client.eval(`({
      panel: document.getElementById('file-manager-panel').style.display,
      root: document.getElementById('file-manager-root-path').textContent,
      externalTitle: document.getElementById('file-manager-open-external').title
    })`);
    assert.deepEqual(result.workspacePathClick, {
      panel: 'flex',
      root: WORK_DIR,
      externalTitle: '在资源管理器中打开',
    });
    await clickSelector(client, `document.getElementById('file-manager-close')`);
    await waitFor('file manager closed', () => client.eval(`document.getElementById('file-manager-panel').style.display === 'none'`));

    await clickSelector(client, `document.querySelector('.terminal-header .btn-file-manager-toggle')`);
    await waitFor('file tree entries', () => client.eval(`document.querySelectorAll('.fm-node-button').length >= 5`));
    result.tree = await client.eval(`(() => {
      const panel = document.getElementById('file-manager-panel');
      const names = Array.from(document.querySelectorAll('.fm-node-name')).map(node => node.textContent);
      const root = document.getElementById('file-manager-root');
      return {
        open: panel.style.display === 'flex',
        names,
        rootName: document.getElementById('file-manager-root-name').textContent,
        rootPath: document.getElementById('file-manager-root-path').textContent,
        rootTitle: root.title,
        width: Math.round(panel.getBoundingClientRect().width),
      };
    })()`);
    assert.equal(result.tree.open, true);
    assert.deepEqual(result.tree.names, ['docs', 'dashboard.html', 'data.json', 'external-demo.zip', 'README.md']);
    assert.equal(result.tree.rootName, 'AIWork E2E');
    assert.equal(result.tree.rootPath, WORK_DIR);
    assert.match(result.tree.rootTitle, /资源管理器/);
    assert.ok(result.tree.width >= 292 && result.tree.width <= 360, `unexpected panel width ${result.tree.width}`);
    await screenshot(client, TREE_SCREENSHOT);

    await clickSelector(client, `Array.from(document.querySelectorAll('.fm-node-button')).find(button => button.querySelector('.fm-node-name')?.textContent === 'docs')`);
    await waitFor('nested directory', () => client.eval(`Array.from(document.querySelectorAll('.fm-node-name')).some(node => node.textContent === 'nested.md')`));
    await clickSelector(client, `Array.from(document.querySelectorAll('.fm-node-button')).find(button => button.querySelector('.fm-node-name')?.textContent === 'README.md')`);
    await waitFor('markdown preview', () => client.eval(`document.getElementById('preview-panel').style.display === 'flex' && /README\.md/i.test(document.getElementById('preview-title').textContent)`));
    result.preview = await client.eval(`(() => ({
      previewVisible: document.getElementById('preview-panel').style.display === 'flex',
      fileManagerStillVisible: document.getElementById('file-manager-panel').style.display === 'flex',
      title: document.getElementById('preview-title').textContent,
      markdownText: document.getElementById('preview-body').innerText,
      selectedCount: document.querySelectorAll('.fm-node-button.selected').length,
      nestedVisible: Array.from(document.querySelectorAll('.fm-node-name')).some(node => node.textContent === 'nested.md')
    }))()`);
    assert.equal(result.preview.previewVisible, true);
    assert.equal(result.preview.fileManagerStillVisible, true);
    assert.match(result.preview.title, /README\.md/i);
    assert.match(result.preview.markdownText, /File Manager E2E/);
    assert.equal(result.preview.selectedCount, 1);
    assert.equal(result.preview.nestedVisible, true);
    await screenshot(client, PREVIEW_SCREENSHOT);

    await clickSelector(client, `document.getElementById('preview-close')`);
    await waitFor('preview closed', () => client.eval(`document.getElementById('preview-panel').style.display === 'none'`));
    await clickSelector(client, `document.querySelector('[data-action="open-memo"]')`);
    await waitFor('memo replaces file manager', () => client.eval(`document.getElementById('memo-panel').style.display === 'flex' && document.getElementById('file-manager-panel').style.display === 'none'`));
    result.sidePanelExclusivity = await client.eval(`({
      memo: document.getElementById('memo-panel').style.display,
      files: document.getElementById('file-manager-panel').style.display
    })`);
    assert.deepEqual(result.sidePanelExclusivity, { memo: 'flex', files: 'none' });

    await clickSelector(client, `document.querySelector('.terminal-header [data-action="open-memory"]')`);
    await waitFor('memory opens from header', () => client.eval(`document.querySelector('.mp-overlay')?.style.display === 'flex'`));
    result.memoryFromHeader = await client.eval(`document.querySelector('.mp-overlay')?.style.display === 'flex'`);
    assert.equal(result.memoryFromHeader, true);

    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ...result, resultPath: RESULT_PATH }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    const tempBase = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.startsWith(tempBase) && path.basename(resolved).startsWith('hub-file-manager-layout-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
