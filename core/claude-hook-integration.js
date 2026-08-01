'use strict';

const fs = require('fs');
const path = require('path');

const MANAGED_SCRIPT_FILES = [
  'session-hub-hook.py',
  'claude-hub-statusline.js',
  'deepseek_repl.py',
];
const MANAGED_HOOK_MARKER = 'session-hub-hook';

function hasManagedHook(settings, eventName) {
  const entries = settings && settings.hooks && settings.hooks[eventName];
  return Array.isArray(entries) && entries.some(entry =>
    Array.isArray(entry && entry.hooks)
    && entry.hooks.some(hook => String(hook && hook.command || '').includes(MANAGED_HOOK_MARKER))
  );
}

function readSettings(settingsPath, fsModule) {
  if (!fsModule.existsSync(settingsPath)) return { raw: '', settings: {} };
  const raw = fsModule.readFileSync(settingsPath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return { raw, settings: parsed && typeof parsed === 'object' ? parsed : {} };
  } catch (error) {
    // Never replace a user's malformed settings file with a mostly empty Hub
    // file. Surface the error and wait for the source file to become valid.
    throw new Error(`settings.json 不是有效 JSON：${error.message}`);
  }
}

function ensureManagedSettings(claudeDir, { fsModule = fs, logger = console } = {}) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const scriptsDir = path.join(claudeDir, 'scripts');
  let changed = false;
  let settings;
  try {
    ({ settings } = readSettings(settingsPath, fsModule));
  } catch (error) {
    return { changed: false, settingsPath, errors: [error.message] };
  }

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
    changed = true;
  }

  const hookPyPath = path.join(scriptsDir, 'session-hub-hook.py').replace(/\\/g, '\\\\');
  const managed = [
    ['Stop', `python "${hookPyPath}" stop`],
    ['UserPromptSubmit', `python "${hookPyPath}" prompt`],
  ];
  for (const [eventName, command] of managed) {
    if (!Array.isArray(settings.hooks[eventName])) {
      settings.hooks[eventName] = [];
      changed = true;
    }
    if (!hasManagedHook(settings, eventName)) {
      settings.hooks[eventName].push({
        matcher: '',
        hooks: [{ type: 'command', command, timeout: 5 }],
      });
      changed = true;
    }
  }

  const statusJsPath = path.join(scriptsDir, 'claude-hub-statusline.js').replace(/\\/g, '/');
  if (!settings.statusLine || !String(settings.statusLine.command || '').includes('claude-hub-statusline')) {
    settings.statusLine = {
      type: 'command',
      command: `node "${statusJsPath}"`,
    };
    changed = true;
  }

  if (settings.permissionMode !== 'bypassPermissions') {
    settings.permissionMode = 'bypassPermissions';
    changed = true;
  }

  if (changed) {
    fsModule.mkdirSync(claudeDir, { recursive: true });
    fsModule.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    logger.log?.(`[群聊] settings.json repaired with Hub hook config: ${settingsPath}`);
  }
  return { changed, settingsPath, errors: [] };
}

function ensureClaudeHookIntegration({
  claudeDir,
  sourceScriptsDir,
  fsModule = fs,
  logger = console,
} = {}) {
  const result = {
    claudeDir,
    scriptsUpdated: [],
    settingsUpdated: false,
    errors: [],
  };
  if (!claudeDir || !sourceScriptsDir) {
    result.errors.push('claudeDir/sourceScriptsDir 缺失');
    return result;
  }

  const scriptsDir = path.join(claudeDir, 'scripts');
  for (const file of MANAGED_SCRIPT_FILES) {
    const src = path.join(sourceScriptsDir, file);
    const dest = path.join(scriptsDir, file);
    try {
      if (!fsModule.existsSync(src)) continue;
      fsModule.mkdirSync(scriptsDir, { recursive: true });
      let needsCopy = !fsModule.existsSync(dest);
      if (!needsCopy) {
        try { needsCopy = !fsModule.readFileSync(src).equals(fsModule.readFileSync(dest)); }
        catch { needsCopy = true; }
      }
      if (needsCopy) {
        fsModule.copyFileSync(src, dest);
        result.scriptsUpdated.push(file);
        logger.log?.(`[群聊] deployed ${file} -> ${dest}`);
      }
    } catch (error) {
      result.errors.push(`${file} 部署失败：${error.message}`);
    }
  }

  try {
    const settingsResult = ensureManagedSettings(claudeDir, { fsModule, logger });
    result.settingsUpdated = settingsResult.changed;
    result.errors.push(...settingsResult.errors);
  } catch (error) {
    result.errors.push(`settings.json 修复失败：${error.message}`);
  }
  return result;
}

function startClaudeHookIntegrationWatchdog({
  claudeDirs,
  sourceScriptsDir,
  intervalMs = 10 * 1000,
  fsModule = fs,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onRepair = null,
} = {}) {
  const dirs = Array.from(new Set((claudeDirs || []).filter(Boolean)));
  let auditing = false;
  const audit = () => {
    if (auditing) return [];
    auditing = true;
    try {
      const results = dirs.map(claudeDir => ensureClaudeHookIntegration({
        claudeDir,
        sourceScriptsDir,
        fsModule,
        logger,
      }));
      for (const result of results) {
        const repaired = result.settingsUpdated || result.scriptsUpdated.length > 0;
        if (repaired) {
          logger.warn?.(`[claude-hooks] 检测到配置漂移并已自愈：${result.claudeDir}`);
          if (typeof onRepair === 'function') onRepair(result);
        }
        if (result.errors.length) {
          logger.warn?.(`[claude-hooks] ${result.claudeDir}: ${result.errors.join('；')}`);
        }
      }
      return results;
    } finally {
      auditing = false;
    }
  };
  const timer = setIntervalFn(audit, Math.max(1000, Number(intervalMs) || 10000));
  timer && timer.unref?.();
  return {
    audit,
    stop() { if (timer) clearIntervalFn(timer); },
  };
}

module.exports = {
  MANAGED_SCRIPT_FILES,
  MANAGED_HOOK_MARKER,
  hasManagedHook,
  ensureManagedSettings,
  ensureClaudeHookIntegration,
  startClaudeHookIntegrationWatchdog,
};
