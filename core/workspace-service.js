'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getHubDataDir, isIsolatedHub } = require('./data-dir.js');

const REGISTRY_VERSION = 1;

function normalizeKey(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeSlug(value, fallback = 'workspace') {
  const ascii = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48);
  return ascii || fallback;
}

function timestampSlug(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

class WorkspaceService {
  constructor(opts = {}) {
    this.fs = opts.fs || fs;
    this.path = opts.path || path;
    this.os = opts.os || os;
    this.getHubDataDir = opts.getHubDataDir || getHubDataDir;
    this.isIsolatedHub = opts.isIsolatedHub || isIsolatedHub;
    this.now = opts.now || (() => Date.now());
    this.randomId = opts.randomId || (() => crypto.randomBytes(3).toString('hex'));
    this.logger = opts.logger || console;
    this.workspaceRoot = opts.workspaceRoot || null;
    this.initGit = opts.initGit || (cwd => {
      const result = childProcess.spawnSync('git', ['init', '--quiet'], {
        cwd,
        windowsHide: true,
        encoding: 'utf8',
      });
      return !result.error && result.status === 0;
    });
  }

  getWorkspaceRoot() {
    if (this.workspaceRoot) return this.path.resolve(this.workspaceRoot);
    const override = process.env.AI_HUB_WORKSPACE_ROOT;
    if (override && override.trim()) return this.path.resolve(override.trim());
    if (this.isIsolatedHub()) return this.path.join(this.getHubDataDir(), 'workspaces', 'user');
    return this.path.join(this.os.homedir(), 'Workspaces');
  }

  getScratchRoot() {
    return this.path.join(this.getWorkspaceRoot(), '_scratch');
  }

  getRegistryPath() {
    return this.path.join(this.getHubDataDir(), 'workspaces.json');
  }

  ensureRoot() {
    this.fs.mkdirSync(this.getWorkspaceRoot(), { recursive: true });
    this.fs.mkdirSync(this.getScratchRoot(), { recursive: true });
    return this.getWorkspaceRoot();
  }

  _emptyRegistry() {
    return { schemaVersion: REGISTRY_VERSION, selectedPath: null, workspaces: [] };
  }

  _readRegistry() {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.getRegistryPath(), 'utf8'));
      return {
        schemaVersion: REGISTRY_VERSION,
        selectedPath: typeof parsed.selectedPath === 'string' ? parsed.selectedPath : null,
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      };
    } catch (err) {
      if (err && err.code !== 'ENOENT') this.logger.warn('[workspace] registry read failed:', err.message);
      return this._emptyRegistry();
    }
  }

  _writeRegistry(registry) {
    const file = this.getRegistryPath();
    this.fs.mkdirSync(this.path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    this.fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
    this.fs.renameSync(tmp, file);
  }

  _isDirectory(value) {
    try { return this.fs.statSync(value).isDirectory(); } catch { return false; }
  }

  _defaultLabel(cwd) {
    const resolved = this.path.resolve(cwd);
    if (normalizeKey(resolved) === normalizeKey(this.os.homedir())) return '用户主目录（旧会话）';
    return this.path.basename(resolved) || resolved;
  }

  getWorkspace(cwd) {
    if (!cwd || typeof cwd !== 'string') return null;
    const resolved = this.path.resolve(cwd);
    const registry = this._readRegistry();
    const item = registry.workspaces.find(entry => normalizeKey(entry.path) === normalizeKey(resolved));
    return item ? { ...item } : null;
  }

  isScratchWorkspace(cwd) {
    if (!cwd || typeof cwd !== 'string') return false;
    const resolved = this.path.resolve(cwd);
    return isPathInside(this.getScratchRoot(), resolved);
  }

  listArchiveCategories() {
    this.ensureRoot();
    const excluded = new Set(['_scratch', '_admin', 'worktrees']);
    let entries = [];
    try { entries = this.fs.readdirSync(this.getWorkspaceRoot(), { withFileTypes: true }); } catch {}
    return entries
      .filter(entry => entry && entry.isDirectory() && !excluded.has(entry.name.toLowerCase()) && !entry.name.startsWith('.'))
      .map(entry => ({ name: entry.name, path: this.path.join(this.getWorkspaceRoot(), entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  // 用户关掉过归档框就不再追问这个 workspace（含「暂留 _scratch」和 ×/Esc）。
  // 落盘而不是只存内存，Hub 重启后同样不再打扰。
  dismissArchive(cwd) {
    if (!cwd) return null;
    const resolved = this.path.resolve(cwd);
    const registry = this._readRegistry();
    const item = registry.workspaces.find(entry => normalizeKey(entry.path) === normalizeKey(resolved));
    if (!item) return null;
    item.archiveDismissedAt = this.now();
    this._writeRegistry(registry);
    return { ...item };
  }

  getArchiveContext(cwd) {
    const workspace = this.getWorkspace(cwd);
    const required = !!(workspace && workspace.draft && !workspace.archiveDismissedAt
      && this.isScratchWorkspace(workspace.path));
    return {
      required,
      root: this.getWorkspaceRoot(),
      workspace,
      categories: this.listArchiveCategories(),
    };
  }

  planArchive(cwd, opts = {}) {
    const source = this.path.resolve(String(cwd || ''));
    const workspace = this.getWorkspace(source);
    if (!workspace || !workspace.draft || !this.isScratchWorkspace(source)) {
      throw new Error('workspace is not an active scratch draft');
    }

    const parent = this.path.resolve(String(opts.parent || ''));
    if (!this._isDirectory(parent)) throw new Error(`archive parent does not exist: ${parent}`);
    if (normalizeKey(parent) === normalizeKey(this.getWorkspaceRoot())) {
      throw new Error('请选择 Vibe 下的分类目录，不要把项目直接放在 Vibe 根目录');
    }
    if (normalizeKey(parent) === normalizeKey(this.getScratchRoot()) || isPathInside(this.getScratchRoot(), parent)) {
      throw new Error('归档目标不能仍在 _scratch 内');
    }

    const folderName = safeSlug(opts.folderName || workspace.suggestedName || workspace.label, workspace.id || 'workspace');
    const target = this.path.join(parent, folderName);
    if (normalizeKey(source) === normalizeKey(target) || isPathInside(source, target)) {
      throw new Error('archive target overlaps the scratch source');
    }
    if (this.path.parse(source).root.toLowerCase() !== this.path.parse(target).root.toLowerCase()) {
      throw new Error('暂不支持跨磁盘归档，请选择与 _scratch 相同磁盘上的路径');
    }
    if (this.fs.existsSync(target)) throw new Error(`目标路径已存在：${target}`);
    return { source, parent, folderName, target, workspace };
  }

  archiveDraft(cwd, opts = {}) {
    const plan = this.planArchive(cwd, opts);
    const registry = this._readRegistry();
    const item = registry.workspaces.find(entry => normalizeKey(entry.path) === normalizeKey(plan.source));
    if (!item) throw new Error('scratch workspace disappeared from registry');

    this.fs.renameSync(plan.source, plan.target);
    try {
      item.path = plan.target;
      item.label = String(opts.label || item.label || plan.folderName).trim().slice(0, 60) || plan.folderName;
      item.suggestedName = plan.folderName;
      item.draft = false;
      item.archivedAt = this.now();
      item.lastUsedAt = this.now();
      if (registry.selectedPath && normalizeKey(registry.selectedPath) === normalizeKey(plan.source)) {
        registry.selectedPath = plan.target;
      }
      this._writeRegistry(registry);
    } catch (error) {
      try { this.fs.renameSync(plan.target, plan.source); } catch (rollbackError) {
        this.logger.error?.('[workspace] archive registry rollback failed:', rollbackError && rollbackError.message);
      }
      throw error;
    }
    return { ...item };
  }

  touchWorkspace(cwd, meta = {}) {
    if (!cwd || typeof cwd !== 'string') throw new Error('workspace path is required');
    const resolved = this.path.resolve(cwd);
    if (!this._isDirectory(resolved)) throw new Error(`workspace directory does not exist: ${resolved}`);
    const registry = this._readRegistry();
    const key = normalizeKey(resolved);
    let item = registry.workspaces.find(entry => normalizeKey(entry.path) === key);
    if (!item) {
      item = {
        id: meta.id || this.randomId(),
        path: resolved,
        label: meta.label || this._defaultLabel(resolved),
        createdAt: this.now(),
        lastUsedAt: this.now(),
        draft: !!meta.draft,
        pinned: !!meta.pinned,
        gitInitialized: !!meta.gitInitialized,
      };
      registry.workspaces.push(item);
    } else {
      item.path = resolved;
      item.lastUsedAt = this.now();
      if (typeof meta.label === 'string' && meta.label.trim()) item.label = meta.label.trim().slice(0, 60);
      // Only ever raise the draft flag here. Clearing it is archiveDraft()'s job —
      // a stray `draft: false` from a reconnect used to silently kill the
      // first-turn archive prompt and strand the workspace in _scratch.
      if (meta.draft === true) item.draft = true;
      if (typeof meta.pinned === 'boolean') item.pinned = meta.pinned;
      if (typeof meta.gitInitialized === 'boolean') item.gitInitialized = meta.gitInitialized;
    }
    if (meta.select !== false) registry.selectedPath = resolved;
    this._writeRegistry(registry);
    return { ...item };
  }

  // Claude Code 会一路向上读到 <root>\CLAUDE.md，但 Codex / Kimi / Gemini 只读
  // 自己的全局 AGENTS.md 和 cwd 自身的那一份——实测在 _scratch\inbox-* 里
  // 问 <root>\AGENTS.md 独有的规则，Codex 答 NO-RULES（git / 非 git 都一样）。
  // 所以把工作区边界规则复制进每个新 scratch，非 Claude 的 CLI 才能拿到。
  seedScratchAgentsFile(cwd) {
    const root = this.getWorkspaceRoot();
    const source = this.path.join(root, 'AGENTS.md');
    const target = this.path.join(cwd, 'AGENTS.md');
    try {
      if (!this.fs.existsSync(source) || this.fs.existsSync(target)) return false;
      const header = `<!-- 由 AI Hub 在新建临时 workspace 时自动复制自 ${source}。\n`
        + `     Codex / Kimi / Gemini 读不到上级目录的 AGENTS.md，只能靠这份副本。\n`
        + `     归档到正式项目后可以删除，改用项目自己的 AGENTS.md。 -->\n\n`;
      this.fs.writeFileSync(target, header + this.fs.readFileSync(source, 'utf8'), 'utf8');
      return true;
    } catch (error) {
      this.logger.warn('[workspace] seed AGENTS.md failed:', error && error.message);
      return false;
    }
  }

  createScratchWorkspace(meta = {}) {
    this.ensureRoot();
    const name = `inbox-${timestampSlug(new Date(this.now()))}-${this.randomId()}`;
    const cwd = this.path.join(this.getScratchRoot(), name);
    this.fs.mkdirSync(cwd, { recursive: false });
    this.seedScratchAgentsFile(cwd);
    let gitInitialized = false;
    try { gitInitialized = !!this.initGit(cwd); } catch (err) {
      this.logger.warn('[workspace] scratch git init failed:', err && err.message);
    }
    return this.touchWorkspace(cwd, {
      label: meta.label || '未命名任务',
      draft: true,
      select: meta.select !== false,
      gitInitialized,
    });
  }

  resolveForSession(cwd, meta = {}) {
    if (typeof cwd === 'string' && cwd.trim()) return this.touchWorkspace(cwd.trim(), meta);
    return this.createScratchWorkspace(meta);
  }

  updateSuggestedName(cwd, title) {
    if (!cwd || !title) return null;
    const resolved = this.path.resolve(cwd);
    const registry = this._readRegistry();
    const item = registry.workspaces.find(entry => normalizeKey(entry.path) === normalizeKey(resolved));
    if (!item) return null;
    item.label = String(title).trim().slice(0, 60) || item.label;
    item.suggestedName = safeSlug(title, item.id || 'workspace');
    item.autoNamedAt = this.now();
    item.lastUsedAt = this.now();
    this._writeRegistry(registry);
    return { ...item };
  }

  renameLabel(cwd, label) {
    const clean = String(label || '').trim().slice(0, 60);
    if (!clean) throw new Error('workspace label is required');
    return this.touchWorkspace(cwd, { label: clean, select: true });
  }

  listWorkspaces(extraPaths = []) {
    this.ensureRoot();
    const registry = this._readRegistry();
    let changed = false;
    for (const cwd of extraPaths) {
      if (!cwd || typeof cwd !== 'string' || !this._isDirectory(cwd)) continue;
      const resolved = this.path.resolve(cwd);
      if (!registry.workspaces.some(entry => normalizeKey(entry.path) === normalizeKey(resolved))) {
        registry.workspaces.push({
          id: this.randomId(),
          path: resolved,
          label: this._defaultLabel(resolved),
          createdAt: this.now(),
          lastUsedAt: 0,
          draft: false,
          pinned: false,
          legacy: normalizeKey(resolved) === normalizeKey(this.os.homedir()),
        });
        changed = true;
      }
    }
    registry.workspaces = registry.workspaces.filter(entry => entry && entry.path && this._isDirectory(entry.path));
    if (changed) this._writeRegistry(registry);
    const selectedKey = registry.selectedPath ? normalizeKey(registry.selectedPath) : '';
    const items = registry.workspaces
      .map(entry => ({ ...entry, selected: normalizeKey(entry.path) === selectedKey }))
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    return {
      root: this.getWorkspaceRoot(),
      scratchRoot: this.getScratchRoot(),
      selectedPath: registry.selectedPath,
      items,
    };
  }
}

module.exports = {
  WorkspaceService,
  isPathInside,
  normalizeKey,
  safeSlug,
  timestampSlug,
};
