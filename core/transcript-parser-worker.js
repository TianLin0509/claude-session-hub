'use strict';

const fs = require('node:fs');
const { parentPort, threadId } = require('node:worker_threads');
const { parseClaudeTranscriptToTurns } = require('./claude-transcript-parser.js');
const { parseCodexRolloutToTurns } = require('./codex-transcript-parser.js');
const { parseKimiWireToTurns } = require('./kimi-transcript-parser.js');

const MAX_CACHE_ENTRIES = 8;
const cache = new Map();

function parserForKind(kind) {
  if (kind === 'claude') return parseClaudeTranscriptToTurns;
  if (kind === 'codex') return parseCodexRolloutToTurns;
  if (kind === 'kimi') return parseKimiWireToTurns;
  throw new Error(`Unsupported transcript parser kind: ${kind}`);
}

function cacheKey(kind, transcriptPath, opts) {
  return `${kind}\0${transcriptPath}\0${JSON.stringify(opts || {})}`;
}

function touchCache(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

function parseTask(message) {
  const { id, kind, transcriptPath, opts = {} } = message || {};
  if (!id || !transcriptPath) throw new Error('Invalid transcript worker request');
  const stat = fs.statSync(transcriptPath);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const key = cacheKey(kind, transcriptPath, opts);
  const cached = cache.get(key);
  if (cached && cached.signature === signature) {
    touchCache(key, cached);
    return {
      id,
      turns: cached.turns,
      meta: { cacheHit: true, fileSize: stat.size, parseMs: 0, workerThreadId: threadId },
    };
  }

  const startedAt = Date.now();
  const turns = parserForKind(kind)(transcriptPath, opts);
  const normalizedTurns = Array.isArray(turns) ? turns : [];
  touchCache(key, { signature, turns: normalizedTurns });
  return {
    id,
    turns: normalizedTurns,
    meta: {
      cacheHit: false,
      fileSize: stat.size,
      parseMs: Date.now() - startedAt,
      workerThreadId: threadId,
    },
  };
}

parentPort.on('message', (message) => {
  try {
    parentPort.postMessage(parseTask(message));
  } catch (error) {
    parentPort.postMessage({
      id: message && message.id,
      error: error && error.message ? error.message : String(error),
    });
  }
});
