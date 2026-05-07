#!/usr/bin/env node
// Roundtable Memory MCP server (plan 2026-05-05 阶段 0)。
// Spawned by 圆桌 sub session 的 Claude/Codex/Gemini CLI（per meeting per slot），
// 通过 MCP config 注入。暴露 3 个 tool：
//   memory_write({scope, kind, key, content, source})
//   memory_search({query, limit})
//   memory_list({kind})
//
// 调用链：tool call → HTTP POST → Hub hookServer (loopback) → core/roundtable-memory/store.js
//
// STUB_MODE：当 ARENA_* env 缺失（用户独立终端跑 gemini 等）时进入 stub
//   —— 响应 initialize、tools/list 返回空，避免 gemini settings.json 全局注册的 server 报错。
// 参考 core/research-mcp-server.js 框架。
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MEETING_ID = process.env.ARENA_MEETING_ID || '';
const HUB_PORT = parseInt(process.env.ARENA_HUB_PORT || '0', 10);
const HOOK_TOKEN = process.env.ARENA_HOOK_TOKEN || '';
const AI_KIND = process.env.ARENA_AI_KIND || 'unknown';
const AI_MODEL = process.env.ARENA_AI_MODEL || ''; // Phase 3：精确到模型版本（claude-opus-4-7 / gemini-3-pro / ...）
const AI_SLOT = process.env.ARENA_AI_SLOT || ''; // UI 槽位（pikachu/charmander/squirtle），仅日志用

const DEBUG = process.env.ARENA_MCP_DEBUG === '1';
const LOG_FILE = DEBUG
  ? path.join(os.tmpdir(), 'arena-memory-mcp-' + Date.now() + '-' + process.pid + '.log')
  : null;
function logErr(msg) {
  try { process.stderr.write('[arena-memory-mcp] ' + msg + '\n'); } catch {}
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
  }
}

logErr('startup pid=' + process.pid + ' meeting=' + MEETING_ID + ' port=' + HUB_PORT + ' kind=' + AI_KIND + ' model=' + AI_MODEL + ' slot=' + AI_SLOT);

// Phase 3：以 AI 身份（kind+model）作为存储 key，slot 仅 UI 标识。
//   STUB 判定保留 slot 检查（无 slot 视为非圆桌环境，进 STUB），不强制 model 存在 — model 缺失时 hookServer 会兜底为 'default'。
const STUB_MODE = !MEETING_ID || !HUB_PORT || !HOOK_TOKEN || !AI_SLOT;
if (STUB_MODE) {
  logErr('no/partial ARENA_* env detected, running in STUB mode (tools list will be empty)');
}

const TOOLS = [
  {
    name: 'memory_write',
    description: '写一条圆桌记忆到自己的个体记忆文件 (slot.md)。仅记录长期偏好/稳定事实/对用户的稳定理解，不要记录单轮讨论结论或一次性观察（防思维固化）。同 key 重复写入会更新最新内容并 +1 recall。用户说"记住这个/记下"时必须立即调用，source="explicit"。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['scene'],
          description: '阶段 0 固定 "scene"（per-scene 隔离，cross-scene 阶段 2+ 才开放）',
          default: 'scene',
        },
        kind: {
          type: 'string',
          enum: ['preference', 'fact', 'observation', 'persisted'],
          description: 'preference=用户协作偏好；fact=项目稳定信息；observation=对用户的稳定理解；persisted=永不淘汰',
        },
        key: {
          type: 'string',
          description: '短名 key（如 conclusion-first / no-mock / downside-first），同 key 写入会 dedup',
        },
        content: {
          type: 'string',
          description: '一句话内容（≤ 100 字）',
        },
        source: {
          type: 'string',
          enum: ['self', 'inbox', 'explicit'],
          description: 'self=AI 自主写；inbox=采纳后台 worker 候选；explicit=用户显式说"记住"触发',
          default: 'self',
        },
      },
      required: ['kind', 'key', 'content'],
    },
  },
  {
    name: 'memory_search',
    description: '在自己的记忆文件里按 key 或 content 子串匹配搜索。命中条目 recall+1，用于追踪哪些记忆真的被用上。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键字（朴素子串匹配，无大小写）' },
        limit: { type: 'number', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_list',
    description: '列出自己的全部记忆条目（可按 kind 过滤）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['preference', 'fact', 'observation', 'persisted'],
        },
      },
    },
  },
];

// --- HTTP helper ---
function postFetch(endpoint, body, timeoutMs = 30000) {
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
      serverInfo: { name: 'arena-roundtable-memory', version: '0.1.0' },
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
      return replyError(id, -32601, 'arena-roundtable-memory in stub mode (not in roundtable session)');
    }
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    // 注意 baseBody 用 aiKind 字段名而非 kind，避免与 memory_list/memory_write 的 entry kind 字段同名冲突
    // （之前的 bug：list 调用时 spread `{ ...baseBody, ...args }` 让 baseBody.kind='claude' 漏到 store.listMemory.kind）
    // Phase 3：透传 model 给 hookServer（hookServer 会用 (aiKind, model) 派生 identity）
    const baseBody = { token: HOOK_TOKEN, meetingId: MEETING_ID, aiKind: AI_KIND, aiModel: AI_MODEL, slot: AI_SLOT };

    if (name === 'memory_write') {
      const r = await postFetch('/api/roundtable/memory-write', { ...baseBody, ...args });
      if (!r.ok) {
        return reply(id, { content: [{ type: 'text', text: `memory_write 失败 (${r.status}): ${r.body}` }], isError: true });
      }
      return reply(id, { content: [{ type: 'text', text: r.body }], isError: false });
    }

    if (name === 'memory_search') {
      const r = await postFetch('/api/roundtable/memory-search', { ...baseBody, ...args });
      if (!r.ok) {
        return reply(id, { content: [{ type: 'text', text: `memory_search 失败 (${r.status}): ${r.body}` }], isError: true });
      }
      return reply(id, { content: [{ type: 'text', text: r.body }], isError: false });
    }

    if (name === 'memory_list') {
      const r = await postFetch('/api/roundtable/memory-list', { ...baseBody, ...args });
      if (!r.ok) {
        return reply(id, { content: [{ type: 'text', text: `memory_list 失败 (${r.status}): ${r.body}` }], isError: true });
      }
      return reply(id, { content: [{ type: 'text', text: r.body }], isError: false });
    }

    return replyError(id, -32601, 'unknown tool: ' + name);
  }
  return replyError(id, -32601, 'method not found: ' + method);
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
