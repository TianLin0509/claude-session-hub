'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');
const {
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_SOURCE_CHARS,
  DEFAULT_MAX_SOURCES,
  sqlitePathForLegacyCache,
} = require('./session-search-engine.js');

class SessionSearchService {
  constructor(options = {}) {
    this._fork = options.fork || fork;
    this._childPath = options.childPath || path.join(__dirname, 'session-search-child.js');
    this._prewarmEnabled = options.prewarmEnabled === true;
    this._childData = {
      cachePath: options.cachePath || null,
      databasePath: options.databasePath || sqlitePathForLegacyCache(options.cachePath),
      claudeRoots: Array.isArray(options.claudeRoots) ? options.claudeRoots : [],
      codexRoots: Array.isArray(options.codexRoots) ? options.codexRoots : [],
      meetingDir: options.meetingDir || null,
      refreshTtlMs: Number(options.refreshTtlMs) || 10_000,
      maxSources: Math.max(20, Number(options.maxSources) || DEFAULT_MAX_SOURCES),
      maxFileBytes: Math.max(1024 * 1024, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES),
      maxSourceChars: Math.max(64 * 1024, Number(options.maxSourceChars) || DEFAULT_MAX_SOURCE_CHARS),
      maxDocChars: Math.max(8 * 1024, Number(options.maxDocChars) || DEFAULT_MAX_DOC_CHARS),
      maxCandidateSessions: Math.max(50, Number(options.maxCandidateSessions) || 20_000),
      maxQueryDocs: Math.max(1000, Number(options.maxQueryDocs) || 100_000),
    };
    this._childMemoryLimitMb = Math.max(256, Number(options.childMemoryLimitMb) || 768);
    this._requestTimeoutMs = Math.max(50, Number(options.requestTimeoutMs) || 180_000);
    this._child = null;
    this._stderrTail = [];
    this._nextId = 0;
    this._pending = new Map();
    this._closed = false;
    this._status = {
      phase: 'idle', ready: false, refreshing: false,
      index: { sessions: 0, documents: 0, terms: 0, providers: {}, storage: 'sqlite-child-process' },
    };
    this._stats = { submitted: 0, completed: 0, workerRestarts: 0, failures: 0 };
  }

  _armRequestTimeout(id, pending) {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this._pending.get(id) !== pending) return;
      const error = new Error(`Session search child did not respond for ${this._requestTimeoutMs}ms (${pending.type})`);
      this._handleFailure(error, this._child);
    }, this._requestTimeoutMs);
    pending.timer.unref?.();
  }

  _touchPendingRequests() {
    for (const [id, pending] of this._pending) this._armRequestTimeout(id, pending);
  }

  _ensureChild() {
    if (this._closed) throw new Error('Session search service is closed');
    if (this._child) return this._child;
    this._stderrTail = [];
    const child = this._fork(this._childPath, [], {
      // Do not set cwd to __dirname: in packaged builds it points inside
      // app.asar, which is not a real Windows working directory.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
      execArgv: [`--max-old-space-size=${this._childMemoryLimitMb}`],
      windowsHide: true,
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child.on('message', message => this._handleMessage(message));
    child.on('error', error => this._handleFailure(error, child));
    child.on('exit', (code, signal) => {
      if (this._child !== child) return;
      const detail = this._stderrTail.slice(-8).join('\n');
      const error = new Error(`Session search child exited (code=${code}, signal=${signal || 'none'})${detail ? `\n${detail}` : ''}`);
      this._handleFailure(error, child);
    });
    if (child.stderr) {
      child.stderr.on('data', data => {
        this._stderrTail.push(...String(data || '').split(/\r?\n/).filter(Boolean));
        if (this._stderrTail.length > 80) this._stderrTail.splice(0, this._stderrTail.length - 80);
      });
    }
    this._child = child;
    this._stats.workerRestarts += 1;
    try {
      child.send({ type: 'init', options: this._childData }, error => {
        if (error) this._handleFailure(error, child);
      });
    } catch (error) {
      this._handleFailure(error, child);
      throw error;
    }
    return child;
  }

  _handleMessage(message) {
    if (message && message.type === 'status') {
      this._status = { ...this._status, ...(message.status || {}) };
      this._touchPendingRequests();
      return;
    }
    if (message && message.type === 'fatal') {
      this._status = { ...this._status, refreshing: false, lastError: message.error || '搜索子进程异常退出' };
      return;
    }
    const pending = message && this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    this._stats.completed += 1;
    if (message.result && (pending.type === 'status' || pending.type === 'refresh')) {
      this._status = { ...this._status, ...message.result };
    } else if (pending.type === 'search' && message.result && message.result.status) {
      this._status = { ...this._status, ...message.result.status };
    }
    pending.resolve(message.result);
  }

  _handleFailure(error, child) {
    if (child && this._child !== child) return;
    const failedChild = this._child;
    if (failedChild) {
      failedChild.removeAllListeners();
      try { if (failedChild.connected) failedChild.kill(); } catch {}
    }
    this._child = null;
    this._stats.failures += 1;
    this._status = { ...this._status, ready: false, refreshing: false, phase: 'child_error', lastError: error.message };
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }

  _request(type, payload = {}) {
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      const pending = { type, resolve, reject, timer: null };
      this._pending.set(id, pending);
      this._armRequestTimeout(id, pending);
      try {
        const child = this._ensureChild();
        child.send({ id, type, ...payload }, error => {
          if (!error) return;
          this._handleFailure(error, child);
        });
        this._stats.submitted += 1;
      } catch (error) {
        this._pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      }
    });
  }

  search(request = {}, snapshot = {}) {
    return this._request('search', { request, snapshot });
  }

  preview(request = {}) {
    return this._request('preview', { request });
  }

  refresh(snapshot = {}, options = {}) {
    return this._request('refresh', { snapshot, force: options.force === true });
  }

  status() {
    if (!this._child) return Promise.resolve({ ...this._status });
    return this._request('status');
  }

  prewarm(snapshot = {}) {
    if (!this._prewarmEnabled) {
      this._status = { ...this._status, phase: 'deferred', ready: false, refreshing: false, lastError: null };
      return Promise.resolve({ ...this._status });
    }
    return this.refresh(snapshot, { force: false });
  }

  getStats() {
    return {
      ...this._stats,
      childRestarts: this._stats.workerRestarts,
      pending: this._pending.size,
      status: { ...this._status },
    };
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    const error = new Error('Session search service closed');
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
    const child = this._child;
    this._child = null;
    if (!child) return;
    await new Promise(resolve => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      const terminate = () => {
        try { child.kill(); } catch {}
        finish();
      };
      const timer = setTimeout(() => {
        terminate();
      }, 2000);
      timer.unref?.();
      child.once('exit', finish);
      try { child.send({ type: 'close' }, error => { if (error) terminate(); }); }
      catch { terminate(); }
    });
  }
}

module.exports = { SessionSearchService };
