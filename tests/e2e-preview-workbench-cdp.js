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
const TEMP_ROOT = path.join(os.tmpdir(), `hub-preview-workbench-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const FIXTURE_DIR = path.join(TEMP_ROOT, 'workspace');
const FIRST_PATH = path.join(FIXTURE_DIR, 'first-report.md');
const SECOND_PATH = path.join(FIXTURE_DIR, 'second-notes.md');
const THIRD_PATH = path.join(FIXTURE_DIR, 'third-checklist.md');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'preview-workbench');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `preview-workbench-${RUN_ID}.png`);
const QUICK_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `preview-quick-open-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port');
}

async function waitFor(client, expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await client.eval(expression)) return;
    } catch (_) {}
    await _waitMs(80);
  }
  throw new Error(`timeout waiting for: ${expression}`);
}

async function capture(client, target) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

async function openThroughQuickPath(client, targetPath) {
  await client.eval(`(() => {
    const input = document.getElementById('preview-quick-open-input');
    input.value = ${JSON.stringify(targetPath)};
    input.dispatchEvent(new Event('input', { bubbles:true }));
    return true;
  })()`);
  await client.eval(`(() => {
    const input = document.getElementById('preview-quick-open-input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
    return true;
  })()`);
  await waitFor(client, `document.getElementById('preview-title')?.title === ${JSON.stringify(targetPath)}
    && document.getElementById('preview-quick-open').style.display === 'none'`);
}

