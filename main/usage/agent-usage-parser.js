'use strict';

const fs = require('fs');
const { SessionManager } = require('../../core/session-manager.js');

const DEFAULT_RATE_LIMIT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_RATE_LIMIT_SCAN_BYTES = 8 * 1024 * 1024;

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
  const cliUsage = parseCodexCliUsageLimits(plain);
  if (cliUsage.usage5h) result.usage5h = cliUsage.usage5h;
  if (cliUsage.usage7d) result.usage7d = cliUsage.usage7d;
  const modelMatch = plain.match(/\b(gpt-[\w.-]+|o\d-[\w.-]+)\b/i);
  if (modelMatch) {
    const id = modelMatch[1];
    result.model = { id, displayName: id };
  }
  const tokenMatch = plain.match(/Token usage:\s*total=([\d,]+)/i);
  if (tokenMatch) result.tokensUsed = parseInt(tokenMatch[1].replace(/,/g, ''), 10);
  return result;
}

function parseCodexCliUsageLimits(plain) {
  const text = String(plain || '');
  const usageHeader = text.toLowerCase().lastIndexOf('https://chatgpt.com/codex/settings/usage');
  let section = usageHeader >= 0 ? text.slice(usageHeader) : text;
  const modelSpecificIdx = section.search(/\n\s*(?:gpt-[^\n]+|o\d[^\n]+)\s+limit:\s*/i);
  if (modelSpecificIdx >= 0) section = section.slice(0, modelSpecificIdx);

  const parseLimit = (labelPattern) => {
    const re = new RegExp(`(?:^|\\n)\\s*${labelPattern}\\s+limit:\\s*(?:\\[[^\\n]*?\\]\\s*)?(\\d+)%\\s+left(?:\\s*\\(([^)]*)\\))?`, 'i');
    const m = section.match(re);
    if (!m) return null;
    const left = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    const usage = { pct: 100 - left };
    const resetsAt = parseCodexCliResetText(m[2]);
    if (resetsAt) usage.resetsAt = resetsAt;
    return usage;
  };

  const result = {};
  const usage5h = parseLimit('5h');
  const usage7d = parseLimit('(?:Weekly|7d)');
  if (usage5h) result.usage5h = usage5h;
  if (usage7d) result.usage7d = usage7d;
  return result;
}

function parseCodexCliResetText(text, nowDate = new Date()) {
  const raw = String(text || '');
  const m = raw.match(/resets\s+(\d{1,2}):(\d{2})(?:\s+on\s+(\d{1,2})\s+([A-Za-z]{3,9}))?/i);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (hour > 23 || min > 59) return null;
  const monthNames = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11,
  };
  let d;
  if (m[3] && m[4]) {
    const month = monthNames[String(m[4]).toLowerCase()];
    const day = parseInt(m[3], 10);
    if (month == null || day < 1 || day > 31) return null;
    d = new Date(nowDate.getFullYear(), month, day, hour, min, 0, 0);
    if (d.getTime() <= nowDate.getTime() - 60_000) d.setFullYear(d.getFullYear() + 1);
  } else {
    d = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), hour, min, 0, 0);
    if (d.getTime() <= nowDate.getTime() - 60_000) d.setDate(d.getDate() + 1);
  }
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function parseCodexRateLimitLine(line) {
  if (!line || !line.trim()) return null;
  try {
    const obj = JSON.parse(line);
    if (obj.type !== 'event_msg' || !obj.payload || obj.payload.type !== 'token_count' || !obj.payload.rate_limits) {
      return null;
    }
    const rl = obj.payload.rate_limits;
    const toMs = (t) => (typeof t === 'number' && t < 1e12) ? t * 1000 : t;
    const result = {};
    if (rl.primary && typeof rl.primary.used_percent === 'number') {
      result.usage5h = { pct: Math.round(rl.primary.used_percent), resetsAt: toMs(rl.primary.resets_at) };
    }
    if (rl.secondary && typeof rl.secondary.used_percent === 'number') {
      result.usage7d = { pct: Math.round(rl.secondary.used_percent), resetsAt: toMs(rl.secondary.resets_at) };
    }
    return (result.usage5h || result.usage7d) ? result : null;
  } catch {
    return null;
  }
}

