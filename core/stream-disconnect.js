'use strict';

const DEFAULT_TAIL_CHARS = 2400;

function stripTerminalControls(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\r/g, '\n');
}

const STREAM_DISCONNECT_PATTERNS = [
  /(?:^|\n)\s*[■✖×!]*\s*(stream\s+(?:disconnected|closed|error|failed)\b[^\n]*)/i,
  /(?:^|\n)\s*[■✖×!]*\s*((?:error|fatal)(?::|\s)[^\n]*(?:response\.completed|ECONNRESET|ETIMEDOUT|ENETUNREACH|connection\s+(?:reset|closed)|network\s+unreachable)[^\n]*)/i,
  /(?:^|\n)\s*[■✖×!]*\s*(API\s+Error:\s*(?:Connection|Network|Unable\s+to\s+connect)[^\n]*)/i,
];

function compactDisconnectMessage(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function detectStreamDisconnect(value) {
  const plain = stripTerminalControls(value);
  for (const pattern of STREAM_DISCONNECT_PATTERNS) {
    const match = pattern.exec(plain);
    if (!match) continue;
    const message = compactDisconnectMessage(match[1] || match[0]);
    if (!message) continue;
    return {
      type: 'stream-disconnected',
      message,
      signature: message.toLowerCase(),
    };
  }
  return null;
}

function appendStreamDisconnectChunk(previousTail, chunk, maxTailChars = DEFAULT_TAIL_CHARS) {
  const limit = Math.max(500, Number(maxTailChars) || DEFAULT_TAIL_CHARS);
  const combined = (String(previousTail || '') + stripTerminalControls(chunk)).slice(-limit);
  return {
    tail: combined,
    issue: detectStreamDisconnect(combined),
  };
}

function hasStreamDisconnectIssue(session) {
  return !!(session && session.connectionIssue
    && session.connectionIssue.type === 'stream-disconnected');
}

module.exports = {
  DEFAULT_TAIL_CHARS,
  STREAM_DISCONNECT_PATTERNS,
  appendStreamDisconnectChunk,
  compactDisconnectMessage,
  detectStreamDisconnect,
  hasStreamDisconnectIssue,
  stripTerminalControls,
};
