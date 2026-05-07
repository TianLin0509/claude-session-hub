// Phase 3 mock E2E：模型切换场景（场 A 三家 → 关 → 场 B 三家不同 model）
//
// 链路与 phase 0 integration 同：spawn mcp-server 子进程 + JSON-RPC + HTTP loopback + store 写盘
// 但本测试模拟"两场圆桌使用不同 model" — 验证：
//   场 A 写入 → 场 B 同 slot 不同 model → 看不到场 A 的偏好
//   关掉场 A 不影响数据持久化（重新 spawn 仍能读到自己历史）
//
// 不启 Hub UI；mock hookServer 复用 main.js 真实 route 的 identity 派生逻辑。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mem-p3-e2e-'));
const PROJECT_CWD = TEMP;
const SCENE = 'general';
const MEETING_ID = 'p3-e2e-' + Date.now();
const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');

const store = require('../core/roundtable-memory/store.js');

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
        // Phase 3：派生 identity from (aiKind, aiModel)
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
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function startMcpClient(slot, aiKind, aiModel, port) {
  const serverPath = path.resolve(__dirname, '..', 'core', 'roundtable-memory-mcp-server.js');
  const proc = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ARENA_MEETING_ID: MEETING_ID,
      ARENA_HUB_PORT: String(port),
      ARENA_HOOK_TOKEN: HOOK_TOKEN,
      ARENA_AI_KIND: aiKind,
      ARENA_AI_MODEL: aiModel,
      ARENA_AI_SLOT: slot,
    },
  });
  let respBuf = '';
  const pendingByid = new Map();
  let nextId = 1;
  let stderrBuf = '';
  proc.stderr.on('data', (c) => { stderrBuf += c.toString(); });
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
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pendingByid.has(id)) {
          pendingByid.delete(id);
          reject(new Error(`timeout slot=${slot} kind=${aiKind} model=${aiModel}; stderr: ${stderrBuf.slice(0, 400)}`));
        }
      }, 5000);
    });
  }
  function notify(method, params) {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  function close() { try { proc.stdin.end(); } catch {} proc.kill(); }
  return { proc, call, notify, close };
}

