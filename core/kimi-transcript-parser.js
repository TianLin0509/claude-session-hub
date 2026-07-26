'use strict';

const fs = require('fs');

const KIMI_TAIL_WINDOW_INITIAL_BYTES = 8 * 1024 * 1024;

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function toMs(record) {
  const value = record && (record.timestamp || record.time || record.createdAt || record.created_at);
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isToolFinish(reason) {
  return ['tool_calls', 'tool_call', 'tool_use'].includes(String(reason || '').toLowerCase());
}

function canonicalKimiModel(value) {
  const model = String(value || '').trim();
  if (!model) return null;
  if (/\bk3\b/i.test(model)) return 'kimi-code/k3';
  return model;
}

function kimiStepUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const number = (key) => Number.isFinite(Number(value[key])) ? Number(value[key]) : 0;
  const inputTokens = number('inputOther') + number('inputCacheRead') + number('inputCacheCreation');
  const outputTokens = number('output');
  if (inputTokens <= 0 && outputTokens <= 0) return null;
  return { inputTokens, outputTokens };
}

function parseKimiWireRecords(records) {
  const turns = [];
  let turnIndex = 0;
  let turnText = '';
  let lastUserText = '';
  let currentAssistantTs = null;
  let currentModel = null;
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let turnContextTokens = 0;
  let toolCalls = [];
  const steps = new Map();

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (record.type === 'config.update') {
      currentModel = canonicalKimiModel(record.modelAlias || record.model) || currentModel;
      continue;
    }
    if (record.type === 'usage.record') {
      currentModel = canonicalKimiModel(record.model) || currentModel;
      continue;
    }
    if (record.type === 'context.append_message' && record.message) {
      const text = blocksText(record.message.content).trim();
      if (record.message.role === 'user' && text) lastUserText = text;
      continue;
    }
    if (record.type === 'turn.prompt') {
      turnIndex += 1;
      turnText = '';
      toolCalls = [];
      steps.clear();
      currentAssistantTs = null;
      turnInputTokens = 0;
      turnOutputTokens = 0;
      turnContextTokens = 0;
      const text = (blocksText(record.input) || lastUserText).trim();
      if (text && (!record.origin || record.origin.kind === 'user')) {
        turns.push({
          id: `kimi-user-${turnIndex}`,
          role: 'user',
          text,
          ts: toMs(record),
          source: 'kimi_wire',
        });
      }
      continue;
    }
    if (record.type !== 'context.append_loop_event' || !record.event) continue;
    const event = record.event;
    const fallbackKey = `${event.turnId || turnIndex}:${event.step || ''}`;
    if (event.type === 'step.begin') {
      steps.set(event.uuid || fallbackKey, { text: '', hadTool: false });
      if (currentAssistantTs == null) currentAssistantTs = toMs(record);
      continue;
    }
    const stepKey = event.stepUuid || event.uuid || fallbackKey;
    const step = steps.get(stepKey) || { text: '', hadTool: false };
    if (event.type === 'content.part' && event.part && event.part.type === 'text' && typeof event.part.text === 'string') {
      step.text += event.part.text;
      steps.set(stepKey, step);
      continue;
    }
    if (event.type === 'tool.call') {
      step.hadTool = true;
      steps.set(stepKey, step);
      toolCalls.push({
        id: event.toolCallId || event.uuid || null,
        name: event.name || 'tool',
        input: event.args || {},
      });
      continue;
    }
    if (event.type === 'tool.result') {
      const call = toolCalls.find((item) => item.id && item.id === event.toolCallId);
      if (call) call.result = event.result;
      continue;
    }
    if (event.type !== 'step.end') continue;
    const ended = steps.get(event.uuid || stepKey) || step;
    const stepUsage = kimiStepUsage(event.usage);
    if (stepUsage) {
      turnInputTokens += stepUsage.inputTokens;
      turnOutputTokens += stepUsage.outputTokens;
      turnContextTokens = stepUsage.inputTokens;
    }
    if (ended.text) turnText += ended.text;
    if (isToolFinish(event.finishReason) || ended.hadTool) continue;
    const text = (ended.text || turnText).trim();
    if (!text && toolCalls.length === 0) continue;
    turns.push({
      id: `kimi-assistant-${turnIndex}`,
      role: 'assistant',
      text,
      ts: currentAssistantTs,
      tsEnd: toMs(record),
      stopReason: event.finishReason || 'completed',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: currentModel || undefined,
      usage: (turnInputTokens > 0 || turnOutputTokens > 0) ? {
        input_tokens: turnInputTokens,
        output_tokens: turnOutputTokens,
        context_tokens: turnContextTokens,
        context_window: currentModel === 'kimi-code/k3' ? 1_048_576 : undefined,
      } : undefined,
      source: 'kimi_wire',
    });
  }
  return turns;
}

function parseKimiWireText(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return parseKimiWireRecords(records);
}

function readKimiTailWindowText(wirePath, maxBytes) {
  const stat = fs.statSync(wirePath);
  if (stat.size <= maxBytes) return fs.readFileSync(wirePath, 'utf8');
  const start = stat.size - maxBytes;
  const fd = fs.openSync(wirePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    const newline = text.indexOf('\n');
    return newline >= 0 ? text.slice(newline + 1) : '';
  } finally {
    fs.closeSync(fd);
  }
}

function applyKimiLimit(turns, opts) {
  const limit = Number(opts.limit);
  if (!Number.isFinite(limit) || limit <= 0 || turns.length <= limit) return turns;
  return opts.fromTail === false ? turns.slice(0, limit) : turns.slice(turns.length - limit);
}

function parseKimiWireToTurns(wirePath, opts = {}) {
  const limit = Number(opts.limit);
  if (opts.fromTail !== false && Number.isFinite(limit) && limit > 0) {
    const stat = fs.statSync(wirePath);
    if (stat.size > KIMI_TAIL_WINDOW_INITIAL_BYTES) {
      const tailTurns = parseKimiWireText(readKimiTailWindowText(wirePath, KIMI_TAIL_WINDOW_INITIAL_BYTES));
      if (tailTurns.length >= limit) return applyKimiLimit(tailTurns, opts);
    }
  }
  return applyKimiLimit(parseKimiWireText(fs.readFileSync(wirePath, 'utf8')), opts);
}

module.exports = {
  KIMI_TAIL_WINDOW_INITIAL_BYTES,
  parseKimiWireText,
  parseKimiWireRecords,
  parseKimiWireToTurns,
};
