'use strict';
// 编排员 MCP：stdio 协议、工具清单，以及经 Hub 桥的身份绑定（请求头决定调用者，正文伪造无效）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AssistantBridge } = require('../core/hub-assistant/bridge');
const { TOOL_NAMES } = require('../main/orchestration/service');

function rpc(child) {
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  let id = 0;
  return (method, params) => new Promise(resolve => { id += 1; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}

test('orchestrator MCP lists exactly the Hub tools and forwards calls with the host-bound identity', async t => {
  const calls = [];
  const bridge = new AssistantBridge(async request => { calls.push(request); return { echo: request.name }; }, { identityHeader: 'x-hub-orchestrator-session' });
  await bridge.start();
  t.after(() => bridge.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-'));
  const endpoint = path.join(dir, 'endpoint.json');
  fs.writeFileSync(endpoint, JSON.stringify({ url: bridge.url, token: bridge.secret }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'orchestrator-mcp.js')], {
    env: { ...process.env, HUB_ORCH_ENDPOINT_FILE: endpoint, HUB_ORCH_SESSION_ID: 'session-from-host' }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
  });
  t.after(() => child.kill());
  child.stdout.setEncoding('utf8');
  const call = rpc(child);
  const init = await call('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.result.serverInfo.name, 'hub-orchestrator');
  const list = await call('tools/list', {});
  assert.deepEqual(list.result.tools.map(x => x.name).sort(), [...TOOL_NAMES].sort());
  const res = await call('tools/call', { name: 'orch_status', arguments: {}, callerSessionId: 'forged' });
  assert.equal(res.result.isError, false);
  assert.equal(calls[0].callerSessionId, 'session-from-host');
  const bad = await call('tools/call', { name: 'rm_rf', arguments: {} });
  assert.match(bad.error.message, /未知工具/);
  // The assistant's default header is unchanged.
  assert.equal(new AssistantBridge(() => {}).identityHeader, 'x-hub-assistant-session');
});
