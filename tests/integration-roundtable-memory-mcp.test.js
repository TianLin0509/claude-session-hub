// tests/integration-roundtable-memory-mcp.test.js
// 阶段 0 集成测试 (plan 2026-05-05 Task 0.8 模拟版)
//
// 链路：MCP server (JSON-RPC over stdio) → mock hookServer (HTTP loopback)
//       → core/roundtable-memory/store.js → .md 文件写盘
//
// 模拟三家 AI（pikachu/charmander/squirtle）各调一次 memory_write，
// 验证 .arena/rooms/general/memory/{slot}.md 三个文件创建 + 内容正确。
//
// 不启动真实 Hub UI；mock hookServer 复用 main.js:3076-3147 的 memory route 逻辑。
//
// 这一步证明的是 MCP 协议层 + HTTP loopback + store 写盘三段链路通；
// AI 是否真主动调 memory_write 是 prompt 工程问题，留待真实 5-10 场圆桌验证。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mem-int-'));
const PROJECT_CWD = TEMP;
const SCENE = 'general';
const MEETING_ID = 'test-meeting-' + Date.now();
const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');

const store = require('../core/roundtable-memory/store.js');

// ---------------------------------------------------------------------------
// 1. 启 mock hookServer
// ---------------------------------------------------------------------------
function startMockHookServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const isMemory = req.method === 'POST' && req.url.startsWith('/api/roundtable/memory-');
      if (!isMemory) { res.writeHead(404); res.end('{}'); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
        if (parsed.token !== HOOK_TOKEN) { res.writeHead(403); res.end('{}'); return; }
        // Phase 3：从 (aiKind, aiModel) 派生 identity（同 main.js hookServer 真实 route）
        const identity = store.makeIdentity(parsed.aiKind, parsed.aiModel);
        let result;
        try {
          if (req.url === '/api/roundtable/memory-write') {
            result = store.appendMemoryEntry({
              projectCwd: PROJECT_CWD, scene: SCENE, identity,
              scope: parsed.scope || 'scene',
              kind: parsed.kind, key: parsed.key, content: parsed.content,
              source: parsed.source || 'self',
            });
          } else if (req.url === '/api/roundtable/memory-search') {
            result = store.searchMemory({
              projectCwd: PROJECT_CWD, scene: SCENE, identity,
              query: parsed.query, limit: parsed.limit,
            });
          } else if (req.url === '/api/roundtable/memory-list') {
            result = store.listMemory({
              projectCwd: PROJECT_CWD, scene: SCENE, identity,
              kind: parsed.kind,
            });
          }
        } catch (e) {
          result = { ok: false, error: 'route throw: ' + e.message };
        }
        res.writeHead(200);
        res.end(JSON.stringify(result));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.log(`mock hookServer listening on 127.0.0.1:${port}`);
      resolve({ server, port });
    });
  });
}