(async () => {
  const { server, port } = await startMockHookServer();
  console.log(`mock hookServer on 127.0.0.1:${port}`);
  console.log(`temp project cwd: ${PROJECT_CWD}\n`);

  // ========== 场 A：三家 sonnet 4.6 / gemini 3 pro / gpt-5.2 codex ==========
  console.log('=== 场 A：3 家 AI 写偏好 ===');
  const sceneAClients = [
    { slot: 'pikachu',    kind: 'claude', model: 'claude-sonnet-4-6' },
    { slot: 'charmander', kind: 'gemini', model: 'gemini-3-pro' },
    { slot: 'squirtle',   kind: 'codex',  model: 'gpt-5.2-codex' },
  ];
  const aClients = sceneAClients.map(s => ({ ...s, client: startMcpClient(s.slot, s.kind, s.model, port) }));
  for (const c of aClients) {
    const r = await c.client.call('initialize', {});
    assert.ok(r.result, `场 A initialize ${c.kind}`);
    c.client.notify('notifications/initialized', {});
  }
  for (const c of aClients) {
    const r = await c.client.call('tools/call', {
      name: 'memory_write',
      arguments: { scope: 'scene', kind: 'preference', key: 'conclusion-first', content: `${c.kind} 偏好结论先行`, source: 'explicit' },
    });
    const parsed = JSON.parse(r.result.content[0].text);
    assert.strictEqual(parsed.ok, true, `场 A ${c.kind} write OK`);
  }
  for (const c of aClients) c.client.close();
  console.log('场 A 三家写完，关闭 mcp clients');
  // 等子进程清理（Windows 下 spawn close 异步）
  await new Promise(r => setTimeout(r, 300));

  // 验证三家家族文件落盘（Phase 4：codex 合到 gpt.md）
  const memDir = path.join(PROJECT_CWD, '.arena', 'rooms', SCENE, 'memory');
  const filesAfterA = fs.readdirSync(memDir).filter(n => n.endsWith('.md')).sort();
  console.log('场 A 后 memDir：', filesAfterA);
  assert.deepStrictEqual(filesAfterA, [
    'claude.md',
    'gemini.md',
    'gpt.md', // codex canonical → gpt 家族
  ].sort(), '场 A 应生成 3 个家族命名 .md（codex 合并到 gpt.md）');
  console.log('PASS · 场 A 按家族分别落盘（codex→gpt 合并）\n');

  // ========== 场 B：同 slot 切到不同 model（仍同家族）→ Phase 4 应读到（家族共享） ==========
  console.log('=== 场 B：切到不同 model 但同家族 → Phase 4 应读到（家族共享）===');
  const sceneBClients = [
    { slot: 'pikachu',    kind: 'claude', model: 'claude-opus-4-7' },     // 4.6 → 4.7（同 claude 家族）
    { slot: 'charmander', kind: 'gemini', model: 'gemini-2-5-pro' },       // 3 → 2.5（同 gemini 家族）
    { slot: 'squirtle',   kind: 'gpt',    model: 'gpt-5.5' },              // codex → gpt（同 gpt 家族）
  ];
  const bClients = sceneBClients.map(s => ({ ...s, client: startMcpClient(s.slot, s.kind, s.model, port) }));
  for (const c of bClients) {
    const r = await c.client.call('initialize', {});
    assert.ok(r.result);
    c.client.notify('notifications/initialized', {});
  }
  let bAllShared = true;
  for (const c of bClients) {
    const r = await c.client.call('tools/call', { name: 'memory_list', arguments: {} });
    const parsed = JSON.parse(r.result.content[0].text);
    const hits = (parsed.results || []).length;
    console.log(`  场 B ${c.kind}/${c.model}（同 slot=${c.slot}）→ ${hits} 条`);
    if (hits === 0) bAllShared = false;
  }
  for (const c of bClients) c.client.close();
  await new Promise(r => setTimeout(r, 300));

  assert.strictEqual(bAllShared, true, '场 B 同家族不同 model 应读到场 A 偏好（family 共享生效）');
  console.log('PASS · 场 B 同家族跨 model 共享 memory（Phase 4 反转 phase 3 的 model 隔离）\n');

  // ========== 场 C：跨家族（gemini 读 → 看不到 claude 的） ==========
  console.log('=== 场 C：Sonnet 重连同家族 → 仍能读到自己历史 ===');
  const cClient = startMcpClient('pikachu', 'claude', 'claude-sonnet-4-6', port);
  await cClient.call('initialize', {});
  cClient.notify('notifications/initialized', {});
  const lr = await cClient.call('tools/call', { name: 'memory_list', arguments: {} });
  const lParsed = JSON.parse(lr.result.content[0].text);
  const sonnetHits = (lParsed.results || []).length;
  cClient.close();
  console.log(`场 C Sonnet 重连读到 ${sonnetHits} 条偏好`);
  // Phase 4：claude.md 现在共享，所以 Sonnet 重连读到的是整个 claude 家族的 entries（1 条 — 场 A 自己写的）
  assert.strictEqual(sonnetHits, 1, 'Sonnet 跨场重连应读到 claude 家族的 1 条');
  assert.strictEqual(lParsed.results[0].key, 'preference:conclusion-first');
  console.log('PASS · 场 C Sonnet 跨场延续生效（同 model 不管 slot 都能读自己历史）\n');

  // ========== 总结 ==========
  const finalFiles = fs.readdirSync(memDir).filter(n => n.endsWith('.md')).sort();
  console.log('最终 memDir：', finalFiles);
  console.log('\nALL PASS · phase 3 model-switch E2E');
  console.log('TEMP:', TEMP);
  server.close();
})().catch((e) => {
  console.error('FAIL:', e.stack || e);
  process.exit(1);
});
