'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { parentPort, workerData } = require('node:worker_threads');
const { SessionSearchIndex } = require('./session-search-index.js');
const {
  collectSourceDescriptors,
  normalizePath,
  parseSourceDescriptor,
  titleOnlySources,
} = require('./session-search-sources.js');

const CACHE_VERSION = 2;
const CACHE_DOCS_PER_PART = 750;
const CACHE_CHARS_PER_PART = 6 * 1024 * 1024;
const options = {
  cachePath: workerData && workerData.cachePath,
  claudeRoots: Array.isArray(workerData && workerData.claudeRoots) ? workerData.claudeRoots : [],
  codexRoots: Array.isArray(workerData && workerData.codexRoots) ? workerData.codexRoots : [],
  meetingDir: workerData && workerData.meetingDir,
  refreshTtlMs: Number(workerData && workerData.refreshTtlMs) || 10_000,
};

let sourceByKey = new Map();
let index = new SessionSearchIndex();
let refreshPromise = null;
let lastRefreshAt = 0;
let cacheManifest = null;
let status = {
  phase: 'idle',
  ready: false,
  refreshing: false,
  indexedSources: 0,
  totalSources: 0,
  parsedSources: 0,
  reusedSources: 0,
  staleSources: 0,
  lastRefreshAt: 0,
  lastError: null,
  sourceErrors: [],
  index: index.getStats(),
};

function emitStatus(patch = {}) {
  status = { ...status, ...patch, index: patch.index || index.getStats() };
  try { parentPort.postMessage({ type: 'status', status }); } catch {}
}

function cacheShardDir() {
  return `${options.cachePath}.sources`;
}

function cacheHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function replaceFileSync(tmp, target) {
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error && error.code)) throw error;
    try { fs.unlinkSync(target); } catch (unlinkError) {
      if (unlinkError && unlinkError.code !== 'ENOENT') throw unlinkError;
    }
    fs.renameSync(tmp, target);
  }
}

function loadCache() {
  if (!options.cachePath) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(options.cachePath, 'utf8'));
    if (!parsed || parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return;
    const loaded = new Map();
    const errors = [];
    const shardDir = cacheShardDir();
    for (const entry of parsed.entries) {
      if (!entry || !entry.key || !Array.isArray(entry.files) || !entry.files.length) continue;
      let sourceMeta = null;
      const docs = [];
      try {
        for (const file of entry.files) {
          const compressed = fs.readFileSync(path.join(shardDir, file));
          const part = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
          if (!sourceMeta && part && part.source) sourceMeta = part.source;
          if (part && Array.isArray(part.docs)) docs.push(...part.docs);
        }
        if (sourceMeta) loaded.set(entry.key, { ...sourceMeta, docs });
      } catch (error) {
        errors.push(`${entry.key}: ${error.message}`);
      }
    }
    cacheManifest = parsed;
    sourceByKey = loaded;
    index.replaceSources([...sourceByKey.values()]);
    lastRefreshAt = Number(parsed.savedAt) || 0;
    emitStatus({
      phase: errors.length ? 'ready_with_errors' : 'ready', ready: true, refreshing: false,
      indexedSources: sourceByKey.size,
      totalSources: sourceByKey.size,
      lastRefreshAt,
      lastError: errors[0] || null,
      sourceErrors: errors.slice(0, 8),
      staleSources: errors.length,
      cacheShards: parsed.entries.reduce((sum, entry) => sum + (entry.files && entry.files.length || 0), 0),
    });
  } catch (error) {
    emitStatus({ phase: 'idle', ready: false, lastError: `索引缓存读取失败：${error.message}` });
  }
}

function splitSourceForCache(source) {
  const { docs = [], ...sourceMeta } = source || {};
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const doc of docs) {
    const estimate = String(doc && doc.text || '').length + 512;
    if (current.length && (current.length >= CACHE_DOCS_PER_PART || chars + estimate > CACHE_CHARS_PER_PART)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(doc);
    chars += estimate;
  }
  if (current.length || !chunks.length) chunks.push(current);
  return chunks.map(chunk => ({ source: sourceMeta, docs: chunk }));
}

