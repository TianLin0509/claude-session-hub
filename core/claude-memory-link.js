'use strict';
// Claude Code 的 memory 目录按 cwd 分桶：~/<root>/projects/<slug(cwd)>/memory。
// Hub 现在每个任务都开在全新的 _scratch/inbox-*，归档后路径又变一次，所以用户
// 积累的记忆库（默认在 home 目录对应的桶里）在任何 Hub 会话中都读不到。
//
// 这里在会话 spawn 前把新桶的 memory 指向同一个规范库（Windows junction，
// 不需要管理员权限）。deepseek 走 CLAUDE_CONFIG_DIR=~/.claude-deepseek，
// transcript/settings 刻意隔离，但记忆（用户偏好、协作约定）是要共享的，
// 所以两个 root 都指向同一份库。

const fs = require('fs');
const os = require('os');
const path = require('path');

const { CLAUDE_PROJECT_ROOT_DIRS, projectSlug } = require('./claude-transcript-locator.js');

function defaultHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

// 规范库 = home 目录自身的 project 桶，也就是用户在迁移到 C:\Vibe 之前
// 一直在用的那个（~/.claude/projects/C--Users-lintian/memory）。
function canonicalMemoryDir(homeDir = defaultHomeDir()) {
  return path.join(homeDir, '.claude', 'projects', projectSlug(homeDir), 'memory');
}

function isLinked(memoryPath) {
  try {
    return fs.lstatSync(memoryPath).isSymbolicLink();
  } catch {
    return false;
  }
}

// 已经是真实目录（用户手写过记忆）时绝不覆盖——只在空缺时补链接。
function ensureMemoryLink(cwd, opts = {}) {
  const result = { linked: [], skipped: [], errors: [] };
  if (!cwd) return result;
  const homeDir = opts.homeDir || defaultHomeDir();
  const canonical = opts.canonicalDir || canonicalMemoryDir(homeDir);
  const logger = opts.logger || console;

  let canonicalExists = false;
  try { canonicalExists = fs.statSync(canonical).isDirectory(); } catch {}
  if (!canonicalExists) {
    result.skipped.push(`canonical memory store missing: ${canonical}`);
    return result;
  }

  const slug = projectSlug(cwd);
  for (const root of CLAUDE_PROJECT_ROOT_DIRS) {
    const bucket = path.join(homeDir, root, 'projects', slug);
    const memoryPath = path.join(bucket, 'memory');
    try {
      if (path.resolve(memoryPath) === path.resolve(canonical)) {
        result.skipped.push(memoryPath);
        continue;
      }
      if (fs.existsSync(memoryPath) || isLinked(memoryPath)) {
        result.skipped.push(memoryPath);
        continue;
      }
      fs.mkdirSync(bucket, { recursive: true });
      fs.symlinkSync(canonical, memoryPath, 'junction');
      result.linked.push(memoryPath);
    } catch (error) {
      result.errors.push(`${memoryPath}: ${error && error.message ? error.message : String(error)}`);
      logger.warn?.('[memory] link failed:', error && error.message);
    }
  }
  return result;
}

module.exports = {
  canonicalMemoryDir,
  ensureMemoryLink,
};
