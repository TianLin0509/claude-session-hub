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
const CODE_PATH = path.join(FIXTURE_DIR, 'sample-code.js');
const EDGE_MD_PATH = path.join(FIXTURE_DIR, 'outline-edge.md');
const TEMP_A_PATH = path.join(FIXTURE_DIR, 'temporary-a.txt');
const TEMP_B_PATH = path.join(FIXTURE_DIR, 'temporary-b.json');
const HTML_PATH = path.join(FIXTURE_DIR, 'find-page.html');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'preview-workbench');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `preview-workbench-${RUN_ID}.png`);
const QUICK_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `preview-quick-open-${RUN_ID}.png`);
const FILE_CHANGE_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `preview-file-changed-${RUN_ID}.png`);
const FIND_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `preview-find-${RUN_ID}.png`);
const OUTLINE_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `preview-outline-${RUN_ID}.png`);
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
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await client.eval(expression)) return;
    } catch (error) {
      lastError = error;
      if (/WebSocket|not open|closed|ECONN|socket/i.test(String(error && error.message || error))) {
        throw new Error(`CDP connection lost while waiting for ${expression}: ${error.message}`);
      }
    }
    await _waitMs(80);
  }
  throw new Error(`timeout waiting for: ${expression}${lastError ? `; last error: ${lastError.message}` : ''}`);
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
  fs.writeFileSync(CODE_PATH, ['const one = 1;', 'const two = 2;', '', 'function total() {', '  return one + two;', '}'].join('\n'), 'utf8');
  fs.writeFileSync(EDGE_MD_PATH, '#\n> # Quoted\n## Fish &amp; Chips\n\n<widget>\n\nList<String>\n', 'utf8');
  fs.writeFileSync(TEMP_A_PATH, 'temporary A\nline 2\n', 'utf8');
  fs.writeFileSync(TEMP_B_PATH, '{"temporary":"B","line":2}\n', 'utf8');
  fs.writeFileSync(HTML_PATH, '<!doctype html><meta charset="utf-8"><h1>Webview find</h1><p>WEBVIEW_FIND_MARKER first</p><p>WEBVIEW_FIND_MARKER second</p>', 'utf8');

  const port = await availablePort(Number(process.env.HUB_PREVIEW_E2E_PORT || 19871));
  const result = {
    runId: RUN_ID,
    port,
    fixtureDir: FIXTURE_DIR,
    screenshot: SCREENSHOT_PATH,
    quickOpenScreenshot: QUICK_SCREENSHOT_PATH,
    fileChangeScreenshot: FILE_CHANGE_SCREENSHOT_PATH,
    findScreenshot: FIND_SCREENSHOT_PATH,
    outlineScreenshot: OUTLINE_SCREENSHOT_PATH,
    resultPath: RESULT_PATH,
  };
  let hub = null;
  let client = null;
  let testBodyPassed = false;

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'preview-workbench',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        DEEPSEEK_API_KEY: '',
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_E2E_FAKE_CLIPBOARD: '1',
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
    result.temporaryInitial = await client.eval(`(() => {
      const state = window.__hubE2E.previewWorkbench.state();
      const shell = document.querySelector('#preview-tabs .preview-tab-shell.active');
      return {
        tabCount:state.tabs.length,
        pinned:state.tabs[0].pinned,
        temporaryClass:shell.classList.contains('temporary'),
        badge:shell.querySelector('.preview-tab-preview-badge')?.textContent || '',
        pinButton:!!shell.querySelector('[data-pin-tab-id]'),
      };
    })()`);
    assert.deepEqual(result.temporaryInitial, {
      tabCount:1,
      pinned:false,
      temporaryClass:true,
      badge:'临时',
      pinButton:true,
    });
    await client.eval(`(() => {
      const tab = document.querySelector('#preview-tabs .preview-tab.active');
      tab.dispatchEvent(new MouseEvent('dblclick', { bubbles:true, cancelable:true, detail:2 }));
    })()`);
    await waitFor(client, `window.__hubE2E.previewWorkbench.state().tabs[0].pinned === true
      && !document.querySelector('#preview-tabs .preview-tab-shell').classList.contains('temporary')`);
    result.doubleClickPinned = true;

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
      window.__hubE2EPreviewClipboardText = '';
      document.getElementById('preview-copy-content').click();
      const deadline = Date.now() + 2000;
      while (!String(window.__hubE2EPreviewClipboardText || '').includes('COPY_FULL_TEXT_MARKER') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const content = String(window.__hubE2EPreviewClipboardText || '');
      document.getElementById('preview-copy-path').click();
      const pathDeadline = Date.now() + 2000;
      while (window.__hubE2EPreviewClipboardText !== ${JSON.stringify(FIRST_PATH)} && Date.now() < pathDeadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return {
        content,
        path:String(window.__hubE2EPreviewClipboardText || ''),
        contentAnnouncement:document.getElementById('preview-copy-content').getAttribute('aria-label'),
        pathAnnouncement:document.getElementById('preview-copy-path').getAttribute('aria-label'),
      };
    })()`);
    assert.match(copied.content, /COPY_FULL_TEXT_MARKER/);
    assert.equal(copied.path, FIRST_PATH);
    assert.equal(copied.contentAnnouncement, '全文已复制');
    assert.equal(copied.pathAnnouncement, '路径已复制');
    await waitFor(client, `document.getElementById('preview-action-status').textContent === '路径已复制'`);
    result.copyLiveAnnouncement = '路径已复制';
    await waitFor(client, `!!document.querySelector('#preview-copy-content span')
      && !!document.querySelector('#preview-copy-path span')
      && document.getElementById('preview-copy-content').getAttribute('aria-label') === '复制全文'
      && document.getElementById('preview-copy-path').getAttribute('aria-label') === '复制路径或 URL'`);

    await client.eval(`document.getElementById('preview-new-tab').click()`);
    await waitFor(client, `document.getElementById('preview-quick-open').style.display === 'flex'`);
    await openThroughQuickPath(client, THIRD_PATH);

    const beforeClose = await client.eval(`(() => ({
      tabs:document.querySelectorAll('#preview-tabs .preview-tab').length,
      activePath:document.getElementById('preview-title').title,
      activePinned:window.__hubE2E.previewWorkbench.state().tabs
        .find(tab => tab.id === window.__hubE2E.previewWorkbench.state().activeTabId).pinned,
      replacementChars:(document.getElementById('preview-panel').innerText.match(/\uFFFD/g) || []).length,
    }))()`);
    assert.equal(beforeClose.tabs, 3);
    assert.equal(beforeClose.activePath, THIRD_PATH);
    assert.equal(beforeClose.activePinned, true, 'the + button must create a fixed tab');
    assert.equal(beforeClose.replacementChars, 0);

    await client.eval(`(() => {
      const active = document.querySelector('#preview-tabs .preview-tab.active');
      active.focus();
      active.dispatchEvent(new KeyboardEvent('keydown', { key:'Delete', bubbles:true, cancelable:true }));
      return true;
    })()`);
    await waitFor(client, `document.querySelectorAll('#preview-tabs .preview-tab').length === 2
      && document.getElementById('preview-title')?.title !== ${JSON.stringify(THIRD_PATH)}
      && document.activeElement === document.querySelector('#preview-tabs .preview-tab.active')`);
    result.deleteTabFocusRestored = true;

    result.final = await client.eval(`(() => ({
      panelDisplay:document.getElementById('preview-panel').style.display,
      tabCount:document.querySelectorAll('#preview-tabs .preview-tab').length,
      activePath:document.getElementById('preview-title').title,
      copyContentButton:document.getElementById('preview-copy-content').title,
      copyPathButton:document.getElementById('preview-copy-path').title,
      quickPathButton:document.getElementById('btn-preview-path').innerText.trim(),
      panelWidth:document.getElementById('preview-panel').getBoundingClientRect().width,
      copyActionLabelDisplay:getComputedStyle(document.querySelector('#preview-open-path span')).display,
      copyPrimaryLabelDisplay:getComputedStyle(document.querySelector('#preview-copy-content span')).display,
      headerActionsClientWidth:document.querySelector('.preview-header-actions').clientWidth,
      headerActionsScrollWidth:document.querySelector('.preview-header-actions').scrollWidth,
      tabCloseTag:document.querySelector('#preview-tabs .preview-tab-close').tagName,
      tabControls:document.querySelector('#preview-tabs .preview-tab.active').getAttribute('aria-controls'),
      panelRole:document.getElementById('preview-body').getAttribute('role'),
      panelLabelledBy:document.getElementById('preview-body').getAttribute('aria-labelledby'),
      activeTabNodeId:document.querySelector('#preview-tabs .preview-tab.active').id,
      findButtonTitle:document.getElementById('preview-find-toggle').title,
    }))()`);
    assert.equal(result.final.panelDisplay, 'flex');
    assert.equal(result.final.tabCount, 2);
    assert.match(result.final.quickPathButton, /路径预览/);
    assert.ok(result.final.panelWidth < 820, JSON.stringify(result.final));
    assert.equal(result.final.copyActionLabelDisplay, 'none', 'panel container query must compact the narrow toolbar');
    assert.notEqual(result.final.copyPrimaryLabelDisplay, 'none', 'copy text remains discoverable at common split width');
    assert.ok(result.final.headerActionsScrollWidth <= result.final.headerActionsClientWidth + 1, JSON.stringify(result.final));
    assert.equal(result.final.tabCloseTag, 'BUTTON');
    assert.equal(result.final.tabControls, 'preview-body');
    assert.equal(result.final.panelRole, 'tabpanel');
    assert.equal(result.final.panelLabelledBy, result.final.activeTabNodeId);
    assert.match(result.final.findButtonTitle, /Ctrl\+F/);
    result.splitterKeyboard = await client.eval(`(() => {
      const splitter = document.getElementById('preview-splitter');
      const panel = document.getElementById('preview-panel');
      const beforeValue = Number(splitter.getAttribute('aria-valuenow'));
      const beforeWidth = panel.getBoundingClientRect().width;
      splitter.focus();
      splitter.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowLeft', bubbles:true, cancelable:true }));
      const afterValue = Number(splitter.getAttribute('aria-valuenow'));
      const afterWidth = panel.getBoundingClientRect().width;
      const valueText = splitter.getAttribute('aria-valuetext');
      splitter.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true, cancelable:true }));
      return { beforeValue, afterValue, beforeWidth, afterWidth, valueText, role:splitter.getAttribute('role') };
    })()`);
    assert.equal(result.splitterKeyboard.role, 'separator');
    assert.equal(result.splitterKeyboard.afterValue, result.splitterKeyboard.beforeValue - 5);
    assert.ok(result.splitterKeyboard.afterWidth > result.splitterKeyboard.beforeWidth);
    assert.match(result.splitterKeyboard.valueText, /左侧 .*预览/);
    result.layoutToggleA11y = await client.eval(`(() => {
      const button = document.getElementById('preview-toggle-layout');
      const svgBefore = !!button.querySelector('svg');
      button.click();
      const fullscreen = {
        pressed:button.getAttribute('aria-pressed'),
        label:button.getAttribute('aria-label'),
        svg:!!button.querySelector('svg'),
      };
      button.click();
      return {
        svgBefore,
        fullscreen,
        restoredPressed:button.getAttribute('aria-pressed'),
        restoredLabel:button.getAttribute('aria-label'),
      };
    })()`);
    assert.deepEqual(result.layoutToggleA11y, {
      svgBefore:true,
      fullscreen:{ pressed:'true', label:'全屏预览', svg:true },
      restoredPressed:'false',
      restoredLabel:'全屏预览',
    });
    result.watchStatsWithTabs = await client.eval(`window.__hubE2E.previewWorkbench.watchStats()`);
    assert.deepEqual(result.watchStatsWithTabs, { directories:1, files:2, listeners:2, degradedDirectories:0, cleanupFailures:0 });

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

    fs.writeFileSync(SECOND_PATH, '# Second notes updated\n\nFILE_WATCH_UPDATED_MARKER one\n\nFILE_WATCH_UPDATED_MARKER two\n\nFILE_WATCH_UPDATED_MARKER three\n\nCross **inline** phrase\n\n## Architecture\n\nDesign detail. [Jump to safety](#safety)\n\n### Safety\n\nGuard detail.\n', 'utf8');
    await waitFor(client, `!document.getElementById('preview-change-badge').hidden
      && document.querySelector('#preview-tabs .preview-tab-shell.active').classList.contains('stale')`);
    result.fileWatchBeforeReload = await client.eval(`(() => ({
      badge:document.getElementById('preview-change-badge').textContent,
      badgeRole:document.getElementById('preview-change-badge').getAttribute('role'),
      badgeLive:document.getElementById('preview-change-badge').getAttribute('aria-live'),
      badgeLabel:document.getElementById('preview-change-badge').getAttribute('aria-label'),
      reloadAttention:document.getElementById('preview-reload').classList.contains('attention'),
      oldContentStillVisible:document.getElementById('preview-body').innerText.includes('Tab switching keeps state'),
      newContentAlreadyVisible:document.getElementById('preview-body').innerText.includes('FILE_WATCH_UPDATED_MARKER'),
    }))()`);
    assert.deepEqual(result.fileWatchBeforeReload, {
      badge:'已更新',
      badgeRole:'status',
      badgeLive:'polite',
      badgeLabel:'文件已更新，点击重新加载',
      reloadAttention:true,
      oldContentStillVisible:true,
      newContentAlreadyVisible:false,
    });
    await capture(client, FILE_CHANGE_SCREENSHOT_PATH);
    await client.eval(`document.getElementById('preview-reload').click()`);
    await waitFor(client, `document.getElementById('preview-body').innerText.includes('FILE_WATCH_UPDATED_MARKER')
      && document.getElementById('preview-change-badge').hidden`);
    result.fileWatchAfterReload = await client.eval(`(() => ({
      badgeHidden:document.getElementById('preview-change-badge').hidden,
      reloadAttention:document.getElementById('preview-reload').classList.contains('attention'),
      updatedContent:document.getElementById('preview-body').innerText.includes('FILE_WATCH_UPDATED_MARKER'),
    }))()`);
    assert.deepEqual(result.fileWatchAfterReload, {
      badgeHidden:true,
      reloadAttention:false,
      updatedContent:true,
    });

    await client.eval(`document.getElementById('preview-outline-toggle').click()`);
    await waitFor(client, `!document.getElementById('preview-outline').hidden
      && document.querySelectorAll('#preview-outline-list .preview-outline-item').length === 3`);
    result.markdownOutline = await client.eval(`(() => {
      const state = window.__hubE2E.previewWorkbench.state();
      const tab = state.tabs.find(item => item.id === state.activeTabId);
      const buttons = [...document.querySelectorAll('#preview-outline-list .preview-outline-item')];
      return {
        entries:tab.outline,
        levels:buttons.map(button => button.querySelector('.preview-outline-item-level').textContent),
        ariaLabels:buttons.map(button => button.getAttribute('aria-label')),
        labels:buttons.map(button => button.querySelector('.preview-outline-item-text').textContent),
        lines:buttons.map(button => button.querySelector('.preview-outline-item-line').textContent),
        tabStops:buttons.filter(button => button.tabIndex === 0).length,
        expanded:document.getElementById('preview-outline-toggle').getAttribute('aria-expanded'),
        toggleLabel:document.getElementById('preview-outline-toggle').getAttribute('aria-label'),
        gotoHidden:document.getElementById('preview-goto-line-form').hidden,
      };
    })()`);
    assert.deepEqual(result.markdownOutline.labels, ['Second notes updated', 'Architecture', 'Safety']);
    assert.deepEqual(result.markdownOutline.levels, ['H1', 'H2', 'H3']);
    assert.ok(result.markdownOutline.ariaLabels[1].startsWith('H2 Architecture，源文件第 11 行'));
    assert.deepEqual(result.markdownOutline.lines, ['L1', 'L11', 'L15']);
    assert.deepEqual(result.markdownOutline.entries.map(entry => entry.anchor), ['second-notes-updated', 'architecture', 'safety']);
    assert.equal(result.markdownOutline.tabStops, 1);
    assert.equal(result.markdownOutline.expanded, 'true');
    assert.equal(result.markdownOutline.toggleLabel, '关闭 Markdown 文档大纲');
    assert.equal(result.markdownOutline.gotoHidden, true);
    await client.eval(`document.querySelectorAll('#preview-outline-list .preview-outline-item')[1].click()`);
    await waitFor(client, `document.querySelectorAll('#preview-outline-list .preview-outline-item')[1].getAttribute('aria-current') === 'location'
      && !!document.querySelector('.preview-markdown h2.preview-heading-target')`);
    await client.eval(`document.getElementById('preview-outline-copy').click()`);
    await waitFor(client, `window.__hubE2EPreviewClipboardText === ${JSON.stringify(SECOND_PATH + ':11#architecture')}`);
    result.markdownReference = await client.eval(`window.__hubE2EPreviewClipboardText`);
    assert.equal(result.markdownReference, SECOND_PATH + ':11#architecture');
    await capture(client, OUTLINE_SCREENSHOT_PATH);
    await client.eval(`(() => {
      const active = document.querySelector('#preview-outline-list .preview-outline-item[aria-current="location"]');
      active.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true, cancelable:true }));
    })()`);
    await waitFor(client, `document.activeElement?.dataset?.outlineIndex === '2'`);
    result.outlineKeyboard = true;
    await client.eval(`document.querySelector('.preview-markdown a[href="#safety"]').click()`);
    await waitFor(client, `document.querySelector('.preview-markdown h3').classList.contains('preview-heading-target')
      && window.__hubE2E.previewWorkbench.state().tabs
        .find(tab => tab.id === window.__hubE2E.previewWorkbench.state().activeTabId).outlineActiveAnchor === 'safety'`);
    result.samePageAnchor = true;
    await client.eval(`document.getElementById('preview-outline-close').click()`);
    await waitFor(client, `document.getElementById('preview-outline').hidden
      && document.activeElement?.id === 'preview-outline-toggle'`);
    await client.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key:'O', code:'KeyO', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true,
    }))`);
    await waitFor(client, `!document.getElementById('preview-outline').hidden`);
    await client.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key:'Escape', code:'Escape', bubbles:true, cancelable:true,
    }))`);
    await waitFor(client, `document.getElementById('preview-outline').hidden
      && document.querySelectorAll('#preview-tabs .preview-tab').length === 2
      && document.getElementById('preview-panel').style.display === 'flex'`);
    result.outlineShortcut = true;
    result.outlineEscapePreservedTabs = true;

    await client.send('Input.dispatchKeyEvent', {
      type:'keyDown', key:'f', code:'KeyF', modifiers:2, windowsVirtualKeyCode:70,
    });
    await client.send('Input.dispatchKeyEvent', {
      type:'keyUp', key:'f', code:'KeyF', modifiers:2, windowsVirtualKeyCode:70,
    });
    await waitFor(client, `!document.getElementById('preview-find-bar').hidden
      && document.activeElement?.id === 'preview-find-input'`);
    result.findToggleA11y = await client.eval(`(() => {
      const toggle = document.getElementById('preview-find-toggle');
      return {
        controls:toggle.getAttribute('aria-controls'),
        expanded:toggle.getAttribute('aria-expanded'),
      };
    })()`);
    assert.deepEqual(result.findToggleA11y, { controls:'preview-find-bar', expanded:'true' });
    await client.eval(`(() => {
      const input = document.getElementById('preview-find-input');
      input.value = 'FILE_WATCH_UPDATED_MARKER';
      input.dispatchEvent(new Event('input', { bubbles:true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
    })()`);
    await waitFor(client, `document.getElementById('preview-find-count').textContent === '2 / 3'`);
    result.domFindDebounceRace = true;
    result.domFind = await client.eval(`(() => ({
      count:document.getElementById('preview-find-count').textContent,
      allHighlights:CSS.highlights.get('preview-find-all')?.size || 0,
      currentHighlights:CSS.highlights.get('preview-find-current')?.size || 0,
      terminalSearchVisible:!!document.querySelector('.xterm-search-bar:not(.hidden)'),
    }))()`);
    assert.deepEqual(result.domFind, {
      count:'2 / 3',
      allHighlights:2,
      currentHighlights:1,
      terminalSearchVisible:false,
    });
    await capture(client, FIND_SCREENSHOT_PATH);
    await client.eval(`document.getElementById('preview-find-input').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }))`);
    await waitFor(client, `document.getElementById('preview-find-count').textContent === '3 / 3'`);
    await client.eval(`(() => {
      const input = document.getElementById('preview-find-input');
      input.value = 'Cross inline phrase';
      input.dispatchEvent(new Event('input', { bubbles:true }));
    })()`);
    await waitFor(client, `document.getElementById('preview-find-count').textContent === '1 / 1'`);
    result.crossNodeFind = await client.eval(`(() => {
      const highlight = CSS.highlights.get('preview-find-current');
      const range = highlight ? Array.from(highlight)[0] : null;
      return { count:document.getElementById('preview-find-count').textContent, text:range?.toString() || '' };
    })()`);
    assert.deepEqual(result.crossNodeFind, { count:'1 / 1', text:'Cross inline phrase' });
    await client.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
    await client.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
    await waitFor(client, `document.getElementById('preview-find-bar').hidden
      && document.getElementById('preview-panel').style.display === 'flex'`);
    assert.equal(await client.eval(`document.getElementById('preview-find-toggle').getAttribute('aria-expanded')`), 'false');

    await client.eval(`window.openPreviewPanel(${JSON.stringify(HTML_PATH)})`);
    await waitFor(client, `document.getElementById('preview-title').title === ${JSON.stringify(HTML_PATH)}
      && !!document.querySelector('#preview-body webview')
      && document.querySelector('#preview-body webview').isLoading() === false`);
    result.webviewGuestProbe = await client.eval(`(async () => {
      const webview = document.querySelector('#preview-body webview');
      const text = await webview.executeJavaScript('document.body.innerText');
      return { markerCount:(String(text).match(/WEBVIEW_FIND_MARKER/g) || []).length };
    })()`);
    assert.deepEqual(result.webviewGuestProbe, { markerCount:2 });
    await client.eval(`(async () => {
      const webview = document.querySelector('#preview-body webview');
      webview.focus();
      await webview.executeJavaScript('document.body.tabIndex = -1; document.body.focus(); true;');
    })()`);
    await client.send('Input.dispatchKeyEvent', {
      type:'keyDown', key:'f', code:'KeyF', modifiers:2, windowsVirtualKeyCode:70,
    });
    await client.send('Input.dispatchKeyEvent', {
      type:'keyUp', key:'f', code:'KeyF', modifiers:2, windowsVirtualKeyCode:70,
    });
    await waitFor(client, `document.activeElement?.id === 'preview-find-input'`);
    result.webviewGuestShortcut = true;
    await client.eval(`(() => {
      const input = document.getElementById('preview-find-input');
      input.value = 'WEBVIEW_FIND_MARKER';
      input.dispatchEvent(new Event('input', { bubbles:true }));
    })()`);
    await waitFor(client, `document.getElementById('preview-find-count').textContent === '1 / 2'`);
    await client.eval(`document.getElementById('preview-find-input').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }))`);
    await waitFor(client, `document.getElementById('preview-find-count').textContent === '2 / 2'`);
    result.webviewFind = await client.eval(`(() => ({
      count:document.getElementById('preview-find-count').textContent,
      webviewVisible:!!document.querySelector('#preview-body webview'),
      scope:document.getElementById('preview-find-input').getAttribute('aria-description'),
    }))()`);
    assert.deepEqual(result.webviewFind, {
      count:'2 / 2',
      webviewVisible:true,
      scope:'查找当前页面主文档；不包含内嵌 iframe',
    });
    await client.eval(`(() => {
      const input = document.getElementById('preview-find-input');
      for (let index = 0; index < 3; index += 1) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
      }
    })()`);
    await waitFor(client, `document.getElementById('preview-find-count').textContent === '1 / 2'`);
    result.webviewRapidFind = { count:'1 / 2', queuedSteps:3 };
    await client.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
    await client.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
    await waitFor(client, `document.getElementById('preview-find-bar').hidden`);
    await client.eval(`(() => {
      const webview = document.querySelector('#preview-body webview');
      webview.dispatchEvent(new CustomEvent('render-process-gone', { detail:{ reason:'crashed' } }));
    })()`);
    await waitFor(client, `document.getElementById('preview-body').innerText.includes('预览进程异常退出')
      && document.getElementById('preview-change-badge').textContent === '读取异常'`);
    result.webviewCrashState = await client.eval(`(() => ({
      badge:document.getElementById('preview-change-badge').textContent,
      body:document.getElementById('preview-body').innerText,
    }))()`);
    assert.equal(result.webviewCrashState.badge, '读取异常');
    assert.match(result.webviewCrashState.body, /预览进程异常退出/);
    await client.eval(`document.getElementById('preview-reload').click()`);
    await waitFor(client, `!!document.querySelector('#preview-body webview')
      && document.querySelector('#preview-body webview').isLoading() === false
      && document.getElementById('preview-change-badge').hidden`);
    await client.eval(`(() => {
      const active = document.querySelector('#preview-tabs .preview-tab.active');
      active.closest('.preview-tab-shell').querySelector('.preview-tab-close').click();
    })()`);
    await waitFor(client, `document.querySelectorAll('#preview-tabs .preview-tab').length === 2
      && document.getElementById('preview-title').title === ${JSON.stringify(SECOND_PATH)}`);

    await client.eval(`window.openPreviewPanel(${JSON.stringify(CODE_PATH)}, { pinned:true })`);
    await waitFor(client, `document.getElementById('preview-title').title === ${JSON.stringify(CODE_PATH)}
      && document.querySelectorAll('#preview-body .preview-code-line').length === 6
      && !document.getElementById('preview-outline-toggle').disabled`);
    await client.eval(`document.getElementById('preview-outline-toggle').click()`);
    await waitFor(client, `!document.getElementById('preview-outline').hidden
      && !document.getElementById('preview-goto-line-form').hidden`);
    await client.eval(`(() => {
      const input = document.getElementById('preview-goto-line-input');
      input.value = '';
      document.getElementById('preview-goto-line-form').dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
    })()`);
    await waitFor(client, `document.getElementById('preview-notice')?.textContent.includes('行号无效')`);
    result.invalidLineRejected = true;
    await client.eval(`(() => {
      const input = document.getElementById('preview-goto-line-input');
      input.value = '5';
      document.getElementById('preview-goto-line-form').dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
    })()`);
    await waitFor(client, `document.querySelector('.preview-code-line[data-line="5"]').classList.contains('preview-line-target')
      && !document.getElementById('preview-outline-copy').disabled`);
    await client.eval(`document.getElementById('preview-outline-copy').click()`);
    await waitFor(client, `window.__hubE2EPreviewClipboardText === ${JSON.stringify(CODE_PATH + ':5')}`);
    result.codeLineJump = await client.eval(`(() => ({
      reference:window.__hubE2EPreviewClipboardText,
      line:window.__hubE2E.previewWorkbench.state().tabs
        .find(tab => tab.id === window.__hubE2E.previewWorkbench.state().activeTabId).referenceLine,
      gotoMax:document.getElementById('preview-goto-line-input').max,
      gutterHidden:[...document.querySelectorAll('.preview-line-num')]
        .every(number => number.getAttribute('aria-hidden') === 'true'),
    }))()`);
    assert.deepEqual(result.codeLineJump, {
      reference:CODE_PATH + ':5',
      line:5,
      gotoMax:'6',
      gutterHidden:true,
    });
    await client.eval(`document.getElementById('preview-outline-close').click()`);
    await waitFor(client, `document.getElementById('preview-outline').hidden`);
    await client.eval(`(() => {
      const active = document.querySelector('#preview-tabs .preview-tab.active');
      active.closest('.preview-tab-shell').querySelector('.preview-tab-close').click();
    })()`);
    await waitFor(client, `document.getElementById('preview-title').title === ${JSON.stringify(SECOND_PATH)}
      && document.querySelectorAll('#preview-tabs .preview-tab').length === 2`);

    await client.eval(`window.openPreviewPanel(${JSON.stringify(EDGE_MD_PATH)}, { pinned:true })`);
    await waitFor(client, `document.getElementById('preview-title').title === ${JSON.stringify(EDGE_MD_PATH)}
      && window.__hubE2E.previewWorkbench.state().tabs
        .find(tab => tab.id === window.__hubE2E.previewWorkbench.state().activeTabId).outline.length === 2`);
    result.markedTokenAlignment = await client.eval(`(() => {
      const state = window.__hubE2E.previewWorkbench.state();
      const tab = state.tabs.find(item => item.id === state.activeTabId);
      return {
        outline:tab.outline,
        text:document.querySelector('.preview-markdown').innerText,
        widgetElement:!!document.querySelector('.preview-markdown widget'),
        h1Count:document.querySelectorAll('.preview-markdown h1').length,
      };
    })()`);
    assert.deepEqual(result.markedTokenAlignment.outline, [
      { level:1, text:'Quoted', line:2, anchor:'quoted' },
      { level:2, text:'Fish & Chips', line:3, anchor:'fish-chips' },
    ]);
    assert.match(result.markedTokenAlignment.text, /<widget>/);
    assert.match(result.markedTokenAlignment.text, /List<String>/);
    assert.equal(result.markedTokenAlignment.widgetElement, false);
    assert.equal(result.markedTokenAlignment.h1Count, 2);
    await client.eval(`(() => {
      const active = document.querySelector('#preview-tabs .preview-tab.active');
      active.closest('.preview-tab-shell').querySelector('.preview-tab-close').click();
    })()`);
    await waitFor(client, `document.getElementById('preview-title').title === ${JSON.stringify(SECOND_PATH)}
      && document.querySelectorAll('#preview-tabs .preview-tab').length === 2`);

    fs.unlinkSync(FIRST_PATH);
    await waitFor(client, `Array.from(document.querySelectorAll('#preview-tabs .preview-tab-shell'))
      .some(shell => shell.querySelector('.preview-tab')?.title === ${JSON.stringify(FIRST_PATH)}
        && shell.classList.contains('missing'))`);
    result.missingFileState = await client.eval(`(() => {
      const tab = Array.from(document.querySelectorAll('#preview-tabs .preview-tab'))
        .find(item => item.title === ${JSON.stringify(FIRST_PATH)});
      return {
        missing:tab.closest('.preview-tab-shell').classList.contains('missing'),
        aria:tab.getAttribute('aria-label'),
        activePath:document.getElementById('preview-title').title,
      };
    })()`);
    assert.equal(result.missingFileState.missing, true);
    assert.match(result.missingFileState.aria, /文件已移除/);
    assert.equal(result.missingFileState.activePath, SECOND_PATH);
    fs.writeFileSync(FIRST_PATH, '# First report restored\n\nCOPY_FULL_TEXT_MARKER\n', 'utf8');
    await waitFor(client, `Array.from(document.querySelectorAll('#preview-tabs .preview-tab-shell'))
      .some(shell => shell.querySelector('.preview-tab')?.title === ${JSON.stringify(FIRST_PATH)}
        && shell.classList.contains('stale') && !shell.classList.contains('missing'))`);

    await client.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key:'o', code:'KeyO', ctrlKey:true, bubbles:true, cancelable:true,
    }))`);
    await waitFor(client, `document.getElementById('preview-quick-open').style.display === 'flex'`);
    await openThroughQuickPath(client, TEMP_A_PATH);
    const firstTemporary = await client.eval(`(() => {
      const state = window.__hubE2E.previewWorkbench.state();
      const tab = state.tabs.find(item => item.pinned === false);
      return { id:tab.id, path:tab.path, count:state.tabs.length };
    })()`);
    assert.equal(firstTemporary.path, TEMP_A_PATH);
    assert.equal(firstTemporary.count, 3);
    await client.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {
      key:'o', code:'KeyO', ctrlKey:true, bubbles:true, cancelable:true,
    }))`);
    await waitFor(client, `document.getElementById('preview-quick-open').style.display === 'flex'`);
    await openThroughQuickPath(client, TEMP_B_PATH);
    await waitFor(client, `(() => {
      const state = window.__hubE2E.previewWorkbench.state();
      const tab = state.tabs.find(item => item.path === ${JSON.stringify(TEMP_B_PATH)});
      return tab && tab.lineCount === 4 && tab.lineReferenceExact === false;
    })()`);
    result.temporaryReuse = await client.eval(`(() => {
      const state = window.__hubE2E.previewWorkbench.state();
      const tab = state.tabs.find(item => item.pinned === false);
      return { id:tab.id, path:tab.path, count:state.tabs.length, lineReferenceExact:tab.lineReferenceExact };
    })()`);
    assert.deepEqual(result.temporaryReuse, {
      id:firstTemporary.id,
      path:TEMP_B_PATH,
      count:3,
      lineReferenceExact:false,
    });
    await client.eval(`(() => {
      const active = document.querySelector('#preview-tabs .preview-tab.active');
      active.focus();
      active.dispatchEvent(new KeyboardEvent('keydown', {
        key:'Enter', code:'Enter', ctrlKey:true, bubbles:true, cancelable:true,
      }));
    })()`);
    await waitFor(client, `window.__hubE2E.previewWorkbench.state().tabs.every(tab => tab.pinned)`);
    result.keyboardPinned = true;
    await client.eval(`(() => {
      const active = document.querySelector('#preview-tabs .preview-tab.active');
      active.closest('.preview-tab-shell').querySelector('.preview-tab-close').click();
    })()`);
    await waitFor(client, `document.getElementById('preview-title').title === ${JSON.stringify(SECOND_PATH)}
      && document.querySelectorAll('#preview-tabs .preview-tab').length === 2`);

    await client.eval(`(() => {
      const panel = document.getElementById('preview-panel');
      window.__previewE2EPriorFlex = panel.style.flex;
      panel.style.flex = '0 0 220px';
      document.getElementById('preview-find-toggle').click();
    })()`);
    await waitFor(client, `!document.getElementById('preview-find-bar').hidden
      && document.getElementById('preview-panel').getBoundingClientRect().width <= 222`);
    result.narrowFind = await client.eval(`(() => {
      const panel = document.getElementById('preview-panel');
      const bar = document.getElementById('preview-find-bar');
      const input = document.getElementById('preview-find-input').getBoundingClientRect();
      const count = document.getElementById('preview-find-count').getBoundingClientRect();
      const actions = document.querySelector('.preview-header-actions');
      const panelRect = panel.getBoundingClientRect();
      const closeRect = document.getElementById('preview-close').getBoundingClientRect();
      const actionRows = new Set(Array.from(actions.querySelectorAll('button'))
        .filter(button => getComputedStyle(button).display !== 'none')
        .map(button => Math.round(button.getBoundingClientRect().top)));
      return {
        panelWidth:panel.getBoundingClientRect().width,
        barClientWidth:bar.clientWidth,
        barScrollWidth:bar.scrollWidth,
        inputTop:input.top,
        controlsTop:count.top,
        headerActionsClientWidth:actions.clientWidth,
        headerActionsScrollWidth:actions.scrollWidth,
        actionRows:actionRows.size,
        closeInsidePanel:closeRect.left >= panelRect.left && closeRect.right <= panelRect.right + 1,
        bodyScrollWidth:document.body.scrollWidth,
        viewportWidth:innerWidth,
      };
    })()`);
    assert.ok(result.narrowFind.panelWidth <= 222, JSON.stringify(result.narrowFind));
    assert.ok(result.narrowFind.barScrollWidth <= result.narrowFind.barClientWidth + 1, JSON.stringify(result.narrowFind));
    assert.ok(result.narrowFind.controlsTop > result.narrowFind.inputTop, JSON.stringify(result.narrowFind));
    assert.ok(result.narrowFind.headerActionsScrollWidth <= result.narrowFind.headerActionsClientWidth + 1, JSON.stringify(result.narrowFind));
    assert.ok(result.narrowFind.actionRows >= 2, JSON.stringify(result.narrowFind));
    assert.equal(result.narrowFind.closeInsidePanel, true);
    assert.equal(result.narrowFind.bodyScrollWidth, result.narrowFind.viewportWidth);
    await client.eval(`document.getElementById('preview-find-close').click()`);
    await waitFor(client, `document.getElementById('preview-find-bar').hidden`);
    await client.eval(`document.getElementById('preview-outline-toggle').click()`);
    await waitFor(client, `!document.getElementById('preview-outline').hidden`);
    result.narrowOutline = await client.eval(`(() => {
      const panel = document.getElementById('preview-panel').getBoundingClientRect();
      const outline = document.getElementById('preview-outline').getBoundingClientRect();
      const close = document.getElementById('preview-outline-close').getBoundingClientRect();
      return {
        panelWidth:panel.width,
        outlineWidth:outline.width,
        inside:outline.left >= panel.left && outline.right <= panel.right + 1,
        closeVisible:close.width > 0 && close.left >= outline.left && close.right <= outline.right + 1,
        bodyScrollWidth:document.body.scrollWidth,
        viewportWidth:innerWidth,
      };
    })()`);
    assert.ok(result.narrowOutline.outlineWidth <= result.narrowOutline.panelWidth - 15, JSON.stringify(result.narrowOutline));
    assert.equal(result.narrowOutline.inside, true);
    assert.equal(result.narrowOutline.closeVisible, true);
    assert.equal(result.narrowOutline.bodyScrollWidth, result.narrowOutline.viewportWidth);
    await client.eval(`(() => {
      document.getElementById('preview-outline-close').click();
      document.getElementById('preview-panel').style.flex = window.__previewE2EPriorFlex || '';
    })()`);
    await waitFor(client, `document.getElementById('preview-outline').hidden`);

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
        name:input.getAttribute('aria-label'),
        describedBy:input.getAttribute('aria-describedby'),
        controls:input.getAttribute('aria-controls'),
        expanded:input.getAttribute('aria-expanded'),
        activeDescendant:input.getAttribute('aria-activedescendant'),
        statusLive:document.getElementById('preview-quick-open-status').getAttribute('aria-live'),
        modeHint:document.getElementById('preview-quick-open-mode-hint').textContent,
        optionLabel:document.getElementById(input.getAttribute('aria-activedescendant')).getAttribute('aria-label'),
        optionIconHidden:document.querySelector('.preview-quick-open-item-icon').getAttribute('aria-hidden'),
      };
    })()`);
    assert.deepEqual(result.quickOpenA11y, {
      role:'combobox',
      name:'输入路径或搜索文件',
      describedBy:'preview-quick-open-mode-hint',
      controls:'preview-quick-open-results',
      expanded:'true',
      activeDescendant:'preview-quick-open-option-0',
      statusLive:'polite',
      modeHint:'↑↓ 选择 · Enter 固定打开',
      optionLabel:'second-notes.md，' + SECOND_PATH + '，最近',
      optionIconHidden:'true',
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
        noticeRole:notice?.getAttribute('role') || '',
        noticeLive:notice?.getAttribute('aria-live') || '',
        noticePosition:notice ? getComputedStyle(notice).position : '',
        noticeZ:notice ? Number(getComputedStyle(notice).zIndex) : 0,
      };
    })()`);
    assert.equal(result.visibleOpenError.ok, false);
    assert.match(result.visibleOpenError.noticeText, /文件打开失败/);
    assert.equal(result.visibleOpenError.noticeRole, 'alert');
    assert.equal(result.visibleOpenError.noticeLive, 'assertive');
    assert.equal(result.visibleOpenError.noticePosition, 'fixed');
    assert.ok(result.visibleOpenError.noticeZ >= 14000, JSON.stringify(result.visibleOpenError));
    await client.eval(`document.getElementById('preview-close').click()`);
    await waitFor(client, `window.__hubE2E.previewWorkbench.watchStats().files === 0`);
    result.resourceRelease = await client.eval(`(() => ({
      watch:window.__hubE2E.previewWorkbench.watchStats(),
      find:window.__hubE2E.previewWorkbench.findState(),
      panel:document.getElementById('preview-panel').style.display,
    }))()`);
    assert.deepEqual(result.resourceRelease.watch, { directories:0, files:0, listeners:0, degradedDirectories:0, cleanupFailures:0 });
    assert.equal(result.resourceRelease.find.query, '');
    assert.equal(result.resourceRelease.find.matches, 0);
    assert.equal(result.resourceRelease.panel, 'none');
    testBodyPassed = true;
  } catch (error) {
    if (hub) console.error('[isolated hub log]\n' + hub.log().slice(-100).join('\n'));
    throw error;
  } finally {
    try {
      if (client) await client.close().catch(error => {
        console.warn('[preview-e2e] CDP client close failed:', error && error.message);
      });
      if (hub) result.teardown = await gracefulQuit(hub);
    } finally {
      const resolved = path.resolve(TEMP_ROOT);
      if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
          && path.basename(resolved).startsWith('hub-preview-workbench-')) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
  if (testBodyPassed) {
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((error) => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
