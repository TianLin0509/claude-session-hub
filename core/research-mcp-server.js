#!/usr/bin/env node
// Research Roundtable MCP server (2026-05-03 重构)。
// Spawned by Claude/Codex/Gemini CLI per research mode meeting，through MCP config 注入。
// 暴露 2 个工具：
//   fetch_lindang_stock(symbol)         — 一站式快照（gate + basic + price + 17 指标 + 资金流）
//   fetch_lindang_field(op, symbol, …)  — 按需取单字段（financial/flow/dragon-tiger/...）
//
// 调用链：tool call → HTTP POST → Hub hookServer (loopback) → core/lindang-bridge.js → data_query.py
// 详见 C:\LinDangAgent\data\AGENT_GUIDE.md
//
// 旧的 fetch_concept_stocks / fetch_sector_overview 已下线（依赖 Stock_top10 已删）。
'use strict';

const http = require('http');

const MEETING_ID = process.env.ARENA_MEETING_ID || '';
const HUB_PORT = parseInt(process.env.ARENA_HUB_PORT || '0', 10);
const HOOK_TOKEN = process.env.ARENA_HOOK_TOKEN || '';
const AI_KIND = process.env.ARENA_AI_KIND || 'unknown';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEBUG = process.env.ARENA_MCP_DEBUG === '1';
const LOG_FILE = DEBUG
  ? path.join(os.tmpdir(), 'arena-research-mcp-' + Date.now() + '-' + process.pid + '.log')
  : null;
function logErr(msg) {
  try { process.stderr.write('[arena-research-mcp] ' + msg + '\n'); } catch {}
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
  }
}

logErr('startup pid=' + process.pid + ' meeting=' + MEETING_ID + ' port=' + HUB_PORT + ' kind=' + AI_KIND);

// Stub mode: 当 ARENA_* env 缺失（例如用户在终端独立跑 gemini，或非 research 圆桌会议
// spawn gemini）时，server 不退出而是进入 stub —— 响应 initialize、tools/list 返回空，
// 避免 gemini settings.json 里全局注册的 arena-research server 在无 ARENA_* 环境下报错。
const STUB_MODE = !MEETING_ID || !HUB_PORT || !HOOK_TOKEN;
if (STUB_MODE) {
  logErr('no ARENA_* env detected, running in STUB mode (tools list will be empty)');
}

// --- MCP tools ---
const FIELD_OPS = [
  'gate', 'basic', 'price', 'financial', 'flow', 'dragon-tiger',
  'valuation', 'northbound', 'margin', 'peers', 'holders', 'pledge', 'funds',
  'qmt-kline', 'qmt-realtime', 'qmt-sector', 'qmt-financial', 'indicators',
];

const TOOLS = [
  {
    name: 'fetch_lindang_stock',
    description: '【优先用此工具】拉 A 股单股快照：一次返回 gate(退市/ST 拦截) + basic(PE/PB/市值/换手率) + price_summary(走势文本) + indicators(17 项 RSI/MACD/Bollinger/KDJ/ATR/...) + capital_flow(资金流向)。讨论新股票的标准开场。来源：用户的 LinDangAgent，含 5 层数据兜底（tushare→akshare→东财→baostock→sina）。底层调 `python data_query.py snapshot <symbol>`。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'A股股票代码（"600519" / "600519.SH" / 中文名"贵州茅台" 都可）',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'fetch_lindang_field',
    description: '按需取 A 股单字段数据（snapshot 不够细时用）。op 可选：gate(退市/ST检查) / basic(基本面) / price(K线+摘要) / financial(财务报表) / flow(资金流) / dragon-tiger(龙虎榜) / valuation(PE/PB历史分位) / northbound(北向) / margin(融资融券) / peers(同业对比) / holders(大股东) / pledge(质押) / funds(基金持仓) / indicators(17项技术指标) / qmt-kline(实时K线) / qmt-realtime(实时盘口，symbol 用逗号分隔) / qmt-sector(板块成分，symbol传板块名) / qmt-financial(QMT财报)。底层调 `python data_query.py <op> <symbol>`。',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: FIELD_OPS,
          description: '要查的字段 op',
        },
        symbol: {
          type: 'string',
          description: '股票代码或名称（qmt-realtime 多股逗号分隔；qmt-sector 传板块名）',
        },
      },
      required: ['op', 'symbol'],
    },
  },
];

