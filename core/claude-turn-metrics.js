'use strict';

const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
function inputTokens(usage) {
  return count(usage?.input_tokens) + count(usage?.cache_read_input_tokens) + count(usage?.cache_creation_input_tokens);
}
// Result usage is the sum of API calls; the last assistant call describes
// context occupancy. Never present the summed inputs as a context percentage.
function claudeTurnMetrics(record, frames) {
  const messages = new Map();
  for (const frame of frames) {
    if (frame.type === 'assistant' && !frame.parent_tool_use_id && frame.message?.id) messages.set(frame.message.id, frame.message);
  }
  const calls = [...messages.values()];
  const last = calls.findLast(message => message.usage);
  const model = record.model || calls.findLast(message => message.model)?.model;
  const result = record.result || {};
  const usage = record.usage || result.usage;
  const contextWindow = result.modelUsage?.[model]?.contextWindow;
  const duration = record.durationMs ?? result.duration_ms;
  return {
    ...(model ? { model } : {}),
    ...(usage || last ? { usage: {
      input_tokens: usage ? inputTokens(usage) : calls.reduce((sum, message) => sum + inputTokens(message.usage), 0),
      output_tokens: usage ? count(usage.output_tokens) : calls.reduce((sum, message) => sum + count(message.usage?.output_tokens), 0),
      context_tokens: last ? inputTokens(last.usage) : null,
      ...(count(contextWindow) > 0 ? { context_window: contextWindow } : {}),
    } } : {}),
    ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}),
  };
}

module.exports = { claudeTurnMetrics, inputTokens };
