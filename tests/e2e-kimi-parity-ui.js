'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'artifacts');
const USAGE_SHOT = path.join(ARTIFACT_DIR, 'kimi-parity-usage.png');
const CARD_SHOT = path.join(ARTIFACT_DIR, 'kimi-parity-card.png');
const GROUP_SHOT = path.join(ARTIFACT_DIR, 'kimi-parity-group.png');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(client, expression, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await client.eval(expression)) return;
    } catch (error) {
      lastError = error;
    }
    await _waitMs(250);
  }
  throw new Error(`Timed out waiting for: ${expression}${lastError ? `\nLast error: ${lastError.message}` : ''}`);
}

async function screenshot(client, targetPath, selector = null) {
  let clip;
  if (selector) {
    clip = await client.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.max(1, r.width + 16), height: Math.max(1, r.height + 16), scale: 1 };
    })()`);
  }
  const result = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: !!clip,
    ...(clip ? { clip } : {}),
  });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(result.data, 'base64'));
}

function copyKimiAuth(sourceHome, targetHome) {
  const required = ['config.toml', 'device_id', 'kimi-code.json'];
  fs.mkdirSync(targetHome, { recursive: true });
  for (const name of required) {
    const source = path.join(sourceHome, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(targetHome, name));
  }
  const credentialSource = path.join(sourceHome, 'credentials', 'kimi-code.json');
  if (!fs.existsSync(credentialSource)) throw new Error('Kimi Code credentials not found; run kimi /login first');
  const credentials = JSON.parse(fs.readFileSync(credentialSource, 'utf8'));
  const expiresRaw = Number(credentials.expires_at) || 0;
  const expiresAt = expiresRaw > 0 && expiresRaw < 1e12 ? expiresRaw * 1000 : expiresRaw;
  if (!expiresAt || expiresAt - Date.now() < 5 * 60 * 1000) {
    throw new Error('Kimi access token is too close to expiry for safe auth-copy E2E; refresh the real CLI login first');
  }
  const credentialTargetDir = path.join(targetHome, 'credentials');
  fs.mkdirSync(credentialTargetDir, { recursive: true });
  fs.copyFileSync(credentialSource, path.join(credentialTargetDir, 'kimi-code.json'));
}

async function run() {
  const sourceKimiHome = path.join(os.homedir(), '.kimi-code');
  const kimiBin = path.join(sourceKimiHome, 'bin', 'kimi.exe');
  if (!fs.existsSync(kimiBin)) throw new Error(`Kimi Code CLI not found: ${kimiBin}`);

  const dataDir = path.join(os.tmpdir(), `claude-session-hub-kimi-parity-${process.pid}-${Date.now()}`);
  const kimiHome = path.join(dataDir, 'kimi-home');
  const port = await getFreePort();
  let hub = null;
  let cdp = null;

  copyKimiAuth(sourceKimiHome, kimiHome);
  try {
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'kimi-parity-ui-e2e',
      extraEnv: {
        KIMI_CODE_HOME: kimiHome,
        KIMI_CODE_BIN: kimiBin,
      },
    });
    cdp = await connectFirstPage(
      hub,
      (target) => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url),
    );
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(cdp, `document.readyState === 'complete' && document.querySelectorAll('.acc-usage-row').length === 3`);
    await waitFor(cdp, `(() => {
      const row = [...document.querySelectorAll('.acc-usage-row')].find(el => el.querySelector('.acc-provider-name')?.textContent.includes('Kimi'));
      return !!row && [...row.querySelectorAll('.acc-window-value')].some(el => /\\d+%/.test(el.textContent));
    })()`, 30000);

    const usageState = await cdp.eval(`(() => ({
      providers: [...document.querySelectorAll('.acc-provider-name')].map(el => el.childNodes[0].textContent.trim()),
      rows: [...document.querySelectorAll('.acc-usage-row')].map(row => row.innerText.replace(/\\s+/g, ' ').trim()),
      refreshActions: document.querySelectorAll('[data-action="refresh-usage"]').length,
      decorativeBars: document.querySelectorAll('.acc-bar-track').length,
      providerLogos: document.querySelectorAll('.acc-ai-logo').length,
    }))()`);
    assert.deepStrictEqual(usageState.providers, ['Claude', 'Codex', 'Kimi']);
    assert.strictEqual(usageState.refreshActions, 1);
    assert.strictEqual(usageState.decorativeBars, 0);
    assert.strictEqual(usageState.providerLogos, 0);
    assert.ok(usageState.rows[2].includes('5h') && usageState.rows[2].includes('周'));
    await screenshot(cdp, USAGE_SHOT, '#account-usage');

    await cdp.eval(`(() => {
      document.getElementById('btn-new').click();
      document.querySelector('.new-session-option[data-kind="kimi"]').click();
      return true;
    })()`);
    await waitFor(cdp, `(async () => {
      const sessions = await require('electron').ipcRenderer.invoke('get-sessions');
      return sessions.some(s => s.kind === 'kimi' && !s.meetingId && s.kimiSid && s.transcriptPath);
    })()`, 30000);
    await cdp.eval(`document.querySelector('.view-toggle-btn[data-view="card"]').click()`);
    await waitFor(cdp, `document.querySelector('.floating-input-box') && !document.getElementById('msg-overlay').classList.contains('hidden')`);
    await cdp.eval(`(() => {
      const input = document.querySelector('.floating-input-box');
      input.textContent = '只回复 KIMI_CARD_E2E_OK';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.textContent }));
      document.querySelector('.floating-input-send').click();
      return true;
    })()`);
    await waitFor(cdp, `document.getElementById('msg-overlay').innerText.includes('KIMI_CARD_E2E_OK')`, 120000);
    await waitFor(cdp, `document.querySelector('#msg-overlay .turn-card:not(.user) .pill-token') && document.querySelector('#msg-overlay .turn-card:not(.user) .pill-ctx')`, 30000);
    try {
      await waitFor(cdp, `document.querySelector('#session-list .ctx-badge')`, 30000);
    } catch (error) {
      const contextDebug = await cdp.eval(`(async () => {
        const ipc = require('electron').ipcRenderer;
        const all = await ipc.invoke('get-sessions');
        const session = all.find(s => s.kind === 'kimi' && !s.meetingId);
        const buffer = session ? await ipc.invoke('debug:get-session-buffer', session.id) : '';
        return {
          session: session ? { id: session.id, kind: session.kind, currentModel: session.currentModel, contextPct: session.contextPct, contextUsed: session.contextUsed, contextMax: session.contextMax } : null,
          bufferTail: String(buffer || '').slice(-2500),
          sidebarText: document.getElementById('session-list')?.innerText || '',
        };
      })()`);
      throw new Error(`${error.message}\nKimi context debug: ${JSON.stringify(contextDebug)}`);
    }

    const cardState = await cdp.eval(`(() => {
      const card = [...document.querySelectorAll('#msg-overlay .turn-card:not(.user)')].find(el => el.innerText.includes('KIMI_CARD_E2E_OK'));
      const avatar = card && card.querySelector('.turn-avatar img');
      return {
        found: !!card,
        avatar: avatar && avatar.getAttribute('src'),
        token: card && card.querySelector('.pill-token')?.textContent.trim(),
        context: card && card.querySelector('.pill-ctx')?.textContent.trim(),
        model: card && card.querySelector('.turn-who')?.textContent.trim(),
        sidebarContext: document.querySelector('#session-list .ctx-badge')?.textContent.trim(),
      };
    })()`);
    assert.strictEqual(cardState.found, true);
    assert.ok(cardState.avatar && cardState.avatar.endsWith('kimi.svg'));
    assert.ok(cardState.token && cardState.context);
    assert.ok(cardState.model && cardState.model.toLowerCase().includes('k3'));
    assert.ok(/^Ctx\s+[\d.]+%$/.test(cardState.sidebarContext));
    await screenshot(cdp, CARD_SHOT, '.terminal-panel');

    await cdp.eval(`(() => {
      window.LaunchCenter.open('group');
      document.getElementById('launch-center-configure-group').click();
    })()`);
    await waitFor(cdp, `document.getElementById('meeting-create-modal')?.style.display === 'flex'`);
    await cdp.eval(`(() => {
      let slots = [...document.querySelectorAll('#meeting-create-modal .mcm-slot')];
      for (const slot of slots.slice(0, 2)) {
        const select = slot.querySelector('.mcm-ai-select');
        select.value = 'kimi';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('[data-remove-member="2"]').click();
      document.getElementById('mcm-title-input').value = 'Kimi 体验一致性验证';
      document.querySelector('#meeting-create-modal .mcm-create').click();
      return true;
    })()`);
    await waitFor(cdp, `document.getElementById('meeting-create-modal').style.display === 'none'`, 30000);
    await waitFor(cdp, `document.querySelectorAll('.mr-gc-member').length === 2`, 30000);
    await waitFor(cdp, `[...document.querySelectorAll('.mr-gc-member-ctx')].every(el => !el.textContent.includes('--'))`, 30000);

    const memberState = await cdp.eval(`(() => ({
      rows: [...document.querySelectorAll('.mr-gc-member')].map(row => {
        const rr = row.getBoundingClientRect();
        const logo = row.querySelector('.mr-gc-member-logo')?.getBoundingClientRect();
        const img = row.querySelector('.mr-gc-member-logo img')?.getBoundingClientRect();
        return { height: rr.height, logoWidth: logo?.width || 0, logoHeight: logo?.height || 0, imgWidth: img?.width || 0, imgHeight: img?.height || 0, text: row.innerText.replace(/\\s+/g, ' ').trim() };
      }),
    }))()`);
    assert.strictEqual(memberState.rows.length, 2);
    assert.ok(memberState.rows.every(row => row.height >= 40 && row.height <= 64));
    assert.ok(memberState.rows.every(row => row.logoWidth === 32 && row.logoHeight === 32));
    assert.ok(memberState.rows.every(row => row.imgWidth <= 30 && row.imgHeight <= 30));

    await cdp.eval(`(() => {
      window.__kimiGroupE2E = { done: false, result: null, error: null };
      const ipc = require('electron').ipcRenderer;
      Promise.all([ipc.invoke('get-meetings'), ipc.invoke('get-sessions')]).then(([meetings]) => {
        const meeting = meetings.find(m => m.title === 'Kimi 体验一致性验证');
        return ipc.invoke('groupchat:turn', {
          meetingId: meeting.id,
          userInput: '只回复 KIMI_GROUP_E2E_OK',
          targetMemberIds: ['m1'],
        });
      }).then(result => { window.__kimiGroupE2E = { done: true, result, error: null }; })
        .catch(error => { window.__kimiGroupE2E = { done: true, result: null, error: error.message }; });
      return true;
    })()`);
    await waitFor(cdp, `window.__kimiGroupE2E && window.__kimiGroupE2E.done === true`, 120000);
    const groupResult = await cdp.eval(`window.__kimiGroupE2E`);
    assert.ifError(groupResult.error ? new Error(groupResult.error) : null);
    assert.strictEqual(groupResult.result.status, 'completed');
    assert.ok(groupResult.result.results.some(item => String(item.text || '').includes('KIMI_GROUP_E2E_OK')));
    await waitFor(cdp, `document.getElementById('meeting-room-panel').innerText.includes('KIMI_GROUP_E2E_OK')`, 30000);
    await screenshot(cdp, GROUP_SHOT, '#meeting-room-panel');

    console.log(JSON.stringify({
      ok: true,
      usageState,
      cardState,
      memberState,
      groupStatus: groupResult.result.status,
      screenshots: [USAGE_SHOT, CARD_SHOT, GROUP_SHOT],
      hubLogTail: hub.log().slice(-30),
    }, null, 2));
  } finally {
    if (cdp) await cdp.close();
    if (hub) await gracefulQuit(hub);
    const resolved = path.resolve(dataDir);
    const tempRoot = path.resolve(os.tmpdir());
    if (resolved.toLowerCase().startsWith((tempRoot + path.sep).toLowerCase())) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
