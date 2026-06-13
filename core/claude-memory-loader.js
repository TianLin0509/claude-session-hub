'use strict';
// core/claude-memory-loader.js
//
// 2026-06-05 替代 shared-memory-loader.js（联邦记忆方案下线）。
// 设计目标：
// - 群聊只在 DeepSeek 上注入 Claude 主工作台的 MEMORY.md（用 --append-system-prompt-file）
// - Claude / Codex / 其它 AI 都不再额外注入记忆（依赖各自原生 auto-memory）
// - 注入内容前面加一段 header，告诉 DeepSeek 详细记忆文件的绝对路径前缀
//   （群聊 cwd 是 USERPROFILE，相对路径找不到 memory 详档）
//
// graceful：源 MEMORY.md 不存在 → 返回 null，不阻塞群聊创建。

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_MEMORY_DIR = path.join(
  os.homedir(),
  '.claude',
  'projects',
  'C--Users-lintian',
  'memory',
);
const CLAUDE_MEMORY_INDEX = path.join(CLAUDE_MEMORY_DIR, 'MEMORY.md');

let _cache = { sourceMtimeMs: 0, targetPath: null };

function _buildInjectText(memoryContent) {
  const header = [
    '# Claude 主工作台 Memory（注入给 DeepSeek 的只读副本）',
    '',
    '以下是 Claude Code 主工作台维护的 memory 索引。如需查看详细记忆条目，',
    `请用 Read 工具读取绝对路径：${CLAUDE_MEMORY_DIR}\\<filename>`,
    `（例如 [user_profile.md](user_profile.md) 对应 ${path.join(CLAUDE_MEMORY_DIR, 'user_profile.md')}）`,
    '',
    '不要用相对路径找这些详档——群聊 cwd 是 C:\\Users\\lintian 而不是 memory 目录。',
    '',
    '---',
    '',
  ].join('\n');
  return header + memoryContent;
}

/**
 * 生成（或复用）注入文件，返回绝对路径。
 * 调用方拿这个路径喂给 --append-system-prompt-file。
 *
 * @param {string} hubDataDir Hub 数据目录（隔离/生产都遵循 CLAUDE_HUB_DATA_DIR）
 * @returns {string|null} 注入文件路径；源 MEMORY.md 缺失或写入失败时返回 null
 */
function ensureClaudeMemoryFile(hubDataDir) {
  if (!fs.existsSync(CLAUDE_MEMORY_INDEX)) {
    return null;
  }
  let stat;
  try {
    stat = fs.statSync(CLAUDE_MEMORY_INDEX);
  } catch {
    return null;
  }

  const targetDir = path.join(hubDataDir, 'arena-prompts');
  const targetPath = path.join(targetDir, 'claude-memory-injection.md');

  // 缓存命中：源未变 + 目标文件存在 → 直接复用
  if (
    _cache.sourceMtimeMs === stat.mtimeMs &&
    _cache.targetPath === targetPath &&
    fs.existsSync(targetPath)
  ) {
    return targetPath;
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const content = fs.readFileSync(CLAUDE_MEMORY_INDEX, 'utf-8');
    fs.writeFileSync(targetPath, _buildInjectText(content), 'utf-8');
    _cache = { sourceMtimeMs: stat.mtimeMs, targetPath };
    return targetPath;
  } catch (err) {
    console.warn('[claude-memory-loader] write inject file failed:', err.message);
    return null;
  }
}

function invalidateCache() {
  _cache = { sourceMtimeMs: 0, targetPath: null };
}

module.exports = {
  ensureClaudeMemoryFile,
  invalidateCache,
  CLAUDE_MEMORY_DIR,
  CLAUDE_MEMORY_INDEX,
};
