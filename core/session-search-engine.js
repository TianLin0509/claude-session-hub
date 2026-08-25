'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { SqliteSessionSearchIndex } = require('./session-search-sqlite-index.js');
const {
  collectSourceDescriptors,
  normalizePath,
  parseSourceDescriptor,
  titleOnlySourceFromDescriptor,
  titleOnlySources,
} = require('./session-search-sources.js');

const DEFAULT_MAX_SOURCES = 10_000;
// Transcript adapters materialize one source at a time. Real Codex rollouts can
// exceed hundreds of MB, so files above this bound reuse the prior disk index
// (or a title-only row) instead of risking even the isolated child heap.
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_CHARS = 1024 * 1024;
const DEFAULT_MAX_DOC_CHARS = 128 * 1024;

function sqlitePathForLegacyCache(cachePath) {
  if (!cachePath) return null;
  return path.join(path.dirname(cachePath), 'session-search-v3.sqlite');
}

function clipSource(source, options = {}) {
  const maxSourceChars = Math.max(64 * 1024, Number(options.maxSourceChars) || DEFAULT_MAX_SOURCE_CHARS);
  const maxDocChars = Math.max(8 * 1024, Number(options.maxDocChars) || DEFAULT_MAX_DOC_CHARS);
  const docs = [];
  let chars = 0;
  let truncated = false;
  for (const doc of (source && source.docs || [])) {
    const remaining = maxSourceChars - chars;
    if (remaining <= 0) { truncated = true; break; }
    const raw = String(doc && doc.text || '');
    if (!raw) continue;
    const limit = Math.min(maxDocChars, remaining);
    const text = raw.length > limit ? raw.slice(0, limit) : raw;
    if (text.length < raw.length) truncated = true;
    docs.push({ ...doc, text });
    chars += text.length;
  }
  return {
    source: { ...source, docs, stale: !!(source && source.stale) || truncated, truncatedByStorageGuard: truncated },
    chars,
    truncated,
  };
}

class SessionSearchEngine {
  constructor(options = {}, emitStatus = () => {}) {
    const databasePath = options.databasePath || sqlitePathForLegacyCache(options.cachePath);
    if (!databasePath) throw new Error('session search databasePath is required');
    this.options = {
      databasePath,
      cachePath: options.cachePath || null,
      claudeRoots: Array.isArray(options.claudeRoots) ? options.claudeRoots : [],
      codexRoots: Array.isArray(options.codexRoots) ? options.codexRoots : [],
      meetingDir: options.meetingDir || null,
      refreshTtlMs: Number(options.refreshTtlMs) || 10_000,
      maxSources: Math.max(20, Number(options.maxSources) || DEFAULT_MAX_SOURCES),
      maxFileBytes: Math.max(1024 * 1024, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES),
      maxSourceChars: Math.max(64 * 1024, Number(options.maxSourceChars) || DEFAULT_MAX_SOURCE_CHARS),
      maxDocChars: Math.max(8 * 1024, Number(options.maxDocChars) || DEFAULT_MAX_DOC_CHARS),
    };
    this.emitStatus = emitStatus;
    this.index = new SqliteSessionSearchIndex(databasePath, options);
    this.refreshPromise = null;
    this.lastRefreshAt = Number(this.index.getMeta('lastRefreshAt', 0)) || 0;
    const stats = this.index.getStats();
    const staleSources = Number(stats.staleSources) || 0;
    this.statusValue = {
      phase: stats.sessions ? (staleSources ? 'ready_with_errors' : 'ready') : 'idle',
      ready: stats.sessions > 0,
      refreshing: false,
      indexedSources: this.index.getSourceSignatures().size,
      totalSources: this.index.getSourceSignatures().size,
      parsedSources: 0,
      reusedSources: 0,
      staleSources,
      lastRefreshAt: this.lastRefreshAt,
      lastError: null,
      sourceErrors: [],
      index: stats,
      storage: 'sqlite-child-process',
    };
  }

  _emit(patch = {}) {
    this.statusValue = { ...this.statusValue, ...patch, index: patch.index || this.index.getStats() };
    try { this.emitStatus({ ...this.statusValue }); } catch {}
  }

  _dynamicOptions(snapshot = {}) {
    const codexRoots = new Set(this.options.codexRoots.map(normalizePath).filter(Boolean));
    const originalByNormalized = new Map(this.options.codexRoots.map(root => [normalizePath(root), root]));
    for (const session of (Array.isArray(snapshot.sessions) ? snapshot.sessions : [])) {
      const root = session && session.codexSessionsRoot;
      const normalized = normalizePath(root);
      if (!normalized) continue;
      codexRoots.add(normalized);
      originalByNormalized.set(normalized, root);
    }
    return {
      ...this.options,
      codexRoots: [...codexRoots].map(key => originalByNormalized.get(key) || key),
    };
  }

