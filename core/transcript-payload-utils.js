'use strict';

function codexTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item) return '';
      if (typeof item === 'string') return item;
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.content)) return codexTextFromContent(content.content);
  }
  return '';
}

function codexTextFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return (
    codexTextFromContent(payload.message) ||
    codexTextFromContent(payload.text) ||
    codexTextFromContent(payload.content) ||
    codexTextFromContent(payload.input) ||
    codexTextFromContent(payload.prompt)
  );
}

function codexTurnIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const nested = payload.internal_chat_message_metadata_passthrough;
  const candidates = [
    payload.turn_id,
    payload.turnId,
    nested && nested.turn_id,
    nested && nested.turnId,
  ];
  for (const value of candidates) {
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return null;
}

function timestampToMs(timestamp) {
  if (!timestamp) return null;
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? ms : null;
}

module.exports = {
  codexTextFromContent,
  codexTextFromPayload,
  codexTurnIdFromPayload,
  timestampToMs,
};
