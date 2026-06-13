'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LINDANG_DIR = process.env.LINDANG_DIR || 'C:\\LinDangAgent';
const DEFAULT_STOCK_LIST = path.join(DEFAULT_LINDANG_DIR, 'data', 'stock_list.csv');

const FULL_MODE_RE = /全量|深度|深挖|完整|全面|full/i;
const QUICK_MODE_RE = /快评|快速|简单|看看|看一下/i;
const COMPARE_RE = /对比|相比|比较|比一?下|哪个|哪只|vs\.?|VS|和|跟|与/;
const STOP_WORDS_RE = /怎么样|如何|看看|看一下|帮我|麻烦|分析|研究|深挖|一下|投委会|全量|深度|完整|全面|快评|快速|简单|对比|相比|比较|哪个|哪只|更好|更强|更值得|和|跟|与|比|一下|吗|呢|吧|的/g;

let stockCache = null;
let stockCachePath = null;

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function normalizeStock(raw) {
  if (!raw) return null;
  const symbol = String(raw.symbol || '').replace(/\D/g, '').slice(0, 6);
  const name = String(raw.name || '').trim();
  if (!/^\d{6}$/.test(symbol) || !name) return null;
  const tsCode = String(raw.ts_code || raw.tsCode || '').trim()
    || `${symbol}.${symbol.startsWith('6') ? 'SH' : symbol.startsWith('8') || symbol.startsWith('4') ? 'BJ' : 'SZ'}`;
  return {
    symbol,
    ts_code: tsCode,
    name,
    industry: raw.industry ? String(raw.industry).trim() : '',
  };
}

function loadStockList(filePath = DEFAULT_STOCK_LIST) {
  if (stockCache && stockCachePath === filePath) return stockCache;
  let rows = [];
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines.shift() || '').map(h => h.trim());
    rows = lines.map(line => {
      const cols = parseCsvLine(line);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cols[i]; });
      return normalizeStock(obj);
    }).filter(Boolean);
  } catch {
    rows = [];
  }
  stockCache = rows;
  stockCachePath = filePath;
  return rows;
}

function modeFromText(text) {
  if (FULL_MODE_RE.test(text || '')) return 'full';
  if (QUICK_MODE_RE.test(text || '')) return 'quick';
  return 'quick';
}

function normalizeNameText(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '');
}

function compactQueryText(text) {
  return normalizeNameText(String(text || '').replace(STOP_WORDS_RE, ' '));
}

function uniqStocks(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const stock = normalizeStock(item);
    if (!stock || seen.has(stock.symbol)) continue;
    seen.add(stock.symbol);
    out.push(stock);
  }
  return out;
}

function lookupStock(token, stocks = loadStockList()) {
  const raw = String(token || '').trim();
  if (!raw) return [];
  const code = raw.match(/\b(\d{6})(?:\.(?:SZ|SH|BJ))?\b/i);
  if (code) {
    return stocks.filter(s => s.symbol === code[1]);
  }
  const norm = normalizeNameText(raw);
  if (!norm || norm.length < 2) return [];
  const exact = stocks.filter(s => normalizeNameText(s.name) === norm);
  if (exact.length) return exact;
  const contained = stocks.filter(s => normalizeNameText(s.name).includes(norm));
  if (contained.length) return contained.slice(0, 8);
  return stocks.filter(s => norm.includes(normalizeNameText(s.name))).slice(0, 8);
}

function findStockCandidates(userInput, stocks = loadStockList()) {
  const text = String(userInput || '');
  const candidates = [];
  const codeRe = /\b(\d{6})(\.(SZ|SH|BJ))?\b/ig;
  let m;
  while ((m = codeRe.exec(text)) !== null) {
    const hit = stocks.find(s => s.symbol === m[1]) || normalizeStock({ symbol: m[1], name: m[1], ts_code: m[1] + (m[2] || '') });
    candidates.push({ ...hit, match: m[0], score: 100, reason: 'code' });
  }

  const normText = normalizeNameText(text);
  for (const s of stocks) {
    const name = normalizeNameText(s.name);
    if (name && normText.includes(name)) {
      candidates.push({ ...s, match: s.name, score: 95, reason: 'exact_name_in_text' });
    }
  }

  const compact = compactQueryText(text);
  const tokens = compact
    .split(/[^0-9A-Z\u4e00-\u9fff]+/)
    .map(x => x.trim())
    .filter(x => x.length >= 2 && !/^\d+$/.test(x));
  for (const token of tokens) {
    const hits = lookupStock(token, stocks);
    for (const h of hits) {
      const hName = normalizeNameText(h.name);
      let score = 70;
      if (hName === token) score = 92;
      else if (hName.includes(token)) score = token.length >= 3 ? 82 : 74;
      else if (token.includes(hName)) score = 76;
      candidates.push({ ...h, match: token, score, reason: 'name_token' });
    }
  }

  const best = new Map();
  for (const c of candidates) {
    const prev = best.get(c.symbol);
    if (!prev || c.score > prev.score) best.set(c.symbol, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol)).slice(0, 12);
}