  _readLegacyShard(shardDir, fileName) {
    const safeName = path.basename(String(fileName || ''));
    if (!safeName || safeName !== fileName) throw new Error(`非法旧索引分片名: ${fileName}`);
    const filePath = path.join(shardDir, safeName);
    const stat = fs.statSync(filePath);
    if (stat.size > 16 * 1024 * 1024) throw new Error(`旧索引分片过大: ${safeName}`);
    const raw = zlib.gunzipSync(fs.readFileSync(filePath), { maxOutputLength: 12 * 1024 * 1024 });
    return JSON.parse(raw.toString('utf8'));
  }

  async _migrateLegacyCache(allowedKeys) {
    const cachePath = this.options.cachePath;
    if (!cachePath || !fs.existsSync(cachePath)) return [];
    if (Number(this.index.getMeta('legacyCacheMigrationVersion', 0)) >= 3) return [];
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (error) {
      return [`旧索引清单读取失败: ${error.message}`];
    }
    if (!manifest || manifest.version !== 2 || !Array.isArray(manifest.entries)) return [];
    const shardDir = `${cachePath}.sources`;
    const eligibleEntries = allowedKeys instanceof Set
      ? manifest.entries.filter(entry => entry && allowedKeys.has(entry.key))
      : manifest.entries;
    const entries = eligibleEntries.slice(0, this.options.maxSources);
    const diagnostics = [];
    const existing = this.index.getSourceStates();
    let migrated = 0;
    let reused = 0;
    let processed = 0;
    this._emit({
      phase: 'migrating_legacy_cache', refreshing: true,
      totalSources: entries.length, indexedSources: 0,
    });
    for (const entry of entries) {
      if (!entry || !entry.key || !Array.isArray(entry.files) || !entry.files.length) continue;
      const previous = existing.get(entry.key);
      if (previous && previous.signature === entry.signature) {
        reused += 1;
      } else {
        try {
          const firstPart = this._readLegacyShard(shardDir, entry.files[0]);
          if (!firstPart || !firstPart.source) throw new Error('分片缺少 source 元数据');
          const { docs: _ignoredDocs, ...sourceMeta } = firstPart.source;
          const source = {
            ...sourceMeta,
            key: entry.key,
            signature: String(entry.signature || sourceMeta.signature || ''),
            stale: entry.stale === true,
          };
          let chars = 0;
          let truncated = false;
          const self = this;
          function* chunks() {
            for (let fileIndex = 0; fileIndex < entry.files.length; fileIndex += 1) {
              const part = fileIndex === 0 ? firstPart : self._readLegacyShard(shardDir, entry.files[fileIndex]);
              const clipped = [];
              for (const doc of (Array.isArray(part && part.docs) ? part.docs : [])) {
                if (doc && doc.scope === 'title') continue;
                const remaining = self.options.maxSourceChars - chars;
                if (remaining <= 0) { truncated = true; break; }
                const rawText = String(doc && doc.text || '');
                if (!rawText) continue;
                const limit = Math.min(self.options.maxDocChars, remaining);
                const text = rawText.length > limit ? rawText.slice(0, limit) : rawText;
                if (text.length < rawText.length) truncated = true;
                clipped.push({ ...doc, text });
                chars += text.length;
              }
              if (clipped.length) yield clipped;
              if (chars >= self.options.maxSourceChars) {
                if (fileIndex + 1 < entry.files.length) truncated = true;
                break;
              }
            }
          }
          this.index.replaceSourceChunks(source, chunks());
          if (truncated) this.index.markSourceStale(entry.key, source.signature);
          migrated += 1;
        } catch (error) {
          diagnostics.push(`${entry.key}: ${error.message}`);
        }
      }
      processed += 1;
      if (processed % 8 === 0 || processed === entries.length) {
        this._emit({
          phase: 'migrating_legacy_cache', refreshing: true,
          totalSources: entries.length, indexedSources: processed,
          parsedSources: migrated, reusedSources: reused,
          sourceErrors: diagnostics.slice(0, 8),
        });
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    if (eligibleEntries.length > entries.length) {
      diagnostics.push(`旧索引迁移仅处理前 ${entries.length}/${eligibleEntries.length} 个可用来源`);
    }
    this.index.setMeta('legacyCacheMigrationVersion', 3);
    this.index.setMeta('legacyCacheMigratedAt', Date.now());
    return diagnostics;
  }

  async refresh(snapshot = {}, { force = false } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    if (!force && this.statusValue.ready && Date.now() - this.lastRefreshAt < this.options.refreshTtlMs) {
      return { ...this.statusValue };
    }
    this.refreshPromise = (async () => {
      this._emit({ phase: 'discovering', refreshing: true, lastError: null, sourceErrors: [] });
      const collected = collectSourceDescriptors(this._dynamicOptions(snapshot), snapshot);
      const descriptors = [...(collected.descriptors || [])]
        .sort((left, right) => Number(right && right.mtime || 0) - Number(left && left.mtime || 0))
        .slice(0, this.options.maxSources);
      const migrationDiagnostics = await this._migrateLegacyCache(new Set(descriptors.map(descriptor => descriptor.key)));
      const diagnostics = [...migrationDiagnostics, ...(collected.diagnostics || [])];
      if ((collected.descriptors || []).length > descriptors.length) {
        diagnostics.push(`仅索引最近 ${descriptors.length}/${collected.descriptors.length} 个 transcript source`);
      }
      const sourceStates = this.index.getSourceStates();
      const activeKeys = new Set();
      let parsedSources = 0;
      let reusedSources = 0;
      let staleSources = diagnostics.length;
      let indexedChars = 0;
      let completed = 0;
      this._emit({ totalSources: descriptors.length, indexedSources: 0 });

      for (const descriptor of descriptors) {
        const previous = sourceStates.get(descriptor.key) || null;
        if (!force && previous && previous.signature === descriptor.signature) {
          activeKeys.add(descriptor.key);
          reusedSources += 1;
          if (previous.stale) staleSources += 1;
        } else {
          try {
            const stat = fs.statSync(descriptor.filePath);
            if (stat.size > this.options.maxFileBytes) {
              diagnostics.push(`${descriptor.filePath}: 文件过大，保留标题但跳过全文`);
              staleSources += 1;
              if (previous) this.index.markSourceStale(descriptor.key, descriptor.signature);
              else this.index.replaceSource(titleOnlySourceFromDescriptor(descriptor, { stale: true }));
              activeKeys.add(descriptor.key);
            } else {
              const limited = clipSource(parseSourceDescriptor(descriptor, collected.maps), this.options);
              this.index.replaceSource(limited.source);
              activeKeys.add(descriptor.key);
              parsedSources += 1;
              indexedChars += limited.chars;
              if (limited.truncated) staleSources += 1;
            }
          } catch (error) {
            staleSources += 1;
            diagnostics.push(`${descriptor.filePath || descriptor.key}: ${error.message}`);
            const retrySignature = `parse-error:${descriptor.signature}`;
            if (previous) this.index.markSourceStale(descriptor.key, retrySignature);
            else this.index.replaceSource(titleOnlySourceFromDescriptor(descriptor, { signature: retrySignature, stale: true }));
            activeKeys.add(descriptor.key);
          }
        }
        completed += 1;
        if (completed % 4 === 0 || completed === descriptors.length) {
          this._emit({
            phase: 'indexing', totalSources: descriptors.length, indexedSources: completed,
            parsedSources, reusedSources, staleSources, sourceErrors: diagnostics.slice(0, 8),
          });
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      // Drop sources outside the current discovery/retention set before adding
      // metadata-only Hub rows, otherwise an about-to-be-pruned transcript can
      // incorrectly suppress its replacement title record.
      this.index.pruneSources(activeKeys);
      const represented = this.index.getRepresentedIds();
      const currentSignatures = this.index.getSourceSignatures();
      for (const source of titleOnlySources(collected.maps, represented.hubIds, represented.meetingIds)) {
        const limited = clipSource(source, this.options);
        if (force || currentSignatures.get(source.key) !== source.signature) this.index.replaceSource(limited.source);
        activeKeys.add(source.key);
      }
      this.index.pruneSources(activeKeys);
      this.lastRefreshAt = Date.now();
      this.index.setMeta('lastRefreshAt', this.lastRefreshAt);
      const stats = this.index.getStats();
      staleSources = Math.max(staleSources, Number(stats.staleSources) || 0);
      this._emit({
        phase: staleSources ? 'ready_with_errors' : 'ready',
        ready: true, refreshing: false,
        totalSources: activeKeys.size, indexedSources: activeKeys.size,
        parsedSources, reusedSources, staleSources,
        indexedTextChars: indexedChars,
        lastRefreshAt: this.lastRefreshAt,
        lastError: diagnostics[0] || null,
        sourceErrors: diagnostics.slice(0, 8),
        index: stats,
      });
      return { ...this.statusValue };
    })().catch(error => {
      this._emit({ phase: this.statusValue.ready ? 'ready_with_errors' : 'error', refreshing: false, lastError: error.message });
      throw error;
    }).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async search(request = {}, snapshot = {}) {
    if (!this.statusValue.ready) await this.refresh(snapshot, { force: false });
    else if (Date.now() - this.lastRefreshAt >= this.options.refreshTtlMs && !this.refreshPromise) {
      void this.refresh(snapshot, { force: false }).catch(() => {});
    }
    return { ...this.index.search(request), refreshing: !!this.refreshPromise, status: { ...this.statusValue } };
  }

  preview(request = {}) {
    return this.index.preview(request);
  }

  status() {
    return { ...this.statusValue };
  }

  close() {
    this.index.close();
  }
}

module.exports = {
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_SOURCE_CHARS,
  DEFAULT_MAX_SOURCES,
  SessionSearchEngine,
  clipSource,
  sqlitePathForLegacyCache,
};
