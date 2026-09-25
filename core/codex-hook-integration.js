'use strict';

// PTY 模式下 Codex 的状态与卡片绑定靠 Codex 自己的 hook（0.153 起支持）。
//
// 这里只管 Hub 自己的那几条 hook：
//   1. 把 session-hub-hook.py 复制到 <CODEX_HOME>/hub-scripts/，路径稳定；
//   2. 在 <CODEX_HOME>/hooks.json 里补齐缺的事件，已有的 session-hub-hook 条目原样保留；
//   3. 在 <CODEX_HOME>/config.toml 的 [hooks.state] 里为这些条目写 trusted_hash。
//
// 第 3 步等价于用户在 Codex /hooks 里点一次「信任」。Codex 只执行 hash 一致的
// hook，否则新条目会被静默跳过，状态就退化成只能看 rollout。hash 算法与 Codex
// 源码 hooks/src/engine/discovery.rs::hook_hash + config/src/fingerprint.rs 一致：
// {event_name, matcher?, hooks:[归一化后的 handler]} 转 JSON、键排序、紧凑序列化后 sha256。
// 只为命令里带 session-hub-hook 的条目写信任，绝不替用户信任别的 hook。
//
// hook 脚本在没有 CLAUDE_HUB_SESSION_ID 时立刻退出，所以用户自己在终端里跑的
// Codex 不受影响。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MARKER = 'session-hub-hook';
const TIMEOUT_SEC = 5;
// [Codex 事件名, trust key 里的事件标签, hook 脚本参数, 是否 async]
const HUB_CODEX_HOOKS = [
  ['SessionStart', 'session_start', 'session-start', false],
  ['UserPromptSubmit', 'user_prompt_submit', 'prompt', false],
  ['PreToolUse', 'pre_tool_use', 'tool-start', true],
  ['PostToolUse', 'post_tool_use', 'tool-complete', true],
  ['PermissionRequest', 'permission_request', 'permission-request', false],
  ['Stop', 'stop', 'stop', false],
];

function defaultCodexHome() {
  return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.codex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

// Codex 对 command handler 的归一化：timeout 缺省 600、最小 1；async 总是序列化；
// commandWindows / statusMessage / matcher 为空时不进入 hash。
function codexHookTrustHash(eventLabel, matcher, handler) {
  const normalized = {
    type: 'command',
    command: String(handler.command),
    timeout: Math.max(1, Number.isInteger(handler.timeout) ? handler.timeout : 600),
    async: handler.async === true,
  };
  if (typeof handler.statusMessage === 'string') normalized.statusMessage = handler.statusMessage;
  const identity = { event_name: eventLabel, hooks: [normalized] };
  if (typeof matcher === 'string') identity.matcher = matcher;
  const json = JSON.stringify(canonical(identity));
  return 'sha256:' + crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

function hookArg(command) {
  const match = /session-hub-hook(?:\.py)?"?\s+([a-z-]+)\s*$/i.exec(String(command || ''));
  return match ? match[1] : null;
}

function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('hooks.json 不是对象');
  return parsed;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, 'utf8');
  fs.renameSync(temporary, file);
}

function copyHookScript(codexHome, sourceScript) {
  const target = path.join(codexHome, 'hub-scripts', 'session-hub-hook.py');
  const source = fs.readFileSync(sourceScript);
  let current = null;
  try { current = fs.readFileSync(target); } catch {}
  if (!current || !current.equals(source)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, source);
    fs.renameSync(temporary, target);
  }
  return target;
}

// TOML literal key：Windows 路径里没有单引号时可原样放进 '...'。
function tomlStateHeader(key) {
  if (key.includes("'") || /[\r\n]/.test(key)) return null;
  return `[hooks.state.'${key}']`;
}

