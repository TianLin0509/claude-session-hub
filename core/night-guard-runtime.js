'use strict';

const fs = require('fs');
const path = require('path');
const { detectHostShellTakeover, stripAnsi } = require('./host-shell-detector.js');
const { classifyTerminalRuntime } = require('./terminal-runtime-state.js');

const FRAME_RESET_MARKERS = ['\x1b[2J', '\x1b[3J', '\x1bc', '\x1b[?1049h'];

function latestTerminalFrame(value) {
  const text = String(value || '');
  let start = -1;
  for (const marker of FRAME_RESET_MARKERS) start = Math.max(start, text.lastIndexOf(marker));
  return (start >= 0 ? text.slice(start) : text.slice(-12_000));
}

async function inspectCodexRuntime(sessionManager, sessionId) {
  if (!sessionManager || typeof sessionManager.getSessionBuffer !== 'function') {
    return { state: 'missing', reason: 'session-manager-unavailable' };
  }
  const buffer = sessionManager.getSessionBuffer(sessionId);
  if (buffer == null) return { state: 'missing', reason: 'live-pty-missing' };
  if (detectHostShellTakeover(buffer)) return { state: 'host-shell', reason: 'host-shell-takeover' };

  // The serialized snapshot intentionally contains scrollback. An old
  // "esc to interrupt" in that history must not beat the current Codex input
  // box. The raw ring keeps complete live chunks, so classify only the newest
  // reset-delimited frame (or a bounded tail when the runtime did not clear).
  const lines = stripAnsi(latestTerminalFrame(buffer)).replace(/\r/g, '\n').split('\n');
  const classified = classifyTerminalRuntime('codex', lines);
  return {
    state: classified.state,
    reason: classified.reason,
    evidence: classified.evidence,
  };
}

function createNightGuardAuditWriter(filePath, options = {}) {
  const fsApi = options.fs || fs;
  const logger = options.logger || console;
  return function appendNightGuardAudit(record) {
    try {
      fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
      fsApi.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      logger.warn('[night-guard] audit append failed:', error && error.message);
    }
  };
}

module.exports = {
  createNightGuardAuditWriter,
  inspectCodexRuntime,
  latestTerminalFrame,
};
