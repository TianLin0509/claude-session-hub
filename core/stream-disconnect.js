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
  /(?:^|\n)\s*[■✖×!]*\s*(API\s+Error:\s*(?:Connection|Network|Request|Unable\s+to\s+connect)[^\n]*)/i,
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

// 用户点开会话 = 已经看过这条提醒。记下被确认的签名，语义与「等你响应」一致：
// 提醒只提醒一次，除非它再次发生。
function markStreamDisconnectAcknowledged(session, now = Date.now()) {
  if (!session || !session.connectionIssue) return null;
  const ack = {
    signature: String(session.connectionIssue.signature || ''),
    at: Number(now) || Date.now(),
  };
  session._connectionIssueAck = ack;
  return ack;
}

/**
 * 同一条报错要不要重新升起「运行异常」。
 *
 * 关键在于断连是从 PTY 输出里认出来的，而 TUI（尤其 Codex）会把整屏反复重绘 ——
 * 用户点开清掉之后，下一帧同一段报错文本又流过来，就会被重新判成断连，于是
 * 「运行异常」永远下不去（2026-08-28 用户反馈：异常早已恢复还一直显示断连）。
 * 所以已确认过的签名默认压住，只有「确认之后又真的开过新的一轮」才放行。
 */
function shouldRaiseStreamDisconnect(session, issue) {
  if (!session || !issue) return false;
  const previous = session.connectionIssue;
  if (previous && previous.signature === issue.signature) return false;
  const ack = session._connectionIssueAck;
  if (!ack || !ack.signature || ack.signature !== issue.signature) return true;
  const runStartedAt = Number(session.runStartedAt) || 0;
  const ackAt = Number(ack.at) || 0;
  return runStartedAt > ackAt;
}

module.exports = {
  DEFAULT_TAIL_CHARS,
  STREAM_DISCONNECT_PATTERNS,
  appendStreamDisconnectChunk,
  compactDisconnectMessage,
  detectStreamDisconnect,
  hasStreamDisconnectIssue,
  markStreamDisconnectAcknowledged,
  shouldRaiseStreamDisconnect,
  stripTerminalControls,
};
