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
const TEMP_ROOT = path.join(os.tmpdir(), `hub-workspace-selector-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORKSPACE_ROOT = path.join(TEMP_ROOT, 'workspaces');
const FAKE_BIN = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const INVOCATION_LOG = path.join(TEMP_ROOT, 'invocations.jsonl');
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'workspace-selector');
const MODAL_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `new-session-modal-${RUN_ID}.png`);
const TERMINAL_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `session-workspace-terminal-${RUN_ID}.png`);
const ARCHIVE_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `workspace-archive-modal-${RUN_ID}.png`);
const GROUP_MODAL_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `group-workspace-modal-${RUN_ID}.png`);
const GROUP_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `group-workspace-header-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `workspace-selector-${RUN_ID}.json`);

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

async function waitFor(label, fn, timeoutMs = 20000) {
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

async function clickPoint(client, point) {
  assert.equal(point.visible, true, `${point.selector} should be visible`);
  assert.equal(point.topmost, true, `${point.selector} should be topmost`);
  await client.send('Page.bringToFront');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function pointFor(client, selector) {
  return client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { selector: ${JSON.stringify(selector)}, found: false };
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      selector: ${JSON.stringify(selector)}, found: true, x, y,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none',
      topmost: hit === el || el.contains(hit),
    };
  })()`);
}

async function screenshot(client, target) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
}

function writeFixtures() {
  fs.mkdirSync(FAKE_BIN, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_ROOT, 'Tools'), { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const fake = path.join(FAKE_BIN, 'fake-cli.js');
  fs.writeFileSync(fake, `'use strict';
