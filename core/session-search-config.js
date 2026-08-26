'use strict';

const path = require('node:path');

const DEFAULT_MAX_SOURCES = 10_000;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_CHARS = 1024 * 1024;
const DEFAULT_MAX_DOC_CHARS = 128 * 1024;
const DEFAULT_MAX_CANDIDATE_SESSIONS = 1200;
const DEFAULT_MAX_QUERY_DOCS = 20_000;

function sqlitePathForLegacyCache(cachePath) {
  if (!cachePath) return null;
  return path.join(path.dirname(cachePath), 'session-search-v3.sqlite');
}

module.exports = {
  DEFAULT_MAX_CANDIDATE_SESSIONS,
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_QUERY_DOCS,
  DEFAULT_MAX_SOURCE_CHARS,
  DEFAULT_MAX_SOURCES,
  sqlitePathForLegacyCache,
};
