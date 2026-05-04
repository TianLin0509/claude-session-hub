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

// === Spec 3 · W9: 提取 tool_result entry 内的 result 列表 ===
// 一个 tool_result entry 的 message.content 可能含多条 tool_result（少见但合规）。
// 每条 tool_result.content 可以是 string 或 array of {type:'text'/'image',...}。
// 卡片视图只关心文本部分（image 暂不显示，留 spec 4+）。
// is_error=true 标记后端错误返回（renderer 渲红色）。
function extractToolResults(entry) {
  const out = [];
  if (!entry || !entry.message || !Array.isArray(entry.message.content)) return out;
  for (const c of entry.message.content) {
    if (!c || c.type !== 'tool_result' || !c.tool_use_id) continue;
    let textContent = '';
    if (typeof c.content === 'string') {
      textContent = c.content;
    } else if (Array.isArray(c.content)) {
      textContent = c.content
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n');
    }
    out.push({
      tool_use_id: c.tool_use_id,
      content: textContent,
      isError: c.is_error === true,
    });
  }
  return out;
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

// === Spec 3 · W5 合并连续 assistant entries ===
// Claude CLI 在 stop_reason='tool_use' 时把每次 LLM call 写成单独 entry：
// 一个 assistant entry = 1 thinking + 1 tool_use（D3 实测 5196 entries 中 0 或 1 个 tool）。
// 一次 user prompt 实际触发 N 个 assistant entries（中间夹 tool_result entry，已过滤）。
// 用户视角应该看到 1 个 logical turn（聚合所有 thinking/tools/text），而不是 N 张卡片。
//
// 合并规则：连续 assistant entries（之间可能夹 tool_result，已 skip）合为 1 turn，
//   终止于 stop_reason ∈ {end_turn, max_tokens, refusal, stop_sequence} 那条 entry（含）。
//   user 真消息出现 → flush 当前 acc。
//
// 字段合并：
//   id → 第一条 entry uuid（dedup 锚定，streaming 中保持稳定让 mountSessionTurnCard
//        replace 而非新增卡片）
//   text → 各 entry text 用 \n\n 拼接
//   thinking → 各 entry thinking 用 \n\n---\n\n 分隔拼接
//   toolCalls → flatten append（保持顺序）
//   ts → 第一条；tsEnd → 最后一条（用于头部"⏱ X.Ys"耗时 pill）
//   model → 最后一条（极少跨 model 切换；保最新）
//   stopReason → 最后一条（end_turn 表示真完成）
//   usage → 累计 input_tokens/output_tokens（multi-call 累积）
//   mergedCount → 合并的 entry 数（>1 表示发生了合并）
function _mergeConsecutiveAssistantTurns(turns) {
  const merged = [];
  let acc = null;

  const flush = () => {
    if (acc) {
      // thinking 数组 → 字符串
      if (Array.isArray(acc.thinking)) {
        acc.thinking = acc.thinking.length ? acc.thinking.join('\n\n---\n\n') : null;
      }
      merged.push(acc);
      acc = null;
    }
  };

  for (const t of turns) {
    if (t.role === 'user') {
      flush();
      merged.push(t);
      continue;
    }
    // assistant
    if (!acc) {
      acc = {
        id: t.id,
        role: 'assistant',
        text: t.text || '',
        ts: t.ts,
        tsEnd: t.ts,
        model: t.model,
        stopReason: t.stopReason,
        thinking: t.thinking ? [t.thinking] : [],
        toolCalls: Array.isArray(t.toolCalls) ? [...t.toolCalls] : [],
        usage: t.usage
          ? { input_tokens: t.usage.input_tokens || 0, output_tokens: t.usage.output_tokens || 0 }
          : { input_tokens: 0, output_tokens: 0 },
        mergedCount: 1,
      };
    } else {
      if (t.text) acc.text += (acc.text ? '\n\n' : '') + t.text;
      if (t.thinking) acc.thinking.push(t.thinking);
      if (Array.isArray(t.toolCalls) && t.toolCalls.length) acc.toolCalls.push(...t.toolCalls);
      acc.tsEnd = t.ts;
      acc.stopReason = t.stopReason || acc.stopReason;
      if (t.model) acc.model = t.model;
      if (t.usage) {
        acc.usage.input_tokens += t.usage.input_tokens || 0;
        acc.usage.output_tokens += t.usage.output_tokens || 0;
      }
      acc.mergedCount += 1;
    }
    // 终止于非 tool_use stop_reason（一轮真完成）
    if (t.stopReason && t.stopReason !== 'tool_use') {
      flush();
    }
  }
  flush();

  return merged;
}

function parseClaudeTranscriptToTurns(jsonlPath, opts = {}) {
  const { limit, fromTail = false } = opts;
  if (typeof limit === 'number' && limit <= 0) return [];

  // 简化：D3 实测 5MB transcript readFileSync 仅 9ms（B2 tail-only over-engineered）。
  // merge 必须基于完整 entries（局部 tail 会切断 merge group 头），所以全 read 后 merge。
  const raw = fs.readFileSync(jsonlPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const rawTurns = [];
  // Spec 3 · W9：tool_use_id → result 映射，用于关联 stdout 到 toolCall
  const toolResultMap = new Map();

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

    // tool_result entry：提取后存映射，不作为 turn
    if (isToolResultEntry(entry)) {
      const results = extractToolResults(entry);
      for (const r of results) {
        toolResultMap.set(r.tool_use_id, { content: r.content, isError: r.isError });
      }
      continue;
    }

    const turn = _entryToTurn(entry);
    if (turn) rawTurns.push(turn);
  }

  // Spec 3 · W9：把 result 关联到对应 toolCall（必须在 merge 之前 — merge 后 toolCalls flatten 不丢 id）
  for (const t of rawTurns) {
    if (t.role !== 'assistant' || !Array.isArray(t.toolCalls)) continue;
    for (const tc of t.toolCalls) {
      const r = tc && tc.id ? toolResultMap.get(tc.id) : null;
      if (r) {
        tc.result = r.content;
        tc.isError = r.isError;
      }
    }
  }

  // Spec 3 · W5：合并连续 assistant entries
  const merged = _mergeConsecutiveAssistantTurns(rawTurns);

  if (typeof limit === 'number' && limit < merged.length) {
    return fromTail
      ? merged.slice(merged.length - limit)
      : merged.slice(0, limit);
  }
  return merged;
}

module.exports = {
  parseClaudeTranscriptToTurns,
  parseAssistantContent,
  isToolResultEntry,
  extractToolResults,
};
