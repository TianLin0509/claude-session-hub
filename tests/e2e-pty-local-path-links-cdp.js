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
const TEMP_ROOT = path.join(os.tmpdir(), `hub-pty-local-path-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const HOME_DIR = path.join(TEMP_ROOT, 'home');
const WORK_DIR = path.join(TEMP_ROOT, '工作区');
const ABS_FILE = path.join(WORK_DIR, '中文目录', '带 空格的报告.md');
const REL_FILE = path.join(WORK_DIR, 'docs', 'note.md');
const LONG_URL = 'https://example.com/api/items?id=1&mode=full';
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'pty-local-path-links');
const TERMINAL_SCREENSHOT = path.join(ARTIFACT_DIR, `pty-path-links-${RUN_ID}.png`);
const PREVIEW_SCREENSHOT = path.join(ARTIFACT_DIR, `pty-path-preview-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `pty-path-links-${RUN_ID}.json`);

function canListen(port) {
  return new Promise(resolve => {
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

async function waitFor(client, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(expression)) return; } catch {}
    await _waitMs(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function capture(client, filePath) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function terminalCellWidth(text) {
  return Array.from(String(text)).reduce((sum, char) => sum + (char.codePointAt(0) > 0xFF ? 2 : 1), 0);
}

(async () => {
  fs.mkdirSync(path.dirname(ABS_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(REL_FILE), { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(ABS_FILE, '# PTY absolute path preview\n', 'utf8');
  fs.writeFileSync(REL_FILE, '# PTY relative path preview\n', 'utf8');

  const port = await availablePort(Number(process.env.HUB_PTY_PATH_E2E_PORT || 19691));
  let hub = null;
  let client = null;
  const result = {
    runId: RUN_ID,
    port,
    workDir: WORK_DIR,
    absoluteFile: ABS_FILE,
    relativeFile: REL_FILE,
    longUrl: LONG_URL,
  };
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'pty-local-path-links',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: HOME_DIR,
        DEEPSEEK_API_KEY: '',
      },
    });
    await _waitMs(1400);
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1180,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(
      client,
      `document.readyState === 'complete' && window.__hubE2E?.terminalLinks && window.openPathInHub`,
      'PTY link E2E helpers',
    );

    const session = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
      kind: 'powershell',
      opts: { title: 'PTY path links E2E', cwd: ${JSON.stringify(WORK_DIR)} }
    })`);
    assert.ok(session && session.id, JSON.stringify(session));
    result.sessionId = session.id;
    await waitFor(
      client,
      `window.__hubE2E.terminalCacheStats().ids.includes(${JSON.stringify(session.id)})`,
      'real xterm cache',
    );
    await waitFor(
      client,
      `window.__hubE2E.terminalBufferText(${JSON.stringify(session.id)}).length > 20`,
      'PowerShell prompt',
    );

    const doubled = ABS_FILE.replace(/\\/g, '\\\\');
    const outputLines = [
      `ABS_MARKER 中文路径：${ABS_FILE}`,
      `DOUBLE_MARKER 转义路径：${doubled}`,
      'REL_MARKER 相对路径：docs\\note.md',
      `URL_MARKER 长网址：${LONG_URL}`,
      'PTY_PATH_LINKS_DONE',
    ];
    const command = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); '
      + outputLines.map(line => `[Console]::WriteLine(${psQuote(line)})`).join('; ') + '\r';
    await client.eval(`(() => {
      require('electron').ipcRenderer.send('terminal-input', {
        sessionId: ${JSON.stringify(session.id)},
        data: ${JSON.stringify(command)}
      });
      return true;
    })()`);
    await waitFor(
      client,
      `window.__hubE2E.terminalBufferText(${JSON.stringify(session.id)}, 80).includes('PTY_PATH_LINKS_DONE')`,
      'path fixture output',
    );

    const lineNumbers = await client.eval(`(() => ({
      absolute: window.__hubE2E.terminalFindLastLine(${JSON.stringify(session.id)}, 'ABS_MARKER'),
      doubled: window.__hubE2E.terminalFindLastLine(${JSON.stringify(session.id)}, 'DOUBLE_MARKER'),
      relative: window.__hubE2E.terminalFindLastLine(${JSON.stringify(session.id)}, 'REL_MARKER'),
      url: window.__hubE2E.terminalFindLastLine(${JSON.stringify(session.id)}, 'URL_MARKER'),
    }))()`);
    result.lineNumbers = lineNumbers;
    assert.ok(Object.values(lineNumbers).every(value => value > 0), JSON.stringify(lineNumbers));

    async function readLinks(lineNumber) {
      return await client.eval(`window.__hubE2E.terminalLinks(
        ${JSON.stringify(session.id)}, ${Number(lineNumber)}
      )`);
    }
    result.links = {
      absolute: await readLinks(lineNumbers.absolute),
      doubled: await readLinks(lineNumbers.doubled),
      relative: await readLinks(lineNumbers.relative),
      url: await readLinks(lineNumbers.url),
    };
    result.bufferTail = await client.eval(
      `window.__hubE2E.terminalBufferText(${JSON.stringify(session.id)}, 30)`
    );
    const absoluteIndex = result.links.absolute.findIndex(link => link.text === ABS_FILE);
    const doubledIndex = result.links.doubled.findIndex(link => link.text === ABS_FILE);
    const relativeIndex = result.links.relative.findIndex(link => link.text === REL_FILE);
    const urlIndex = result.links.url.findIndex(link => link.text === LONG_URL);
    assert.ok(absoluteIndex >= 0, JSON.stringify({ links: result.links.absolute, bufferTail: result.bufferTail }));
    assert.ok(doubledIndex >= 0, JSON.stringify({ links: result.links.doubled, bufferTail: result.bufferTail }));
    assert.ok(relativeIndex >= 0, JSON.stringify({ links: result.links.relative, bufferTail: result.bufferTail }));
    assert.ok(urlIndex >= 0, JSON.stringify({ links: result.links.url, bufferTail: result.bufferTail }));
    assert.equal(
      result.links.absolute[absoluteIndex].range.start.x,
      terminalCellWidth('ABS_MARKER 中文路径：') + 1,
      'Chinese prefix glyphs must use their real xterm cell width',
    );

    result.geometry = await client.eval(`window.__hubE2E.terminalLinkGeometry(
      ${JSON.stringify(session.id)}, ${lineNumbers.absolute}, ${absoluteIndex}
    )`);
    assert.ok(result.geometry && result.geometry.row >= 0, JSON.stringify(result.geometry));
    await client.eval(`(() => {
      window.__ptyPhysicalEvents = [];
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        document.addEventListener(type, event => {
          window.__ptyPhysicalEvents.push({
            type,
            x:event.clientX,
            y:event.clientY,
            button:event.button,
            ctrlKey:event.ctrlKey,
            target:event.target && event.target.className || event.target && event.target.tagName || '',
          });
        }, { capture:true, once:true });
      }
    })()`);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: result.geometry.x,
      y: result.geometry.y,
      modifiers: 0,
    });
    await _waitMs(500);
    result.hitTest = await client.eval(`(() => {
      const target = document.elementFromPoint(${Number(result.geometry.x)}, ${Number(result.geometry.y)});
      const screen = document.querySelector('.xterm-screen');
      const xterm = document.querySelector('.xterm');
      return {
        tag:target && target.tagName || '',
        className:target && target.className || '',
        screenCursor:screen ? getComputedStyle(screen).cursor : '',
        xtermCursor:xterm ? getComputedStyle(xterm).cursor : '',
      };
    })()`);
    await capture(client, TERMINAL_SCREENSHOT);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: result.geometry.x,
      y: result.geometry.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: result.geometry.x,
      y: result.geometry.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      modifiers: 0,
    });
    await _waitMs(1200);
    result.physicalEvents = await client.eval(`window.__ptyPhysicalEvents || []`);
    result.activationStats = await client.eval(
      `window.__hubE2E.terminalLinkActivationStats(${JSON.stringify(session.id)})`
    );
    const physicalOpened = await client.eval(`document.getElementById('preview-panel')?.style.display === 'flex'
      && document.getElementById('preview-title')?.title === ${JSON.stringify(ABS_FILE)}`);
    assert.equal(physicalOpened, true, JSON.stringify({
      geometry: result.geometry,
      hitTest: result.hitTest,
      events: result.physicalEvents,
      activationStats: result.activationStats,
    }));
    assert.equal(result.activationStats.activations, 1, JSON.stringify(result.activationStats));
    result.physicalClick = await client.eval(`(() => ({
      display: document.getElementById('preview-panel').style.display,
      title: document.getElementById('preview-title').textContent,
      path: document.getElementById('preview-title').title,
      isFullscreen: window.__hubE2E.previewWorkbench.state().isFullscreen,
      fullPressed: document.getElementById('preview-layout-full').getAttribute('aria-pressed'),
      sourceDisplay: getComputedStyle(document.getElementById('terminal-panel')).display,
    }))()`);
    assert.deepEqual(result.physicalClick, {
      display: 'flex',
      title: path.basename(ABS_FILE),
      path: ABS_FILE,
      isFullscreen: true,
      fullPressed: 'true',
      sourceDisplay: 'none',
    });
    await capture(client, PREVIEW_SCREENSHOT);

    await client.eval(`document.getElementById('preview-close').click()`);
    await _waitMs(250);
    const relativeLineAfterRefit = await client.eval(
      `window.__hubE2E.terminalFindLastLine(${JSON.stringify(session.id)}, 'REL_MARKER')`
    );
    const relativeLinksAfterRefit = await readLinks(relativeLineAfterRefit);
    const relativeIndexAfterRefit = relativeLinksAfterRefit.findIndex(link => link.text === REL_FILE);
    assert.ok(relativeIndexAfterRefit >= 0, JSON.stringify(relativeLinksAfterRefit));
    result.relativeActivation = await client.eval(`window.__hubE2E.activateTerminalLink(
      ${JSON.stringify(session.id)}, ${relativeLineAfterRefit}, ${relativeIndexAfterRefit}
    )`);
    await waitFor(
      client,
      `document.getElementById('preview-title')?.title === ${JSON.stringify(REL_FILE)}`,
      'relative PTY link opens against session cwd',
    );
    assert.equal(result.relativeActivation.text, REL_FILE);

    await client.eval(`document.getElementById('preview-close').click()`);
    await _waitMs(250);
    const urlLineAfterRefit = await client.eval(
      `window.__hubE2E.terminalFindLastLine(${JSON.stringify(session.id)}, 'URL_MARKER')`
    );
    const urlLinksAfterRefit = await readLinks(urlLineAfterRefit);
    const urlIndexAfterRefit = urlLinksAfterRefit.findIndex(link => link.text === LONG_URL);
    assert.ok(urlIndexAfterRefit >= 0, JSON.stringify(urlLinksAfterRefit));
    result.urlGeometry = await client.eval(`window.__hubE2E.terminalLinkGeometry(
      ${JSON.stringify(session.id)}, ${urlLineAfterRefit}, ${urlIndexAfterRefit}
    )`);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: result.urlGeometry.x, y: result.urlGeometry.y, modifiers: 0,
    });
    await _waitMs(250);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: result.urlGeometry.x, y: result.urlGeometry.y,
      button: 'left', buttons: 1, clickCount: 1, modifiers: 0,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: result.urlGeometry.x, y: result.urlGeometry.y,
      button: 'left', buttons: 0, clickCount: 1, modifiers: 0,
    });
    await waitFor(
      client,
      `document.getElementById('preview-panel')?.style.display === 'flex'
        && document.getElementById('preview-title')?.title === ${JSON.stringify(LONG_URL)}`,
      'plain-click HTTP URL opens in Hub preview',
    );
    result.urlPlainClick = await client.eval(`(() => ({
      path: document.getElementById('preview-title')?.title || '',
      display: document.getElementById('preview-panel')?.style.display || '',
    }))()`);
    assert.deepEqual(result.urlPlainClick, { path: LONG_URL, display: 'flex' });

    await client.eval(`(() => {
      document.getElementById('preview-close').click();
      const textarea = document.querySelector('.xterm-helper-textarea');
      textarea.focus();
      return document.activeElement === textarea;
    })()`);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79,
    });
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'o', code: 'KeyO', modifiers: 2, windowsVirtualKeyCode: 79,
    });
    await waitFor(
      client,
      `document.getElementById('preview-quick-open').style.display === 'flex'
        && document.activeElement?.id === 'preview-quick-open-input'`,
      'Ctrl+O opens quick path from the focused xterm textarea',
    );
    result.ctrlOFromPty = await client.eval(`(() => ({
      overlay:document.getElementById('preview-quick-open').style.display,
      focused:document.activeElement?.id || '',
    }))()`);
    assert.deepEqual(result.ctrlOFromPty, { overlay:'flex', focused:'preview-quick-open-input' });
    await client.eval(`document.getElementById('preview-quick-open-close').click()`);

    result.terminalScreenshot = TERMINAL_SCREENSHOT;
    result.previewScreenshot = PREVIEW_SCREENSHOT;
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, resultPath: RESULT_PATH, ...result }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-80).join('\n'));
    process.exitCode = 1;
  } finally {
    if (client) { try { await client.close(); } catch {} }
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
        && path.basename(resolved).startsWith('hub-pty-local-path-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})();
