'use strict';
// core/writing/member-opts.js
//
// 写作场景群聊成员的启动参数。新建与休眠唤醒两条路径都用它，保证重启后写作成员依然「干净」。
//
// 盲测结论（2026-09-26）：起草时带着工程规则（先说结论、区分已验证/推断、产物命名……）
// 会把 AI 腔带进文章。2026-10-11 田哥进一步要求：写作成员是写文章的大师，不是编程助手，
// 上下文里只留写作需要的东西。日志核实过此前仍混进来的内容，现在逐项去掉：
//   - 编程助手的基础指令：Claude 用 --system-prompt-file、Codex 用 model_instructions_file，
//     都换成写作须知（core/writing/voice-pack.js 生成的文章目录 AGENTS.md）
//   - 个人协作约定：Claude 关 CLAUDE.md；Codex 换到写作专用配置目录（core/writing/codex-writing-home.js）
//   - 输出风格：Claude 用回默认输出风格，不带田哥日常的 Lintian-Plain
//   - 记忆、技能清单、插件、MCP、浏览器扩展说明：Claude 关自动记忆、关全部 skill、MCP 清空、--no-chrome；
//     Codex 在写作配置目录里关掉
//   - 工具：留读写文件、检索与上网查资料，够起草和交稿
//   - purpose = 'writing'：Hub 发消息时不再追加共享工作区规则（core/hub-memory-service.js）

const { writeVoicePack } = require('./voice-pack.js');

const WRITING_CLAUDE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

// deepseek-legacy 走的也是 Claude CLI（core/ai-kinds.js 的 CLAUDE_FAMILY），同样要关掉 CLAUDE.md
function isClaudeKind(kind) {
  return /^(claude|deepseek-legacy)(?:$|-)/.test(String(kind || ''));
}

/**
 * @param kind  成员 CLI 类型
 * @param opts  会话启动参数
 * @param ctx   { dir }：文章目录（写作群的 workspace）。给了就刷新写作须知并接到成员上
 */
function withWritingMemberOpts(kind, opts = {}, ctx = {}) {
  const next = { ...opts, purpose: 'writing', mcpProfile: 'none' };
  delete next.codexMcpEntries;
  delete next.mcpConfigFile;
  const pack = ctx && ctx.dir ? writeVoicePack(ctx.dir) : null;
  if (isClaudeKind(kind)) {
    next.extraEnv = { ...(opts.extraEnv || {}), CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' };
    next.claudeOutputStyle = 'default';
    next.disableSlashCommands = true;
    next.claudeNoChrome = true;
    next.claudeTools = [...WRITING_CLAUDE_TOOLS];
    delete next.appendSystemPromptFile;
    if (pack) next.systemPromptFile = pack;
  } else if (pack) {
    next.codexInstructionFile = pack;
  }
  return next;
}

module.exports = { withWritingMemberOpts, isClaudeKind, WRITING_CLAUDE_TOOLS };
