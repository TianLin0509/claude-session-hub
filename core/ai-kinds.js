'use strict';
// core/ai-kinds.js — AI kind 单一真理源
//
// 背景（2026-05-02 用户血泪反馈）：
//   项目最早只支持 claude/gemini/codex 三家，后加了 deepseek/glm（都跑在 Claude CLI 上），
//   但许多分支判断当时硬编码 ['claude', 'gemini', 'codex'] 三家，导致：
//     - 一键提取按钮对 DS/GLM 永远失败（"按钮假的"）
//     - DS/GLM 卡片不更新（依赖 Claude Stop hook，但分支没接通）
//     - DS/GLM 子 session 无法自动获取标题
//     - DS/GLM 普通发送可能卡输入框（缺 paste-detect 延迟补偿）
//     - DS/GLM aiStats 迁移失败（_isLegacyKindKeyed 白名单不全）
//     - BASE_RULES 系统 prompt 告诉 DS/GLM"你是 Claude/Gemini/Codex 三家之一"
//
// 解决：把所有"AI 列表 / 家族判定 / 标志位"集中到本文件，**所有调用方必须 require 这里的常量
//   和 helper**，禁止再写 ['claude', 'gemini', 'codex'] 字面量。
//   单测 unit-ai-kinds-no-hardcode.test.js 用 grep 兜底防回归。

// ---------------------------------------------------------------------------
// 全部支持的 AI kind（圆桌可参与的）。
//   新增 AI 时只需追加这个数组 + 补 KIND_LABELS。
//   不含 'powershell' 等非 AI 类型。
// ---------------------------------------------------------------------------
const ALL_AI_KINDS = ['claude', 'gemini', 'codex', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen'];

// ---------------------------------------------------------------------------
// 显示标签（UI 各处显示家族短名用）。
//   新增 AI 时同步追加。
// ---------------------------------------------------------------------------
const KIND_LABELS = {
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  gpt: 'GPT',
  kimi: 'Kimi',
  qwen: 'Qwen',
};

// ---------------------------------------------------------------------------
// Claude 家族（共享 Claude Code CLI 引擎）：
//   - claude         主 Claude（~/.claude）
//   - claude-resume  resume 路径（同主）
//   - deepseek       走 ~/.claude-deepseek 隔离配置
//   - glm            走 ~/.claude-glm 隔离配置
//   - gpt            走 ~/.claude-packy-gpt 隔离配置（PackyAPI 协议翻译，跑 GPT-5.5 等）
//   - kimi           走 ~/.claude-packy-kimi 隔离配置（PackyAPI bailian 分组，跑 kimi-k2.5）
//   - qwen           走 ~/.claude-packy-qwen 隔离配置（PackyAPI bailian 分组，跑 qwen3.6-plus）
// 共享：transcript JSONL shape / Stop hook / OSC title 协议 / system prompt 注入参数 (--append-system-prompt)
// ---------------------------------------------------------------------------
const CLAUDE_FAMILY = ['claude', 'claude-resume', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen'];

// ---------------------------------------------------------------------------
// TUI alt-screen 程序（paste-sensitive）：
//   把紧贴到达的字符当"粘贴"事件，紧贴的 \r 不会被识别为 Enter。
//   所有 5 家 AI CLI 都是 TUI alt-screen；powershell 等普通 shell 不是。
//   普通模式发送 prompt 时这些 kind 需要 ≥400ms 延迟才能让 paste-detect 完成。
// ---------------------------------------------------------------------------
const PASTE_SENSITIVE_KINDS = ['claude', 'claude-resume', 'gemini', 'codex', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen'];

// ---------------------------------------------------------------------------
// 跑在 Claude CLI 上、复用 Stop hook + transcript JSONL 的 kind。
//   ClaudeTap 用此判定。CLAUDE_FAMILY 的别名（语义相同），保留两个名字让调用点更可读。
// ---------------------------------------------------------------------------
const CLAUDE_HOOK_BACKED = CLAUDE_FAMILY;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isClaudeFamily(kind) {
  return CLAUDE_FAMILY.includes(kind);
}

function isPasteSensitive(kind) {
  return PASTE_SENSITIVE_KINDS.includes(kind);
}

function isAiKind(kind) {
  return ALL_AI_KINDS.includes(kind);
}

function getKindLabel(kind) {
  return KIND_LABELS[kind] || kind || 'AI';
}

// 用于 prompt 文本里枚举 "可参与的 AI"。返回类似 "Claude/Gemini/Codex/DeepSeek/GLM"。
function listKindsForPrompt() {
  return ALL_AI_KINDS.map(k => KIND_LABELS[k]).join('/');
}

// 正则字符类，用于 @summary @<who> / @<who> 等命令解析。
// 返回类似 "claude|gemini|codex|deepseek|glm"。
function kindRegexAlternation() {
  return ALL_AI_KINDS.join('|');
}

module.exports = {
  ALL_AI_KINDS,
  KIND_LABELS,
  CLAUDE_FAMILY,
  CLAUDE_HOOK_BACKED,
  PASTE_SENSITIVE_KINDS,
  isClaudeFamily,
  isPasteSensitive,
  isAiKind,
  getKindLabel,
  listKindsForPrompt,
  kindRegexAlternation,
};
