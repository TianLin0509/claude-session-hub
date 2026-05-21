'use strict';

const fs = require('fs');
const { SessionManager } = require('../../core/session-manager.js');

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]/g, '');
}

function parseGeminiUsage(plain) {
  const result = {};
  const leftPatterns = [
    /\((\d+)%\s*context\s*left\)/gi,
    /\((\d+)%\s*context\s*remaining\)/gi,
    /\((\d+)%\s*left\)/gi,
    /\((\d+)%\s*remaining\)/gi,
    /·\s*(\d+)%\s*context\s*left/gi,
    /·\s*(\d+)%\s*left/gi,
    /(\d+)%\s*context\s*remaining/gi,
    /(\d+)%\s*上下文\s*剩余/gi,
  ];
  for (const re of leftPatterns) {
    let m;
    let last = null;
    while ((m = re.exec(plain)) !== null) last = m;
    if (last) {
      result.contextPct = 100 - parseInt(last[1], 10);
      break;
    }
  }
  const leftMatch = plain.match(/(gemini[-\w.]+)\s*\((\d+)%\s*context\s*left\)/i);
  if (leftMatch) {
    result.model = { id: leftMatch[1], displayName: SessionManager.geminiDisplayName(leftMatch[1]) };
    if (result.contextPct == null) result.contextPct = 100 - parseInt(leftMatch[2], 10);
  }
  const usedMatch = plain.match(/(gemini[-\w.]*[a-z])\s*(\d+)%\s*used/i);
  if (usedMatch) {
    if (!result.model) result.model = { id: usedMatch[1], displayName: SessionManager.geminiDisplayName(usedMatch[1]) };
    result.quotaPct = parseInt(usedMatch[2], 10);
  }
  if (!result.model) {
    const modelMatch = plain.match(/\b(gemini[-\w.]+)\b/i);
    if (modelMatch) result.model = { id: modelMatch[1], displayName: SessionManager.geminiDisplayName(modelMatch[1]) };
  }
  return result;
}

function parseCodexUsage(plain) {
  const result = {};
  const ctxMatch = plain.match(/Context\s+(\d+)%\s+left/i);
  if (ctxMatch) {
    const remaining = parseInt(ctxMatch[1], 10);
    result.contextPct = 100 - remaining;
  }
  const modelMatch = plain.match(/\b(gpt-[\w.-]+|o\d-[\w.-]+)\b/i);
  if (modelMatch) {
    const id = modelMatch[1];
    result.model = { id, displayName: id };
  }
  const tokenMatch = plain.match(/Token usage:\s*total=([\d,]+)/i);
  if (tokenMatch) result.tokensUsed = parseInt(tokenMatch[1].replace(/,/g, ''), 10);
  return result;
}

function extractCodexRateLimits(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const tailSize = Math.min(stat.size, 4096);
    const buf = Buffer.alloc(tailSize);
    fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'event_msg' && obj.payload && obj.payload.type === 'token_count' && obj.payload.rate_limits) {
          const rl = obj.payload.rate_limits;
          const toMs = (t) => (typeof t === 'number' && t < 1e12) ? t * 1000 : t;
          const result = {};
          if (rl.primary && typeof rl.primary.used_percent === 'number') {
            result.usage5h = { pct: Math.round(rl.primary.used_percent), resetsAt: toMs(rl.primary.resets_at) };
          }
          if (rl.secondary && typeof rl.secondary.used_percent === 'number') {
            result.usage7d = { pct: Math.round(rl.secondary.used_percent), resetsAt: toMs(rl.secondary.resets_at) };
          }
          if (result.usage5h || result.usage7d) return result;
        }
      } catch { /* skip malformed lines */ }
    }
    return null;
  } catch { return null; }
}

module.exports = {
  extractCodexRateLimits,
  parseCodexUsage,
  parseGeminiUsage,
  stripAnsi,
};
