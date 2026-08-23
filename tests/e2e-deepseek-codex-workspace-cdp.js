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
const TEMP_ROOT = path.join(os.tmpdir(), `hub-deepseek-codex-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const INVOCATION_LOG = path.join(TEMP_ROOT, 'invocations.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'deepseek-codex-workspace');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `v4-pro-new-session-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `v4-pro-result-${RUN_ID}.json`);

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

async function waitFor(label, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await _waitMs(120);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

function writeFixtures() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  for (const directory of ['AI', 'Wireless', 'Stock']) {
    fs.mkdirSync(path.join(WORKSPACE_ROOT, directory), { recursive: true });
  }

  const fake = path.join(FAKE_BIN, 'fake-cli.js');
  fs.writeFileSync(fake, `'use strict';
const fs = require('node:fs');
const provider = process.argv[2];
fs.appendFileSync(process.env.HUB_DEEPSEEK_E2E_LOG, JSON.stringify({
  provider,
  cwd: process.cwd(),
  args: process.argv.slice(3),
  codexHome: process.env.CODEX_HOME || null,
  hasDeepSeekKey: !!process.env.DEEPSEEK_API_KEY,
  hasAnthropicBase: !!process.env.ANTHROPIC_BASE_URL,
}) + '\\n');
process.stdout.write('FAKE_CLI_READY ' + provider + '\\r\\n');
setInterval(() => {}, 1000);
`, 'utf8');
  for (const provider of ['claude', 'codex']) {
    fs.writeFileSync(path.join(FAKE_BIN, `${provider}.cmd`), `@echo off\r\n"${process.execPath}" "${fake}" ${provider} %*\r\n`, 'utf8');
  }
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      deepseek: { api_key: 'e2e-deepseek-key-not-secret' },
    },
  }, null, 2), 'utf8');
}

