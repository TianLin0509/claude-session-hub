'use strict';
// Group chat scene helpers for research MCP injection.
// Prompt assembly lives in core/group-chat-orchestrator.js.
// This file only keeps the two helpers needed to attach stock research tools.
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