function persistCache(sources, { force = false } = {}) {
  if (!options.cachePath) return;
  fs.mkdirSync(path.dirname(options.cachePath), { recursive: true });
  const shardDir = cacheShardDir();
  fs.mkdirSync(shardDir, { recursive: true });
  const previousByKey = new Map(
    cacheManifest && Array.isArray(cacheManifest.entries)
      ? cacheManifest.entries.map(entry => [entry.key, entry])
      : [],
  );
  const entries = [];
  const referenced = new Set();
  let compressedBytes = 0;
  for (const source of sources) {
    if (!source || !source.key) continue;
    const previous = previousByKey.get(source.key);
    const canReuse = !force && previous
      && previous.signature === source.signature
      && !!previous.stale === !!source.stale
      && Array.isArray(previous.files)
      && previous.files.every(file => fs.existsSync(path.join(shardDir, file)));
    if (canReuse) {
      entries.push(previous);
      for (const file of previous.files) {
        referenced.add(file);
        try { compressedBytes += fs.statSync(path.join(shardDir, file)).size; } catch {}
      }
      continue;
    }
    const parts = splitSourceForCache(source);
    const prefix = `${cacheHash(source.key)}-${cacheHash(source.signature)}`;
    const files = [];
    parts.forEach((part, index) => {
      const file = `${prefix}-${String(index).padStart(3, '0')}.json.gz`;
      const target = path.join(shardDir, file);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(part)), { level: 6 });
        fs.writeFileSync(tmp, compressed);
        replaceFileSync(tmp, target);
        compressedBytes += compressed.length;
      } finally {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
        catch (error) { console.warn('[session-search] shard temp cleanup failed:', error.message); }
      }
      files.push(file);
      referenced.add(file);
    });
    entries.push({ key: source.key, signature: source.signature, stale: !!source.stale, files });
  }

  const tmp = `${options.cachePath}.${process.pid}.${Date.now()}.tmp`;
  const manifest = {
    version: CACHE_VERSION,
    savedAt: Date.now(),
    entries,
    cacheShards: referenced.size,
    compressedBytes,
  };
  try {
    fs.writeFileSync(tmp, JSON.stringify(manifest));
    replaceFileSync(tmp, options.cachePath);
    cacheManifest = manifest;
    let existingFiles = [];
    try { existingFiles = fs.readdirSync(shardDir); } catch {}
    for (const file of existingFiles) {
      if (!file.endsWith('.json.gz') || referenced.has(file)) continue;
      try { fs.unlinkSync(path.join(shardDir, file)); }
      catch (error) { console.warn('[session-search] stale cache shard cleanup failed:', error.message); }
    }
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    catch (error) { console.warn('[session-search] temporary cache cleanup failed:', error.message); }
  }
  return { cacheShards: referenced.size, compressedBytes };
}

function dynamicOptions(snapshot = {}) {
  const codexRoots = new Set(options.codexRoots.map(normalizePath).filter(Boolean));
  const originalByNormalized = new Map(options.codexRoots.map(root => [normalizePath(root), root]));
  for (const session of (Array.isArray(snapshot.sessions) ? snapshot.sessions : [])) {
    const root = session && session.codexSessionsRoot;
    const normalized = normalizePath(root);
    if (!normalized) continue;
    codexRoots.add(normalized);
    originalByNormalized.set(normalized, root);
  }
  return {
    ...options,
    codexRoots: [...codexRoots].map(key => originalByNormalized.get(key) || key),
  };
}