function extractCodexRateLimits(filePath, opts = {}) {
  const chunkBytes = Math.max(1024, opts.chunkBytes || DEFAULT_RATE_LIMIT_CHUNK_BYTES);
  const maxScanBytes = Math.max(chunkBytes, opts.maxScanBytes || DEFAULT_RATE_LIMIT_SCAN_BYTES);
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    let pos = stat.size;
    let scanned = 0;
    let carry = '';

    while (pos > 0 && scanned < maxScanBytes) {
      const readSize = Math.min(chunkBytes, pos, maxScanBytes - scanned);
      pos -= readSize;
      scanned += readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      const text = buf.toString('utf8') + carry;
      const lines = text.split(/\r?\n/);
      carry = lines.shift() || '';

      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const parsed = parseCodexRateLimitLine(lines[i]);
        if (parsed) return parsed;
      }
    }

    return parseCodexRateLimitLine(carry);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function selectCodexUsageWindow(candidates, windowKey, now = Date.now(), opts = {}) {
  const usable = [];
  const expired = [];
  for (const candidate of candidates || []) {
    const usage = candidate && candidate[windowKey];
    if (!usage || typeof usage.pct !== 'number') continue;
    const resetsAt = new Date(usage.resetsAt || 0).getTime();
    if (Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt <= now - 60_000) {
      expired.push({ candidate, usage });
      continue;
    }
    usable.push({ candidate, usage });
  }
  if (usable.length === 0) {
    // 窗口已过期（codex 端 5h/7d 已重置），但我们曾观察到过 candidate：
    // 显示 0%（已重置）而不是 null（无数据）。否则 UI 渲染成 "—"，
    // 用户误以为「读不到数据」，和 codex /status 显示的「0%」对不上。
    if (expired.length === 0) return null;
    expired.sort((a, b) => (b.candidate.observedAt || 0) - (a.candidate.observedAt || 0));
    return {
      usage: { pct: 0, resetsAt: null, expired: true },
      candidate: expired[0].candidate,
    };
  }

  const positive = usable.filter(item => item.usage.pct > 0);
  const pool = positive.length ? positive : usable;
  if (opts.rolling) {
    pool.sort((a, b) => (b.candidate.observedAt || 0) - (a.candidate.observedAt || 0));
    return {
      usage: pool[0].usage,
      candidate: pool[0].candidate,
    };
  }

  pool.sort((a, b) => {
    const pctDelta = (b.usage.pct || 0) - (a.usage.pct || 0);
    if (pctDelta) return pctDelta;
    return (b.candidate.observedAt || 0) - (a.candidate.observedAt || 0);
  });
  return {
    usage: pool[0].usage,
    candidate: pool[0].candidate,
  };
}

function selectCurrentAuthCandidates(candidates, minObservedAt) {
  const cutoff = Number(minObservedAt) || 0;
  if (cutoff <= 0) return candidates || [];
  const scoped = (candidates || []).filter(candidate => (candidate.observedAt || 0) >= cutoff);
  return scoped.length ? scoped : (candidates || []);
}

function mergeCodexRateLimitCandidates(candidates, now = Date.now(), opts = {}) {
  const effectiveCandidates = selectCurrentAuthCandidates(candidates, opts.minObservedAt);
  const usage5h = selectCodexUsageWindow(effectiveCandidates, 'usage5h', now);
  const usage7d = selectCodexUsageWindow(effectiveCandidates, 'usage7d', now, { rolling: true });
  if (!usage5h && !usage7d) return null;
  const primaryCandidate = (usage5h && usage5h.candidate) || (usage7d && usage7d.candidate);
  return {
    usage5h: usage5h ? usage5h.usage : null,
    usage7d: usage7d ? usage7d.usage : null,
    rolloutPath: primaryCandidate && primaryCandidate.rolloutPath,
    observedAt: Math.max(
      usage5h && usage5h.candidate ? usage5h.candidate.observedAt || 0 : 0,
      usage7d && usage7d.candidate ? usage7d.candidate.observedAt || 0 : 0,
    ) || undefined,
  };
}

module.exports = {
  extractCodexRateLimits,
  mergeCodexRateLimitCandidates,
  parseCodexUsage,
  parseGeminiUsage,
  stripAnsi,
};
