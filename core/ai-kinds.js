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
//   所有 8 家 AI CLI 都是 TUI alt-screen；powershell 等普通 shell 不是。
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

// ---------------------------------------------------------------------------
// Phase 4 family canonical 映射（圆桌记忆系统按家族存储）
//   - 'codex' (Codex CLI) 与 'gpt' (packy-gpt 跑 GPT-5.5) 都是 OpenAI 家族 → 合并到 'gpt'
//   - 'claude-resume' 是 Claude resume 路径（语义同 'claude'）→ 归为 'claude'
//   - 其他 7 个 kind 各自独立家族
//   返回 7 个家族字符串：claude / gemini / gpt / deepseek / glm / kimi / qwen
// ---------------------------------------------------------------------------
// 圆桌记忆系统的 7 个家族存储 key 集合（去重 canonical 后）
const FAMILY_KINDS = ['claude', 'gemini', 'gpt', 'deepseek', 'glm', 'kimi', 'qwen'];
const _FAMILY_SET = new Set(FAMILY_KINDS);

function canonicalAiKind(rawKind) {
  if (rawKind === 'codex') return 'gpt';
  if (rawKind === 'claude-resume') return 'claude';
  const out = rawKind || 'unknown';
  // [Phase 4 silent-failure-hunt] 静默 fall-through 会让未来新加的 kind（如 'mistral'）
  //   生成预期外的 .md 文件，且 _runLegacyMigration 不会归档它（因为不在 FAMILY_SET）。
  //   warn 一次即可让维护者知道补 FAMILY_KINDS。
  if (!_FAMILY_SET.has(out) && out !== 'unknown') {
    console.warn(`[ai-kinds] canonicalAiKind: unknown kind '${rawKind}', treating as-is — 请补 FAMILY_KINDS`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 圆桌席位（slot）单一真理源 — 2026-05-03 道雪
//   背景：圆桌允许 5 选 3 + 同 kind 多份（如 3 claude），按 kind 区分总结人/@对象
//     不可行（dropdown 只显 1 个 Claude，sidByKind 永远返回首匹配）。改为按 slot 索引
//     绑定 stable id（pikachu/charmander/squirtle），@解析、prompt、归档全用 slot id。
//   命名：内部 id 走 ASCII（让正则 \b 边界正常工作），UI 显示中英双语方便用户识别。
//   头像图片已存在（renderer/assets/）—— 本常量只补语义/正则/显示标签，UI 不动头像逻辑。
// ---------------------------------------------------------------------------
const SLOT_IDS = ['pikachu', 'charmander', 'squirtle'];

const SLOT_DISPLAY = {
  pikachu:    { en: 'Pikachu',    zh: '皮卡丘', icon: '⚡' },
  charmander: { en: 'Charmander', zh: '小火龙', icon: '🔥' },
  squirtle:   { en: 'Squirtle',   zh: '杰尼龟', icon: '💎' },
};

// 给 prompt 用的纯英文名（AI 上下文用，国际化稳定）。
function getSlotPromptName(slotIdOrIndex) {
  const id = typeof slotIdOrIndex === 'number' ? SLOT_IDS[slotIdOrIndex] : slotIdOrIndex;
  return SLOT_DISPLAY[id]?.en || 'AI';
}

// 给 UI 卡片显示用的双语标签（含 emoji）。
function getSlotDisplayLabel(slotIdOrIndex) {
  const id = typeof slotIdOrIndex === 'number' ? SLOT_IDS[slotIdOrIndex] : slotIdOrIndex;
  const d = SLOT_DISPLAY[id];
  return d ? `${d.icon} ${d.en} · ${d.zh}` : 'AI';
}

// 正则字符类，用于 @<slot> / @summary @<slot> 命令解析。返回 "pikachu|charmander|squirtle"。
function slotIdRegexAlternation() {
  return SLOT_IDS.join('|');
}

// slot id ↔ slot index 双向映射 helper。
function slotIdToIndex(slotId) {
  return SLOT_IDS.indexOf(slotId);
}
function slotIndexToId(idx) {
  return SLOT_IDS[idx] || null;
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
  // Phase 4 圆桌记忆家族级共享
  canonicalAiKind,
  FAMILY_KINDS,
  // slot 单一真理源
  SLOT_IDS,
  SLOT_DISPLAY,
  getSlotPromptName,
  getSlotDisplayLabel,
  slotIdRegexAlternation,
  slotIdToIndex,
  slotIndexToId,
};
