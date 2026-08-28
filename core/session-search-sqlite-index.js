'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  MAX_QUERY_LENGTH,
  SCOPE_WEIGHTS,
  createSnippet,
  normalizeSearchText,
  queryTerms,
  sinceTimestamp,
} = require('./session-search-index.js');
const {
  DEFAULT_MAX_CANDIDATE_SESSIONS,
  DEFAULT_MAX_QUERY_DOCS,
} = require('./session-search-config.js');

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PREVIEW_TEXT_LIMIT = 12_000;
// IN (...) 一次塞多少个 id。SQLite 默认变量上限 32766，留足余量。
const DOC_FETCH_CHUNK = 900;
// 短词（<3 字，trigram 索引不到）默认只扫这三档。tool 占 87% 的行、205MB 正文，
// 而两个字在工具入参 JSON 里命中的基本都是噪声。
const SHORT_TERM_SCOPES = Object.freeze(['title', 'user', 'assistant']);

function isRecoverableDatabaseError(error) {
  const text = `${error && error.code || ''} ${error && error.message || error || ''}`.toLocaleLowerCase();
  return /sqlite_corrupt|sqlite_notadb|database disk image is malformed|file is not a database|malformed database schema/.test(text);
}

function quarantineDatabase(databasePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantined = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${databasePath}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const target = `${databasePath}.corrupt-${stamp}${suffix}`;
    fs.renameSync(source, target);
    quarantined.push(target);
  }
  return quarantined;
}

function quoteFtsTerm(term) {
  return `"${String(term || '').replace(/"/g, '""')}"`;
}

function countOccurrences(text, term, cap = 8) {
  if (!text || !term) return 0;
  let count = 0;
  let cursor = 0;
  while (count < cap) {
    const hit = text.indexOf(term, cursor);
    if (hit < 0) break;
    count += 1;
    cursor = hit + Math.max(1, term.length);
  }
  return count;
}

function trimPreviewText(text, terms) {
  const raw = String(text || '');
  if (raw.length <= PREVIEW_TEXT_LIMIT) return { text: raw, truncated: false };
  const normalized = normalizeSearchText(raw);
  let anchor = 0;
  for (const term of terms) {
    const index = normalized.indexOf(term);
    if (index >= 0) { anchor = index; break; }
  }
  const start = Math.max(0, anchor - 2000);
  const end = Math.min(raw.length, start + PREVIEW_TEXT_LIMIT);
  return {
    text: `${start > 0 ? '…' : ''}${raw.slice(start, end)}${end < raw.length ? '…' : ''}`,
    truncated: true,
  };
}

function rowToSession(row) {
  if (!row) return null;
  return {
    key: row.key,
    provider: row.provider,
    nativeFamily: row.native_family || null,
    kind: row.kind || null,
    title: row.title || '未命名会话',
    cwd: row.cwd || null,
    projectLabel: row.project_label || null,
    model: row.model || null,
    updatedAt: Number(row.updated_at) || 0,
    hubSessionId: row.hub_session_id || null,
    nativeSessionId: row.native_session_id || null,
    meetingId: row.meeting_id || null,
    transcriptPath: row.transcript_path || null,
    codexSessionsRoot: row.codex_sessions_root || null,
    codexProfile: row.codex_profile || null,
    turnCount: Number(row.turn_count) || 0,
  };
}

function rowToDoc(row) {
  return {
    id: row.event_id,
    eventId: row.event_id,
    scope: row.scope,
    role: row.role || null,
    speaker: row.speaker || null,
    text: row.text || '',
    normalizedText: row.normalized_text || '',
    ordinal: Number(row.ordinal) || 0,
    timestamp: Number(row.timestamp) || 0,
  };
}