const fs = require('node:fs');
const provider = process.argv[2];
fs.appendFileSync(process.env.HUB_WORKSPACE_E2E_LOG, JSON.stringify({ provider, cwd: process.cwd(), args: process.argv.slice(3) }) + '\\n');
process.stdout.write('FAKE_CLI_READY ' + provider + '\\r\\n');
setInterval(() => {}, 1000);
`, 'utf8');
  for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
    fs.writeFileSync(path.join(FAKE_BIN, `${provider}.cmd`), `@echo off\r\n"${process.execPath}" "${fake}" ${provider} %*\r\n`, 'utf8');
  }
  fs.writeFileSync(path.join(CODEX_HOME, 'config.toml'), 'approval_policy = "never"\n', 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      claude: { backend: 'subscription' },
      codex: {
        backend: 'subscription',
        subscription_profile: 'e2e',
        subscription_profiles: [{ id: 'e2e', label: 'E2E', home: CODEX_HOME }],
      },
    },
  }, null, 2), 'utf8');
}

async function main() {
  writeFixtures();
  const port = await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const result = {
    runId: RUN_ID,
    port,
    screenshots: { modal: MODAL_SCREENSHOT_PATH, terminal: TERMINAL_SCREENSHOT_PATH, archive: ARCHIVE_SCREENSHOT_PATH, groupModal: GROUP_MODAL_SCREENSHOT_PATH, group: GROUP_SCREENSHOT_PATH },
  };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port,
      label: 'workspace-selector',
      extraEnv: {
        AI_HUB_WORKSPACE_ROOT: WORKSPACE_ROOT,
        CODEX_HOME,
        HUB_CODEX_PROFILE: 'e2e',
        HUB_WORKSPACE_E2E_ALLOW_FALLBACK_RESUME: '1',
        HUB_WORKSPACE_E2E_LOG: INVOCATION_LOG,
        [pathKey]: `${FAKE_BIN}${path.delimiter}${process.env[pathKey] || ''}`,
      },
    });
    await _waitMs(900);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.eval(`(() => {
      window.__workspaceE2eErrors = [];
      window.addEventListener('error', event => window.__workspaceE2eErrors.push(String(event.error || event.message || 'renderer error')));
      window.addEventListener('unhandledrejection', event => window.__workspaceE2eErrors.push(String(event.reason || 'unhandled rejection')));
      return true;
    })()`);

    result.sidebar = await client.eval(`(() => ({
      hasWorkspaceBar: !!document.querySelector('#workspace-bar'),
      sessionCount: document.querySelectorAll('.session-item').length,
    }))()`);
    assert.equal(result.sidebar.hasWorkspaceBar, false, 'sidebar must aggregate sessions without a global workspace selector');

    await clickPoint(client, await pointFor(client, '#btn-new'));
    result.newSessionModal = await waitFor('new session modal', () => client.eval(`(() => {
      const modal = document.querySelector('#new-session-menu');
      if (!modal || modal.style.display === 'none') return null;
      return {
        modelChoices: modal.querySelectorAll('.new-session-option').length,
        workspaceChoices: modal.querySelectorAll('.session-workspace-choice').length,
        selectedKind: modal.querySelector('.new-session-option.selected')?.dataset.kind || null,
        selectedWorkspaceMode: modal.querySelector('.session-workspace-choice.selected')?.dataset.workspaceMode || null,
        submitEnabled: !document.querySelector('#new-session-submit').disabled,
      };
    })()`));
    assert.equal(result.newSessionModal.modelChoices, 6);
    assert.equal(result.newSessionModal.workspaceChoices, 2);
    assert.equal(result.newSessionModal.selectedKind, 'claude');
    assert.equal(result.newSessionModal.selectedWorkspaceMode, 'scratch');
    assert.equal(result.newSessionModal.submitEnabled, true);
    await screenshot(client, MODAL_SCREENSHOT_PATH);

    await clickPoint(client, await pointFor(client, '#new-session-submit'));
    const normalSessionRecord = await waitFor('normal session record', () => client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const sessions = await ipcRenderer.invoke('get-sessions');
      return sessions.find(item => !item.meetingId) || null;
    })()`), 30000);
    await _waitMs(1200);
    result.normalSession = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const session = (await ipcRenderer.invoke('get-sessions')).find(item => !item.meetingId);
      const header = document.querySelector('.terminal-header');
      const cwd = document.querySelector('.metric-cwd');
      const rows = document.querySelector('.terminal-container .xterm-rows');
      return {
        session,
        headerVisible: !!header && header.getBoundingClientRect().height > 0,
        cwdText: cwd ? cwd.textContent : '',
        terminalText: rows ? rows.textContent : '',
        bufferText: session ? await ipcRenderer.invoke('debug:get-session-buffer', session.id) : '',
        panelTextLength: document.querySelector('#terminal-panel').textContent.length,
        errors: window.__workspaceE2eErrors || [],
      };
    })()`);
    assert.equal(result.normalSession.session.id, normalSessionRecord.id);
    assert.ok(result.normalSession.session.cwd.includes('_scratch'));
    assert.notEqual(result.normalSession.session.cwd.toLowerCase(), os.homedir().toLowerCase());
    assert.ok(fs.existsSync(path.join(result.normalSession.session.cwd, '.git')));
    assert.equal(result.normalSession.headerVisible, true);
    assert.match(result.normalSession.cwdText, /_scratch/i);
    assert.match(result.normalSession.bufferText, /FAKE_CLI_READY/);
    assert.ok(result.normalSession.panelTextLength > 0, 'new session panel must not be black/empty');
    await screenshot(client, TERMINAL_SCREENSHOT_PATH);

    const normalScratchPath = result.normalSession.session.cwd;
    await client.eval(`window.WorkspaceController.maybePromptSessionArchive(${JSON.stringify(normalSessionRecord.id)})`);
    result.archiveModal = await waitFor('first-turn archive modal', () => client.eval(`(() => {
      const modal = document.querySelector('#workspace-archive-modal');
      if (!modal || modal.style.display === 'none') return null;
      return {
        categories: modal.querySelectorAll('.workspace-archive-categories button').length,
        source: modal.querySelector('#workspace-archive-source')?.title || '',
        submitDisabled: modal.querySelector('#workspace-archive-submit')?.disabled,
      };
    })()`), 15000);
    assert.equal(result.archiveModal.categories, 1);
    assert.equal(result.archiveModal.source, normalScratchPath);
    assert.equal(result.archiveModal.submitDisabled, true);
    await screenshot(client, ARCHIVE_SCREENSHOT_PATH);
    await clickPoint(client, await pointFor(client, '.workspace-archive-categories button'));
    await clickPoint(client, await pointFor(client, '#workspace-archive-submit'));
    result.normalArchive = await waitFor('normal workspace archive and reconnect', () => client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const session = (await ipcRenderer.invoke('get-sessions')).find(item => item.id === ${JSON.stringify(normalSessionRecord.id)});
      const modal = document.querySelector('#workspace-archive-modal');
      if (!session || session.cwd === ${JSON.stringify(normalScratchPath)} || (modal && modal.style.display !== 'none')) return null;
      const buffer = await ipcRenderer.invoke('debug:get-session-buffer', session.id);
      if (!/FAKE_CLI_READY/.test(buffer || '')) return null;
      return { session, buffer };
    })()`), 30000);
    assert.match(result.normalArchive.session.cwd, /[\\/]Tools[\\/]/);
    assert.equal(fs.existsSync(normalScratchPath), false, 'archived normal scratch directory should be removed');
    assert.match(result.normalArchive.buffer, /FAKE_CLI_READY/, 'archived session should reconnect its CLI');

    await clickPoint(client, await pointFor(client, '#btn-group-chat'));
    result.groupModal = await waitFor('group workspace choices', () => client.eval(`(() => {
      const modal = document.querySelector('#meeting-create-modal');
      if (!modal || modal.style.display === 'none') return null;
      return {
        workspaceChoices: modal.querySelectorAll('.mcm-workspace-choice').length,
        selectedMode: modal.querySelector('.mcm-workspace-choice.selected')?.dataset.mcmWorkspaceMode || null,
        members: modal.querySelectorAll('.mcm-slot').length,
      };
    })()`));
    assert.equal(result.groupModal.workspaceChoices, 2);
    assert.equal(result.groupModal.selectedMode, 'scratch');
    assert.equal(result.groupModal.members, 3);
    await screenshot(client, GROUP_MODAL_SCREENSHOT_PATH);

    await clickPoint(client, await pointFor(client, '.mcm-create'));
    result.meeting = await waitFor('group sessions and workspace header', () => client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const meetings = await ipcRenderer.invoke('get-meetings');
      const sessions = await ipcRenderer.invoke('get-sessions');
      const meeting = meetings.find(item => item.workspace);
      const chip = document.querySelector('#mr-workspace-chip');
      if (!meeting || meeting.subSessions.length !== 3 || !chip) return null;
      return {
        meeting,
        subs: sessions.filter(item => item.meetingId === meeting.id),
        chipText: chip.textContent,
        chipTitle: chip.title,
      };
    })()`), 30000);
    assert.ok(result.meeting.meeting.workspace.includes('_scratch'));
    assert.notEqual(result.meeting.meeting.workspace, result.normalSession.session.cwd, 'each fresh task gets its own scratch');
    assert.equal(result.meeting.subs.length, 3);
    assert.ok(result.meeting.subs.every(item => item.cwd === result.meeting.meeting.workspace));
    assert.match(result.meeting.chipTitle, /_scratch/i);
    await screenshot(client, GROUP_SCREENSHOT_PATH);

    const groupScratchPath = result.meeting.meeting.workspace;
    await client.eval(`window.WorkspaceController.maybePromptMeetingArchive(${JSON.stringify(result.meeting.meeting.id)})`);
    await waitFor('group first-turn archive modal', () => client.eval(`(() => {
      const modal = document.querySelector('#workspace-archive-modal');
      return modal && modal.style.display !== 'none' ? true : null;
    })()`), 15000);
    await clickPoint(client, await pointFor(client, '.workspace-archive-categories button'));
    await clickPoint(client, await pointFor(client, '#workspace-archive-submit'));
    result.groupArchive = await waitFor('group workspace archive and reconnect', () => client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const meeting = (await ipcRenderer.invoke('get-meetings')).find(item => item.id === ${JSON.stringify(result.meeting.meeting.id)});
      const sessions = await ipcRenderer.invoke('get-sessions');
      const subs = meeting ? sessions.filter(item => item.meetingId === meeting.id) : [];
      if (!meeting || meeting.workspace === ${JSON.stringify(groupScratchPath)} || subs.length !== 3) return null;
      const buffers = await Promise.all(subs.map(item => ipcRenderer.invoke('debug:get-session-buffer', item.id)));
      if (!buffers.every(value => /FAKE_CLI_READY/.test(value || ''))) return null;
      return { meeting, subs, buffers };
    })()`), 40000);
    assert.match(result.groupArchive.meeting.workspace, /[\\/]Tools[\\/]/);
    assert.ok(result.groupArchive.subs.every(item => item.cwd === result.groupArchive.meeting.workspace));
    assert.equal(fs.existsSync(groupScratchPath), false, 'archived group scratch directory should be removed');
    assert.deepEqual(fs.readdirSync(path.join(WORKSPACE_ROOT, '_scratch')), [], '_scratch should be empty after both confirmations');

    result.renderer = await client.eval(`(() => ({ errors: window.__workspaceE2eErrors || [] }))()`);
    assert.deepEqual(result.renderer.errors, [], `renderer errors: ${result.renderer.errors.join(' | ')}`);
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, normalWorkspace: result.normalSession.session.cwd, groupWorkspace: result.meeting.meeting.workspace, screenshots: result.screenshots, result: RESULT_PATH }, null, 2));
  } finally {
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub);
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
