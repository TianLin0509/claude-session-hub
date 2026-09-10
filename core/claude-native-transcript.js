'use strict';
const { displayUserText } = require('./synthetic-user-filter');
const END = new Set(['completed', 'failed', 'interrupted']);

function captureClaudeMessage(record, frame) {
  if (!record.messages) record.messages = new Map();
  if (!record.streams) record.streams = new Map();
  if (frame.type === 'stream_event') {
    const event = frame.event || {};
    const key = frame.parent_tool_use_id || 'root';
    if (event.type === 'message_start') {
      record.streams.set(key, { type: 'assistant', partial: true, uuid: event.message.id,
        parent_tool_use_id: frame.parent_tool_use_id, message: { ...event.message, content: [] } });
    }
    const stream = record.streams.get(key);
    if (!stream) return;
    if (event.type === 'content_block_start') stream.message.content[event.index] = { ...event.content_block };
    const block = stream.message.content[event.index];
    if (event.type === 'content_block_delta' && block) {
      if (event.delta.type === 'text_delta') block.text = (block.text || '') + event.delta.text;
      else if (event.delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + event.delta.thinking;
      else if (event.delta.type === 'input_json_delta') block.partialInput = (block.partialInput || '') + event.delta.partial_json;
    }
    return;
  }
  if (frame.type === 'assistant' || frame.type === 'user') {
    record.messages.set(frame.uuid || frame.message?.id, frame);
    if (frame.type === 'assistant') {
      for (const [key, stream] of record.streams) {
        if (stream.message.id === frame.message?.id) record.streams.delete(key);
      }
    }
  }
}

function claudeTranscriptTurns(records) {
  const cards = [];
  for (const record of records) {
    const source = 'claude-stream-json';
    const id = record.userMessageId;
    if (!record.nativeActivity) cards.push({ id, role: 'user', text: displayUserText(record.text), ts: record.createdAt,
      source, clientSubmissionId: record.submissionId, deliveryStatus: record.status,
      attachments: (record.content || []).filter(block => block.type !== 'text') });
    const frames = [...(record.messages?.values() || []), ...(record.streams?.values() || [])];
    const toolCalls = new Map();
    const results = new Map();
    const text = []; const thinking = [];
    for (const frame of frames) {
      for (const block of frame.message?.content || []) {
        if (!block) continue;
        if (block.type === 'tool_result') results.set(block.tool_use_id, block);
        if (frame.type !== 'assistant') continue;
        if (block.type === 'text' && !frame.parent_tool_use_id) text.push(block.text || '');
        if (block.type === 'thinking') thinking.push(block.thinking || '');
        if (block.type === 'tool_use') toolCalls.set(block.id, { id: block.id, callId: block.id,
          name: block.name, input: block.partialInput || block.input,
          parentToolUseId: frame.parent_tool_use_id || null, status: END.has(record.status) ? 'unknown' : 'running' });
      }
    }
    for (const [id, tool] of toolCalls) {
      const result = results.get(id);
      if (result) Object.assign(tool, { output: result.content, isError: result.is_error === true,
        status: result.is_error ? 'failed' : 'completed' });
    }
    const terminal = END.has(record.status);
    const answer = terminal ? record.finalText || '' : text.join('\n\n');
    if (answer || thinking.length || toolCalls.size || terminal) cards.push({ id: id + ':assistant',
      role: 'assistant', kind: 'claude', text: answer, thinking: thinking.join('\n\n'),
      toolCalls: [...toolCalls.values()], ts: record.createdAt, tsEnd: record.completedAt || null,
      source, nativeActivity: record.nativeActivity || false, nativeOrigin: record.origin || null,
      stopReason: terminal ? record.status : null, nativeOutcome: terminal ? record.status : null });
  }
  return cards;
}

module.exports = { captureClaudeMessage, claudeTranscriptTurns };