class SqliteSessionSearchIndex {
  constructor(databasePath, options = {}) {
    if (!databasePath) throw new Error('databasePath is required');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.maxCandidateSessions = Math.max(50, Number(options.maxCandidateSessions) || DEFAULT_MAX_CANDIDATE_SESSIONS);
    this.maxQueryDocs = Math.max(1000, Number(options.maxQueryDocs) || DEFAULT_MAX_QUERY_DOCS);
    this.db = null;
    this.statsCache = null;
    this.matchStatementCache = new Map();
    this.recoveredDatabaseFiles = [];
    try {
      this._open();
    } catch (error) {
      try { if (this.db) this.db.close(); } catch {}
      this.db = null;
      if (!isRecoverableDatabaseError(error)) throw error;
      this.recoveredDatabaseFiles = quarantineDatabase(databasePath);
      this._open();
    }
  }

  _open() {
    this.db = new DatabaseSync(this.databasePath);
    // cache_size 从 32MB 提到 128MB、并开 1GB mmap：这个库实测 1.8GB，短词查询要顺序
    // 扫 docs 表，页缓存太小时每次搜索都在重新读盘。
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE; PRAGMA cache_size=-131072; PRAGMA mmap_size=1073741824; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    // WAL 从不截断（journal_size_limit 默认 -1），实测生产环境攒到 290MB，
    // 每次读都要先过一遍这么大的 WAL 索引。开库时截断一次，之后限制在 64MB。
    this.db.exec('PRAGMA journal_size_limit=67108864;');
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* 别的进程占着就算了，下次再截 */ }
    this._ensureSchema();
    this._prepare();
  }

  _ensureSchema() {
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version) || 0;
    if (version && version !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS docs_fts;
        DROP TABLE IF EXISTS docs;
        DROP TABLE IF EXISTS sessions;
        DROP TABLE IF EXISTS sources;
        DROP TABLE IF EXISTS meta;
      `);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (
        key TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        searchable INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE REFERENCES sources(key) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        native_family TEXT,
        kind TEXT,
        title TEXT,
        cwd TEXT,
        project_label TEXT,
        model TEXT,
        updated_at INTEGER,
        hub_session_id TEXT,
        native_session_id TEXT,
        meeting_id TEXT,
        transcript_path TEXT,
        codex_sessions_root TEXT,
        codex_profile TEXT,
        turn_count INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL REFERENCES sources(key) ON DELETE CASCADE,
        session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        role TEXT,
        speaker TEXT,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        ordinal REAL,
        timestamp INTEGER,
        UNIQUE(session_key, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_docs_session ON docs(session_key, ordinal);
      CREATE INDEX IF NOT EXISTS idx_docs_scope_time ON docs(scope, timestamp);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        normalized_text,
        content='docs',
        content_rowid='id',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, normalized_text) VALUES (new.id, new.normalized_text);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, normalized_text) VALUES ('delete', old.id, old.normalized_text);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, normalized_text) VALUES ('delete', old.id, old.normalized_text);
        INSERT INTO docs_fts(rowid, normalized_text) VALUES (new.id, new.normalized_text);
      END;
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
  }

  _prepare() {
    this.selectSourceStates = this.db.prepare('SELECT key, signature, stale FROM sources');
    this.markSourceStaleStatement = this.db.prepare('UPDATE sources SET signature = ?, stale = 1 WHERE key = ?');
    this.deleteSource = this.db.prepare('DELETE FROM sources WHERE key = ?');
    this.insertSource = this.db.prepare('INSERT INTO sources(key, signature, stale, searchable, updated_at) VALUES (?, ?, ?, ?, ?)');
    this.insertSession = this.db.prepare(`INSERT INTO sessions(
      key, source_key, provider, native_family, kind, title, cwd, project_label, model, updated_at,
      hub_session_id, native_session_id, meeting_id, transcript_path, codex_sessions_root, codex_profile, turn_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insertDoc = this.db.prepare(`INSERT OR IGNORE INTO docs(
      source_key, session_key, event_id, scope, role, speaker, text, normalized_text, ordinal, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.selectSession = this.db.prepare('SELECT * FROM sessions WHERE key = ?');
    this.selectSessionUpdatedAt = this.db.prepare('SELECT updated_at FROM sessions WHERE key = ?');
    this.selectDocs = this.db.prepare('SELECT * FROM docs WHERE session_key = ? ORDER BY ordinal, id');
    // scope / 时间 / 词条三个条件现在全部下推到 SQL，语句按条件形状缓存。
    this.matchStatementCache = new Map();
  }

  /**
   * 命中文档查询。原来这里只取 session_key，然后回头把**整个 session 的所有 doc**
   * （含 text 全文）捞进 JS 再逐条 includes —— 实测一次查询要物化 20000 条 / 40MB
   * 字符串，而其中真正命中的只有 0.3%~1.8%。
   *
   * 打分循环本来就只用得到「命中的那些 doc」（不命中的在 matchedTerms 为空时直接
   * continue），所以只取命中行与原实现**语义完全等价**，只是不再搬无关数据。
   */
  _matchStatement({ useFts, scopes, hasSince }) {
    // ⚠ FTS 分支绝不能把 scope 放进 WHERE。
    //
    // `docs_fts MATCH ? AND d.scope IN (...)` 会让查询规划器改用 idx_docs_scope_time
    // 当驱动表，对该 scope 的全部行逐行去 FTS 里验证，同时 LIMIT 也失去短路能力。
    // 实测（真实 1.8GB 索引）：
    //     powershell + scope IN ('tool')   在 WHERE 里 → 298477 ms
    //                                       在投影里 + JS 过滤 →     16 ms
    //     status     + scope IN ('tool')   60630 ms  →  29 ms
    //     session    + scope IN ('tool')   50617 ms  →  26 ms
    // 所以 FTS 分支只把 scope/timestamp 放进**投影**，由调用方在 JS 里过滤。
    // instr 分支相反：scope 必须留在 WHERE 里，那是它唯一的收窄手段
    //     （'归档' 全表 821ms → 三档 188ms → 只 title 2ms）。
    const pushDown = !useFts;
    const scopeCount = pushDown && scopes ? scopes.length : 0;
    const pushSince = pushDown && hasSince;
    const cacheKey = `${useFts ? 'fts' : 'instr'}|${scopeCount}|${pushSince ? 't' : 'f'}`;
    let statement = this.matchStatementCache.get(cacheKey);
    if (statement) return statement;
    const where = [];
    if (useFts) where.push('docs_fts MATCH ?');
    else where.push('instr(d.normalized_text, ?) > 0');
    if (scopeCount) where.push(`d.scope IN (${scopes.map(() => '?').join(',')})`);
    if (pushSince) where.push('d.timestamp >= ?');
    const from = useFts
      ? 'FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid'
      : 'FROM docs d';
    statement = this.db.prepare(
      `SELECT d.id AS id, d.session_key AS session_key, d.scope AS scope, d.timestamp AS timestamp `
      + `${from} WHERE ${where.join(' AND ')} LIMIT ?`,
    );
    this.matchStatementCache.set(cacheKey, statement);
    return statement;
  }

  getSourceSignatures() {
    return new Map([...this.getSourceStates()].map(([key, state]) => [key, state.signature]));
  }

  getSourceStates() {
    return new Map(this.selectSourceStates.all().map(row => [row.key, {
      signature: row.signature,
      stale: Number(row.stale) === 1,
    }]));
  }

  markSourceStale(key, signature) {
    this.statsCache = null;
    this.markSourceStaleStatement.run(String(signature || ''), String(key || ''));
  }

  replaceSource(source) {
    this.statsCache = null;
    if (!source || !source.key) return { docs: 0, chars: 0 };
    const docs = source.searchable === false ? [] : (Array.isArray(source.docs) ? source.docs.slice() : []);
    return this.replaceSourceChunks(source, [docs]);
  }

  replaceSourceChunks(source, chunks) {
    this.statsCache = null;
    if (!source || !source.key) return { docs: 0, chars: 0 };
    const session = source.session || {};
    let documentCount = 0;
    let textChars = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.deleteSource.run(source.key);
      this.insertSource.run(source.key, String(source.signature || ''), source.stale ? 1 : 0, source.searchable === false ? 0 : 1, Number(session.updatedAt) || 0);
      if (source.searchable !== false && session.key) {
        this.insertSession.run(
          session.key, source.key, session.provider || 'unknown', session.nativeFamily || null,
          session.kind || null, session.title || '未命名会话', session.cwd || null,
          session.projectLabel || null, session.model || null, Number(session.updatedAt) || 0,
          session.hubSessionId || null, session.nativeSessionId || null, session.meetingId || null,
          session.transcriptPath || null, session.codexSessionsRoot || null, session.codexProfile || null,
          Number(session.turnCount) || 0,
        );
        const insertDocument = (doc) => {
          const text = String(doc && doc.text || '');
          if (!text) return;
          const inserted = this.insertDoc.run(
            source.key, session.key, String(doc.eventId || doc.id || `doc-${doc.ordinal || 0}`),
            doc.scope || 'assistant', doc.role || null, doc.speaker || null, text,
            normalizeSearchText(text), Number(doc.ordinal) || 0, Number(doc.timestamp) || 0,
          );
          if (Number(inserted.changes) > 0) {
            documentCount += 1;
            textChars += text.length;
          }
        };
        const insertedSyntheticTitle = !!session.title;
        if (insertedSyntheticTitle) insertDocument({
          id: 'title', eventId: 'title', scope: 'title', role: 'title',
          text: session.title, ordinal: -1, timestamp: Number(session.updatedAt) || 0,
        });
        for (const chunk of chunks || []) {
          for (const doc of (Array.isArray(chunk) ? chunk : [])) {
            if (insertedSyntheticTitle && doc && doc.scope === 'title') continue;
            insertDocument(doc);
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return {
      docs: documentCount,
      chars: textChars,
    };
  }

  pruneSources(activeKeys) {
    this.statsCache = null;
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS active_source_keys(key TEXT PRIMARY KEY); DELETE FROM active_source_keys;');
    const insert = this.db.prepare('INSERT OR IGNORE INTO active_source_keys(key) VALUES (?)');
    this.db.exec('BEGIN');
    try {
      for (const key of activeKeys || []) insert.run(String(key));
      this.db.exec('DELETE FROM sources WHERE key NOT IN (SELECT key FROM active_source_keys); COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }

  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }

  getRepresentedIds() {
    const rows = this.db.prepare('SELECT hub_session_id, meeting_id FROM sessions').all();
    return {
      hubIds: new Set(rows.map(row => row.hub_session_id).filter(Boolean).map(String)),
      meetingIds: new Set(rows.map(row => row.meeting_id).filter(Boolean).map(String)),
    };
  }

  getStats() {
    // search() 有 4 个返回点都调它，里面的 count(*) FROM docs 要扫 325k 行。
    // 统计值只在写索引时会变，缓存到下次写入。
    if (this.statsCache) return this.statsCache;
    const sessions = Number(this.db.prepare('SELECT count(*) AS count FROM sessions').get().count) || 0;
    const documents = Number(this.db.prepare('SELECT count(*) AS count FROM docs').get().count) || 0;
    const staleSources = Number(this.db.prepare('SELECT count(*) AS count FROM sources WHERE stale = 1').get().count) || 0;
    const providers = Object.fromEntries(this.db.prepare('SELECT provider, count(*) AS count FROM sessions GROUP BY provider').all().map(row => [row.provider, Number(row.count) || 0]));
    this.statsCache = {
      sessions, documents, terms: 0, providers, staleSources, storage: 'sqlite-fts5',
      recoveredCorruptDatabase: this.recoveredDatabaseFiles.length > 0,
    };
    return this.statsCache;
  }

  /** 取一个词条命中的 doc id（不取正文）。scopes 为 null 表示不限 scope。 */
  _matchedDocsForTerm(term, scopes, since) {
    const limit = this.maxQueryDocs;
    const scopeList = Array.isArray(scopes) && scopes.length ? scopes : null;
    const hasSince = since !== null && since !== undefined;
    let rows = null;
    let truncated = false;
    if (String(term).length >= 3) {
      try {
        rows = this._matchStatement({ useFts: true, scopes: scopeList, hasSince })
          .all(quoteFtsTerm(term), limit + 1);
        // 截断要按**过滤前**的行数判断：LIMIT 发生在 SQL 里，JS 过滤在其后。
        truncated = rows.length > limit;
        if (scopeList || hasSince) {
          const allowed = scopeList ? new Set(scopeList) : null;
          rows = rows.filter(row => (!allowed || allowed.has(row.scope))
            && (!hasSince || Number(row.timestamp) >= since));
        }
      } catch {
        // FTS 语法/分词器拒绝这个词（例如全是标点），退回顺序扫描。
        rows = null;
        truncated = false;
      }
    }
    if (!rows) {
      rows = this._matchStatement({ useFts: false, scopes: scopeList, hasSince })
        .all(term, ...(scopeList || []), ...(hasSince ? [since] : []), limit + 1);
      truncated = rows.length > limit;
    }
    return { rows: rows.slice(0, limit), truncated };
  }

  /** 按 id 批量取命中行的完整内容（打分与摘要需要正文）。 */
  _docsByIds(ids) {
    const out = [];
    for (let start = 0; start < ids.length; start += DOC_FETCH_CHUNK) {
      const chunk = ids.slice(start, start + DOC_FETCH_CHUNK);
      const statement = this.db.prepare(
        `SELECT * FROM docs WHERE id IN (${chunk.map(() => '?').join(',')}) ORDER BY ordinal, id`,
      );
      for (const row of statement.all(...chunk)) out.push(row);
    }
    return out;
  }

  search(request = {}) {
    const startedAt = Date.now();
    const rawInput = String(request.query || '');
    if (rawInput.length > MAX_QUERY_LENGTH) {
      return {
        results: [], totalSessions: 0, totalMatches: 0, truncated: false,
        facets: { providers: {}, scopes: {}, projects: [] }, queryMs: Date.now() - startedAt,
        index: this.getStats(), error: `搜索关键词过长（最多 ${MAX_QUERY_LENGTH} 个字符）`,
      };
    }
    const rawQuery = rawInput.trim();
    const terms = queryTerms(rawQuery);
    // 2026-08-28 压测发现：单个汉字（「蜃」「熵」「锁」）在中文里是完整的检索单位，
    // 但这里此前一律拦掉 —— 不是「没搜到」，是**根本没去搜**，属于静默错误。
    // 放开到 1 个字符；短词本来就走 scope 收窄后的顺序扫描，代价可控。
    if (!normalizeSearchText(rawQuery).length || !terms.length) {
      return {
        results: [], totalSessions: 0, totalMatches: 0, truncated: false,
        facets: { providers: {}, scopes: {}, projects: [] }, queryMs: Date.now() - startedAt,
        index: this.getStats(),
      };
    }
    const providerFilter = Array.isArray(request.providers) && request.providers.length ? new Set(request.providers.map(String)) : null;
    const scopeFilter = Array.isArray(request.scopes) && request.scopes.length ? new Set(request.scopes.map(String)) : null;
    const scopeList = scopeFilter ? [...scopeFilter] : null;
    const projectFilter = normalizeSearchText(request.project || '');
    const since = sinceTimestamp(request.timeRange, startedAt);
    const sort = request.sort === 'recent' ? 'recent' : 'relevance';
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(request.limit) || DEFAULT_LIMIT));

    // 2 字中文词是最常见的检索单位，但 trigram 分词器索引不到它，只能顺序扫 docs。
    // 全表扫 325k 行 / 686MB 实测 ~880ms，而其中 87% 的行、205MB 是 tool 输出
    // （命令行与工具入参 JSON）。默认把短词限制在 标题/我的提问/AI 回答 三档，
    // 用户显式选「工具 / 文件」页签时才扫 tool。
    const shortTermScopes = scopeList || SHORT_TERM_SCOPES;
    let shortTermNarrowed = false;

    const termMatches = terms.map(term => {
      const short = String(term).length < 3;
      if (short && !scopeList) shortTermNarrowed = true;
      return this._matchedDocsForTerm(term, short ? shortTermScopes : scopeList, since);
    });
    if (termMatches.some(match => match.rows.length === 0)) {
      return {
        results: [], totalSessions: 0, totalMatches: 0, truncated: false,
        facets: { providers: {}, scopes: {}, projects: [] }, queryMs: Date.now() - startedAt,
        index: this.getStats(),
        ...(shortTermNarrowed ? { narrowedScopes: SHORT_TERM_SCOPES } : {}),
      };
    }
    // 按 session 归并命中行。SQL 侧的覆盖只是预筛（trigram 可能有假阳性），
    // 最终仍由下面打分循环里的 includes 复核。
    const bySession = new Map();
    termMatches.forEach((match, index) => {
      const term = terms[index];
      for (const row of match.rows) {
        let entry = bySession.get(row.session_key);
        if (!entry) { entry = { ids: new Set(), covered: new Set() }; bySession.set(row.session_key, entry); }
        entry.ids.add(row.id);
        entry.covered.add(term);
      }
    });
    // 命中太多时下面的 maxQueryDocs 闸门会截断。按会话最近活动倒序，让被截掉的
    // 是最老的会话而不是「索引顺序里恰好排在后面的」。
    const candidateKeys = [];
    for (const [key, entry] of bySession) {
      if (entry.covered.size === terms.length) candidateKeys.push(key);
    }
    if (candidateKeys.length > 1) {
      const recency = new Map(candidateKeys.map(key => {
        const row = this.selectSessionUpdatedAt.get(key);
        return [key, Number(row && row.updated_at) || 0];
      }));
      candidateKeys.sort((left, right) => recency.get(right) - recency.get(left));
    }
    const groups = [];
    const providerFacet = new Map();
    const scopeFacet = new Map();
    const projectFacet = new Map();
    let totalMatches = 0;
    let loadedDocs = 0;
    let queryGuardHit = termMatches.some(match => match.truncated);

    for (const sessionKey of candidateKeys) {
      if (loadedDocs >= this.maxQueryDocs) { queryGuardHit = true; break; }
      const sessionRow = this.selectSession.get(sessionKey);
      const session = rowToSession(sessionRow);
      if (!session) continue;
      if (providerFilter && !providerFilter.has(session.provider)) continue;
      const searchableProject = normalizeSearchText(`${session.projectLabel || ''} ${session.cwd || ''}`);
      if (projectFilter && !searchableProject.includes(projectFilter)) continue;
      // 只取这个 session 里**命中的**行。不命中的行在下面 matchedTerms 为空时本来
      // 就会被跳过，所以与原来「取全部行再逐条 includes」语义等价。
      const rows = this._docsByIds([...bySession.get(sessionKey).ids]);
      loadedDocs += rows.length;
      const covered = new Set();
      const matchedScopes = new Set();
      let matchCount = 0;
      let newestMatchAt = 0;
      let bestScore = -Infinity;
      let bestMatch = null;
      for (const row of rows) {
        const doc = rowToDoc(row);
        if (scopeFilter && !scopeFilter.has(doc.scope)) continue;
        if (since !== null && doc.timestamp < since) continue;
        const matchedTerms = terms.filter(term => doc.normalizedText.includes(term));
        if (!matchedTerms.length) continue;
        matchedTerms.forEach(term => covered.add(term));
        let score = Number(SCOPE_WEIGHTS[doc.scope]) || 1;
        for (const term of matchedTerms) score += Math.min(8, countOccurrences(doc.normalizedText, term)) * 1.4;
        if (doc.normalizedText.includes(normalizeSearchText(rawQuery))) score += 8;
        score += Math.max(0, 4 - Math.log10(1 + Math.max(0, startedAt - doc.timestamp) / 86_400_000));
        matchCount += 1;
        newestMatchAt = Math.max(newestMatchAt, doc.timestamp);
        matchedScopes.add(doc.scope);
        if (score > bestScore || (score === bestScore && doc.timestamp > Number(bestMatch && bestMatch.timestamp))) {
          bestScore = score;
          bestMatch = {
            eventId: doc.eventId || doc.id || null,
            scope: doc.scope, role: doc.role || null, speaker: doc.speaker || null,
            timestamp: doc.timestamp, ordinal: doc.ordinal,
            text: createSnippet(doc.text, terms),
          };
        }
      }
      if (!terms.every(term => covered.has(term)) || !bestMatch) continue;
      groups.push({
        session, bestMatch, matchCount, newestMatchAt,
        groupScore: bestScore + Math.log2(1 + matchCount) * 2,
      });
      providerFacet.set(session.provider, (providerFacet.get(session.provider) || 0) + 1);
      const projectLabel = session.projectLabel || session.cwd || '';
      if (projectLabel) projectFacet.set(projectLabel, (projectFacet.get(projectLabel) || 0) + 1);
      for (const scope of matchedScopes) scopeFacet.set(scope, (scopeFacet.get(scope) || 0) + 1);
      totalMatches += matchCount;
    }
    groups.sort((a, b) => sort === 'recent'
      ? b.newestMatchAt - a.newestMatchAt || b.groupScore - a.groupScore
      : b.groupScore - a.groupScore || b.newestMatchAt - a.newestMatchAt);
    const results = groups.slice(0, limit).map(group => ({
        ...group.session,
        sessionKey: group.session.key,
        updatedAt: group.session.updatedAt || group.newestMatchAt,
        matchCount: group.matchCount,
        bestMatch: group.bestMatch,
      }));
    const projects = [...projectFacet.entries()].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN')).slice(0, 40);
    return {
      results, totalSessions: groups.length, totalMatches, truncated: groups.length > limit || queryGuardHit,
      truncatedReason: queryGuardHit ? 'query_guard' : (groups.length > limit ? 'result_limit' : null),
      facets: { providers: Object.fromEntries(providerFacet), scopes: Object.fromEntries(scopeFacet), projects },
      queryMs: Date.now() - startedAt, index: this.getStats(),
      ...(shortTermNarrowed ? { narrowedScopes: SHORT_TERM_SCOPES } : {}),
    };
  }

  preview(request = {}) {
    const sessionKey = String(request.sessionKey || '');
    const session = rowToSession(this.selectSession.get(sessionKey));
    if (!session) return null;
    const allDocs = this.selectDocs.all(sessionKey).map(rowToDoc);
    const titleDoc = allDocs.find(doc => doc.scope === 'title') || null;
    const dialogue = allDocs.filter(doc => doc.scope !== 'title');
    const terms = queryTerms(String(request.query || '').slice(0, MAX_QUERY_LENGTH));
    const eventId = String(request.eventId || '');
    const requestedDoc = allDocs.find(doc => String(doc.eventId || doc.id || '') === eventId) || null;
    let contextDocs;
    if (requestedDoc && requestedDoc.scope === 'title' && titleDoc) {
      contextDocs = [titleDoc, ...dialogue.slice(0, 2)];
    } else {
      let targetIndex = dialogue.findIndex(doc => String(doc.eventId || doc.id || '') === eventId);
      if (targetIndex < 0) targetIndex = 0;
      contextDocs = dialogue.slice(Math.max(0, targetIndex - 1), Math.min(dialogue.length, targetIndex + 2));
    }
    if (!contextDocs.length && allDocs.length) contextDocs.push(allDocs[0]);
    return {
      session,
      targetEventId: eventId || (contextDocs[0] && contextDocs[0].eventId) || null,
      context: contextDocs.map(doc => {
        const trimmed = trimPreviewText(doc.text, terms);
        return {
          eventId: doc.eventId || doc.id || null,
          scope: doc.scope, role: doc.role || null, speaker: doc.speaker || null,
          timestamp: doc.timestamp, ordinal: doc.ordinal,
          text: trimmed.text, truncated: trimmed.truncated,
          isMatch: String(doc.eventId || doc.id || '') === eventId,
        };
      }),
    };
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } finally { this.db = null; }
  }
}

module.exports = {
  SqliteSessionSearchIndex,
  isRecoverableDatabaseError,
  quarantineDatabase,
  quoteFtsTerm,
  rowToDoc,
  rowToSession,
};
