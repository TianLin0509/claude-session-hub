'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  HUB_APP_USER_MODEL_ID,
  HUB_SHORTCUT_NAME,
  LEGACY_DESKTOP_SHORTCUT_NAME,
  buildLaunchSpec,
  buildShortcutDetails,
  getShortcutPaths,
  isWindowsShellIntegrationHealthy,
  ensureWindowsShellIntegration,
  startWindowsShellIntegrationWatchdog,
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
      if (name === 'appData') return temp;
      if (name === 'desktop') return path.join(temp, 'Desktop');
      assert.fail(`unexpected app path: ${name}`);
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

test('Jump List registration cannot leave the canonical shortcut without the Hub app-root argument', () => {
  const h = makeHarness();
  try {
    const { shortcutPath } = getShortcutPaths({ app: h.app });
    h.app.setUserTasks = (value) => {
      h.tasks.push(value);
      // Mirrors the source-mode Windows/Electron behavior observed in production:
      // task registration normalizes the AUMID shortcut back to a bare exe launch.
      h.links.set(path.resolve(shortcutPath), {
        ...buildShortcutDetails(h),
        args: '',
        cwd: path.dirname(h.execPath),
      });
      return true;
    };

    const result = ensureWindowsShellIntegration({ ...h, platform: 'win32' });
    const repaired = h.links.get(path.resolve(shortcutPath));

    assert.equal(result.errors.length, 0);
    assert.equal(result.shortcutUpdated, true);
    assert.equal(h.writes.length, 2, 'canonical shortcut must be restored after setUserTasks drift');
    assert.equal(repaired.args, `"${path.resolve(h.appRoot)}"`);
    assert.equal(repaired.cwd, path.resolve(h.appRoot));
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

test('a broken legacy Desktop Hub shortcut is backed up and repaired', () => {
  const h = makeHarness();
  try {
    const desktopPath = path.join(h.temp, 'Desktop');
    const shortcutPath = path.join(desktopPath, LEGACY_DESKTOP_SHORTCUT_NAME);
    const missingRoot = path.join(h.temp, 'ai-hub-fresh');
    fs.mkdirSync(desktopPath, { recursive: true });
    fs.writeFileSync(shortcutPath, 'stale shortcut');
    h.links.set(path.resolve(shortcutPath), {
      target: path.join(missingRoot, 'electron.exe'),
      args: `"${missingRoot}"`,
      cwd: missingRoot,
      icon: path.join(missingRoot, 'hub.ico'),
      iconIndex: 0,
    });

    const result = ensureWindowsShellIntegration({
      ...h,
      platform: 'win32',
      now: () => new Date('2026-08-04T00:30:00.000Z'),
    });

    assert.equal(result.desktopShortcutUpdated, true);
    assert.ok(result.desktopBackupPath.endsWith('.hub-invalid-20260804003000.bak'));
    assert.equal(fs.existsSync(result.desktopBackupPath), true);
    assert.equal(fs.existsSync(shortcutPath), true);
    assert.equal(h.links.get(path.resolve(shortcutPath)).target, path.resolve(h.execPath));
  } finally {
    fs.rmSync(h.temp, { recursive: true, force: true });
  }
});

test('an unreadable legacy Desktop Hub shortcut is backed up and repaired', () => {
  const h = makeHarness();
  try {
    const desktopPath = path.join(h.temp, 'Desktop');
    const shortcutPath = path.join(desktopPath, LEGACY_DESKTOP_SHORTCUT_NAME);
    fs.mkdirSync(desktopPath, { recursive: true });
    fs.writeFileSync(shortcutPath, 'corrupt shortcut');

    const result = ensureWindowsShellIntegration({ ...h, platform: 'win32' });

    assert.equal(result.desktopShortcutUpdated, true);
    assert.equal(fs.existsSync(result.desktopBackupPath), true);
    assert.equal(h.links.get(path.resolve(shortcutPath)).target, path.resolve(h.execPath));
  } finally {
    fs.rmSync(h.temp, { recursive: true, force: true });
  }
});

test('a current Desktop Hub launch missing its AppUserModelID is upgraded', () => {
  const h = makeHarness();
  try {
    const desktopPath = path.join(h.temp, 'Desktop');
    const shortcutPath = path.join(desktopPath, LEGACY_DESKTOP_SHORTCUT_NAME);
    fs.mkdirSync(desktopPath, { recursive: true });
    fs.writeFileSync(shortcutPath, 'unbranded shortcut');
    h.links.set(path.resolve(shortcutPath), {
      ...buildShortcutDetails(h),
      appUserModelId: '',
    });

    const result = ensureWindowsShellIntegration({ ...h, platform: 'win32' });

    assert.equal(result.desktopShortcutUpdated, true);
    assert.equal(
      h.links.get(path.resolve(shortcutPath)).appUserModelId,
      HUB_APP_USER_MODEL_ID,
    );
  } finally {
    fs.rmSync(h.temp, { recursive: true, force: true });
  }
});

test('a working customized Desktop shortcut is left untouched', () => {
  const h = makeHarness();
  try {
    const desktopPath = path.join(h.temp, 'Desktop');
    const shortcutPath = path.join(desktopPath, LEGACY_DESKTOP_SHORTCUT_NAME);
    const customRoot = path.join(h.temp, 'custom-hub');
    const customTarget = path.join(customRoot, 'custom.exe');
    fs.mkdirSync(customRoot, { recursive: true });
    fs.writeFileSync(customTarget, 'custom');
    fs.mkdirSync(desktopPath, { recursive: true });
    fs.writeFileSync(shortcutPath, 'custom shortcut');
    h.links.set(path.resolve(shortcutPath), {
      target: customTarget,
      args: '',
      cwd: customRoot,
      icon: customTarget,
      iconIndex: 0,
    });

    const result = ensureWindowsShellIntegration({ ...h, platform: 'win32' });

    assert.equal(result.desktopShortcutUpdated, false);
    assert.equal(result.desktopBackupPath, null);
    assert.equal(fs.existsSync(shortcutPath), true);
    assert.equal(h.links.get(path.resolve(shortcutPath)).target, customTarget);
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

test('watchdog recreates a branded shortcut that disappears after launch', () => {
  const h = makeHarness();
  try {
    ensureWindowsShellIntegration({ ...h, platform: 'win32' });
    assert.equal(isWindowsShellIntegrationHealthy({ ...h, platform: 'win32' }), true);

    const { shortcutPath } = getShortcutPaths({ app: h.app });
    fs.unlinkSync(shortcutPath);
    h.links.delete(path.resolve(shortcutPath));
    assert.equal(isWindowsShellIntegrationHealthy({ ...h, platform: 'win32' }), false);

    let scheduled = null;
    let stopped = false;
    const watchdog = startWindowsShellIntegrationWatchdog({
      ...h,
      platform: 'win32',
      setIntervalFn: (fn) => { scheduled = fn; return { unref() {} }; },
      clearIntervalFn: () => { stopped = true; },
      logger: { warn() {} },
    });
    assert.equal(typeof scheduled, 'function');
    const repaired = watchdog.audit();
    assert.equal(repaired.shortcutUpdated, true);
    assert.equal(isWindowsShellIntegrationHealthy({ ...h, platform: 'win32' }), true);
    watchdog.stop();
    assert.equal(stopped, true);
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

test('legacy icon script delegates to canonical shell repair and never recreates claudeWX.lnk', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'create-shortcut.ps1'), 'utf8');
  assert.match(script, /repair-windows-shell-integration\.js/);
  assert.doesNotMatch(script, /CreateShortcut\(/);
  assert.doesNotMatch(script, /claudeWX\.lnk/);
});

// 2026-08-08 图标回归：Explorer 崩溃重启会重建任务栏并丢掉窗口 HICON，任务栏按钮
// 回落到 electron.exe 自带的原子图标。但此时**快捷方式是完好的** —— 健康检查通过、
// onRepair 永远不触发，所以把「重贴图标」挂在 onRepair 上救不回来。
// 实测链条：系统 08-06 14:11 启动 → Hub 14:17 图标正常 → explorer.exe 08-07
// 19:56:47 崩溃重启 → 08-08 17:40 截图已是原子图标，窗口全程可见。
// 这条契约钉住：健康状态下每一拍也必须调用 onTick。
test('watchdog re-asserts the window icon every tick even while the shortcut is healthy', () => {
  const h = makeHarness();
  try {
    ensureWindowsShellIntegration({ ...h, platform: 'win32' });
    assert.equal(isWindowsShellIntegrationHealthy({ ...h, platform: 'win32' }), true,
      'precondition: shortcut is healthy, so onRepair must not fire');

    let ticks = 0;
    let repairs = 0;
    let scheduled = null;
    const watchdog = startWindowsShellIntegrationWatchdog({
      ...h,
      platform: 'win32',
      setIntervalFn: (fn) => { scheduled = fn; return { unref() {} }; },
      clearIntervalFn: () => {},
      onTick: () => { ticks += 1; },
      onRepair: () => { repairs += 1; },
      logger: { warn() {} },
    });

    scheduled();
    scheduled();
    watchdog.audit();

    assert.equal(ticks, 3, 'onTick 必须每一拍都跑，这是 Explorer 重启后自愈的唯一路径');
    assert.equal(repairs, 0, '快捷方式健康时不应触发 onRepair —— 正因如此图标不能挂在它上面');
    watchdog.stop();
  } finally {
    fs.rmSync(h.temp, { recursive: true, force: true });
  }
});

test('watchdog survives an onTick that throws and still repairs the shortcut', () => {
  const h = makeHarness();
  try {
    ensureWindowsShellIntegration({ ...h, platform: 'win32' });
    const { shortcutPath } = getShortcutPaths({ app: h.app });
    fs.unlinkSync(shortcutPath);
    h.links.delete(path.resolve(shortcutPath));

    const warnings = [];
    const watchdog = startWindowsShellIntegrationWatchdog({
      ...h,
      platform: 'win32',
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
      onTick: () => { throw new Error('setIcon exploded'); },
      logger: { warn: (msg) => warnings.push(String(msg)) },
    });

    const result = watchdog.audit();
    assert.equal(result.shortcutUpdated, true, 'onTick 抛错不能吃掉快捷方式修复');
    assert.ok(warnings.some(w => /onTick failed/.test(w)), '异常要记日志，不能静默');
    watchdog.stop();
  } finally {
    fs.rmSync(h.temp, { recursive: true, force: true });
  }
});
