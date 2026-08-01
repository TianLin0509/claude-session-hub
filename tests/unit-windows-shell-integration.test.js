'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  HUB_APP_USER_MODEL_ID,
  HUB_SHORTCUT_NAME,
  buildLaunchSpec,
  buildShortcutDetails,
  ensureWindowsShellIntegration,
} = require('../core/windows-shell-integration.js');

function makeHarness() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-shell-'));
  const appRoot = path.join(temp, 'AI Hub Source');
  const execPath = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const iconPath = path.join(appRoot, 'claude-wx.ico');
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, 'fake');
  fs.writeFileSync(iconPath, 'fake');
  const links = new Map();
  const writes = [];
  const tasks = [];
  const shell = {
    readShortcutLink(shortcutPath) {
      const value = links.get(path.resolve(shortcutPath));
      if (!value) throw new Error('missing shortcut');
      return { ...value };
    },
    writeShortcutLink(shortcutPath, operation, details) {
      const exists = fs.existsSync(shortcutPath);
      if (operation === 'create' && exists) return false;
      if (operation === 'replace' && !exists) return false;
      writes.push({ shortcutPath: path.resolve(shortcutPath), operation, details: { ...details } });
      links.set(path.resolve(shortcutPath), { ...details });
      fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
      fs.writeFileSync(shortcutPath, 'shortcut');
      return true;
    },
  };
  const app = {
    getPath(name) {
      assert.equal(name, 'appData');
      return temp;
    },
    setUserTasks(value) {
      tasks.push(value);
      return true;
    },
  };
  return { temp, appRoot, execPath, iconPath, links, writes, tasks, shell, app };
}

test('source launch spec passes the Hub app root to electron.exe', () => {
  const spec = buildLaunchSpec({
    appRoot: 'C:\\Users\\lintian\\claude-session-hub',
    execPath: 'C:\\repo\\electron.exe',
    iconPath: 'C:\\repo\\hub.ico',
    isPackaged: false,
  });
  assert.equal(spec.args, '"C:\\Users\\lintian\\claude-session-hub"');
  assert.match(spec.cwd, /claude-session-hub$/i);
});

test('packaged launch spec does not append a source app-root argument', () => {
  const spec = buildLaunchSpec({
    appRoot: 'C:\\unused-source',
    execPath: 'C:\\Program Files\\AI Hub\\AI Hub.exe',
    isPackaged: true,
  });
  assert.equal(spec.args, '');
  assert.match(spec.cwd, /AI Hub$/i);
});

test('production integration creates a branded shortcut and a working new-window task', () => {
  const h = makeHarness();
  try {
    const result = ensureWindowsShellIntegration({
      ...h,
      platform: 'win32',
      now: () => new Date('2026-08-01T05:00:00.000Z'),
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.shortcutUpdated, true);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].operation, 'create');
    assert.equal(path.basename(h.writes[0].shortcutPath), HUB_SHORTCUT_NAME);
    assert.equal(h.writes[0].details.appUserModelId, HUB_APP_USER_MODEL_ID);
    assert.equal(h.writes[0].details.args, `"${path.resolve(h.appRoot)}"`);
    assert.equal(h.tasks.length, 1);
    assert.equal(h.tasks[0][0].title, '新建 AI 群聊 Hub');
    assert.equal(h.tasks[0][0].arguments, `"${path.resolve(h.appRoot)}"`);
  } finally {
    fs.rmSync(h.temp, { recursive: true, force: true });
  }
});

test('only the exact Hub-owned bare Electron shortcut is retired with a backup', () => {
  const h = makeHarness();
  try {
    const programs = path.join(h.temp, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const legacyPath = path.join(programs, 'Electron.lnk');
    fs.mkdirSync(programs, { recursive: true });
    fs.writeFileSync(legacyPath, 'bad shortcut');
    h.links.set(path.resolve(legacyPath), {
      target: h.execPath,
      args: '',
      appUserModelId: HUB_APP_USER_MODEL_ID,
      icon: '',
      iconIndex: 0,
      cwd: path.dirname(h.execPath),
    });
    const result = ensureWindowsShellIntegration({
      ...h,
      platform: 'win32',
      now: () => new Date('2026-08-01T05:00:00.000Z'),
    });
    assert.equal(fs.existsSync(legacyPath), false);
    assert.ok(result.legacyBackupPath.endsWith('.hub-invalid-20260801050000.bak'));
    assert.equal(fs.existsSync(result.legacyBackupPath), true);
  } finally {
    fs.rmSync(h.temp, { recursive: true, force: true });
  }
});

test('a foreign Electron shortcut is never moved or overwritten', () => {
  const h = makeHarness();
  try {
    const programs = path.join(h.temp, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const legacyPath = path.join(programs, 'Electron.lnk');
    fs.mkdirSync(programs, { recursive: true });
    fs.writeFileSync(legacyPath, 'foreign shortcut');
    h.links.set(path.resolve(legacyPath), {
      target: h.execPath,
      args: '--some-other-app',
      appUserModelId: 'com.someone.else',
    });
    const result = ensureWindowsShellIntegration({ ...h, platform: 'win32' });
    assert.equal(result.legacyBackupPath, null);
    assert.equal(fs.existsSync(legacyPath), true);
  } finally {
    fs.rmSync(h.temp, { recursive: true, force: true });
  }
});

test('an already correct shortcut is not rewritten on every launch', () => {
  const h = makeHarness();
  try {
    const programs = path.join(h.temp, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const shortcutPath = path.join(programs, HUB_SHORTCUT_NAME);
    const details = buildShortcutDetails(h);
    fs.mkdirSync(programs, { recursive: true });
    fs.writeFileSync(shortcutPath, 'shortcut');
    h.links.set(path.resolve(shortcutPath), details);
    const result = ensureWindowsShellIntegration({ ...h, platform: 'win32' });
    assert.equal(result.shortcutUpdated, false);
    assert.equal(h.writes.length, 0);
    assert.equal(h.tasks.length, 1, 'Jump List is refreshed even when the shortcut is already current');
  } finally {
    fs.rmSync(h.temp, { recursive: true, force: true });
  }
});

test('non-Windows runs perform no filesystem or taskbar mutation', () => {
  const h = makeHarness();
  try {
    const result = ensureWindowsShellIntegration({ ...h, platform: 'linux' });
    assert.equal(result.supported, false);
    assert.equal(h.writes.length, 0);
    assert.equal(h.tasks.length, 0);
  } finally {
    fs.rmSync(h.temp, { recursive: true, force: true });
  }
});