// 只增改 Hub 自己的 [hooks.state.'<key>'] 表，其余文本逐字保留。
function upsertTrustedHashes(configText, entries) {
  const eol = configText.includes('\r\n') ? '\r\n' : '\n';
  const lines = configText.length ? configText.split(/\r?\n/) : [];
  let changed = false;
  const appended = [];
  for (const { key, hash } of entries) {
    const header = tomlStateHeader(key);
    if (!header) continue;
    const at = lines.findIndex(line => line.trim() === header);
    if (at < 0) {
      appended.push('', header, `trusted_hash = "${hash}"`);
      changed = true;
      continue;
    }
    let end = at + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
    const hashLine = lines.slice(at + 1, end).findIndex(line => /^\s*trusted_hash\s*=/.test(line));
    const wanted = `trusted_hash = "${hash}"`;
    if (hashLine < 0) { lines.splice(at + 1, 0, wanted); changed = true; }
    else if (lines[at + 1 + hashLine].trim() !== wanted) { lines[at + 1 + hashLine] = wanted; changed = true; }
    // 用户显式禁用过的条目尊重用户：保留 enabled = false，不替他打开。
  }
  if (!changed) return { changed: false, text: configText };
  let text = lines.join(eol);
  if (appended.length) {
    if (text.length && !text.endsWith(eol)) text += eol;
    if (!/\[hooks\.state\]/.test(text)) appended.unshift('', '[hooks.state]');
    text += appended.join(eol) + eol;
  }
  return { changed: true, text };
}

/**
 * 保证指定 CODEX_HOME 下 Hub 的 Codex hook 已部署且受信任。幂等；
 * 失败只返回 errors，由调用方显示降级，不抛出去拦住会话启动。
 */
function ensureCodexHookIntegration({ codexHome = null, sourceScript = null, logger = console } = {}) {
  const home = path.resolve(codexHome || defaultCodexHome());
  const result = { codexHome: home, hooksChanged: false, trustChanged: false, trusted: [], errors: [] };
  const script = sourceScript || path.join(__dirname, '..', 'scripts', 'session-hub-hook.py')
    .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  const hooksPath = path.join(home, 'hooks.json');
  const configPath = path.join(home, 'config.toml');
  try {
    const target = copyHookScript(home, script);
    const hooksFile = readJson(hooksPath);
    if (!hooksFile.hooks || typeof hooksFile.hooks !== 'object' || Array.isArray(hooksFile.hooks)) hooksFile.hooks = {};
    const hooks = hooksFile.hooks;
    for (const [eventName, , arg, asyncHook] of HUB_CODEX_HOOKS) {
      if (!Array.isArray(hooks[eventName])) hooks[eventName] = [];
      const present = hooks[eventName].some(group => Array.isArray(group && group.hooks)
        && group.hooks.some(handler => String(handler && handler.command || '').includes(MARKER)
          && hookArg(handler.command) === arg));
      if (present) continue;
      hooks[eventName].push({ hooks: [{ type: 'command', command: `python "${target}" ${arg}`,
        timeout: TIMEOUT_SEC, ...(asyncHook ? { async: true } : {}) }] });
      result.hooksChanged = true;
    }
    if (result.hooksChanged) writeAtomic(hooksPath, JSON.stringify(hooksFile, null, 2) + '\n');

    const trust = [];
    for (const [eventName, label] of HUB_CODEX_HOOKS) {
      (hooks[eventName] || []).forEach((group, groupIndex) => {
        (group && Array.isArray(group.hooks) ? group.hooks : []).forEach((handler, handlerIndex) => {
          if (!handler || handler.type !== 'command' || !String(handler.command || '').includes(MARKER)) return;
          trust.push({ key: `${hooksPath}:${label}:${groupIndex}:${handlerIndex}`,
            hash: codexHookTrustHash(label, typeof group.matcher === 'string' ? group.matcher : undefined, handler) });
        });
      });
    }
    let configText = '';
    try { configText = fs.readFileSync(configPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = upsertTrustedHashes(configText, trust);
    if (next.changed) { writeAtomic(configPath, next.text); result.trustChanged = true; }
    result.trusted = trust.map(entry => entry.key);
    if (result.hooksChanged || result.trustChanged) logger.log?.(`[codex-hooks] Hub hook 已部署并信任：${home}`);
  } catch (error) {
    result.errors.push(error.message);
    logger.warn?.(`[codex-hooks] ${home}: ${error.message}`);
  }
  return result;
}

module.exports = { HUB_CODEX_HOOKS, codexHookTrustHash, upsertTrustedHashes, ensureCodexHookIntegration, hookArg };
