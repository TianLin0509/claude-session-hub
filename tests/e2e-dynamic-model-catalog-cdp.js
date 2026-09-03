'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-dynamic-model-catalog-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const CLAUDE_DIR = path.join(TEMP_ROOT, 'claude-config');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'model-catalog');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `dynamic-model-catalog-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `dynamic-model-catalog-${RUN_ID}.json`);

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
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch (_) {}
    await _waitMs(80);
  }
  throw new Error(`timeout waiting for ${expression}`);
}

function writeFixtures() {
  for (const directory of [DATA_DIR, CODEX_HOME, CLAUDE_DIR, ARTIFACT_DIR]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const ids = [
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
    'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark',
  ];
  const displayNames = {
    'gpt-5.6-sol': 'GPT-5.6-Sol',
    'gpt-5.6-terra': 'GPT-5.6-Terra',
    'gpt-5.6-luna': 'GPT-5.6-Luna',
    'gpt-5.5': 'GPT-5.5',
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.4-mini': 'GPT-5.4-Mini',
    'gpt-5.3-codex-spark': 'GPT-5.3-Codex-Spark',
  };
  fs.writeFileSync(path.join(CODEX_HOME, 'models_cache.json'), JSON.stringify({
    models: ids.map((slug, index) => ({
      slug,
      display_name: displayNames[slug],
      description: `fixture ${slug}`,
      visibility: 'list',
      priority: index + 1,
      default_reasoning_level: index < 3 ? 'low' : 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map(effort => ({ effort })),
    })),
  }), 'utf8');
  fs.writeFileSync(path.join(CLAUDE_DIR, '.claude.json'), JSON.stringify({
    additionalModelOptionsCache: [{
      value: 'claude-fable-5-1[1m]',
      label: 'Fable',
      description: 'Fable 5.1 · account-specific current option',
    }],
  }), 'utf8');
}

async function main() {
  writeFixtures();
  const port = await availablePort(Number(process.env.HUB_MODEL_CATALOG_E2E_PORT || 19960));
  const result = { runId: RUN_ID, port, screenshot: SCREENSHOT_PATH, resultPath: RESULT_PATH };
  let hub = null;
  let client = null;
  let failure = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'dynamic-model-catalog',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CODEX_HOME,
        CLAUDE_CONFIG_DIR: CLAUDE_DIR,
        DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1540, height: 960, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(client, `window.WorkspaceController && window.openMeetingCreateModal`);

    await client.eval(`window.WorkspaceController.openNewSessionModal({ kind:'claude' })`);
    await waitFor(client, `Array.from(document.querySelectorAll('#new-session-model option')).some(option => option.value === 'claude-fable-5-1[1m]')`);
    result.singleClaude = await client.eval(`Array.from(document.querySelectorAll('#new-session-model option')).map(option => ({ id:option.value, label:option.textContent }))`);
    assert.equal(result.singleClaude[0].id, 'claude-fable-5-1[1m]');
    assert.match(result.singleClaude[0].label, /Fable 5\.1/);

    await client.eval(`document.querySelector('.new-session-option[data-kind="codex"]').click()`);
    await waitFor(client, `document.querySelectorAll('#new-session-model option').length === 7`);
    result.singleCodex = await client.eval(`Array.from(document.querySelectorAll('#new-session-model option')).map(option => option.value)`);
    assert.deepEqual(result.singleCodex, [
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
      'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark',
    ]);
    await client.eval(`window.WorkspaceController.closeNewSessionModal()`);

    await client.eval(`window.openMeetingCreateModal('group')`);
    await waitFor(client, `document.querySelectorAll('#meeting-create-modal .mcm-slot').length === 2
      && Array.from(document.querySelectorAll('#meeting-create-modal .mcm-slot')[1].querySelectorAll('.mcm-model-select option')).some(option => option.value === 'gpt-5.6-terra')`);
    result.group = await client.eval(`(() => {
      const slots = Array.from(document.querySelectorAll('#meeting-create-modal .mcm-slot'));
      return slots.map(slot => ({
        kind:slot.querySelector('.mcm-ai-select').value,
        models:Array.from(slot.querySelectorAll('.mcm-model-select option')).map(option => option.value),
      }));
    })()`);
    assert.ok(result.group[0].models.includes('claude-fable-5-1[1m]'));
    assert.ok(result.group[1].models.includes('gpt-5.6-terra'));
    result.selectedForScreenshot = await client.eval(`(() => {
      let slots = Array.from(document.querySelectorAll('#meeting-create-modal .mcm-slot'));
      const claudeModel = slots[0].querySelector('.mcm-model-select');
      claudeModel.value = 'claude-fable-5-1[1m]';
      claudeModel.dispatchEvent(new Event('change', { bubbles:true }));
      slots = Array.from(document.querySelectorAll('#meeting-create-modal .mcm-slot'));
      const codexModel = slots[1].querySelector('.mcm-model-select');
      codexModel.value = 'gpt-5.6-terra';
      codexModel.dispatchEvent(new Event('change', { bubbles:true }));
      slots = Array.from(document.querySelectorAll('#meeting-create-modal .mcm-slot'));
      return slots.map(slot => ({
        kind:slot.querySelector('.mcm-ai-select').value,
        model:slot.querySelector('.mcm-model-select').value,
        label:slot.querySelector('.mcm-model-select option:checked')?.textContent || '',
      }));
    })()`);
    assert.equal(result.selectedForScreenshot[0].model, 'claude-fable-5-1[1m]');
    assert.equal(result.selectedForScreenshot[1].model, 'gpt-5.6-terra');

    await _waitMs(200);
    const shot = await client.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    result.success = true;
  } catch (error) {
    failure = error;
    if (hub) console.error('[isolated hub log]\n' + hub.log().slice(-80).join('\n'));
  } finally {
    try {
      if (client) await client.close().catch(() => {});
      if (hub) {
        try { result.teardown = await gracefulQuit(hub); }
        catch (error) { if (!failure) failure = error; }
      }
    } finally {
      const resolved = path.resolve(TEMP_ROOT);
      if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
          && path.basename(resolved).startsWith('hub-dynamic-model-catalog-')) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
  if (failure) throw failure;
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
