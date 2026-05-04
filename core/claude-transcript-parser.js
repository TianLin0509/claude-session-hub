/**
 * claude-transcript-parser.js
 *
 * Parse a Claude Code transcript JSONL file (e.g.
 *   ~/.claude/projects/<project>/<session>.jsonl)
 * into a normalized array of conversation "turns" (user / assistant only).
 *
 * Filters out:
 *   - tool_result entries (type='user' but content is array of {type:'tool_result',...})
 *   - non user/assistant entries (queue-operation, attachment, last-prompt,
 *     custom-title, agent-name, ...)
 *   - corrupt JSONL lines (skipped, not thrown)
 *
 * Public API (CommonJS):
 *   parseClaudeTranscriptToTurns(jsonlPath, opts)
 *   parseAssistantContent(contentArray)
 *   isToolResultEntry(entry)
 */

const fs = require('node:fs');

function isToolResultEntry(entry) {
  return !!(
    entry &&
    entry.type === 'user' &&
    entry.message &&
    Array.isArray(entry.message.content) &&
    entry.message.content.some(c => c && c.type === 'tool_result')
  );
}

function parseAssistantContent(contentArray) {
  const result = { thinking: null, text: '', toolCalls: [] };
  if (!Array.isArray(contentArray) || contentArray.length === 0) {
    return result;
  }

  const thinkingParts = [];
  const textParts = [];

  for (const block of contentArray) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinkingParts.push(block.thinking);
    } else if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      result.toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }

  result.thinking = thinkingParts.length > 0 ? thinkingParts.join('\n\n') : null;
  result.text = textParts.join('\n');
  return result;
}

function toMs(timestamp) {
  if (!timestamp) return null;
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function parseClaudeTranscriptToTurns(jsonlPath, opts = {}) {
  const { limit, fromTail = false } = opts;
  const raw = fs.readFileSync(jsonlPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const turns = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // 损坏行 skip
    }
    if (!entry || typeof entry !== 'object') continue;

    // tool_result 污染过滤
    if (isToolResultEntry(entry)) continue;

    if (entry.type === 'user') {
      const message = entry.message || {};
      // 真用户消息 message.content 是 string；其他形态（array 等）已在
      // isToolResultEntry 过滤过头部一种，剩余非字符串一律 skip 以避免污染
      if (typeof message.content !== 'string') continue;
      turns.push({
        id: entry.uuid,
        role: 'user',
        text: message.content,
        ts: toMs(entry.timestamp),
      });
    } else if (entry.type === 'assistant') {
      const message = entry.message || {};
      const parsed = parseAssistantContent(message.content);
      // 跳过完全无内容 entry（API 异常/被打断/拒答 → message.content=[] 或全是未识别类型）。
      // 保留只有 thinking 或只有 tool_use 的 entry：渲染时 "💭 思考过程" summary
      // 或工具卡片仍可见，不会显示为空白。— 2026-05-04 用户反馈空卡片
      const hasContent =
        (parsed.text && parsed.text.length > 0) ||
        (parsed.toolCalls && parsed.toolCalls.length > 0) ||
        (parsed.thinking && parsed.thinking.length > 0);
      if (!hasContent) continue;
      turns.push({
        id: entry.uuid,
        role: 'assistant',
        text: parsed.text,
        ts: toMs(entry.timestamp),
        model: typeof message.model === 'string' ? message.model : undefined,
        stopReason:
          typeof message.stop_reason === 'string' ? message.stop_reason : undefined,
        thinking: parsed.thinking,
        toolCalls: parsed.toolCalls,
        usage: (message.usage && typeof message.usage === 'object') ? message.usage : undefined,
      });
    }
    // 其他 type（queue-operation/attachment/last-prompt/...）→ skip
  }

  if (typeof limit === 'number') {
    if (limit <= 0) return [];
    if (limit < turns.length) {
      return fromTail
        ? turns.slice(turns.length - limit)
        : turns.slice(0, limit);
    }
  }
  return turns;
}

module.exports = {
  parseClaudeTranscriptToTurns,
  parseAssistantContent,
  isToolResultEntry,
};
