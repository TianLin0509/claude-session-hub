'use strict';

const fs = require('fs');
const path = require('path');

const HUB_APP_USER_MODEL_ID = 'com.ai-group-chat-hub';
const HUB_SHORTCUT_NAME = 'AI 群聊 Hub.lnk';
const LEGACY_ELECTRON_SHORTCUT_NAME = 'Electron.lnk';

function quoteWindowsArg(value) {
  const text = String(value || '');
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function normalizeWinPath(value) {
  if (!value) return '';
  return path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
}

function buildLaunchSpec({ appRoot, execPath, isPackaged = false, iconPath }) {
  const resolvedRoot = path.resolve(appRoot);
  const resolvedExec = path.resolve(execPath);
  const resolvedIcon = iconPath ? path.resolve(iconPath) : resolvedExec;
  return {
    target: resolvedExec,
    args: isPackaged ? '' : quoteWindowsArg(resolvedRoot),
    cwd: isPackaged ? path.dirname(resolvedExec) : resolvedRoot,
    icon: resolvedIcon,
  };
}

function buildShortcutDetails(options) {
  const launch = buildLaunchSpec(options);
  return {
    target: launch.target,
    args: launch.args,
    cwd: launch.cwd,
    description: 'AI 群聊 Hub',
    icon: launch.icon,
    iconIndex: 0,
    appUserModelId: HUB_APP_USER_MODEL_ID,
  };
}

function buildNewWindowTask(options) {
  const launch = buildLaunchSpec(options);
  return {
    program: launch.target,
    arguments: launch.args,
    iconPath: launch.icon,
    iconIndex: 0,
    title: '新建 AI 群聊 Hub',
    description: '打开一个新的 AI 群聊 Hub 窗口',
    workingDirectory: launch.cwd,
  };
}

function shortcutMatches(actual, expected) {
  if (!actual) return false;
  return normalizeWinPath(actual.target) === normalizeWinPath(expected.target)
    && String(actual.args || '').trim() === String(expected.args || '').trim()
    && normalizeWinPath(actual.cwd) === normalizeWinPath(expected.cwd)
    && normalizeWinPath(actual.icon) === normalizeWinPath(expected.icon)
    && Number(actual.iconIndex || 0) === Number(expected.iconIndex || 0)
    && String(actual.appUserModelId || '') === String(expected.appUserModelId || '');
}

function isPoisonedLegacyElectronShortcut(details, expected) {
  if (!details) return false;
  return normalizeWinPath(details.target) === normalizeWinPath(expected.target)
    && String(details.appUserModelId || '') === HUB_APP_USER_MODEL_ID
    && !String(details.args || '').trim();
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

/**
 * Keep Windows taskbar identity and relaunch commands bound to the Hub app,
 * rather than to the source-mode electron.exe host.
 *
 * This must only run for the production Hub. Test/isolated instances use the
 * same electron.exe but must never register or rewrite the production AUMID.
 */
function ensureWindowsShellIntegration({
  app,
  shell,
  appRoot,
  execPath,
  isPackaged = false,
  iconPath,
  appDataPath,
  platform = process.platform,
  fsModule = fs,
  now = () => new Date(),
  logger = console,
} = {}) {
  const result = {
    supported: platform === 'win32',
    shortcutPath: null,
    shortcutUpdated: false,
    legacyBackupPath: null,
    userTasksUpdated: false,
    errors: [],
  };
  if (!result.supported) return result;

  const expected = buildShortcutDetails({ appRoot, execPath, isPackaged, iconPath });
  const programsDir = path.join(appDataPath || app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const shortcutPath = path.join(programsDir, HUB_SHORTCUT_NAME);
  const legacyPath = path.join(programsDir, LEGACY_ELECTRON_SHORTCUT_NAME);
  result.shortcutPath = shortcutPath;

  try {
    fsModule.mkdirSync(programsDir, { recursive: true });
    let current = null;
    if (fsModule.existsSync(shortcutPath)) {
      try { current = shell.readShortcutLink(shortcutPath); } catch {}
    }
    if (!shortcutMatches(current, expected)) {
      // Electron follows native Shell Link semantics: `replace` requires an
      // existing file, while `create` fails if one is already present.
      const operation = fsModule.existsSync(shortcutPath) ? 'replace' : 'create';
      const ok = shell.writeShortcutLink(shortcutPath, operation, expected);
      if (!ok) throw new Error(`writeShortcutLink returned false: ${shortcutPath}`);
      result.shortcutUpdated = true;
    }
  } catch (error) {
    result.errors.push(`正式快捷方式修复失败：${error.message}`);
  }

  // A July 2026 regression left a Start Menu Electron.lnk with our production
  // AUMID, but no app-root argument. Windows therefore relaunched bare Electron
  // and used the atom icon. Retire only that exact, Hub-owned signature.
  if (!result.errors.length && normalizeWinPath(legacyPath) !== normalizeWinPath(shortcutPath)
      && fsModule.existsSync(legacyPath)) {
    try {
      const legacy = shell.readShortcutLink(legacyPath);
      if (isPoisonedLegacyElectronShortcut(legacy, expected)) {
        const backupPath = `${legacyPath}.hub-invalid-${timestampForFile(now())}.bak`;
        fsModule.renameSync(legacyPath, backupPath);
        result.legacyBackupPath = backupPath;
      }
    } catch (error) {
      result.errors.push(`错误 Electron 快捷方式退役失败：${error.message}`);
    }
  }

  try {
    result.userTasksUpdated = app.setUserTasks([
      buildNewWindowTask({ appRoot, execPath, isPackaged, iconPath }),
    ]);
    if (!result.userTasksUpdated) {
      result.errors.push('Windows Jump List 拒绝更新“新建 AI 群聊 Hub”任务');
    }
  } catch (error) {
    result.errors.push(`Windows Jump List 更新失败：${error.message}`);
  }

  if (result.errors.length) logger.warn('[windows-shell]', result.errors.join('；'));
  return result;
}

module.exports = {
  HUB_APP_USER_MODEL_ID,
  HUB_SHORTCUT_NAME,
  LEGACY_ELECTRON_SHORTCUT_NAME,
  buildLaunchSpec,
  buildShortcutDetails,
  buildNewWindowTask,
  shortcutMatches,
  isPoisonedLegacyElectronShortcut,
  ensureWindowsShellIntegration,
};