function readInvocations() {
  try {
    return fs.readFileSync(INVOCATION_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch { return []; }
}

async function main() {
  writeFixtures();
  const port = await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'deepseek-codex-workspace',
      extraEnv: {
        AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
        DEEPSEEK_API_KEY: '',
        HUB_DEEPSEEK_E2E_LOG: INVOCATION_LOG,
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await waitFor('Hub session UI', () => client.eval(
      'Boolean(window.WorkspaceController && typeof window.WorkspaceController.openNewSessionModal === "function"'
        + ' && document.getElementById("btn-new")'
        + ' && document.querySelector(".new-session-option[data-kind=deepseek]"))',
    ));
    await client.eval(`(() => {
      window.__deepseekE2eErrors = [];
      window.addEventListener('error', event => window.__deepseekE2eErrors.push(String(event.error || event.message || 'renderer error')));
      window.addEventListener('unhandledrejection', event => window.__deepseekE2eErrors.push(String(event.reason || 'unhandled rejection')));
      return true;
    })()`);

    await client.eval(`window.WorkspaceController.openNewSessionModal()`);
    await waitFor('new-session workspace choices', () => client.eval(`(() => {
      const choice = document.querySelector('.session-workspace-choice[data-workspace-mode="existing"]');
      if (!choice) return false;
      const rect = choice.getBoundingClientRect();
      return getComputedStyle(choice).display !== 'none' && rect.width > 0 && rect.height > 0;
    })()`));
    await client.eval(`document.querySelector('.session-workspace-choice[data-workspace-mode="existing"]').click()`);

    const recommended = await waitFor('recommended workspace cards', () => client.eval(`(() => {
      const modal = document.querySelector('#new-session-menu');
      const items = [...document.querySelectorAll('[data-recommended-path]')].map(item => ({
        label: item.querySelector('strong')?.textContent || '',
        description: item.querySelector('span')?.textContent || '',
        path: item.dataset.recommendedPath,
      }));
      if (!modal || modal.style.display === 'none' || items.length !== 3) return null;
      return { items, summary: document.querySelector('#new-session-summary')?.textContent || '' };
    })()`));
    assert.deepStrictEqual(recommended.items.map(item => item.label), ['AI', 'Wireless', '投研']);
    assert.deepStrictEqual(recommended.items.map(item => item.path), [
      path.join(WORKSPACE_ROOT, 'AI'),
      path.join(WORKSPACE_ROOT, 'Wireless'),
      path.join(WORKSPACE_ROOT, 'Stock'),
    ]);

    await client.eval(`document.querySelector('[data-recommended-path]:nth-child(3)').click()`);
    await client.eval(`document.querySelector('.new-session-option[data-kind="deepseek"]').click()`);
    await client.eval(`(() => {
      const select = document.querySelector('#new-session-model');
      if (!select || ![...select.options].some(option => option.value === 'deepseek-v4-pro')) {
        throw new Error('DeepSeek V4 Pro option missing');
      }
      select.value = 'deepseek-v4-pro';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const selected = await client.eval(`(() => ({
      workspace: document.querySelector('[data-recommended-path].selected')?.dataset.recommendedPath || null,
      kind: document.querySelector('.new-session-option.selected')?.dataset.kind || null,
      model: document.querySelector('#new-session-model')?.value || null,
      modelLabel: document.querySelector('#new-session-model option:checked')?.textContent || null,
      summary: document.querySelector('#new-session-summary')?.textContent || '',
      errors: window.__deepseekE2eErrors || [],
    }))()`);
    assert.strictEqual(selected.workspace, path.join(WORKSPACE_ROOT, 'Stock'));
    assert.strictEqual(selected.kind, 'deepseek');
    assert.strictEqual(selected.model, 'deepseek-v4-pro');
    assert.match(selected.modelLabel, /Codex/);
    assert.match(selected.summary, /DeepSeek/);
    assert.deepStrictEqual(selected.errors, []);
    await screenshot(client, SCREENSHOT_PATH);

    await client.eval(`document.getElementById('new-session-submit').click()`);
    const session = await waitFor('DeepSeek session', () => client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const session = (await ipcRenderer.invoke('get-sessions')).find(item => item.kind === 'deepseek');
      return session && session.cwd ? session : null;
    })()`));
    const invocation = await waitFor('Codex CLI invocation', () => {
      const matches = readInvocations().filter(item => item.provider === 'codex');
      return matches[0] || null;
    });

    assert.strictEqual(session.cwd, path.join(WORKSPACE_ROOT, 'Stock'));
    assert.strictEqual(session.currentModel && session.currentModel.id, 'deepseek-v4-pro');
    assert.strictEqual(invocation.provider, 'codex');
    assert.strictEqual(invocation.cwd, path.join(WORKSPACE_ROOT, 'Stock'));
    assert.ok(invocation.args.includes('deepseek-v4-pro'));
    assert.strictEqual(invocation.hasDeepSeekKey, true);
    assert.strictEqual(invocation.hasAnthropicBase, false);
    assert.strictEqual(readInvocations().some(item => item.provider === 'claude'), false,
      'new DeepSeek sessions must not invoke claude.cmd');
    assert.strictEqual(invocation.codexHome, path.join(DATA_DIR, 'deepseek-codex-profile'));

    const profileConfig = fs.readFileSync(path.join(invocation.codexHome, 'config.toml'), 'utf8');
    const profileCatalog = JSON.parse(fs.readFileSync(path.join(invocation.codexHome, 'models.json'), 'utf8'));
    assert.match(profileConfig, /wire_api = "responses"/);
    assert.match(profileConfig, /env_key = "DEEPSEEK_API_KEY"/);
    assert.doesNotMatch(profileConfig, /e2e-deepseek-key-not-secret/);
    assert.deepStrictEqual(profileCatalog.models.map(model => model.slug), [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);

    const result = {
      ok: true,
      recommended,
      selected,
      session,
      invocation,
      screenshot: SCREENSHOT_PATH,
      profileConfig: path.join(invocation.codexHome, 'config.toml'),
    };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, screenshot: SCREENSHOT_PATH, result: RESULT_PATH, invocation }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
