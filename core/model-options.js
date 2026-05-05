'use strict';
// Per-CLI model lists — single source of truth for the single-session top-bar
// model picker (renderer.js) and round-table create modal (meeting-create-modal.js).
//
// Spec: docs/superpowers/specs/2026-05-01-per-cli-model-picker-design.md §6.1
//
// `canSwitchInline(kind)`: claude CLI 接受 `/model <id>\r` 原地切换；deepseek / glm /
// gpt / kimi / qwen 都是 claude CLI + ANTHROPIC_BASE_URL 中转，同样走该路径。codex /
// gemini PTY 实测不识别 inline `/model`（spec §3.1）——必须 kill + respawn with --model，
// 本期未实现，picker 端给明确提示而不是默默无效切换。

const MODEL_OPTIONS_BY_KIND = {
  claude: [
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
    { id: 'gpt-5.5',       label: 'GPT-5.5' },
    { id: 'gpt-5.4',       label: 'GPT-5.4' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  ],
  deepseek: [
    { id: 'deepseek-v4-pro',   label: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  ],
  glm: [
    { id: 'glm-5.1',     label: 'GLM 5.1' },
    { id: 'glm-4.6',     label: 'GLM 4.6' },
    { id: 'glm-4.5-air', label: 'GLM 4.5 Air' },
  ],
  // PackyAPI 三家：跑在 Claude CLI 上（ANTHROPIC_BASE_URL 中转），model id 由 PackyAPI 端确定。
  // 注意：gpt kind 不含 'gpt-5.5'——PackyAPI 中转目前仅支持到 5.4 系列；'gpt-5.5' 只在 codex kind
  // （OpenAI 官方 codex CLI 直连订阅）下可用。
  gpt: [
    { id: 'gpt-5.4-high', label: 'GPT-5.4 High' },
    { id: 'gpt-5.4',      label: 'GPT-5.4' },
  ],
  kimi: [
    { id: 'kimi-k2.5', label: 'Kimi K2.5' },
  ],
  qwen: [
    { id: 'qwen3.6-plus', label: 'Qwen 3.6 Plus' },
  ],
};

// `<base>-resume` kinds 复用对应 base kind 清单（claude-resume → claude，等）。
function modelOptionsFor(kind) {
  if (!kind) return [];
  const base = String(kind).replace(/-resume$/, '');
  return MODEL_OPTIONS_BY_KIND[base] || [];
}

// 走 claude CLI 的 kind（含直连 + 中转）支持 inline `/model <id>\r`。
const INLINE_SWITCH_BASE_KINDS = new Set([
  'claude', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen',
]);

function canSwitchInline(kind) {
  if (!kind) return false;
  const base = String(kind).replace(/-resume$/, '');
  return INLINE_SWITCH_BASE_KINDS.has(base);
}

module.exports = { MODEL_OPTIONS_BY_KIND, modelOptionsFor, canSwitchInline };