// --- HTTP helper ---
function postFetch(endpoint, body, timeoutMs = 100000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: HUB_PORT,
      path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: chunks }));
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: 'request error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

// --- JSON-RPC over stdio ---
function send(msg) {
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) { logErr('stdout write failed: ' + e.message); }
}
function reply(id, result) { if (id != null) send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { if (id != null) send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleRequest(req) {
  const { id, method, params } = req || {};
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'arena-research', version: '2.0.0' },
    });
  }
  if (method === 'notifications/initialized') {
    return;
  }
  if (method === 'tools/list') {
    return reply(id, { tools: STUB_MODE ? [] : TOOLS });
  }
  if (method === 'tools/call') {
    if (STUB_MODE) {
      return replyError(id, -32601, 'arena-research server in stub mode (not in research roundtable)');
    }
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const baseBody = { token: HOOK_TOKEN, meetingId: MEETING_ID, kind: AI_KIND };

    if (name === 'fetch_lindang_stock') {
      const symbol = String(args.symbol || '');
      if (!symbol) {
        return reply(id, { content: [{ type: 'text', text: '错误：symbol 参数必填（例 "600519" 或 "贵州茅台"）' }], isError: true });
      }
      const r = await postFetch('/api/research/fetch-stock', { ...baseBody, symbol });
      const text = r.ok ? r.body : `LinDangAgent 拉股票快照失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }

    if (name === 'fetch_lindang_field') {
      const op = String(args.op || '');
      const symbol = String(args.symbol || '');
      if (!op || !FIELD_OPS.includes(op)) {
        return reply(id, { content: [{ type: 'text', text: `错误：op 参数无效。可选：${FIELD_OPS.join(', ')}` }], isError: true });
      }
      if (!symbol) {
        return reply(id, { content: [{ type: 'text', text: '错误：symbol 参数必填' }], isError: true });
      }
      const r = await postFetch('/api/research/fetch-field', { ...baseBody, op, symbol });
      const text = r.ok ? r.body : `LinDangAgent ${op} 查询失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }

    return replyError(id, -32601, 'unknown tool: ' + name);
  }
  return replyError(id, -32601, 'method not found: ' + method);
}

// --- diagnostic heartbeat ---
if (DEBUG) {
  let _hb = 0;
  const _hbI = setInterval(() => {
    _hb++;
    logErr('heartbeat #' + _hb);
    if (_hb >= 30) clearInterval(_hbI);
  }, 2000);
}

// --- stdin line buffer ---
let buf = '';
process.stdin.on('data', (chunk) => {
  if (DEBUG) logErr('stdin chunk: ' + chunk.length + ' bytes');
  buf += chunk.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch (e) { logErr('parse failed: ' + e.message); continue; }
    if (DEBUG) logErr('handling method=' + req.method + ' id=' + req.id);
    Promise.resolve(handleRequest(req)).catch((e) => {
      logErr('handler error: ' + e.message);
      replyError(req.id, -32603, 'internal error: ' + e.message);
    });
  }
});
process.stdin.on('end', () => { logErr('stdin ended'); process.exit(0); });
process.stdin.on('error', (e) => logErr('stdin error: ' + e.message));
process.stdin.on('close', () => logErr('stdin closed'));
process.on('SIGTERM', () => { logErr('SIGTERM received'); process.exit(0); });
process.on('exit', (code) => logErr('process exit code=' + code));
