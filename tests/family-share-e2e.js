// Phase 4 mock E2E：家族级共享 + codex 合并 gpt + 跨家族隔离
//
// 链路：spawn 真 mcp-server 子进程 + JSON-RPC over stdio + HTTP loopback + store 写盘
// 与 phase 3 identity-model-switch-e2e 同框架，但断言反向：
//   场 A 三家 sonnet/gemini-3/codex-5.2 写偏好（→ claude.md / gemini.md / gpt.md）
//   场 B 同 slot 切到 opus/gemini-2.5/packy-gpt-5.5（同家族不同 model）→ 应**读到**场 A 偏好
//   场 C 切到 deepseek 全家 → 应**读不到**（跨家族隔离）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mem-p4-e2e-'));
const PROJECT_CWD = TEMP;
const SCENE = 'general';
const MEETING_ID = 'p4-e2e-' + Date.now();
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
  console.log(`mock hookServer on 127.0.0.1:${port}\ntemp project cwd: ${PROJECT_CWD}\n`);

  // ========== 场 A：三家不同家族写偏好 ==========
  console.log('=== 场 A：3 家不同家族写偏好（claude / gemini / codex） ===');
  const sceneAClients = [
    { slot: 'pikachu',    kind: 'claude', model: 'claude-sonnet-4-6' },
    { slot: 'charmander', kind: 'gemini', model: 'gemini-3-pro' },
    { slot: 'squirtle',   kind: 'codex',  model: 'gpt-5.2-codex' }, // 应合并到 gpt.md
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
  await new Promise(r => setTimeout(r, 300));

  // 验证 3 个家族文件落盘
  const memDir = path.join(PROJECT_CWD, '.arena', 'rooms', SCENE, 'memory');
  const filesAfterA = fs.readdirSync(memDir).filter(n => n.endsWith('.md')).sort();
  console.log('场 A 后 memDir：', filesAfterA);
  assert.deepStrictEqual(filesAfterA, ['claude.md', 'gemini.md', 'gpt.md'].sort(),
    '场 A 应生成 3 个家族 .md（codex canonical → gpt.md）');
  console.log('PASS · 场 A 按家族落盘（codex→gpt 合并到 gpt.md）\n');

  // ========== 场 B：同家族切到不同 model → 应读到（family 共享） ==========
  console.log('=== 场 B：3 家切到同家族不同 model → 应读到场 A 的偏好（family 共享）===');
  const sceneBClients = [
    { slot: 'pikachu',    kind: 'claude', model: 'claude-opus-4-7' },     // sonnet → opus，仍是 claude
    { slot: 'charmander', kind: 'gemini', model: 'gemini-2-5-pro' },       // 3 → 2.5，仍是 gemini
    { slot: 'squirtle',   kind: 'gpt',    model: 'gpt-5.5' },              // codex → packy-gpt，仍是 gpt
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

  assert.strictEqual(bAllShared, true, '场 B 三家同家族不同 model 应读到场 A 偏好（family 共享）');
  console.log('PASS · 场 B 同家族跨 model 共享（Opus 读 Sonnet 写、packy-gpt 读 codex 写）\n');

  // ========== 场 C：跨家族 → 应读不到 ==========
  console.log('=== 场 C：deepseek 全家（不同家族）→ 应读不到 ===');
  const sceneCClients = [
    { slot: 'pikachu',    kind: 'deepseek', model: 'deepseek-v4-pro' },
    { slot: 'charmander', kind: 'glm',      model: 'glm-4-6' },
    { slot: 'squirtle',   kind: 'kimi',     model: 'kimi-k2-5' },
  ];
  const cClients = sceneCClients.map(s => ({ ...s, client: startMcpClient(s.slot, s.kind, s.model, port) }));
  for (const c of cClients) {
    const r = await c.client.call('initialize', {});
    assert.ok(r.result);
    c.client.notify('notifications/initialized', {});
  }
  let cAllEmpty = true;
  for (const c of cClients) {
    const r = await c.client.call('tools/call', { name: 'memory_list', arguments: {} });
    const parsed = JSON.parse(r.result.content[0].text);
    const hits = (parsed.results || []).length;
    console.log(`  场 C ${c.kind}/${c.model} → ${hits} 条`);
    if (hits > 0) cAllEmpty = false;
  }
  for (const c of cClients) c.client.close();
  await new Promise(r => setTimeout(r, 300));

  assert.strictEqual(cAllEmpty, true, '场 C 跨家族应读不到（家族隔离生效）');
  console.log('PASS · 场 C 跨家族隔离（deepseek/glm/kimi 全 0 条）\n');

  // ========== 总结 ==========
  const finalFiles = fs.readdirSync(memDir).filter(n => n.endsWith('.md')).sort();
  console.log('最终 memDir：', finalFiles);
  console.log('\nALL PASS · phase 4 family-share E2E');
  console.log('TEMP:', TEMP);
  server.close();
})().catch((e) => {
  console.error('FAIL:', e.stack || e);
  process.exit(1);
});
