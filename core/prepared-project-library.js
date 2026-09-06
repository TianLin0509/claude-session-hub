'use strict';
/**
 * 项目库：Hub 见过的目录里，哪些已经被 project-prep skill 整理成「可开并行群聊」的项目。
 *
 * 判据只有两条，和 renderer/dev-workspace-guard.js 的放行条件一致：
 *   1. `.git` 是**目录**（主工作树）。linked worktree 的 `.git` 是一个文件，
 *      那是 agent 干活用的临时目录，不是项目根 —— 列进去只会让「AI HUB」出现十几个重名项。
 *   2. `.agents/project.json` 存在且能解析。中文名取它的 `name` 字段，没有就用目录名。
 *
 * 活跃时间取三路最大值：Hub 注册表 / 会话 / 会议记的 lastUsedAt、`.git` 里几个随操作
 * 更新的文件 mtime。后者让「在别的终端 commit 过」的项目也能排到前面。
 */
const fs = require('fs');
const path = require('path');

const GIT_ACTIVITY_FILES = ['index', 'HEAD', 'ORIG_HEAD', 'FETCH_HEAD', path.join('logs', 'HEAD'), 'packed-refs'];

function normalizeKey(p) {
  return String(p || '').replace(/[\\/]+$/, '').toLowerCase();
}

function _mtime(_fs, p) {
  try { return Number(_fs.statSync(p).mtimeMs) || 0; } catch (e) { return 0; }
}

/**
 * @param {string} dir
 * @returns {{name: string, trunk: string, gitActiveAt: number}|null} null = 不是整理过的项目根
 */
function inspectPreparedProject(dir, deps = {}) {
  const _fs = deps.fs || fs;
  const _path = deps.path || path;
  if (!dir || typeof dir !== 'string') return null;
  let gitStat = null;
  try { gitStat = _fs.statSync(_path.join(dir, '.git')); } catch (e) { return null; }
  if (!gitStat.isDirectory()) return null;
  let cfg = null;
  try {
    cfg = JSON.parse(_fs.readFileSync(_path.join(dir, '.agents', 'project.json'), 'utf-8'));
  } catch (e) {
    return null;
  }
  if (!cfg || typeof cfg !== 'object') return null;
  const name = typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : _path.basename(dir);
  const trunk = typeof cfg.trunk === 'string' && cfg.trunk.trim() ? cfg.trunk.trim() : '';
  const gitActiveAt = GIT_ACTIVITY_FILES.reduce(
    (max, rel) => Math.max(max, _mtime(_fs, _path.join(dir, '.git', rel))), 0);
  return { name, trunk, gitActiveAt };
}

/**
 * @param {Array<{path: string, activeAt?: number}>} candidates 候选目录（可重复，可含非项目）
 * @returns {Array<{name: string, path: string, trunk: string, activeAt: number}>} 按活跃时间降序
 */
function listPreparedProjects(candidates, deps = {}) {
  const _path = deps.path || path;
  const byKey = new Map();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const raw = c && typeof c.path === 'string' ? c.path.trim() : '';
    if (!raw) continue;
    const resolved = _path.resolve(raw);
    const key = normalizeKey(resolved);
    const at = Number(c.activeAt) || 0;
    const prev = byKey.get(key);
    if (prev) prev.activeAt = Math.max(prev.activeAt, at);
    else byKey.set(key, { path: resolved, activeAt: at });
  }
  const out = [];
  for (const entry of byKey.values()) {
    const info = inspectPreparedProject(entry.path, deps);
    if (!info) continue;
    out.push({
      name: info.name,
      path: entry.path,
      trunk: info.trunk,
      activeAt: Math.max(entry.activeAt, info.gitActiveAt),
    });
  }
  out.sort((a, b) => (b.activeAt - a.activeAt) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return out;
}

module.exports = { listPreparedProjects, inspectPreparedProject, normalizeKey };
