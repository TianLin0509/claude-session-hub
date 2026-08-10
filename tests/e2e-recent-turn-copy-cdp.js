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
const TEMP_ROOT = path.join(os.tmpdir(), `hub-recent-turn-copy-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const TRANSCRIPT_PATH = path.join(TEMP_ROOT, 'recent-turn-copy.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'recent-turn-copy');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `recent-turn-copy-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `result-${RUN_ID}.json`);

function jsonl(value) {
  return JSON.stringify(value) + '\n';
}

function writeTranscript() {
  const lines = [];
  const base = Date.now() - 60000;
  for (let i = 1; i <= 4; i += 1) {
    lines.push(jsonl({
      type: 'user', uuid: `recent-u-${i}`, timestamp: new Date(base + i * 2000).toISOString(),
      message: { content: `轮次复制问题 ${i}` },
    }));
    const answer = i === 4
      ? '第四轮可见回答。\n\n```bash\necho RECENT_COPY_VISIBLE_COMMAND\n```\n\n回答结尾。'
      : `轮次复制回答 ${i}`;
    lines.push(jsonl({
      type: 'assistant', uuid: `recent-a-${i}`, timestamp: new Date(base + i * 2000 + 900).toISOString(),
      message: {
        model: 'claude-opus-4-7', stop_reason: 'end_turn',
        content: [{ type: 'text', text: answer }],
      },
    }));
  }
  // This card is visible but incomplete and must never be counted as a round.
  lines.push(jsonl({
    type: 'user', uuid: 'recent-u-5', timestamp: new Date(base + 12000).toISOString(),
    message: { content: '尚未回答的第五轮问题' },
  }));
  fs.writeFileSync(TRANSCRIPT_PATH, lines.join(''), 'utf8');
}

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

async function waitForEval(client, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeTranscript();
  const port = await availablePort(Number(process.env.HUB_RECENT_TURN_COPY_E2E_PORT || 19820));
  let hub = null;
  let client = null;
  const result = { runId: RUN_ID, port };

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'recent-turn-copy',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1500, height: 940, deviceScaleFactor: 1, mobile: false,
    });
    await waitForEval(client, 'window.__hubE2E && window._loadSessionHistoryToOverlay', 'Hub E2E card APIs');

    result.copy = await client.eval(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      window.__recentCopiedText = '';
      try {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: async text => { window.__recentCopiedText = String(text || ''); },
        });
      } catch {
        navigator.clipboard.writeText = async text => { window.__recentCopiedText = String(text || ''); };
      }

      const sid = 'recent-turn-copy-session';
      window.__hubE2E.addFakeSession({
        id: sid,
        kind: 'claude',
        title: '近 N 轮纯文本复制验收',
        status: 'idle',
        transcriptPath: ${JSON.stringify(TRANSCRIPT_PATH)},
        createdAt: Date.now(),
        lastMessageTime: Date.now(),
      });
      applyViewMode('card');
      await window.__hubE2E.selectSession(sid, { forceScrollBottom: true });
      const overlay = document.getElementById('msg-overlay');
      for (let i = 0; i < 80 && overlay.querySelectorAll(':scope > .turn-card').length < 9; i += 1) await wait(100);

      const toolbar = document.getElementById('recent-turn-copy');
      const select = document.getElementById('recent-turn-copy-count');
      const button = document.getElementById('recent-turn-copy-button');
      select.value = '3';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      button.click();
      for (let i = 0; i < 30 && !window.__recentCopiedText; i += 1) await wait(50);
      await wait(50);
      const three = window.__recentCopiedText;
      const threeButtonText = button.textContent;
      const rect = toolbar.getBoundingClientRect();

      window.__recentCopiedText = '';
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      button.click();
      for (let i = 0; i < 30 && !window.__recentCopiedText; i += 1) await wait(50);
      const one = window.__recentCopiedText;

      applyViewMode('pty');
      const hiddenInPty = toolbar.hidden || getComputedStyle(toolbar).display === 'none';
      applyViewMode('card');
      select.value = '3';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      window.__recentCopiedText = '';
      button.click();
      await wait(80);

      return {
        cardCount: overlay.querySelectorAll(':scope > .turn-card').length,
        toolbar: {
          visible: !toolbar.hidden && rect.width > 0 && rect.height > 0,
          x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
          buttonText: threeButtonText,
          hiddenInPty,
        },
        three,
        one,
      };
    })()`);

    assert.equal(result.copy.cardCount, 9, JSON.stringify(result.copy));
    assert.equal(result.copy.toolbar.visible, true, JSON.stringify(result.copy.toolbar));
    assert.equal(result.copy.toolbar.hiddenInPty, true, JSON.stringify(result.copy.toolbar));
    assert.match(result.copy.toolbar.buttonText, /已复制 3 轮/);
    assert.match(result.copy.three, /轮次复制问题 2[\s\S]*轮次复制回答 2/);
    assert.match(result.copy.three, /轮次复制问题 3[\s\S]*轮次复制回答 3/);
    assert.match(result.copy.three, /轮次复制问题 4[\s\S]*RECENT_COPY_VISIBLE_COMMAND/);
    assert.doesNotMatch(result.copy.three, /轮次复制问题 1|尚未回答的第五轮问题/);
    assert.match(result.copy.three, /我：/);
    assert.match(result.copy.three, /AI（Claude · claude-opus-4-7）：/);
    assert.equal((result.copy.three.match(/===== 第 \d+ 轮 =====/g) || []).length, 3);
    assert.doesNotMatch(result.copy.three, /```|📋|复制对话|展开/);
    assert.match(result.copy.one, /轮次复制问题 4[\s\S]*第四轮可见回答/);
    assert.doesNotMatch(result.copy.one, /轮次复制问题 [123]|第五轮/);

    await screenshot(client, SCREENSHOT_PATH);
    result.screenshot = SCREENSHOT_PATH;
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(TEMP_ROOT);
    const tempBase = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.startsWith(tempBase) && path.basename(resolved).startsWith('hub-recent-turn-copy-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
