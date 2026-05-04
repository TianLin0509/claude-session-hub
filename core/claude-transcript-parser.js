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

// 共用 entry → turn 转换（tool_result/空 entry 已在调用方过滤）。
// 返回 turn 对象或 null（非 user/assistant、空 assistant content）。
function _entryToTurn(entry) {
  if (entry.type === 'user') {
    const message = entry.message || {};
    if (typeof message.content !== 'string') return null;
    return {
      id: entry.uuid,
      role: 'user',
      text: message.content,
      ts: toMs(entry.timestamp),
    };
  }
  if (entry.type === 'assistant') {
    const message = entry.message || {};
    const parsed = parseAssistantContent(message.content);
    const hasContent =
      (parsed.text && parsed.text.length > 0) ||
      (parsed.toolCalls && parsed.toolCalls.length > 0) ||
      (parsed.thinking && parsed.thinking.length > 0);
    if (!hasContent) return null;
    return {
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
    };
  }
  return null;
}

// === Spec 3 · B2 tail-only fast path ===
// 反向读取文件尾部 64KB chunks，直到收集到 ≥ limit 个 turns 或读到文件头。
// 大 transcript（5MB+）从前 readFileSync 整文件 → 现在通常只需 1-2 个 chunk。
// 仅在 fromTail+limit>0 时启用；其余调用走原 readFileSync 全文路径。
function _parseTurnsFromTail(jsonlPath, limit) {
  const CHUNK = 65536;
  const collected = []; // 倒序收集（last entry → first entry）
  let fd = null;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const { size } = fs.fstatSync(fd);
    let pos = size;
    let tail = '';
    while (pos > 0 && collected.length < limit) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, pos);
      tail = buf.toString('utf-8') + tail;
      const lines = tail.split('\n');
      // 第一片若不在文件头，可能是不完整行 → 留给下次拼接
      const firstFragment = pos === 0 ? null : lines.shift();
      // 倒序处理 lines（更接近末尾的先收集）
      for (let i = lines.length - 1; i >= 0 && collected.length < limit; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        let entry;
        try { entry = JSON.parse(trimmed); } catch { continue; }
        if (!entry || typeof entry !== 'object') continue;
        if (isToolResultEntry(entry)) continue;
        const turn = _entryToTurn(entry);
        if (turn) collected.push(turn);
      }
      tail = firstFragment == null ? '' : firstFragment;
    }
  } catch {
    // 文件读不到 → 返空，调用方 fallback 为 'transcript not found' 一类语义
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
  // collected 是倒序（最新在前）→ reverse 给 chronological（最旧在前）
  return collected.reverse();
}

function parseClaudeTranscriptToTurns(jsonlPath, opts = {}) {
  const { limit, fromTail = false } = opts;

  // Spec 3 · B2 fast path：fromTail+limit>0 时只读尾部 chunk
  if (fromTail && typeof limit === 'number' && limit > 0) {
    return _parseTurnsFromTail(jsonlPath, limit);
  }
  if (typeof limit === 'number' && limit <= 0) return [];

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

    const turn = _entryToTurn(entry);
    if (turn) turns.push(turn);
  }

  if (typeof limit === 'number' && limit < turns.length) {
    return fromTail
      ? turns.slice(turns.length - limit)
      : turns.slice(0, limit);
  }
  return turns;
}

module.exports = {
  parseClaudeTranscriptToTurns,
  parseAssistantContent,
  isToolResultEntry,
};
