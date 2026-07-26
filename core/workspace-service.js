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
      if (typeof meta.draft === 'boolean') item.draft = meta.draft;
      if (typeof meta.pinned === 'boolean') item.pinned = meta.pinned;
      if (typeof meta.gitInitialized === 'boolean') item.gitInitialized = meta.gitInitialized;
    }
    if (meta.select !== false) registry.selectedPath = resolved;
    this._writeRegistry(registry);
    return { ...item };
  }

  createScratchWorkspace(meta = {}) {
    this.ensureRoot();
    const name = `inbox-${timestampSlug(new Date(this.now()))}-${this.randomId()}`;
    const cwd = this.path.join(this.getScratchRoot(), name);
    this.fs.mkdirSync(cwd, { recursive: false });
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
    return { root: this.getWorkspaceRoot(), selectedPath: registry.selectedPath, items };
  }
}

module.exports = {
  WorkspaceService,
  normalizeKey,
  safeSlug,
  timestampSlug,
};
