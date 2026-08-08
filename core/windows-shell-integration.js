'use strict';

const fs = require('fs');
const path = require('path');

const HUB_APP_USER_MODEL_ID = 'com.ai-group-chat-hub';
const HUB_SHORTCUT_NAME = 'AI 群聊 Hub.lnk';
const LEGACY_ELECTRON_SHORTCUT_NAME = 'Electron.lnk';
const LEGACY_DESKTOP_SHORTCUT_NAME = 'AI Group Chat Hub.lnk';

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

function shortcutLaunchMatches(actual, expected) {
  if (!actual) return false;
  return normalizeWinPath(actual.target) === normalizeWinPath(expected.target)
    && String(actual.args || '').trim() === String(expected.args || '').trim()
    && normalizeWinPath(actual.cwd) === normalizeWinPath(expected.cwd);
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

function getShortcutPaths({ app, appDataPath, desktopPath } = {}) {
  const programsDir = path.join(appDataPath || app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const desktopDir = desktopPath || app.getPath('desktop');
  return {
    programsDir,
    shortcutPath: path.join(programsDir, HUB_SHORTCUT_NAME),
    legacyPath: path.join(programsDir, LEGACY_ELECTRON_SHORTCUT_NAME),
    desktopLegacyPath: path.join(desktopDir, LEGACY_DESKTOP_SHORTCUT_NAME),
  };
}

function shortcutReferencesMissingPath(details, fsModule = fs) {
  if (!details) return true;
  const iconPath = String(details.icon || '').replace(/,\s*\d+$/, '');
  return !details.target || !fsModule.existsSync(details.target)
    || (!!details.cwd && !fsModule.existsSync(details.cwd))
    || (!!iconPath && !fsModule.existsSync(iconPath));
}

function isWindowsShellIntegrationHealthy({
  app,
  shell,
  appRoot,
  execPath,
  isPackaged = false,
  iconPath,
  appDataPath,
  desktopPath,
  platform = process.platform,
  fsModule = fs,
} = {}) {
  if (platform !== 'win32') return true;
  const expected = buildShortcutDetails({ appRoot, execPath, isPackaged, iconPath });
  const { shortcutPath } = getShortcutPaths({ app, appDataPath, desktopPath });
  if (!fsModule.existsSync(shortcutPath)) return false;
  try {
    return shortcutMatches(shell.readShortcutLink(shortcutPath), expected);
  } catch {
    return false;
  }
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
  desktopPath,
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
    desktopShortcutPath: null,
    desktopShortcutUpdated: false,
    desktopBackupPath: null,
    userTasksUpdated: false,
    errors: [],
  };
  if (!result.supported) return result;

  const expected = buildShortcutDetails({ appRoot, execPath, isPackaged, iconPath });
  const {
    programsDir,
    shortcutPath,
    legacyPath,
    desktopLegacyPath,
  } = getShortcutPaths({ app, appDataPath, desktopPath });
  result.shortcutPath = shortcutPath;
  result.desktopShortcutPath = desktopLegacyPath;

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

  // Older development launches created an English-named Desktop shortcut.
  // Keep a working user-customized link untouched; repair only this exact
  // Hub-owned filename when its executable, cwd, or icon no longer exists.
  if (fsModule.existsSync(desktopLegacyPath)) {
    try {
      let desktopShortcut = null;
      try { desktopShortcut = shell.readShortcutLink(desktopLegacyPath); } catch {}
      if (!shortcutMatches(desktopShortcut, expected)
          && (shortcutReferencesMissingPath(desktopShortcut, fsModule)
            || shortcutLaunchMatches(desktopShortcut, expected))) {
        const backupPath = `${desktopLegacyPath}.hub-invalid-${timestampForFile(now())}.bak`;
        fsModule.renameSync(desktopLegacyPath, backupPath);
        try {
          const ok = shell.writeShortcutLink(desktopLegacyPath, 'create', expected);
          if (!ok) throw new Error(`writeShortcutLink returned false: ${desktopLegacyPath}`);
          result.desktopShortcutUpdated = true;
          result.desktopBackupPath = backupPath;
        } catch (error) {
          if (fsModule.existsSync(desktopLegacyPath)) {
            fsModule.rmSync(desktopLegacyPath, { force: true });
          }
          if (fsModule.existsSync(backupPath)) {
            fsModule.renameSync(backupPath, desktopLegacyPath);
          }
          throw error;
        }
      }
    } catch (error) {
      result.errors.push(`Desktop shortcut repair failed: ${error.message}`);
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

function startWindowsShellIntegrationWatchdog({
  intervalMs = 15 * 1000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onRepair = null,
  onTick = null,
  logger = console,
  ...integrationOptions
} = {}) {
  let checking = false;
  const audit = () => {
    if (checking) return null;
    checking = true;
    try {
      // onTick 每一拍都跑，与快捷方式是否漂移无关 —— 窗口 HICON 的丢失和快捷方式
      // 的漂移是两件独立的事。Explorer 崩溃重启会重建任务栏并丢掉 HICON，但快捷
      // 方式本身完好，健康检查会直接 return，onRepair 永远不触发。把「重贴图标」
      // 挂在 onRepair 上就是 2026-08-08 那次图标变原子没能自愈的原因。
      if (typeof onTick === 'function') {
        try { onTick(); } catch (error) {
          logger.warn?.(`[windows-shell] watchdog onTick failed: ${error && error.message}`);
        }
      }
      if (isWindowsShellIntegrationHealthy(integrationOptions)) return null;
      const result = ensureWindowsShellIntegration({ ...integrationOptions, logger });
      if (result.shortcutUpdated) {
        logger.warn?.(`[windows-shell] 快捷方式丢失或漂移，已自动修复：${result.shortcutPath}`);
        if (typeof onRepair === 'function') onRepair(result);
      }
      return result;
    } finally {
      checking = false;
    }
  };
  const timer = setIntervalFn(audit, Math.max(1000, Number(intervalMs) || 15000));
  timer && timer.unref?.();
  return {
    audit,
    stop() { if (timer) clearIntervalFn(timer); },
  };
}

module.exports = {
  HUB_APP_USER_MODEL_ID,
  HUB_SHORTCUT_NAME,
  LEGACY_ELECTRON_SHORTCUT_NAME,
  LEGACY_DESKTOP_SHORTCUT_NAME,
  buildLaunchSpec,
  buildShortcutDetails,
  buildNewWindowTask,
  shortcutMatches,
  shortcutLaunchMatches,
  isPoisonedLegacyElectronShortcut,
  shortcutReferencesMissingPath,
  getShortcutPaths,
  isWindowsShellIntegrationHealthy,
  ensureWindowsShellIntegration,
  startWindowsShellIntegrationWatchdog,
};
