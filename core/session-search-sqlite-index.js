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

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_CANDIDATE_SESSIONS = 1200;
const MAX_QUERY_DOCS = 20_000;
const PREVIEW_TEXT_LIMIT = 12_000;

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
    this.maxCandidateSessions = Math.max(50, Number(options.maxCandidateSessions) || MAX_CANDIDATE_SESSIONS);
    this.maxQueryDocs = Math.max(1000, Number(options.maxQueryDocs) || MAX_QUERY_DOCS);
    this.db = null;
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
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE; PRAGMA cache_size=-32768; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
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
    this.selectDocs = this.db.prepare('SELECT * FROM docs WHERE session_key = ? ORDER BY ordinal, id');
    this.selectFtsCandidates = this.db.prepare(`SELECT DISTINCT d.session_key AS session_key
      FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
      WHERE docs_fts MATCH ? LIMIT ?`);
    this.selectShortCandidates = this.db.prepare(`SELECT DISTINCT session_key
      FROM docs WHERE instr(normalized_text, ?) > 0 LIMIT ?`);
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
    this.markSourceStaleStatement.run(String(signature || ''), String(key || ''));
  }

  replaceSource(source) {
    if (!source || !source.key) return { docs: 0, chars: 0 };
    const docs = source.searchable === false ? [] : (Array.isArray(source.docs) ? source.docs.slice() : []);
    return this.replaceSourceChunks(source, [docs]);
  }

  replaceSourceChunks(source, chunks) {
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
    const sessions = Number(this.db.prepare('SELECT count(*) AS count FROM sessions').get().count) || 0;
    const documents = Number(this.db.prepare('SELECT count(*) AS count FROM docs').get().count) || 0;
    const staleSources = Number(this.db.prepare('SELECT count(*) AS count FROM sources WHERE stale = 1').get().count) || 0;
    const providers = Object.fromEntries(this.db.prepare('SELECT provider, count(*) AS count FROM sessions GROUP BY provider').all().map(row => [row.provider, Number(row.count) || 0]));
    return {
      sessions, documents, terms: 0, providers, staleSources, storage: 'sqlite-fts5',
      recoveredCorruptDatabase: this.recoveredDatabaseFiles.length > 0,
    };
  }

  _candidateKeysForTerm(term) {
    const limit = this.maxCandidateSessions;
    let rows = null;
    if (String(term).length >= 3) {
      try {
        rows = this.selectFtsCandidates.all(quoteFtsTerm(term), limit + 1);
      } catch {}
    }
    if (!rows) rows = this.selectShortCandidates.all(term, limit + 1);
    return {
      keys: new Set(rows.slice(0, limit).map(row => row.session_key)),
      truncated: rows.length > limit,
    };
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
    if (normalizeSearchText(rawQuery).length < 2 || !terms.length) {
      return {
        results: [], totalSessions: 0, totalMatches: 0, truncated: false,
        facets: { providers: {}, scopes: {}, projects: [] }, queryMs: Date.now() - startedAt,
        index: this.getStats(),
      };
    }
    const termCandidates = terms.map(term => this._candidateKeysForTerm(term));
    if (termCandidates.some(candidate => candidate.keys.size === 0)) {
      return {
        results: [], totalSessions: 0, totalMatches: 0, truncated: false,
        facets: { providers: {}, scopes: {}, projects: [] }, queryMs: Date.now() - startedAt,
        index: this.getStats(),
      };
    }
    const termSets = termCandidates.map(candidate => candidate.keys).sort((left, right) => left.size - right.size);
    const candidateKeys = [...termSets[0]].filter(key => termSets.every(set => set.has(key)));
    const providerFilter = Array.isArray(request.providers) && request.providers.length ? new Set(request.providers.map(String)) : null;
    const scopeFilter = Array.isArray(request.scopes) && request.scopes.length ? new Set(request.scopes.map(String)) : null;
    const projectFilter = normalizeSearchText(request.project || '');
    const since = sinceTimestamp(request.timeRange, startedAt);
    const sort = request.sort === 'recent' ? 'recent' : 'relevance';
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(request.limit) || DEFAULT_LIMIT));
    const groups = [];
    const providerFacet = new Map();
    const scopeFacet = new Map();
    const projectFacet = new Map();
    let totalMatches = 0;
    let loadedDocs = 0;
    let queryGuardHit = termCandidates.some(candidate => candidate.truncated);

    for (const sessionKey of candidateKeys) {
      if (loadedDocs >= this.maxQueryDocs) { queryGuardHit = true; break; }
      const sessionRow = this.selectSession.get(sessionKey);
      const session = rowToSession(sessionRow);
      if (!session) continue;
      if (providerFilter && !providerFilter.has(session.provider)) continue;
      const searchableProject = normalizeSearchText(`${session.projectLabel || ''} ${session.cwd || ''}`);
      if (projectFilter && !searchableProject.includes(projectFilter)) continue;
      const allRows = this.selectDocs.all(sessionKey);
      const remainingDocs = this.maxQueryDocs - loadedDocs;
      const rows = allRows.length > remainingDocs ? allRows.slice(0, remainingDocs) : allRows;
      if (rows.length < allRows.length) queryGuardHit = true;
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
