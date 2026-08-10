'use strict';
// Per-CLI model lists — single source of truth for the single-session top-bar
// model picker (renderer.js) and round-table create modal (meeting-create-modal.js).
//
// Model picker options used by the renderer config modal.
//
// `canSwitchInline(kind)`: claude CLI 接受 `/model <id>\r` 原地切换；codex /
// deepseek / gemini PTY 实测不识别 inline `/model`（spec §3.1）——必须 kill + respawn with --model，
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
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash · Codex (1M)' },
  ],
  kimi: [
    { id: 'kimi-code/k3', label: 'Kimi K3' },
  ],
};

const DEFAULT_MODEL_BY_KIND = {
  claude: 'claude-opus-5[1m]',
  gemini: 'gemini-3-pro-preview',
  codex: 'gpt-5.6-sol',
  deepseek: 'deepseek-v4-flash',
  kimi: 'kimi-code/k3',
};

// Migration-only default. It is deliberately separate from the new-session
// default above: an old V4 Pro Claude transcript must not be silently resumed
// on Flash merely because new DeepSeek sessions now use Codex Responses.
const LEGACY_DEEPSEEK_CLAUDE_DEFAULT_MODEL = 'deepseek-v4-pro[1m]';

function normalizeDeepSeekModel(modelId) {
  const raw = String(modelId || '').trim().replace(/\[1m\]$/i, '');
  // V4 Pro 暂未开放 Responses API；旧会话保存的 Pro / legacy model 在切到
  // Codex runtime 后统一落到官方当前唯一支持的 V4 Flash。
  return raw === 'deepseek-v4-flash' ? raw : DEFAULT_MODEL_BY_KIND.deepseek;
}

function normalizeLegacyDeepSeekClaudeModel(modelId) {
  const raw = String(modelId || LEGACY_DEEPSEEK_CLAUDE_DEFAULT_MODEL).trim();
  if (!raw) return LEGACY_DEEPSEEK_CLAUDE_DEFAULT_MODEL;
  if (/^deepseek-/i.test(raw) && !/\[1m\]$/i.test(raw)) return `${raw}[1m]`;
  return raw;
}

function legacyDeepSeekClaudeDisplayName(modelId) {
  const normalized = normalizeLegacyDeepSeekClaudeModel(modelId);
  const base = normalized.replace(/\[1m\]$/i, '');
  if (base === 'deepseek-v4-pro') return 'DS V4 Pro 1M · Legacy Claude';
  if (base === 'deepseek-v4-flash') return 'DS V4 Flash 1M · Legacy Claude';
  return normalized;
}

function deepseekDisplayName(modelId) {
  const normalized = normalizeDeepSeekModel(modelId);
  if (normalized === 'deepseek-v4-flash') return 'DS V4 Flash · Codex 1M';
  return normalized;
}

// `<base>-resume` kinds 复用对应 base kind 清单（claude-resume → claude，等）。
function modelOptionsFor(kind) {
  if (!kind) return [];
  const base = String(kind).replace(/-resume$/, '');
  return MODEL_OPTIONS_BY_KIND[base] || [];
}

// 只有 Claude CLI 支持 inline `/model <id>\r`；DeepSeek 已迁移到 Codex。
const INLINE_SWITCH_BASE_KINDS = new Set([
  'claude',
]);

function canSwitchInline(kind) {
  if (!kind) return false;
  const base = String(kind).replace(/-resume$/, '');
  return INLINE_SWITCH_BASE_KINDS.has(base);
}

module.exports = {
  LEGACY_DEEPSEEK_CLAUDE_DEFAULT_MODEL,
  MODEL_OPTIONS_BY_KIND,
  DEFAULT_MODEL_BY_KIND,
  modelOptionsFor,
  canSwitchInline,
  normalizeDeepSeekModel,
  normalizeLegacyDeepSeekClaudeModel,
  legacyDeepSeekClaudeDisplayName,
  deepseekDisplayName,
};
