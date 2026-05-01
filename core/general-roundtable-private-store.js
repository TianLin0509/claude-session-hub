'use strict';
// General Roundtable Private Store — 私聊历史持久化
// 私聊（@<who> 单家或多家但非全员）独立存储，不入 roundtable.json 的 turns。
//
// 文件结构：<arena-prompts>/<meetingId>-roundtable-private.json
// {
//   <kind>: [{ ts, userInput, response }, ...],
//   ...
// }
//
// meeting-create-modal（2026-05-01）：去掉 claude/gemini/codex 白名单，
//   接受任意非空字符串 kind（含 deepseek/glm）；老 store 文件 schema 不变（向后兼容）。

const fs = require('fs');
const path = require('path');

const MAX_PRIVATE_TURNS_PER_KIND = 50;

function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function privateFilePath(hubDataDir, meetingId) {
  return path.join(arenaPromptsDir(hubDataDir), `${meetingId}-roundtable-private.json`);
}

function _validKind(k) {
  return !!(k && typeof k === 'string' && k.length > 0);
}

// 读 store：保持文件原 schema（任意 kind 顶层 key），但保证返回的每个 value
//   是数组（防 JSON 损坏导致下游 .push 抛错）。
function readPrivateStore(hubDataDir, meetingId) {
  const fp = privateFilePath(hubDataDir, meetingId);
  if (!fs.existsSync(fp)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = Array.isArray(v) ? v : [];
    }
    return out;
  } catch (e) {
    console.warn(`[private-store] read failed for ${meetingId}: ${e.message}`);
    return {};
  }
}

function appendPrivateTurn(hubDataDir, meetingId, kind, userInput, response) {
  if (!_validKind(kind)) {
    throw new Error(`invalid kind: ${kind}`);
  }
  const store = readPrivateStore(hubDataDir, meetingId);
  if (!Array.isArray(store[kind])) store[kind] = [];
  store[kind].push({
    ts: Date.now(),
    userInput: typeof userInput === 'string' ? userInput : '',
    response: typeof response === 'string' ? response : '',
  });
  if (store[kind].length > MAX_PRIVATE_TURNS_PER_KIND) {
    store[kind] = store[kind].slice(-MAX_PRIVATE_TURNS_PER_KIND);
  }
  const dir = arenaPromptsDir(hubDataDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(privateFilePath(hubDataDir, meetingId), JSON.stringify(store, null, 2), 'utf-8');
}

function listPrivateTurns(hubDataDir, meetingId, kind) {
  const store = readPrivateStore(hubDataDir, meetingId);
  if (_validKind(kind)) {
    return Array.isArray(store[kind]) ? store[kind] : [];
  }
  return store;
}

// pilot-mode Task 4（2026-05-01）— sid 索引的私聊存储 API。
//   主驾期间用户和 pilot slot 的对话用此 API 隔离存储；切回时 _generatePilotRecap
//   读所有 turns + 构建 md 镜像 + 写 timeline 后调 clearPrivateTurnsBySid 清空，
//   下个主驾窗口起点重置。键名加 'sid:' 前缀，与老 kind 键名（claude/gemini/...）
//   显式区隔，便于诊断 + 防误删。
function _sidKey(sid) {
  if (!sid || typeof sid !== 'string') throw new Error(`invalid sid: ${sid}`);
  return `sid:${sid}`;
}

function appendPrivateTurnBySid(hubDataDir, meetingId, sid, userInput, response) {
  const key = _sidKey(sid);
  const store = readPrivateStore(hubDataDir, meetingId);
  if (!Array.isArray(store[key])) store[key] = [];
  store[key].push({
    ts: Date.now(),
    userInput: typeof userInput === 'string' ? userInput : '',
    response: typeof response === 'string' ? response : '',
  });
  if (store[key].length > MAX_PRIVATE_TURNS_PER_KIND) {
    store[key] = store[key].slice(-MAX_PRIVATE_TURNS_PER_KIND);
  }
  const dir = arenaPromptsDir(hubDataDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(privateFilePath(hubDataDir, meetingId), JSON.stringify(store, null, 2), 'utf-8');
}

function listPrivateTurnsBySid(hubDataDir, meetingId, sid) {
  const key = _sidKey(sid);
  const store = readPrivateStore(hubDataDir, meetingId);
  return Array.isArray(store[key]) ? store[key] : [];
}

function clearPrivateTurnsBySid(hubDataDir, meetingId, sid) {
  const key = _sidKey(sid);
  const store = readPrivateStore(hubDataDir, meetingId);
  if (!(key in store)) return false;
  delete store[key];
  const dir = arenaPromptsDir(hubDataDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(privateFilePath(hubDataDir, meetingId), JSON.stringify(store, null, 2), 'utf-8');
  return true;
}

module.exports = {
  appendPrivateTurn,
  listPrivateTurns,
  readPrivateStore,
  privateFilePath,
  appendPrivateTurnBySid,
  listPrivateTurnsBySid,
  clearPrivateTurnsBySid,
  MAX_PRIVATE_TURNS_PER_KIND,
};
