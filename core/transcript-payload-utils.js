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

function numericTimestampToMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
}

/**
 * Normalize the authoritative Codex user-submit records across CLI versions.
 *
 * Codex <= 0.144 wrote:
 *   event_msg(payload.type = "user_message")
 *
 * Codex 0.147 writes:
 *   event_msg(payload.type = "item_completed", item.type = "UserMessage")
 *
 * Do not treat every response_item(role = "user") as a submission: the
 * rollout also stores injected AGENTS/environment context with that role.
 */
function codexUserMessageEventFromRecord(record) {
  if (!record || record.type !== 'event_msg' || !record.payload) return null;
  const payload = record.payload;
  let messagePayload = null;
  let signalSource = null;

  if (payload.type === 'user_message') {
    messagePayload = payload;
    signalSource = 'user_message';
  } else if (payload.type === 'item_completed' && payload.item) {
    const itemType = String(payload.item.type || '').replace(/[_-]/g, '').toLowerCase();
    if (itemType !== 'usermessage') return null;
    messagePayload = payload.item;
    signalSource = 'item_completed_user_message';
  } else {
    return null;
  }

  const text = codexTextFromPayload(messagePayload).trim();
  if (!text) return null;
  const submittedAt = timestampToMs(record.timestamp)
    || numericTimestampToMs(payload.completed_at_ms)
    || numericTimestampToMs(payload.started_at_ms)
    || numericTimestampToMs(payload.completed_at)
    || numericTimestampToMs(payload.started_at);

  return {
    text,
    submittedAt,
    turnId: codexTurnIdFromPayload(payload) || codexTurnIdFromPayload(messagePayload),
    signalSource,
  };
}

module.exports = {
  codexTextFromContent,
  codexTextFromPayload,
  codexTurnIdFromPayload,
  codexUserMessageEventFromRecord,
  timestampToMs,
};
