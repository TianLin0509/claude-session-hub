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

function normalizeCodexItemType(value) {
  return String(value || '').replace(/[_-]/g, '').toLowerCase();
}

/**
 * Normalize the authoritative Codex user-submit records across CLI versions.
 *
 * Codex <= 0.144 wrote:
 *   event_msg(payload.type = "user_message")
 *
 * Codex 0.147 ordinary prompts write:
 *   event_msg(payload.type = "item_completed", item.type = "UserMessage")
 *
 * Codex 0.147 /goal prompts instead write:
 *   event_msg(payload.type = "thread_goal_updated", goal.objective = "...")
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
    const itemType = normalizeCodexItemType(payload.item.type);
    if (itemType !== 'usermessage') return null;
    messagePayload = payload.item;
    signalSource = 'item_completed_user_message';
  } else if (payload.type === 'thread_goal_updated' && payload.goal) {
    const status = payload.goal && typeof payload.goal === 'object'
      ? String(payload.goal.status || '').trim().toLowerCase()
      : '';
    if (status && status !== 'active') return null;
    const objective = payload.goal && typeof payload.goal === 'object'
      ? payload.goal.objective
      : payload.goal;
    messagePayload = { message: objective };
    signalSource = 'thread_goal_updated';
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

/**
 * Normalize Codex assistant-message records across the legacy and 0.147
 * rollout schemas. The new schema marks the terminal answer with
 * item.phase="final_answer"; commentary items are user-visible progress.
 */
function codexAgentMessageEventFromRecord(record) {
  if (!record || record.type !== 'event_msg' || !record.payload) return null;
  const payload = record.payload;
  let messagePayload = null;
  let phase = '';
  let signalSource = null;
  let durationMs = null;

  if (payload.type === 'agent_message') {
    messagePayload = payload;
    phase = 'commentary';
    signalSource = 'agent_message';
  } else if (payload.type === 'task_complete') {
    messagePayload = { message: payload.last_agent_message };
    phase = 'final_answer';
    signalSource = 'task_complete';
    if (Number.isFinite(Number(payload.duration_ms))) durationMs = Number(payload.duration_ms);
  } else if (payload.type === 'item_completed' && payload.item
      && normalizeCodexItemType(payload.item.type) === 'agentmessage') {
    messagePayload = payload.item;
    phase = String(payload.item.phase || '').trim().toLowerCase();
    signalSource = `item_completed_agent_message${phase ? `_${phase}` : ''}`;
    const startedAt = numericTimestampToMs(payload.started_at_ms)
      || numericTimestampToMs(payload.started_at);
    const completedAt = numericTimestampToMs(payload.completed_at_ms)
      || numericTimestampToMs(payload.completed_at)
      || timestampToMs(record.timestamp);
    if (startedAt && completedAt && completedAt >= startedAt) durationMs = completedAt - startedAt;
  } else {
    return null;
  }

  const text = codexTextFromPayload(messagePayload).trim();
  if (!text) return null;
  const completedAt = timestampToMs(record.timestamp)
    || numericTimestampToMs(payload.completed_at_ms)
    || numericTimestampToMs(payload.completed_at);

  return {
    text,
    phase,
    completed: phase === 'final_answer',
    completedAt,
    durationMs,
    turnId: codexTurnIdFromPayload(payload) || codexTurnIdFromPayload(messagePayload),
    signalSource,
  };
}

/**
 * Normalize an authoritative Codex terminal failure. Current rollouts encode
 * transport failures as task_complete with error and no last_agent_message.
 * Keeping this separate from assistant completion prevents an errored turn
 * from looking completed while also giving the Hub a redraw-proof occurrence
 * identity (turn id + event time).
 */
function codexTaskErrorEventFromRecord(record) {
  if (!record || record.type !== 'event_msg' || !record.payload) return null;
  const payload = record.payload;
  if (payload.type !== 'task_complete' || !payload.error || typeof payload.error !== 'object') return null;
  const message = codexTextFromPayload(payload.error).trim();
  if (!message) return null;
  const completedAt = timestampToMs(record.timestamp)
    || numericTimestampToMs(payload.completed_at_ms)
    || numericTimestampToMs(payload.completed_at);
  const turnId = codexTurnIdFromPayload(payload);
  return {
    message,
    completedAt,
    durationMs: Number.isFinite(Number(payload.duration_ms)) ? Number(payload.duration_ms) : null,
    turnId,
    errorInfo: typeof payload.error.codex_error_info === 'string'
      ? payload.error.codex_error_info.slice(0, 200)
      : null,
    occurrenceId: `${turnId || 'unknown-turn'}:${completedAt || 'unknown-time'}`,
    signalSource: 'task_complete_error',
  };
}

module.exports = {
  codexTextFromContent,
  codexTextFromPayload,
  codexTurnIdFromPayload,
  codexUserMessageEventFromRecord,
  codexAgentMessageEventFromRecord,
  codexTaskErrorEventFromRecord,
  timestampToMs,
};
