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
const TEMP_ROOT = path.join(os.tmpdir(), `hub-card-local-path-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const FIXTURE_PATH = path.join(TEMP_ROOT, '_scratch', 'My Report', 'report.md');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'card-local-path-links');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `card-local-path-links-${RUN_ID}.png`);
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

async function waitForRenderer(client, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const ready = await client.eval(`Boolean(
        window._renderTurnCard
        && window.wrapPathLinksInElement
        && window.__mrRenderMarkdown
        && window.openPathInHub
      )`);
      if (ready) return;
    } catch (error) {
      lastError = error;
      if (/WebSocket|not open|closed|ECONN|socket/i.test(String(error && error.message || error))) {
        throw new Error(`CDP connection lost while waiting for card renderers: ${error.message}`);
      }
    }
    await _waitMs(120);
  }
  throw new Error(`Hub card renderers did not become ready${lastError ? `; last error: ${lastError.message}` : ''}`);
}

async function capture(client, target) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

async function main() {
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, '# Local path E2E\n\nWindows path preview works.\n', 'utf8');

  const port = await availablePort(Number(process.env.HUB_CARD_PATH_E2E_PORT || 19841));
  const doubledPath = FIXTURE_PATH.replace(/\\/g, '\\\\');
  const forwardPath = FIXTURE_PATH.replace(/\\/g, '/');
  const fileUrl = ('file:///' + forwardPath).replace(/ /g, '%20');
  let hub = null;
  let client = null;
  let testBodyPassed = false;
  const result = { runId: RUN_ID, port, fixturePath: FIXTURE_PATH, screenshot: SCREENSHOT_PATH };

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'card-local-path-links',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(hub, (target) => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1480,
      height: 940,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitForRenderer(client);

    const ordinaryMarkdown = [
      `普通原始路径：${FIXTURE_PATH}`,
      `本地 Markdown 文字链接：[报告文字](${doubledPath})`,
      `正斜杠路径：[forward](${forwardPath})`,
      `文件 URL：[file-url](${fileUrl})`,
      '网页链接：[OpenAI](https://openai.com/)',
    ].join('\n\n');
    const meetingMarkdown = `群聊文字链接：[群聊报告](${doubledPath})`;

    result.render = await client.eval(`(() => {
      const ordinaryMarkdown = ${JSON.stringify(ordinaryMarkdown)};
      const meetingMarkdown = ${JSON.stringify(meetingMarkdown)};
      document.getElementById('path-link-e2e-host')?.remove();
      const host = document.createElement('section');
      host.id = 'path-link-e2e-host';
      host.className = 'msg-overlay';
      host.style.cssText = 'display:block;position:fixed;inset:54px 36px 36px 320px;z-index:99998;background:#111827;padding:24px;overflow:auto;color:#e5e7eb;border:1px solid #334155;border-radius:16px';
      host.innerHTML = '<h2 style="margin:0 0 16px">路径识别回归验证</h2>'
        + window._renderTurnCard({ id:'path-e2e', role:'assistant', kind:'codex', model:'Codex', text:ordinaryMarkdown, ts:Date.now(), toolCalls:[] })
        + '<div id="path-e2e-meeting" style="margin-top:20px;padding:16px;border:1px solid #334155;border-radius:12px"><b>群聊卡片</b></div>';
      document.body.appendChild(host);
      const ordinaryBody = host.querySelector('.turn-body');
      window.wrapPathLinksInElement(ordinaryBody, { cwd:${JSON.stringify(TEMP_ROOT)} });
      const meeting = host.querySelector('#path-e2e-meeting');
      meeting.insertAdjacentHTML('beforeend', window.__mrRenderMarkdown(meetingMarkdown));

      const ordinaryLinks = Array.from(ordinaryBody.querySelectorAll('a')).map(a => ({
        text:a.textContent,
        href:a.getAttribute('href'),
        isLocal:a.classList.contains('rt-file-link'),
        path:a.getAttribute('data-path') || '',
      }));
      const meetingLinks = Array.from(meeting.querySelectorAll('a')).map(a => ({
        text:a.textContent,
        href:a.getAttribute('href'),
        isLocal:a.classList.contains('rt-file-link'),
        path:a.getAttribute('data-path') || '',
      }));
      return {
        ordinaryText:ordinaryBody.innerText,
        ordinaryLinks,
        meetingText:meeting.innerText,
        meetingLinks,
        replacementChars:(host.innerText.match(/\uFFFD/g) || []).length,
      };
    })()`);

    const localOrdinary = result.render.ordinaryLinks.filter((link) => link.isLocal);
    const webOrdinary = result.render.ordinaryLinks.find((link) => !link.isLocal);
    assert.equal(localOrdinary.length, 4);
    assert.equal(localOrdinary[0].text, FIXTURE_PATH);
    assert.equal(localOrdinary[0].path, FIXTURE_PATH);
    assert.equal(localOrdinary[1].text, doubledPath, 'descriptive Markdown label must not hide the CLI path');
    assert.equal(localOrdinary[1].path, FIXTURE_PATH, 'doubled separators must be repaired for opening');
    assert.equal(localOrdinary[2].text, forwardPath);
    assert.equal(localOrdinary[2].path, FIXTURE_PATH);
    assert.equal(localOrdinary[3].text, fileUrl.replace(/%20/g, ' '));
    assert.equal(localOrdinary[3].path, FIXTURE_PATH);
    assert.deepStrictEqual(webOrdinary, {
      text: 'OpenAI', href: 'https://openai.com/', isLocal: false, path: '',
    });
    assert.equal(result.render.meetingLinks.length, 1);
    assert.equal(result.render.meetingLinks[0].isLocal, true);
    assert.equal(result.render.meetingLinks[0].text, doubledPath);
    assert.equal(result.render.meetingLinks[0].path, FIXTURE_PATH);
    assert.match(result.render.ordinaryText, /_scratch/);
    assert.equal(result.render.replacementChars, 0);

    await capture(client, SCREENSHOT_PATH);

    result.click = await client.eval(`(async () => {
      const link = document.querySelector('#path-link-e2e-host .turn-body a.rt-file-link');
      link.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true }));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const panel = document.getElementById('preview-panel');
        const title = document.getElementById('preview-title');
        if (panel?.style.display === 'flex' && title?.title) {
          const state = window.__hubE2E.previewWorkbench.state();
          const active = state.tabs.find(tab => tab.id === state.activeTabId);
          return {
            display:panel.style.display,
            title:title.textContent,
            path:title.title,
            pinned:active?.pinned,
            isFullscreen:state.isFullscreen,
            fullPressed:document.getElementById('preview-layout-full')?.getAttribute('aria-pressed'),
            sourceDisplay:getComputedStyle(document.getElementById('terminal-panel')).display,
          };
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { display:'', title:'', path:'', pinned:null };
    })()`);
    assert.equal(result.click.display, 'flex');
    assert.equal(result.click.path, FIXTURE_PATH);
    assert.equal(result.click.title, path.basename(FIXTURE_PATH));
    assert.equal(result.click.pinned, false, 'a single path click must use the reusable temporary tab');
    assert.equal(result.click.isFullscreen, true);
    assert.equal(result.click.fullPressed, 'true');
    assert.equal(result.click.sourceDisplay, 'none');

    testBodyPassed = true;
  } catch (error) {
    if (hub) console.error('[isolated hub log]\n' + hub.log().slice(-80).join('\n'));
    throw error;
  } finally {
    try {
      if (client) await client.close().catch(error => {
        console.warn('[card-local-path-e2e] CDP close failed:', error && error.message);
      });
      if (hub) result.teardown = await gracefulQuit(hub);
    } finally {
      const resolved = path.resolve(TEMP_ROOT);
      if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
          && path.basename(resolved).startsWith('hub-card-local-path-')) {
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
