'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  gracefulQuit,
  launchIsolatedHub,
  listCdpTargets,
  _waitMs,
} = require('./helpers/hub-launcher.js');
const { connectCDP, connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-clipboard-notification-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const FIXTURE_DIR = path.join(TEMP_ROOT, 'workspace');
const MARKDOWN_PATH = path.join(FIXTURE_DIR, 'clipboard-preview.md');
const HTML_PATH = path.join(FIXTURE_DIR, 'clipboard-preview.html');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'clipboard-notification');
const NOTIFICATION_SCREENSHOT = path.join(ARTIFACT_DIR, `desktop-notification-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `clipboard-notification-${RUN_ID}.json`);

function availablePort(preferred) {
  return new Promise((resolve, reject) => {
    const tryPort = port => {
      const server = net.createServer();
      server.once('error', () => tryPort(port + 1));
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    try { tryPort(preferred); } catch (error) { reject(error); }
  });
}

async function waitFor(client, expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await client.eval(`Boolean(${expression})`)) return;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(80);
  }
  throw new Error(`timeout waiting for ${expression}${lastError ? `: ${lastError.message}` : ''}`);
}

async function dispatchCtrlC(client) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: 2,
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: 2,
  });
}

async function selectNodeText(client, selector, marker) {
  return client.eval(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    if (!root) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = String(node.nodeValue || '').indexOf(${JSON.stringify(marker)});
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + ${JSON.stringify(marker)}.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      root.focus?.();
      return selection.toString();
    }
    return false;
  })()`);
}

async function clipboardText(client) {
  return client.eval(`require('electron').clipboard.readText()`);
}

async function resetClipboard(client) {
  await client.eval(`require('electron').clipboard.writeText('HUB_E2E_CLIPBOARD_SENTINEL')`);
}

