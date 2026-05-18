'use strict';
// Group Chat scene helpers — research MCP 工具注入辅助。
//
// 历史：本文件原承载多层 prompt 装配引擎（BASE_RULES + scene preset + COVENANT + L3 slot bias 等），
//   在 2026-05 群聊扶正过程中被绕过：群聊真正的 prompt 注入由
//   `core/group-chat-orchestrator.js#buildSystemPromptText` 在首条 user message 头部完成。
//   prompt 装配引擎 / SCENE_REGISTRY / SLOT_BIASES / dev L2b 模板等已删（见 git history）。
//
// 现仅保留 research 场景挂载 stock MCP 工具所需的两个函数。memory MCP 工具相关代码
//   待 memory 全链路下线时一并清理。

const fs = require('fs');
const path = require('path');

function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 写 MCP config 文件（Claude/DS/GLM 等 Claude CLI 家族用 --mcp-config 注入投研工具）。
 */
function writeResearchMcpConfig(hubDataDir, meetingId, hookPort, hookToken, aiKind) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-research-mcp.json`);
  const mcpServerPath = path.resolve(__dirname, 'research-mcp-server.js');
  const config = {
    mcpServers: {
      'arena-research': {
        command: process.execPath,
        args: [mcpServerPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          ARENA_MEETING_ID: meetingId,
          ARENA_HUB_PORT: String(hookPort),
          ARENA_HOOK_TOKEN: hookToken,
          ARENA_AI_KIND: aiKind || 'unknown',
        },
      },
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  return filePath;
}

/**
 * 给 Codex 启动命令的 MCP entry（codex toml 中 key 不能含 -）。
 */
function buildResearchMcpEntryForCodex(meetingId, hookPort, hookToken) {
  const mcpServerPath = path.resolve(__dirname, 'research-mcp-server.js');
  return {
    name: 'arena_research',
    command: process.execPath,
    args: [mcpServerPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ARENA_MEETING_ID: meetingId,
      ARENA_HUB_PORT: String(hookPort),
      ARENA_HOOK_TOKEN: hookToken,
      ARENA_AI_KIND: 'codex',
    },
  };
}

module.exports = {
  writeResearchMcpConfig,
  buildResearchMcpEntryForCodex,
};
