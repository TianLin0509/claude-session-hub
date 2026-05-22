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

function timestampToMs(timestamp) {
  if (!timestamp) return null;
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? ms : null;
}

module.exports = {
  codexTextFromContent,
  codexTextFromPayload,
  timestampToMs,
};
