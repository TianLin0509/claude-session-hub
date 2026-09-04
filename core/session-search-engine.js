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
const {
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_SOURCE_CHARS,
  DEFAULT_MAX_SOURCES,
  sqlitePathForLegacyCache,
} = require('./session-search-config.js');

// Non-Codex adapters still materialize source text and retain conservative
// bounds. Codex uses a byte-filtered semantic stream, so its raw rollout size
// is not a proxy for memory use and must never trigger title-only degradation.

function clipSource(source, options = {}) {
  const maxSourceChars = Math.max(64 * 1024, Number(options.maxSourceChars) || DEFAULT_MAX_SOURCE_CHARS);
  const maxDocChars = Math.max(8 * 1024, Number(options.maxDocChars) || DEFAULT_MAX_DOC_CHARS);
  const preserveAll = options.preserveAll === true;
  const docs = [];
  let chars = 0;
  let truncated = false;
  for (const doc of (source && source.docs || [])) {
    const raw = String(doc && doc.text || '');
    if (!raw) continue;
    if (preserveAll) {
      const chunks = Math.max(1, Math.ceil(raw.length / maxDocChars));
      for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1) {
        const text = raw.slice(chunkIndex * maxDocChars, (chunkIndex + 1) * maxDocChars);
        const suffix = chunks > 1 ? `:chunk:${chunkIndex}` : '';
        docs.push({
          ...doc,
          id: `${doc.id || doc.eventId || 'doc'}${suffix}`,
          eventId: `${doc.eventId || doc.id || 'doc'}${suffix}`,
          text,
          ordinal: Number(doc.ordinal || 0) + chunkIndex / (chunks + 1),
        });
        chars += text.length;
      }
      continue;
    }
    const remaining = maxSourceChars - chars;
    if (remaining <= 0) { truncated = true; break; }
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
      kimiRoots: Array.isArray(options.kimiRoots) ? options.kimiRoots : [],
      geminiRoots: Array.isArray(options.geminiRoots) ? options.geminiRoots : [],
      meetingDir: options.meetingDir || null,
      refreshTtlMs: Number(options.refreshTtlMs) || 60_000,
      maxSources: Math.max(20, Number(options.maxSources) || DEFAULT_MAX_SOURCES),
      maxFileBytes: Math.max(1024 * 1024, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES),
      maxSourceChars: Math.max(64 * 1024, Number(options.maxSourceChars) || DEFAULT_MAX_SOURCE_CHARS),
      maxDocChars: Math.max(8 * 1024, Number(options.maxDocChars) || DEFAULT_MAX_DOC_CHARS),
    };
    this.emitStatus = emitStatus;
    this.index = new SqliteSessionSearchIndex(databasePath, options);
    // 短词（1~2 字，中文最常打的长度）要顺序扫「标题 / 我的提问 / AI 回答」三档。
    // 这几档一共十几 MB，冷缓存下第一次查要 1241ms；预热一次只要 ~75ms，之后同一个
    // 查询 65ms。放进 setImmediate：既不挡构造，也不挡第一次查询。
    setImmediate(() => { try { this.index.prewarmShortTermScopes(); } catch { /* 预热失败无所谓 */ } });
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
    // 已经有可用索引时，这一趟本质是「增量体检」：绝大多数来源的 signature 没变，
    //   会被原样复用，用户的检索能力一秒都没缺失。此时**不要**先把状态翻成
    //   refreshing —— 前端一看见 refreshing 就显示「正在建立本地索引 · 0/N」并禁用按钮。
    //   TTL 只有 10s，于是用户每次打开搜索面板都撞见这句话，得出「每次打开都要索引半天」
    //   的结论，而实际上索引是持久化且增量的，真正要重建的往往是 0 个来源。
    //   真有活要干时，下面统计出待解析数量再翻状态，那时候的进度条才是诚实的。
    const silentRescan = !force && this.statusValue.ready === true;
    this.refreshPromise = (async () => {
      this._emit(silentRescan
        ? { phase: 'rescanning', lastError: null, sourceErrors: [] }
        : { phase: 'discovering', refreshing: true, lastError: null, sourceErrors: [] });
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
      // 先数清楚这一趟到底有多少来源真的要重新解析（signature 变了或之前失败过）。
      //   进度条按「要干的活」算，而不是按「扫过的目录数」算 —— 后者永远是 4000+，
      //   看上去像在从零重建，实际上可能一个都不用动。
      const pendingSources = descriptors.reduce((count, descriptor) => {
        const previous = sourceStates.get(descriptor.key) || null;
        const reusable = !force && previous && previous.signature === descriptor.signature
          && !(descriptor.type === 'codex' && previous.stale);
        return reusable ? count : count + 1;
      }, 0);
      const announceProgress = !(silentRescan && pendingSources === 0);
      const progressTotal = announceProgress && silentRescan ? pendingSources : descriptors.length;
      if (!announceProgress) {
        // 纯体检：没有任何来源需要重解析。全程不打扰用户，状态保持 ready。
        this._emit({ phase: 'ready', totalSources: descriptors.length, indexedSources: descriptors.length });
      } else {
        this._emit({ refreshing: true, totalSources: progressTotal, indexedSources: 0 });
      }

      for (const descriptor of descriptors) {
        const previous = sourceStates.get(descriptor.key) || null;
        if (!force && previous && previous.signature === descriptor.signature
            && !(descriptor.type === 'codex' && previous.stale)) {
          activeKeys.add(descriptor.key);
          reusedSources += 1;
          if (previous.stale) staleSources += 1;
        } else {
          try {
            const stat = fs.statSync(descriptor.filePath);
            if (descriptor.type !== 'codex' && stat.size > this.options.maxFileBytes) {
              diagnostics.push(`${descriptor.filePath}: 文件过大，保留标题但跳过全文`);
              staleSources += 1;
              if (previous) this.index.markSourceStale(descriptor.key, descriptor.signature);
              else this.index.replaceSource(titleOnlySourceFromDescriptor(descriptor, { stale: true }));
              activeKeys.add(descriptor.key);
            } else {
              const limited = clipSource(parseSourceDescriptor(descriptor, collected.maps), {
                ...this.options,
                preserveAll: descriptor.type === 'codex',
              });
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
        // 状态推送仍然按 4 个一批（别把 IPC 刷爆），但**每一个来源都要让出事件循环**。
        // 以前 4 个才让一次：子进程是单线程的，一次搜索/状态请求最坏要等 4 个来源
        // 解析完，而大 Codex rollout 单个就要几百毫秒 —— 这就是重建索引时弹窗
        // 「卡顿」的直接原因。让出一次的成本是一个宏任务，2400 个来源可以忽略。
        // 静默体检（没有任何来源要重解析）时一个进度都不推：推了前端就会画进度条，
        // 又变回「看起来在重建索引」。有真活干时照常推。
        if (announceProgress && (completed % 4 === 0 || completed === descriptors.length)) {
          this._emit({
            phase: 'indexing', totalSources: progressTotal, indexedSources: completed,
            parsedSources, reusedSources, staleSources, sourceErrors: diagnostics.slice(0, 8),
          });
        }
        await new Promise(resolve => setImmediate(resolve));
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
      // 刚重写过大量页，缓存被冲掉了，重新预热短词档
      setImmediate(() => { try { this.index.prewarmShortTermScopes(); } catch { /* 同上 */ } });
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
    if (!this.statusValue.ready) {
      // 冷启动：原来这里是 `await this.refresh(...)`，也就是**第一次搜索要等整个索引
      // 建完**（本机 2429 个来源、1.8GB，要几分钟）。用户明确要求「建索引放到后台冷加载，
      // 别让我在搜索时感觉很慢」。
      //
      // 现在改成：立刻用手上已有的索引回答（可能是空的、可能是上次的一部分），
      // 同时在后台把 refresh 踢起来，并用 indexing:true 告诉前端「全文还在建」。
      // 前端此时已经有标题层的即时结果可显示（core/title-index.js）。
      if (!this.refreshPromise) {
        setImmediate(() => { this.refresh(snapshot, { force: false }).catch(() => {}); });
      }
      return {
        ...this.index.search(request),
        refreshing: true,
        indexing: true,
        status: { ...this.statusValue },
      };
    }
    if (Date.now() - this.lastRefreshAt >= this.options.refreshTtlMs && !this.refreshPromise) {
      // 曾经是 `void this.refresh(...)`。看着像后台刷新，其实不是：refresh() 的函数体
      // 在第一个 await 之前是同步执行的，而那一段正是 collectSourceDescriptors()——
      // 要 readdir/stat 近 2000 个 transcript 并读每个 Codex rollout 的头部，实测 326ms。
      // TTL 只有 10s，所以弹窗闲置一会儿再搜必然先吃这一刀。挪到下一个事件循环，
      // 让本次查询先返回。
      setImmediate(() => { this.refresh(snapshot, { force: false }).catch(() => {}); });
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