async function main() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(FIRST_PATH, '# First report\n\nCOPY_FULL_TEXT_MARKER\n', 'utf8');
  fs.writeFileSync(SECOND_PATH, '# Second notes\n\nTab switching keeps state.\n', 'utf8');
  fs.writeFileSync(THIRD_PATH, '# Third checklist\n\nOpened through quick path.\n', 'utf8');

  const port = await availablePort(Number(process.env.HUB_PREVIEW_E2E_PORT || 19871));
  const result = {
    runId: RUN_ID,
    port,
    fixtureDir: FIXTURE_DIR,
    screenshot: SCREENSHOT_PATH,
    quickOpenScreenshot: QUICK_SCREENSHOT_PATH,
    resultPath: RESULT_PATH,
  };
  let hub = null;
  let client = null;

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'preview-workbench',
      extraEnv: {
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        DEEPSEEK_API_KEY: '',
        CLAUDE_HUB_E2E: '1',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1540,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(client, `Boolean(window.openPreviewPanel && window.openPreviewQuickOpen && document.getElementById('btn-preview-path'))`);

    const shortcut = await client.eval(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key:'o', code:'KeyO', ctrlKey:true, bubbles:true, cancelable:true,
      }));
      return document.getElementById('preview-quick-open').style.display;
    })()`);
    assert.equal(shortcut, 'flex', 'Ctrl+O must open quick path while the preview panel is closed');
    await openThroughQuickPath(client, FIRST_PATH);

    await client.eval(`window.openPreviewPanel(${JSON.stringify(SECOND_PATH)})`);
    await waitFor(client, `document.querySelectorAll('#preview-tabs .preview-tab').length === 2
      && document.getElementById('preview-title')?.title === ${JSON.stringify(SECOND_PATH)}`);

    await client.eval(`(() => {
      const first = Array.from(document.querySelectorAll('#preview-tabs .preview-tab'))
        .find(tab => tab.title === ${JSON.stringify(FIRST_PATH)});
      first.click();
      return true;
    })()`);
    await waitFor(client, `document.getElementById('preview-title')?.title === ${JSON.stringify(FIRST_PATH)}`);

    const copied = await client.eval(`(async () => {
      const { clipboard } = require('electron');
      document.getElementById('preview-copy-content').click();
      await new Promise(resolve => setTimeout(resolve, 80));
      const content = clipboard.readText();
      document.getElementById('preview-copy-path').click();
      await new Promise(resolve => setTimeout(resolve, 30));
      return { content, path:clipboard.readText() };
    })()`);
    assert.match(copied.content, /COPY_FULL_TEXT_MARKER/);
    assert.equal(copied.path, FIRST_PATH);

    await client.eval(`document.getElementById('preview-new-tab').click()`);
    await waitFor(client, `document.getElementById('preview-quick-open').style.display === 'flex'`);
    await openThroughQuickPath(client, THIRD_PATH);

    const beforeClose = await client.eval(`(() => ({
      tabs:document.querySelectorAll('#preview-tabs .preview-tab').length,
      activePath:document.getElementById('preview-title').title,
      replacementChars:(document.getElementById('preview-panel').innerText.match(/\uFFFD/g) || []).length,
    }))()`);
    assert.equal(beforeClose.tabs, 3);
    assert.equal(beforeClose.activePath, THIRD_PATH);
    assert.equal(beforeClose.replacementChars, 0);

    await client.eval(`(() => {
      const active = document.querySelector('#preview-tabs .preview-tab.active');
      active.closest('.preview-tab-shell').querySelector('.preview-tab-close').click();
      return true;
    })()`);
    await waitFor(client, `document.querySelectorAll('#preview-tabs .preview-tab').length === 2
      && document.getElementById('preview-title')?.title !== ${JSON.stringify(THIRD_PATH)}`);

    result.final = await client.eval(`(() => ({
      panelDisplay:document.getElementById('preview-panel').style.display,
      tabCount:document.querySelectorAll('#preview-tabs .preview-tab').length,
      activePath:document.getElementById('preview-title').title,
      copyContentButton:document.getElementById('preview-copy-content').title,
      copyPathButton:document.getElementById('preview-copy-path').title,
      quickPathButton:document.getElementById('btn-preview-path').innerText.trim(),
      panelWidth:document.getElementById('preview-panel').getBoundingClientRect().width,
      copyActionLabelDisplay:getComputedStyle(document.querySelector('#preview-open-path span')).display,
      tabCloseTag:document.querySelector('#preview-tabs .preview-tab-close').tagName,
      tabControls:document.querySelector('#preview-tabs .preview-tab.active').getAttribute('aria-controls'),
      panelRole:document.getElementById('preview-body').getAttribute('role'),
      panelLabelledBy:document.getElementById('preview-body').getAttribute('aria-labelledby'),
      activeTabNodeId:document.querySelector('#preview-tabs .preview-tab.active').id,
    }))()`);
    assert.equal(result.final.panelDisplay, 'flex');
    assert.equal(result.final.tabCount, 2);
    assert.match(result.final.quickPathButton, /路径预览/);
    assert.ok(result.final.panelWidth < 820, JSON.stringify(result.final));
    assert.equal(result.final.copyActionLabelDisplay, 'none', 'panel container query must compact the narrow toolbar');
    assert.equal(result.final.tabCloseTag, 'BUTTON');
    assert.equal(result.final.tabControls, 'preview-body');
    assert.equal(result.final.panelRole, 'tabpanel');
    assert.equal(result.final.panelLabelledBy, result.final.activeTabNodeId);

    result.tabKeyboard = await client.eval(`(async () => {
      const active = document.querySelector('#preview-tabs .preview-tab.active');
      active.focus();
      active.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowLeft', bubbles:true, cancelable:true }));
      await new Promise(resolve => setTimeout(resolve, 80));
      const leftPath = document.getElementById('preview-title').title;
      const leftFocused = document.activeElement?.dataset?.tabId || '';
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true, cancelable:true }));
      await new Promise(resolve => setTimeout(resolve, 80));
      return {
        leftPath,
        leftFocused,
        rightPath:document.getElementById('preview-title').title,
        rightFocused:document.activeElement?.dataset?.tabId || '',
      };
    })()`);
    assert.equal(result.tabKeyboard.leftPath, FIRST_PATH);
    assert.ok(result.tabKeyboard.leftFocused);
    assert.equal(result.tabKeyboard.rightPath, SECOND_PATH);
    assert.ok(result.tabKeyboard.rightFocused);

    await client.eval(`(() => {
      const button = document.getElementById('preview-new-tab');
      button.focus();
      button.click();
    })()`);
    await waitFor(client, `document.getElementById('preview-quick-open').style.display === 'flex'`);
    await waitFor(client, `document.activeElement?.id === 'preview-quick-open-input'`);
    result.quickOpenA11y = await client.eval(`(() => {
      const input = document.getElementById('preview-quick-open-input');
      return {
        role:input.getAttribute('role'),
        controls:input.getAttribute('aria-controls'),
        expanded:input.getAttribute('aria-expanded'),
        activeDescendant:input.getAttribute('aria-activedescendant'),
        statusLive:document.getElementById('preview-quick-open-status').getAttribute('aria-live'),
      };
    })()`);
    assert.deepEqual(result.quickOpenA11y, {
      role:'combobox',
      controls:'preview-quick-open-results',
      expanded:'true',
      activeDescendant:'preview-quick-open-option-0',
      statusLive:'polite',
    });
    await capture(client, QUICK_SCREENSHOT_PATH);
    await client.eval(`document.getElementById('preview-quick-open-close').click()`);
    await waitFor(client, `document.activeElement?.id === 'preview-new-tab'
      && document.getElementById('preview-quick-open-input').getAttribute('aria-expanded') === 'false'`);
    await _waitMs(1300);
    await capture(client, SCREENSHOT_PATH);
    result.visibleOpenError = await client.eval(`(async () => {
      const target = ${JSON.stringify(path.join(TEMP_ROOT, 'definitely-missing-preview-workbench-e2e.bin'))};
      const openResult = await window.openPathInHub(target, { requireExistsForRel:false });
      const notice = document.getElementById('preview-notice');
      return {
        ok:openResult && openResult.ok,
        noticeText:notice?.textContent || '',
        noticePosition:notice ? getComputedStyle(notice).position : '',
        noticeZ:notice ? Number(getComputedStyle(notice).zIndex) : 0,
      };
    })()`);
    assert.equal(result.visibleOpenError.ok, false);
    assert.match(result.visibleOpenError.noticeText, /文件打开失败/);
    assert.equal(result.visibleOpenError.noticePosition, 'fixed');
    assert.ok(result.visibleOpenError.noticeZ >= 14000, JSON.stringify(result.visibleOpenError));
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (hub) console.error('[isolated hub log]\n' + hub.log().slice(-100).join('\n'));
    throw error;
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-preview-workbench-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