// ---------------------------------------------------------------------------
// 2. spawn MCP server 子进程，做 JSON-RPC client
// ---------------------------------------------------------------------------
function startMcpClient(slot, port) {
  const serverPath = path.resolve(__dirname, '..', 'core', 'roundtable-memory-mcp-server.js');
  // Phase 3：每个 slot 关联一个具体 (aiKind, aiModel) 模拟真实圆桌
  const SLOT_TO_AI = {
    pikachu:    { kind: 'claude', model: 'claude-opus-4-7' },
    charmander: { kind: 'gemini', model: 'gemini-3-pro' },
    squirtle:   { kind: 'codex',  model: 'gpt-5.2-codex' },
  };
  const ai = SLOT_TO_AI[slot] || { kind: 'unknown', model: '' };
  const proc = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ARENA_MEETING_ID: MEETING_ID,
      ARENA_HUB_PORT: String(port),
      ARENA_HOOK_TOKEN: HOOK_TOKEN,
      ARENA_AI_KIND: ai.kind,
      ARENA_AI_MODEL: ai.model,
      ARENA_AI_SLOT: slot,
    },
  });

  let stderrBuf = '';
  proc.stderr.on('data', (c) => { stderrBuf += c.toString(); });

  let respBuf = '';
  const pendingByid = new Map();
  let nextId = 1;

  proc.stdout.on('data', (c) => {
    respBuf += c.toString();
    let nl;
    while ((nl = respBuf.indexOf('\n')) >= 0) {
      const line = respBuf.slice(0, nl).trim();
      respBuf = respBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pendingByid.has(msg.id)) {
        pendingByid.get(msg.id)(msg);
        pendingByid.delete(msg.id);
      }
    }
  });

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pendingByid.set(id, (msg) => resolve(msg));
      const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      proc.stdin.write(req);
      setTimeout(() => {
        if (pendingByid.has(id)) {
          pendingByid.delete(id);
          reject(new Error(`timeout waiting for ${method} (slot=${slot}); stderr: ${stderrBuf.slice(0, 500)}`));
        }
      }, 5000);
    });
  }

  function notify(method, params) {
    const req = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    proc.stdin.write(req);
  }

  function close() {
    try { proc.stdin.end(); } catch {}
    proc.kill();
  }

  return { proc, call, notify, close, getStderr: () => stderrBuf };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async () => {
  const { server, port } = await startMockHookServer();
  console.log(`temp project cwd: ${PROJECT_CWD}`);

  // 三家各启 MCP server 子进程，模拟圆桌三个 sub session 各跑一个 server
  const slots = ['pikachu', 'charmander', 'squirtle'];
  const clients = {};
  for (const slot of slots) {
    clients[slot] = startMcpClient(slot, port);
  }

  try {
    // T1: initialize 三家
    for (const slot of slots) {
      const r = await clients[slot].call('initialize', {});
      assert.ok(r.result, `initialize ok for ${slot}`);
      assert.strictEqual(r.result.serverInfo.name, 'arena-roundtable-memory');
      clients[slot].notify('notifications/initialized', {});
    }
    console.log('PASS T1 initialize × 3');

    // T2: tools/list 返回 3 个工具
    for (const slot of slots) {
      const r = await clients[slot].call('tools/list', {});
      assert.ok(r.result && Array.isArray(r.result.tools), `tools/list result for ${slot}`);
      assert.strictEqual(r.result.tools.length, 3, `${slot}: 3 tools`);
      const names = r.result.tools.map(t => t.name).sort();
      assert.deepStrictEqual(names, ['memory_list', 'memory_search', 'memory_write']);
    }
    console.log('PASS T2 tools/list × 3 (each returns 3 tools)');

    // T3: 三家各调一次 memory_write
    const writes = [
      { slot: 'pikachu', kind: 'preference', key: 'conclusion-first', content: '用户喜欢结论先行，再展开论证', source: 'self' },
      { slot: 'charmander', kind: 'observation', key: 'risk-averse', content: '用户决策时重视下行风险', source: 'self' },
      { slot: 'squirtle', kind: 'fact', key: 'main-language', content: 'Python 是用户主语言', source: 'explicit' },
    ];
    for (const w of writes) {
      const r = await clients[w.slot].call('tools/call', {
        name: 'memory_write',
        arguments: { scope: 'scene', kind: w.kind, key: w.key, content: w.content, source: w.source },
      });
      assert.ok(r.result, `memory_write call for ${w.slot}`);
      assert.strictEqual(r.result.isError, false, `memory_write not error for ${w.slot}; body=${JSON.stringify(r.result)}`);
      const text = r.result.content[0].text;
      const parsedRet = JSON.parse(text);
      assert.strictEqual(parsedRet.ok, true, `${w.slot} memory_write ok: ${text}`);
      assert.strictEqual(parsedRet.action, 'create', `${w.slot} action=create`);
    }
    console.log('PASS T3 memory_write × 3 (one per slot)');

    // T4: 验证 .md 文件创建（Phase 4：按家族命名 — claude.md / gemini.md / gpt.md，codex 合并到 gpt）
    const SLOT_TO_FAMILY = {
      pikachu:    'claude',
      charmander: 'gemini',
      squirtle:   'gpt', // codex canonical → gpt 家族
    };
    for (const w of writes) {
      const id = SLOT_TO_FAMILY[w.slot];
      const fp = path.join(PROJECT_CWD, '.arena', 'rooms', SCENE, 'memory', id + '.md');
      assert.ok(fs.existsSync(fp), `${id}.md exists for slot ${w.slot}: ${fp}`);
      const text = fs.readFileSync(fp, 'utf-8');
      assert.ok(text.includes(`${w.kind}:${w.key}`), `${id}.md has ${w.kind}:${w.key}`);
      assert.ok(text.includes(`[source: ${w.source}]`), `${id}.md has source=${w.source}`);
      assert.ok(text.includes(w.content), `${id}.md has content`);
    }
    console.log('PASS T4 three .md files created (by family — codex合并到gpt.md)');

    // T5: memory_search 命中
    const sr = await clients.pikachu.call('tools/call', {
      name: 'memory_search',
      arguments: { query: '结论', limit: 5 },
    });
    const sParsed = JSON.parse(sr.result.content[0].text);
    assert.strictEqual(sParsed.ok, true);
    assert.strictEqual(sParsed.results.length, 1);
    assert.strictEqual(sParsed.results[0].key, 'preference:conclusion-first');
    console.log('PASS T5 memory_search hit');

    // T6: memory_list 三家各看自己
    for (const slot of slots) {
      const lr = await clients[slot].call('tools/call', {
        name: 'memory_list',
        arguments: {},
      });
      const lParsed = JSON.parse(lr.result.content[0].text);
      assert.strictEqual(lParsed.ok, true);
      assert.strictEqual(lParsed.results.length, 1, `${slot} list returns 1 entry`);
    }
    console.log('PASS T6 memory_list × 3 (per-slot isolation)');

    // T7: 同 key 二次写入 → update
    const r7 = await clients.pikachu.call('tools/call', {
      name: 'memory_write',
      arguments: {
        scope: 'scene', kind: 'preference', key: 'conclusion-first',
        content: '用户喜欢结论先行（多次确认）', source: 'self',
      },
    });
    const r7Parsed = JSON.parse(r7.result.content[0].text);
    assert.strictEqual(r7Parsed.action, 'update');
    console.log('PASS T7 dedup over MCP');

    console.log('\nALL PASS · integration-roundtable-memory-mcp.test.js');
    console.log('temp dir:', TEMP);
  } catch (e) {
    console.error('FAIL:', e.stack || e);
    for (const slot of slots) {
      const stderr = clients[slot] && clients[slot].getStderr && clients[slot].getStderr();
      if (stderr) console.error(`-- ${slot} stderr --\n${stderr}\n`);
    }
    process.exit(1);
  } finally {
    for (const slot of slots) {
      try { clients[slot].close(); } catch {}
    }
    server.close();
  }
})();
