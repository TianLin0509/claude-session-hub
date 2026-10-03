'use strict';
// core/writing/member-opts.js
//
// 写作场景群聊成员的启动参数。新建与休眠唤醒两条路径都用它，保证重启后写作成员依然「干净」。
//
// 盲测结论（2026-09-26）：起草时带着工程规则（先说结论、区分已验证/推断、产物命名……）
// 会把 AI 腔带进文章。所以写作成员：
//   - purpose = 'writing'：Hub 发消息时不再追加共享工作区规则（core/hub-memory-service.js）
//   - Claude：不加载任何 CLAUDE.md，也不加载 auto-memory。不能用 --setting-sources local，
//     Hub 判断 PTY 会话状态依赖 ~/.claude/settings.json 里的 hooks。
//   - Codex：目前没有不加载 CODEX_HOME/AGENTS.md 的开关；文章目录里放 .vibe-root，
//     让它把文章目录当项目根，不再往上读 C:\AIWork 的规则。格式由写作群规则压住。
//
// 2026-10-03 文风作为常驻指令（core/writing/voice-pack.js）：启动 / 唤醒时刷新文章目录里的 AGENTS.md，
// Codex 自动加载它；Claude 用 --append-system-prompt-file 追加同一个文件。

const { writeVoicePack } = require('./voice-pack.js');

// deepseek-legacy 走的也是 Claude CLI（core/ai-kinds.js 的 CLAUDE_FAMILY），同样要关掉 CLAUDE.md
function isClaudeKind(kind) {
  return /^(claude|deepseek-legacy)(?:$|-)/.test(String(kind || ''));
}

/**
 * @param kind  成员 CLI 类型
 * @param opts  会话启动参数
 * @param ctx   { dir }：文章目录（写作群的 workspace）。给了就刷新文风包并接到成员上
 */
function withWritingMemberOpts(kind, opts = {}, ctx = {}) {
  const next = { ...opts, purpose: 'writing' };
  const pack = ctx && ctx.dir ? writeVoicePack(ctx.dir) : null;
  if (isClaudeKind(kind)) {
    next.extraEnv = { ...(opts.extraEnv || {}), CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
    if (pack) next.appendSystemPromptFile = pack;
  }
  return next;
}

module.exports = { withWritingMemberOpts, isClaudeKind };
