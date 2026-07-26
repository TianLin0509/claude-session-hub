'use strict';
// Per-CLI model lists — single source of truth for the single-session top-bar
// model picker (renderer.js) and round-table create modal (meeting-create-modal.js).
//
// Model picker options used by the renderer config modal.
//
// `canSwitchInline(kind)`: claude CLI 接受 `/model <id>\r` 原地切换；deepseek
// 是 claude CLI + ANTHROPIC_BASE_URL 中转，同样走该路径。codex /
// gemini PTY 实测不识别 inline `/model`（spec §3.1）——必须 kill + respawn with --model，
// 本期未实现，picker 端给明确提示而不是默默无效切换。

const MODEL_OPTIONS_BY_KIND = {
  claude: [
    { id: 'claude-opus-5[1m]',   label: 'Opus 5 (1M context)' },
    { id: 'claude-opus-5',       label: 'Opus 5' },
    { id: 'claude-fable-5',      label: 'Fable 5' },
    { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M context)' },
    { id: 'claude-opus-4-8',     label: 'Opus 4.8' },
    { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M context)' },
    { id: 'claude-opus-4-7',     label: 'Opus 4.7' },
    { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M context)' },
    { id: 'claude-opus-4-6',     label: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6',   label: 'Sonnet 4.6' },
    { id: 'claude-sonnet-4-5',   label: 'Sonnet 4.5' },
    { id: 'claude-haiku-4-5',    label: 'Haiku 4.5' },
  ],
  gemini: [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-2.5-pro',       label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash',     label: 'Gemini 2.5 Flash' },
  ],
  codex: [
    { id: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.5',       label: 'GPT-5.5' },
    { id: 'gpt-5.4',       label: 'GPT-5.4' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  ],
  deepseek: [
    { id: 'deepseek-v4-pro[1m]',   label: 'DeepSeek V4 Pro (1M context)' },
    { id: 'deepseek-v4-flash[1m]', label: 'DeepSeek V4 Flash (1M context)' },
  ],
  kimi: [
    { id: 'kimi-code/k3', label: 'Kimi K3' },
  ],
};

const DEFAULT_MODEL_BY_KIND = {
  claude: 'claude-opus-5[1m]',
  gemini: 'gemini-3-pro-preview',
  codex: 'gpt-5.6-sol',
  deepseek: 'deepseek-v4-pro[1m]',
  kimi: 'kimi-code/k3',
};

function normalizeDeepSeekModel(modelId) {
  const raw = String(modelId || DEFAULT_MODEL_BY_KIND.deepseek).trim();
  if (!raw) return DEFAULT_MODEL_BY_KIND.deepseek;
  if (/^deepseek-/i.test(raw) && !/\[1m\]$/i.test(raw)) return `${raw}[1m]`;
  return raw;
}

function deepseekDisplayName(modelId) {
  const normalized = normalizeDeepSeekModel(modelId);
  const isOneM = /\[1m\]$/i.test(normalized);
  const base = normalized.replace(/\[1m\]$/i, '');
  if (base === 'deepseek-v4-pro') return isOneM ? 'DS V4 Pro 1M' : 'DS V4 Pro';
  if (base === 'deepseek-v4-flash') return isOneM ? 'DS V4 Flash 1M' : 'DS V4 Flash';
  return normalized;
}

// `<base>-resume` kinds 复用对应 base kind 清单（claude-resume → claude，等）。
function modelOptionsFor(kind) {
  if (!kind) return [];
  const base = String(kind).replace(/-resume$/, '');
  return MODEL_OPTIONS_BY_KIND[base] || [];
}

// 走 claude CLI 的 kind（含直连 + 中转）支持 inline `/model <id>\r`。
const INLINE_SWITCH_BASE_KINDS = new Set([
  'claude', 'deepseek',
]);

function canSwitchInline(kind) {
  if (!kind) return false;
  const base = String(kind).replace(/-resume$/, '');
  return INLINE_SWITCH_BASE_KINDS.has(base);
}

module.exports = {
  MODEL_OPTIONS_BY_KIND,
  DEFAULT_MODEL_BY_KIND,
  modelOptionsFor,
  canSwitchInline,
  normalizeDeepSeekModel,
  deepseekDisplayName,
};
