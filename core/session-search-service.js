'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

class SessionSearchService {
  constructor(options = {}) {
    this._Worker = options.Worker || Worker;
    this._workerPath = options.workerPath || path.join(__dirname, 'session-search-worker.js');
    this._prewarmEnabled = options.prewarmEnabled === true;
    this._workerData = {
      cachePath: options.cachePath || null,
      claudeRoots: Array.isArray(options.claudeRoots) ? options.claudeRoots : [],
      codexRoots: Array.isArray(options.codexRoots) ? options.codexRoots : [],
      meetingDir: options.meetingDir || null,
      refreshTtlMs: Number(options.refreshTtlMs) || 10_000,
      maxCacheCompressedBytes: Math.max(1024 * 1024, Number(options.maxCacheCompressedBytes) || 32 * 1024 * 1024),
      maxSources: Math.max(10, Number(options.maxSources) || 200),
      maxIndexedChars: Math.max(1024 * 1024, Number(options.maxIndexedChars) || 16 * 1024 * 1024),
    };
    this._workerResourceLimits = {
      maxOldGenerationSizeMb: Math.max(128, Number(options.workerMemoryLimitMb) || 384),
      maxYoungGenerationSizeMb: 64,
    };
    this._worker = null;
    this._nextId = 0;
    this._pending = new Map();
    this._closed = false;
    this._status = { phase: 'idle', ready: false, refreshing: false, index: { sessions: 0, documents: 0, terms: 0, providers: {} } };
    this._stats = { submitted: 0, completed: 0, workerRestarts: 0, failures: 0 };
  }

  _ensureWorker() {
    if (this._closed) throw new Error('Session search service is closed');
    if (this._worker) return this._worker;
    const worker = new this._Worker(this._workerPath, {
      workerData: this._workerData,
      resourceLimits: this._workerResourceLimits,
    });
    worker.unref?.();
    worker.on('message', message => this._handleMessage(message));
    worker.on('error', error => this._handleFailure(error, worker));
    worker.on('exit', (code) => {
      if (this._worker !== worker) return;
      this._worker = null;
      if (!this._closed && code !== 0) this._handleFailure(new Error(`Session search worker exited with code ${code}`), worker);
    });
    this._worker = worker;
    this._stats.workerRestarts += 1;
    return worker;
  }

  _handleMessage(message) {
    if (message && message.type === 'status') {
      this._status = { ...this._status, ...(message.status || {}) };
      return;
    }
    const pending = message && this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    this._stats.completed += 1;
    if (pending.type === 'status' && message.result) this._status = { ...this._status, ...message.result };
    pending.resolve(message.result);
  }

  _handleFailure(error, worker) {
    if (worker && this._worker !== worker) return;
    if (this._worker) this._worker.removeAllListeners();
    this._worker = null;
    this._stats.failures += 1;
    this._status = { ...this._status, refreshing: false, lastError: error.message };
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
  }

  _request(type, payload = {}) {
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { type, resolve, reject });
      try {
        this._ensureWorker().postMessage({ id, type, ...payload });
        this._stats.submitted += 1;
      } catch (error) {
        this._pending.delete(id);
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
    if (!this._worker) return Promise.resolve({ ...this._status });
    return this._request('status');
  }

  prewarm(snapshot = {}) {
    if (!this._prewarmEnabled) {
      this._status = {
        ...this._status,
        phase: 'deferred',
        ready: false,
        refreshing: false,
        lastError: null,
      };
      return Promise.resolve({ ...this._status });
    }
    return this.refresh(snapshot, { force: false });
  }

  getStats() {
    return { ...this._stats, pending: this._pending.size, status: { ...this._status } };
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    const error = new Error('Session search service closed');
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
    const worker = this._worker;
    this._worker = null;
    if (worker) await worker.terminate();
  }
}

module.exports = { SessionSearchService };