async function waitForNotificationTarget(hub, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listCdpTargets(hub);
    const target = targets.find(item => item.type === 'page' && /desktop-notification\.html/i.test(item.url || ''));
    if (target) return target;
    await _waitMs(100);
  }
  throw new Error('desktop notification CDP target did not appear');
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(MARKDOWN_PATH, '# Copy preview\n\nMARKDOWN_COPY_ONCE 中文段落\n', 'utf8');
  fs.writeFileSync(HTML_PATH, '<!doctype html><meta charset="utf-8"><h1>HTML preview</h1><p>HTML_WEBVIEW_COPY_ONCE 中文段落</p>', 'utf8');

  const port = await availablePort(Number(process.env.HUB_CLIPBOARD_NOTIFICATION_E2E_PORT || 19920));
  const result = {
    runId: RUN_ID,
    port,
    notificationScreenshot: NOTIFICATION_SCREENSHOT,
    resultPath: RESULT_PATH,
  };
  let hub = null;
  let client = null;
  let notificationClient = null;
  let passed = false;
  let failure = null;

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'clipboard-notification',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        DEEPSEEK_API_KEY: '',
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_E2E_SHOW_NOTIFICATION: '1',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(client, `window.__hubE2E && window.__hubE2E.clipboard && window.__hubE2E.desktopNotifications`);

    await client.eval(`window.__hubE2E.cardQuestionNavigator.mountFixture({ sessionId:'copy-card-e2e', start:1, count:1, clear:true })`);
    const cardMarker = '问题 1：请分析第 1 个方案';
    assert.equal(await selectNodeText(client, '#msg-overlay .turn-card.user .turn-body', cardMarker), cardMarker);
    await resetClipboard(client);
    await dispatchCtrlC(client);
    await waitFor(client, `require('electron').clipboard.readText() === ${JSON.stringify(cardMarker)}`);
    result.cardCopy = {
      text: await clipboardText(client),
      feedback: await client.eval(`window.__hubE2E.clipboard.feedbackText()`),
    };
    assert.match(result.cardCopy.feedback, /已复制/);
    assert.match(result.cardCopy.feedback, /已校验/);

    const inputMarker = 'INPUT_COPY_ONCE 输入框文字';
    await client.eval(`(() => {
      let input = document.getElementById('clipboard-e2e-input');
      if (!input) {
        input = document.createElement('div');
        input.id = 'clipboard-e2e-input';
        input.className = 'floating-input-box';
        input.contentEditable = 'true';
        document.body.appendChild(input);
      }
      input.textContent = ${JSON.stringify(inputMarker)};
      return true;
    })()`);
    assert.equal(await selectNodeText(client, '#clipboard-e2e-input', inputMarker), inputMarker);
    await resetClipboard(client);
    await dispatchCtrlC(client);
    await waitFor(client, `require('electron').clipboard.readText() === ${JSON.stringify(inputMarker)}`);
    result.inputCopy = await clipboardText(client);

    await client.eval(`window.openPreviewPanel(${JSON.stringify(MARKDOWN_PATH)})`);
    await waitFor(client, `document.getElementById('preview-title')?.title === ${JSON.stringify(MARKDOWN_PATH)}
      && document.querySelector('#preview-body .preview-markdown')`);
    const markdownMarker = 'MARKDOWN_COPY_ONCE 中文段落';
    assert.equal(await selectNodeText(client, '#preview-body .preview-markdown', markdownMarker), markdownMarker);
    await resetClipboard(client);
    await dispatchCtrlC(client);
    await waitFor(client, `require('electron').clipboard.readText() === ${JSON.stringify(markdownMarker)}`);
    result.markdownCopy = await clipboardText(client);

    await client.eval(`window.openPreviewPanel(${JSON.stringify(HTML_PATH)}, { pinned:true })`);
    await waitFor(client, `document.getElementById('preview-title')?.title === ${JSON.stringify(HTML_PATH)}
      && document.querySelector('#preview-body webview')?.getWebContentsId?.() > 0`);
    const htmlMarker = 'HTML_WEBVIEW_COPY_ONCE 中文段落';
    await resetClipboard(client);
    const guestDispatch = await client.eval(`(async () => {
      const webview = document.querySelector('#preview-body webview');
      const selected = await webview.executeJavaScript(` + JSON.stringify(`(() => {
        const root = document.querySelector('p');
        const node = root && root.firstChild;
        if (!node) return '';
        const text = node.nodeValue || '';
        const marker = ${JSON.stringify(htmlMarker)};
        const index = text.indexOf(marker);
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + marker.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString();
      })()`) + `);
      webview.focus();
      webview.sendInputEvent({ type:'keyDown', keyCode:'C', modifiers:['control'] });
      webview.sendInputEvent({ type:'keyUp', keyCode:'C', modifiers:['control'] });
      return selected;
    })()`);
    assert.equal(guestDispatch, htmlMarker);
    await waitFor(client, `require('electron').clipboard.readText() === ${JSON.stringify(htmlMarker)}`);
    await waitFor(client, `document.getElementById('hub-copy-feedback')?.innerText.includes('已校验')`);
    result.htmlCopy = {
      text: await clipboardText(client),
      feedback: await client.eval(`window.__hubE2E.clipboard.feedbackText()`),
    };

    const notificationSession = {
      id: 'desktop-notification-e2e',
      kind: 'codex',
      title: '无线报告复核已完成',
      status: 'idle',
      attentionState: 'none',
      unreadCount: 0,
      lastMessageTime: Date.now(),
    };
    await client.eval(`window.__hubE2E.addFakeSession(${JSON.stringify(notificationSession)})`);
    const completedAt = Date.now();
    const completedSession = {
      ...notificationSession,
      attentionState: 'reply-ready',
      replyReady: true,
      unreadCount: 1,
      replyReadyText: '报告和验证证据已经准备好，等你查看。',
      lastCompletedAt: completedAt,
      lastMessageTime: completedAt,
      runtimeTruth: {
        state: 'completed',
        source: 'e2e-completion',
        confidence: 'authoritative',
        observedAt: completedAt,
        completedAt,
      },
    };
    await client.eval(`window.__hubE2E.addFakeSession(${JSON.stringify(completedSession)})`);
    const notificationTarget = await waitForNotificationTarget(hub);
    notificationClient = await connectCDP(notificationTarget.webSocketDebuggerUrl);
    await notificationClient.send('Runtime.enable');
    await notificationClient.send('Page.enable');
    await waitFor(notificationClient, `document.getElementById('notification-card')?.dataset.sequence === '1'`);
    result.notification = await notificationClient.eval(`(() => ({
      state:document.querySelector('.eyebrow')?.innerText || '',
      title:document.getElementById('notification-title')?.innerText || '',
      body:document.getElementById('notification-body')?.innerText || '',
      sequence:document.getElementById('notification-card')?.dataset.sequence || '',
      width:document.documentElement.getBoundingClientRect().width,
      height:document.documentElement.getBoundingClientRect().height,
      background:getComputedStyle(document.getElementById('notification-card')).backgroundImage,
    }))()`);
    assert.match(result.notification.state, /已完成 · 待查看/);
    assert.equal(result.notification.title, completedSession.title);
    assert.equal(result.notification.body, completedSession.replyReadyText);
    assert.match(result.notification.background, /gradient/i);
    await _waitMs(350);
    const shot = await notificationClient.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    });
    fs.writeFileSync(NOTIFICATION_SCREENSHOT, Buffer.from(shot.data, 'base64'));

    await client.eval(`window.__hubE2E.addFakeSession(${JSON.stringify({ ...completedSession, unreadCount: 2 })})`);
    await _waitMs(250);
    const unchangedSequence = await notificationClient.eval(`document.getElementById('notification-card')?.dataset.sequence`);
    assert.equal(unchangedSequence, '1', 'remaining in completed-unread must not emit another notification');
    result.sameStateDeduped = true;

    await client.eval(`window.__hubE2E.addFakeSession(${JSON.stringify({ ...notificationSession, attentionState: 'none', replyReady: false, unreadCount: 0 })})`);
    await client.eval(`window.__hubE2E.addFakeSession(${JSON.stringify({ ...completedSession, unreadCount: 1, lastCompletedAt: completedAt + 1000 })})`);
    await waitFor(notificationClient, `document.getElementById('notification-card')?.dataset.sequence === '2'`);
    result.reentryNotified = true;
    result.notifierState = await client.eval(`window.__hubE2E.desktopNotifications.state()`);
    assert.equal(result.notifierState.notificationCount, 2);
    await notificationClient.eval(`document.getElementById('notification-card').click()`);
    await waitFor(client, `document.querySelector('.session-item.selected')?.dataset.sessionId === 'desktop-notification-e2e'`);
    await waitFor(client, `!window.__hubE2E.desktopNotifications.state().eligibleIds.includes('desktop-notification-e2e')`);
    result.notificationClickOpenedSession = true;
    await notificationClient.close().catch(() => {});
    notificationClient = null;
    passed = true;
  } catch (error) {
    failure = error;
    if (hub) console.error('[isolated hub log]\n' + hub.log().slice(-100).join('\n'));
  } finally {
    try {
      if (notificationClient) {
        await notificationClient.eval(`document.getElementById('notification-close')?.click()`).catch(() => {});
        await _waitMs(100);
        await notificationClient.close().catch(() => {});
      }
      if (client) await client.close().catch(() => {});
      if (hub) {
        try { result.teardown = await gracefulQuit(hub); }
        catch (error) {
          if (failure) console.error('[clipboard-notification-e2e teardown]\n' + (error.stack || error.message));
          else failure = error;
        }
      }
    } finally {
      const resolved = path.resolve(TEMP_ROOT);
      if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
          && path.basename(resolved).startsWith('hub-clipboard-notification-')) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }

  if (failure) throw failure;

  if (passed) {
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
