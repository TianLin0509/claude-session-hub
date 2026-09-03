'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MODEL_OPTIONS_BY_KIND,
  isClaudeModelSelection,
} = require('./model-options.js');

function resolveClaudeStatePath({ configDir, homeDir = os.homedir(), fsModule = fs } = {}) {
  const candidates = [];
  if (configDir) candidates.push(path.join(configDir, '.claude.json'));
  if (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR !== configDir) {
    candidates.push(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'));
  }
  candidates.push(path.join(homeDir, '.claude.json'));
  return candidates.find(candidate => {
    try { return fsModule.existsSync(candidate); } catch (_) { return false; }
  }) || candidates[0];
}

function humanizeClaudeModelId(modelId) {
  const id = String(modelId || '').trim();
  const has1m = /\[1m\]$/i.test(id);
  const bare = id.replace(/\[1m\]$/i, '').replace(/^claude-/i, '');
  if (['fable', 'opus', 'sonnet', 'haiku'].includes(bare.toLowerCase())) {
    return `${bare[0].toUpperCase()}${bare.slice(1)} · 最新可用版本`;
  }
  const match = bare.match(/^(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i);
  if (!match) return id;
  const family = `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}`;
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `${family} ${version}${has1m ? ' (1M context)' : ''}`;
}

function collectCachedModelOptions(value, result = [], depth = 0) {
  if (depth > 5 || value == null) return result;
  if (Array.isArray(value)) {
    value.forEach(item => collectCachedModelOptions(item, result, depth + 1));
    return result;
  }
  if (typeof value !== 'object') return result;
  const id = String(value.value || value.id || value.model || '').trim();
  if (isClaudeModelSelection(id)) {
    result.push({
      id,
      label: humanizeClaudeModelId(id),
      description: String(value.description || '').trim(),
      source: 'claude-cli-cache',
    });
    return result;
  }
  Object.values(value).forEach(item => collectCachedModelOptions(item, result, depth + 1));
  return result;
}

function readClaudeModelCache(options = {}) {
  const fsModule = options.fsModule || fs;
  const statePath = options.statePath || resolveClaudeStatePath({ ...options, fsModule });
  try {
    const parsed = JSON.parse(fsModule.readFileSync(statePath, 'utf8'));
    const models = collectCachedModelOptions(parsed && parsed.additionalModelOptionsCache);
    let mtimeMs = 0;
    try { mtimeMs = Number(fsModule.statSync(statePath).mtimeMs) || 0; } catch (_) {}
    return { models, statePath, mtimeMs, loaded: models.length > 0 };
  } catch (error) {
    return {
      models: [],
      statePath,
      mtimeMs: 0,
      loaded: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function mergeModelOptions(primary, fallback) {
  const result = [];
  const seen = new Set();
  for (const option of [...(primary || []), ...(fallback || [])]) {
    if (!option || !isClaudeModelSelection(option.id)) continue;
    const key = String(option.id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...option,
      id: String(option.id),
      label: String(option.label || humanizeClaudeModelId(option.id)),
    });
  }
  return result;
}

function buildClaudeModelSnapshot(options = {}) {
  const cache = readClaudeModelCache(options);
  const fallback = (options.fallbackOptions || MODEL_OPTIONS_BY_KIND.claude || [])
    .map(option => ({ ...option, source: option.source || 'static-fallback' }));
  return {
    ok: true,
    models: mergeModelOptions(cache.models, fallback),
    catalogLoaded: cache.loaded,
    source: cache.loaded ? 'claude-cli-cache' : 'static-fallback',
    catalogMtimeMs: cache.mtimeMs,
    cachePath: cache.statePath,
    ...(cache.error ? { refreshError: cache.error } : {}),
  };
}

module.exports = {
  buildClaudeModelSnapshot,
  collectCachedModelOptions,
  humanizeClaudeModelId,
  mergeModelOptions,
  readClaudeModelCache,
  resolveClaudeStatePath,
};
