'use strict';

// Real end-to-end acceptance for the one-click company -> Hub path:
// separate ChatGPT browser context -> fixed relay conversation -> bridge pull
// button -> isolated Hub -> real Codex PTY -> exact ACK. Production Hub state and
// processes are never touched.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const execFile = promisify(execFileCallback);
const HUB_ROOT = path.resolve(__dirname, '..');
const BRIDGE_CONFIG = path.join('C:\\VibeData', 'ChatGPTBridge', 'config.json');
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', 'chatgpt-bridge-real-pull');
const PYTHON = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Programs', 'Python', 'Python312', 'python.exe');
const BRIDGE = path.join(os.homedir(), 'tools', 'chatgpt_bridge', 'bridge.py');
const NPX = process.platform === 'win32'
  ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
  : 'npx';
const COMPANY_SESSION = 'chatgpt-company-sim';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function parseLastJson(text) {
  const raw = String(text || '').trim();
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  throw new Error(`No JSON envelope in output: ${String(text || '').slice(-1200)}`);
}

async function runBridge(args, timeout = 240000) {
  const result = await execFile(PYTHON, [BRIDGE, ...args], {
    cwd: HUB_ROOT,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = parseLastJson(result.stdout);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return parsed;
}

async function runPlaywrightCode(session, source, timeout = 240000) {
  const script = path.join(os.tmpdir(), `chatgpt-bridge-real-pull-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(script, source, 'utf8');
  try {
    const executable = process.platform === 'win32' ? process.execPath : NPX;
    const prefix = process.platform === 'win32' ? [NPX] : [];
    let result;
    try {
      result = await execFile(executable, [...prefix,
        '--yes', '--package', '@playwright/cli', 'playwright-cli',
        '--session', session, '--json', 'run-code', '--filename', script,
      ], {
        cwd: HUB_ROOT,
        encoding: 'utf8',
        timeout,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      });
    } catch (error) {
      throw new Error(`playwright-cli failed: ${String(error && error.message || error)}\n`
        + `stdout=${String(error && error.stdout || '').slice(-4000)}\n`
        + `stderr=${String(error && error.stderr || '').slice(-4000)}`);
    }
    const envelope = parseLastJson(result.stdout);
    const value = envelope && envelope.result;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } finally {
    fs.rmSync(script, { force: true });
  }
}

async function companySend(url, prompt, screenshotPath) {
  const source = `async (page) => {
    const targetUrl = ${JSON.stringify(url)};
    const payload = ${JSON.stringify(prompt)};
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const rateModal = page.locator('[data-testid="modal-conversation-history-rate-limit"]');
    if (await rateModal.count() && await rateModal.isVisible().catch(() => false)) {
      const value = await rateModal.innerText().catch(() => 'Too many requests');
      await rateModal.getByRole('button', { name: 'Got it' }).click({ force: true }).catch(() => {});
      throw new Error('CHATGPT_RATE_LIMIT: ' + value);
    }
    const selector = '[data-testid^="conversation-turn-"] [data-message-author-role="user"]';
    await page.waitForSelector(selector, { timeout: 30000 });
    const before = await page.locator(selector).evaluateAll(nodes => nodes.map(node =>
      node.getAttribute('data-message-id') || node.closest('[data-turn-id]')?.getAttribute('data-turn-id') || ''
    ).filter(Boolean));
    const box = page.getByRole('textbox', { name: /Chat with ChatGPT|Message ChatGPT/ }).last();
    await box.waitFor({ state: 'visible', timeout: 30000 });
    const editableDeadline = Date.now() + 120000;
    while (!(await box.isEditable().catch(() => false)) && Date.now() < editableDeadline) {
      await page.waitForTimeout(500);
    }
    if (!(await box.isEditable().catch(() => false))) throw new Error('composer-not-editable');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://chatgpt.com' }).catch(() => {});
    const oldClipboard = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    await box.fill('');
    await box.click();
    await page.evaluate(value => navigator.clipboard.writeText(value), payload);
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(1200);
    await page.evaluate(value => navigator.clipboard.writeText(value), oldClipboard).catch(() => {});
    const send = page.getByRole('button', { name: /^(Send prompt|Send message)$/ }).last();
    await send.waitFor({ state: 'visible', timeout: 60000 });
    await send.click();
    await page.waitForFunction(existing => Array.from(document.querySelectorAll(
      '[data-testid^="conversation-turn-"] [data-message-author-role="user"]'
    )).some(node => {
      const id = node.getAttribute('data-message-id') || node.closest('[data-turn-id]')?.getAttribute('data-turn-id') || '';
      return id && !existing.includes(id);
    }), before, { timeout: 30000 });
    const ids = await page.locator(selector).evaluateAll(nodes => nodes.map(node =>
      node.getAttribute('data-message-id') || node.closest('[data-turn-id]')?.getAttribute('data-turn-id') || ''
    ).filter(Boolean));
    const messageId = ids.filter(id => !before.includes(id)).at(-1) || '';
    await page.screenshot({ path: ${JSON.stringify(screenshotPath)}, fullPage: false });
    return { messageId, url: page.url(), title: await page.title() };
  }`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try { return await runPlaywrightCode(COMPANY_SESSION, source); } catch (error) {
      if (!/RATE_LIMIT|Too many requests|modal-conversation-history-rate-limit/.test(String(error)) || attempt === 4) throw error;
      await _waitMs(60000);
    }
  }
  throw new Error('unreachable');
}

async function waitFor(client, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await client.eval(expression, { awaitPromise: true });
      if (value) return value;
    } catch (error) { lastError = error; }
    await _waitMs(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function capture(client, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const target = path.join(OUTPUT, name);
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
  return target;
}

function safeRemove(root) {
  const resolved = path.resolve(root);
  const temp = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.toLowerCase().startsWith(temp.toLowerCase())
      && path.basename(resolved).startsWith('chatgpt-bridge-real-pull-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  assert.equal(fs.existsSync(BRIDGE_CONFIG), true, `missing ${BRIDGE_CONFIG}`);
  assert.equal(fs.existsSync(BRIDGE), true, `missing ${BRIDGE}`);
  const config = JSON.parse(fs.readFileSync(BRIDGE_CONFIG, 'utf8'));
  const token = crypto.randomBytes(6).toString('hex');
  const marker = `BRIDGE_ONE_CLICK_PULL_${token}`;
  const ack = `PULL_ACK_${token}`;
  const prompt = `${marker}\n这是自动桥接验收指令。请只回复：${ack}`;
  const tempRoot = path.join(os.tmpdir(), `chatgpt-bridge-real-pull-${process.pid}-${Date.now()}`);
  const dataDir = path.join(tempRoot, 'hub-data');
  const workDir = path.join(tempRoot, 'workspace');
  fs.mkdirSync(workDir, { recursive: true });

  // Establish a clean cursor immediately before the company-side test message.
  const drained = await runBridge(['pull']);
  const companyScreenshot = path.join(OUTPUT, '01-company-one-click-source.png');
  const company = await companySend(config.conversation_url, prompt, companyScreenshot);
  assert.match(company.messageId, /^[0-9a-f-]{20,}$/i);

  const port = await freePort();
  let hub = null;
  let client = null;
  const startedAt = Date.now();
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'chatgpt-bridge-real-pull',
      windowMode: 'hidden',
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(client, `document.getElementById('chatgpt-bridge-pull')`, 'bridge toolbar');

    const session = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
      kind: 'codex',
      opts: {
        title: 'ChatGPT 一键拉取真实验收',
        cwd: ${JSON.stringify(workDir)},
        model: 'gpt-5.6-sol',
        effort: 'max',
        mcpProfile: 'none',
        codexSpeedTier: 'fast',
        contextMax: 1000000
      }
    })`, { awaitPromise: true });
    assert.ok(session && session.id, `create-session failed: ${JSON.stringify(session)}`);
    await waitFor(client,
      `activeSessionId === ${JSON.stringify(session.id)} && sessions.has(${JSON.stringify(session.id)})`,
      'active real Codex session', 45000);
    await waitFor(client,
      `document.querySelector('.terminal-title') && document.querySelector('.terminal-title').textContent.includes('ChatGPT 一键拉取真实验收')`,
      'session title', 30000);
    const beforeScreenshot = await capture(client, '02-hub-before-one-click-pull.png');

    await client.eval(`document.getElementById('chatgpt-bridge-pull').click()`);
    const toast = await waitFor(client, `(() => {
      const el = document.getElementById('chatgpt-bridge-status');
      return el && el.dataset.state === 'success' && /已拉取并发送给当前 AI/.test(el.textContent)
        ? { state: el.dataset.state, text: el.textContent } : null;
    })()`, 'one-click pull success toast', 240000);
    const pulledScreenshot = await capture(client, '03-hub-one-click-pull-success.png');

    const response = await waitFor(client, `(() => {
      const expected = ${JSON.stringify(ack)};
      const cards = Array.from(document.querySelectorAll('#msg-overlay .turn-card')).map(card => card.innerText || '');
      if (cards.some(text => text.includes(expected))) return { source: 'card', cards };
      const cached = terminalCache.get(${JSON.stringify(session.id)});
      const buffer = cached && cached.terminal && cached.terminal.buffer && cached.terminal.buffer.active;
      if (!buffer) return null;
      const lines = [];
      for (let index = 0; index < buffer.length; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) || '');
      }
      const text = lines.join('\\n');
      return text.includes(expected) ? { source: 'pty', text: text.slice(-12000) } : null;
    })()`, 'exact Codex ACK', 12 * 60 * 1000);

    await client.eval(`document.querySelector('.view-toggle-btn[data-view="card"]')?.click()`);
    await waitFor(client, `document.getElementById('terminal-panel').classList.contains('card-view-active')`, 'card view', 30000);
    await _waitMs(1500);
    const ackScreenshot = await capture(client, '04-hub-real-codex-ack.png');
    const finishedAt = Date.now();
    const summary = {
      ok: true,
      marker,
      ack,
      companyMessageId: company.messageId,
      sessionId: session.id,
      model: session.currentModel && session.currentModel.id || session.model || 'gpt-5.6-sol',
      responseSource: response.source,
      preflightDrainedCount: drained.count || 0,
      pullToast: toast,
      elapsedMs: finishedAt - startedAt,
      isolatedHub: { pid: hub.pid, cdpPort: hub.port, dataDir },
      screenshots: { companyScreenshot, beforeScreenshot, pulledScreenshot, ackScreenshot },
      hubLogTail: hub.log().slice(-30),
      finishedAt: new Date(finishedAt).toISOString(),
    };
    fs.writeFileSync(path.join(OUTPUT, 'real-pull-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
    safeRemove(tempRoot);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