async function refresh(snapshot = {}, { force = false } = {}) {
  if (refreshPromise) return refreshPromise;
  if (!force && status.ready && Date.now() - lastRefreshAt < options.refreshTtlMs) return status;

  refreshPromise = (async () => {
    emitStatus({ phase: 'discovering', refreshing: true, lastError: null, sourceErrors: [], parsedSources: 0, reusedSources: 0, staleSources: 0 });
    const collected = collectSourceDescriptors(dynamicOptions(snapshot), snapshot);
    const { descriptors, maps, diagnostics = [] } = collected;
    const nextSources = new Map();
    let parsedSources = 0;
    let reusedSources = 0;
    let staleSources = diagnostics.length;
    const sourceErrors = diagnostics.slice();
    let completed = 0;
    emitStatus({ totalSources: descriptors.length, indexedSources: 0 });

    for (const descriptor of descriptors) {
      const existing = sourceByKey.get(descriptor.key);
      if (!force && existing && !existing.stale && existing.signature === descriptor.signature) {
        nextSources.set(descriptor.key, existing);
        reusedSources += 1;
      } else {
        try {
          const source = parseSourceDescriptor(descriptor, maps);
          nextSources.set(descriptor.key, source);
          parsedSources += 1;
        } catch (error) {
          staleSources += 1;
          sourceErrors.push(`${descriptor.filePath || descriptor.key}: ${error.message}`);
          if (existing) {
            nextSources.set(descriptor.key, { ...existing, stale: true, lastError: error.message });
          }
        }
      }
      completed += 1;
      if (completed % 8 === 0 || completed === descriptors.length) {
        emitStatus({
          phase: 'indexing', totalSources: descriptors.length, indexedSources: completed,
          parsedSources, reusedSources, staleSources,
          sourceErrors: sourceErrors.slice(0, 8),
        });
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    const representedHubIds = new Set();
    const representedMeetingIds = new Set();
    for (const source of nextSources.values()) {
      if (source && source.session && source.session.hubSessionId) representedHubIds.add(String(source.session.hubSessionId));
      if (source && source.session && source.session.meetingId) representedMeetingIds.add(String(source.session.meetingId));
    }
    for (const source of titleOnlySources(maps, representedHubIds, representedMeetingIds)) {
      nextSources.set(source.key, source);
    }

    const changedSources = [...nextSources.values()].filter(source => {
      const previous = sourceByKey.get(source.key);
      return force || !previous || previous.signature !== source.signature || !!previous.stale !== !!source.stale;
    });
    const removedSourceKeys = [...sourceByKey.keys()].filter(key => !nextSources.has(key));
    const changed = changedSources.length > 0 || removedSourceKeys.length > 0;
    if (changed) {
      emitStatus({ phase: 'building', totalSources: nextSources.size, indexedSources: nextSources.size });
      const useFullRebuild = force || !status.ready || index.getStats().sessions === 0;
      let updateResult;
      if (useFullRebuild) {
        index.replaceSources([...nextSources.values()]);
        updateResult = { compacted: true, changed: changedSources.length, removed: removedSourceKeys.length };
      } else {
        updateResult = index.updateSources(changedSources, removedSourceKeys);
      }
      sourceByKey = nextSources;
      emitStatus({
        phase: 'saving',
        index: index.getStats(),
        incrementalUpdate: !useFullRebuild && !updateResult.compacted,
        compacted: !!updateResult.compacted,
        changedSourceCount: changedSources.length,
        removedSourceCount: removedSourceKeys.length,
      });
      try {
        const cacheStats = persistCache([...sourceByKey.values()], { force });
        if (cacheStats) emitStatus(cacheStats);
      } catch (error) {
        staleSources += 1;
        status.lastError = `索引缓存保存失败：${error.message}`;
      }
    }
    lastRefreshAt = Date.now();
    emitStatus({
      phase: staleSources ? 'ready_with_errors' : 'ready',
      ready: true, refreshing: false,
      totalSources: sourceByKey.size, indexedSources: sourceByKey.size,
      parsedSources, reusedSources, staleSources,
      lastRefreshAt,
      lastError: status.lastError || sourceErrors[0] || null,
      sourceErrors: sourceErrors.slice(0, 8),
      index: index.getStats(),
    });
    return status;
  })().catch((error) => {
    emitStatus({ phase: status.ready ? 'ready_with_errors' : 'error', refreshing: false, lastError: error.message });
    throw error;
  }).finally(() => { refreshPromise = null; });

  return refreshPromise;
}

async function handleMessage(message = {}) {
  const type = message.type;
  if (type === 'status') return status;
  if (type === 'refresh') return refresh(message.snapshot || {}, { force: message.force === true });
  if (type === 'search') {
    if (!status.ready) await refresh(message.snapshot || {}, { force: false });
    else if (Date.now() - lastRefreshAt >= options.refreshTtlMs && !refreshPromise) {
      void refresh(message.snapshot || {}, { force: false });
    }
    const result = index.search(message.request || {});
    return { ...result, refreshing: !!refreshPromise, status };
  }
  if (type === 'preview') {
    return index.preview(message.request || {});
  }
  throw new Error(`Unknown session-search worker message: ${type}`);
}

loadCache();

parentPort.on('message', (message) => {
  Promise.resolve(handleMessage(message))
    .then(result => parentPort.postMessage({ id: message && message.id, result }))
    .catch(error => parentPort.postMessage({
      id: message && message.id,
      error: error && error.message ? error.message : String(error),
    }));
});