function routeDeterministic(userInput, opts = {}) {
  const stocks = opts.stocks || loadStockList(opts.stockListPath);
  const text = String(userInput || '').trim();
  const checkup = opts.parseCheckupCommand ? opts.parseCheckupCommand(text) : null;
  if (checkup) {
    return {
      intent: 'portfolio_checkup',
      mode: 'quick',
      symbols: [],
      needs_clarification: false,
      checkup,
      source: 'deterministic',
      raw_input: text,
    };
  }

  const symbols = uniqStocks(findStockCandidates(text, stocks));
  const mode = modeFromText(text);
  if (!symbols.length) return null;

  if (COMPARE_RE.test(text) && symbols.length >= 2) {
    return {
      intent: 'compare_stocks',
      mode,
      symbols: symbols.slice(0, 4),
      needs_clarification: false,
      source: 'deterministic',
      raw_input: text,
    };
  }

  if (symbols.length === 1) {
    return {
      intent: 'single_stock',
      mode,
      symbols,
      needs_clarification: false,
      source: 'deterministic',
      raw_input: text,
    };
  }

  return {
    intent: 'clarify',
    mode,
    symbols: symbols.slice(0, 6),
    needs_clarification: true,
    question: '检测到多个可能标的，请确认要分析哪一只。',
    source: 'deterministic',
    raw_input: text,
  };
}

function buildLlmRouterPrompt(userInput, candidates = []) {
  const candidateLines = (candidates || []).slice(0, 12)
    .map(c => `- ${c.name} ${c.symbol} ${c.ts_code || ''} ${c.industry || ''}`.trim())
    .join('\n') || '- 本地预检未命中候选；如你能确定 A 股代码可提出，但必须输出 needs_clarification=true 让系统校验。';
  return [
    '【投委会 · 立项路由】',
    '你是投委会主席的立项执法官。本轮只把用户自然语言翻译成结构化意图，不发表任何投资观点。',
    '只输出一个 JSON 对象，不要 Markdown，不要解释。',
    '',
    '允许的 intent：',
    '- single_stock：单只 A 股快评/全量投委会',
    '- compare_stocks：两只或多只 A 股对比',
    '- portfolio_checkup：持仓体检',
    '- clarify：标的或意图不明确，需要用户确认',
    '- non_committee_chat：不是投委会任务',
    '',
    '模式规则：深挖/深度/全面/完整/全量/full => mode=full；否则 mode=quick。',
    '股票名和代码必须优先使用下方本地候选；没有把握时 intent=clarify。',
    '',
    'JSON schema：',
    '{"intent":"single_stock|compare_stocks|portfolio_checkup|clarify|non_committee_chat","mode":"quick|full","symbols":[{"name":"股票名","symbol":"6位代码"}],"needs_clarification":false,"question":""}',
    '',
    '用户原话：',
    String(userInput || ''),
    '',
    '本地候选：',
    candidateLines,
  ].join('\n');
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (!body || !body.trim().startsWith('{')) return null;
  try { return JSON.parse(body); } catch { return null; }
}

function validateLlmRoute(route, userInput, opts = {}) {
  const stocks = opts.stocks || loadStockList(opts.stockListPath);
  if (!route || typeof route !== 'object') return null;
  const intent = String(route.intent || '').trim();
  const allowed = new Set(['single_stock', 'compare_stocks', 'portfolio_checkup', 'clarify', 'non_committee_chat']);
  if (!allowed.has(intent)) return null;
  const mode = String(route.mode || modeFromText(userInput)).toLowerCase() === 'full' ? 'full' : 'quick';

  if (intent === 'non_committee_chat') {
    return { intent, mode, symbols: [], needs_clarification: false, source: 'llm', raw_input: String(userInput || '') };
  }
  if (intent === 'portfolio_checkup') {
    return { intent, mode, symbols: [], needs_clarification: false, source: 'llm', raw_input: String(userInput || '') };
  }

  const resolved = [];
  for (const item of Array.isArray(route.symbols) ? route.symbols : []) {
    if (!item) continue;
    const symbolText = String(item.symbol || '').trim();
    const nameText = String(item.name || '').trim();
    const hasExplicitSymbol = /^\d{6}(?:\.(?:SZ|SH|BJ))?$/i.test(symbolText);
    if (hasExplicitSymbol) {
      const codeHits = lookupStock(symbolText, stocks);
      if (codeHits.length !== 1) return null;
      if (nameText) {
        const nameHits = lookupStock(nameText, stocks);
        if (nameHits.length !== 1 || nameHits[0].symbol !== codeHits[0].symbol) return null;
      }
      resolved.push(codeHits[0]);
      continue;
    }
    if (nameText) {
      const nameHits = lookupStock(nameText, stocks);
      if (nameHits.length === 1) resolved.push(nameHits[0]);
    }
  }
  const symbols = uniqStocks(resolved);

  if (intent === 'single_stock') {
    if (symbols.length === 1) {
      return { intent, mode, symbols, needs_clarification: false, source: 'llm', raw_input: String(userInput || '') };
    }
    return null;
  }
  if (intent === 'compare_stocks') {
    if (symbols.length >= 2) {
      return { intent, mode, symbols: symbols.slice(0, 4), needs_clarification: false, source: 'llm', raw_input: String(userInput || '') };
    }
    return null;
  }
  return {
    intent: 'clarify',
    mode,
    symbols: symbols.length ? symbols.slice(0, 6) : uniqStocks(findStockCandidates(userInput, stocks)).slice(0, 6),
    needs_clarification: true,
    question: String(route.question || '标的或意图不明确，请确认。'),
    source: 'llm',
    raw_input: String(userInput || ''),
  };
}

module.exports = {
  buildLlmRouterPrompt,
  findStockCandidates,
  loadStockList,
  lookupStock,
  modeFromText,
  parseJsonObject,
  routeDeterministic,
  validateLlmRoute,
  _private: { parseCsvLine, normalizeStock, uniqStocks },
};
