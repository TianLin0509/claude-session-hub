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
    // Cards show a clock per row and a duration per tool call. The engine
    // stamps most frames; anything unstamped is timed on arrival rather than
    // inheriting the turn's start, which would make every row read alike.
    if (!frame.hubObservedAt) frame.hubObservedAt = Date.parse(frame.timestamp || '') || Date.now();
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
    const displayByMessage = new Map();
    for (const frame of frames) {
      if (frame.type === 'assistant' && !frame.parent_tool_use_id) {
        const messageId = frame.message?.id || frame.uuid;
        const body = (frame.message?.content || []).filter(b => b?.type === 'text').map(b => b.text || '').join('\n\n');
        if (messageId && body) {
          const previous = displayByMessage.get(messageId);
          displayByMessage.set(messageId, { id: `${id}:message:${messageId}`, itemId: messageId,
            clientSubmissionId: record.submissionId, userMessageId: id, providerTurnId: null,
            text: previous ? previous.text + '\n\n' + body : body,
            phase: frame.message.stop_reason === 'end_turn' ? 'final_answer' : 'commentary',
            // A message is an instant, not an interval: without its own end the
            // row would inherit the turn's and show a meaningless sub-second
            // duration next to the answer.
            ts: frame.hubObservedAt || record.createdAt,
            tsEnd: frame.hubObservedAt || record.createdAt });
        }
      }
      for (const block of frame.message?.content || []) {
        if (!block) continue;
        if (block.type === 'tool_result') results.set(block.tool_use_id, { block, at: frame.hubObservedAt || null });
        if (frame.type !== 'assistant') continue;
        if (block.type === 'text' && !frame.parent_tool_use_id) text.push(block.text || '');
        if (block.type === 'thinking') thinking.push(block.thinking || '');
        if (block.type === 'tool_use') toolCalls.set(block.id, { id: block.id, callId: block.id,
          name: block.name, input: block.partialInput || block.input, startedAt: frame.hubObservedAt || null,
          parentToolUseId: frame.parent_tool_use_id || null, status: END.has(record.status) ? 'unknown' : 'running' });
      }
    }
    for (const [id, tool] of toolCalls) {
      const entry = results.get(id);
      if (!entry) continue;
      const result = entry.block;
      Object.assign(tool, { output: result.content, isError: result.is_error === true,
        status: result.is_error ? 'failed' : 'completed', completedAt: entry.at,
        ...(tool.startedAt && entry.at && entry.at >= tool.startedAt ? { durationMs: entry.at - tool.startedAt } : {}) });
    }
    const terminal = END.has(record.status);
    const answer = terminal ? record.finalText || '' : text.join('\n\n');
    const displayMessages = [...displayByMessage.values()];
    const finalMessage = terminal && displayMessages.findLast(m => m.text === answer);
    if (finalMessage) finalMessage.phase = 'final_answer';
    if (terminal && answer && !displayMessages.some(m => m.text === answer)
        && displayMessages.map(m => m.text).join('\n\n') !== answer) {
      displayMessages.push({ id: `${id}:result`, text: answer, phase: 'final_answer',
        clientSubmissionId: record.submissionId, userMessageId: id, providerTurnId: null,
        ts: record.completedAt || record.createdAt, tsEnd: record.completedAt || record.createdAt });
    }
    if (answer || thinking.length || toolCalls.size || terminal) cards.push({ id: id + ':assistant',
      role: 'assistant', kind: 'claude', text: answer, thinking: thinking.join('\n\n'),
      toolCalls: [...toolCalls.values()], ts: record.createdAt, tsEnd: record.completedAt || null,
      source, displayMessages, clientSubmissionId: record.submissionId, userMessageId: id,
      ...(record.model ? { model: record.model } : {}),
      ...(record.usage ? { usage: {
        input_tokens: (record.usage.input_tokens || 0) + (record.usage.cache_read_input_tokens || 0)
          + (record.usage.cache_creation_input_tokens || 0),
        output_tokens: record.usage.output_tokens || 0,
      } } : {}),
      nativeActivity: record.nativeActivity || false, nativeOrigin: record.origin || null,
      stopReason: terminal ? record.status : null, nativeOutcome: terminal ? record.status : null });
  }
  return cards;
}

function claudeDisplayMessages(record) {
  return record ? require('./conversation-display').displayTurns(claudeTranscriptTurns([record]))
    .filter(m => m.role === 'assistant' && (m.text || m.toolCalls?.length || m.thinking)) : [];
}

module.exports = { captureClaudeMessage, claudeTranscriptTurns, claudeDisplayMessages };
