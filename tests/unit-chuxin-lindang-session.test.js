'use strict';

// 作手林铛的每日决策本来就跑在一个真实的 Claude 会话里（chuxin 后端自己起的）。
// 这组测试守三件事：会话身份能被收进注册表、点开时开成**左侧栏可见**的会话、
// 以及没有原生会话时老老实实报错而不是随便开一个。

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  OK ${name}`))
    .catch((error) => {
      console.error(`  FAIL ${name}`);
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

function fakeIpc() {
  const handlers = new Map();
  return {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    invoke: (channel, payload) => {
      const fn = handlers.get(channel);
      assert.ok(fn, `handler not registered: ${channel}`);
      return fn({}, payload);
    },
    has: (channel) => handlers.has(channel),
  };
}

function stubLindangApi(runs) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/lindang/status') { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runs }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const RUN = {
  run_id: '20260924-083018-2315',
  status: 'warn',
  started_at: '2026-09-24T08:30:18+08:00',
  model: 'claude-fable-5',
  summary: '维持劲拓18%、金禄18%',
  session: {
    provider: 'claude-cli',
    session_id: '24e37a77-ccb1-499d-a1f0-a5c7ef359af0',
    cwd: 'C:\\Users\\lintian\\chuxin-research',
    transcript: 'C:\\Users\\lintian\\.claude\\projects\\C--Users-lintian-chuxin-research\\24e37a77.jsonl',
  },
};

const RUN_WITHOUT_SESSION = {
  run_id: '20260922-192948-055d',
  status: 'failed',
  started_at: '2026-09-22T19:29:48+08:00',
  summary: '未产生决策',
};

async function main() {
  console.log('Running lindang decision session tests...');
  const server = await stubLindangApi([RUN, RUN_WITHOUT_SESSION]);
  const port = server.address().port;
  process.env.CHUXIN_API_BASE = `http://127.0.0.1:${port}`;
  const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lindang-sess-'));
  process.env.CHUXIN_GLOBAL_SESSION_DIR = registryRoot;

  const { registerChuxinIpc } = require('../main/ipc/chuxin-handlers.js');
  const created = [];
  const sessionManager = Object.assign(new EventEmitter(), {
    listSessions: () => [],
    getSession: () => null,
    createSession: (kind, options) => {
      const session = { id: `hub-${created.length + 1}`, kind, ...options };
      created.push(session);
      return session;
    },
  });
  const ipc = fakeIpc();
  registerChuxinIpc(ipc.ipcMain, { sessionManager, sendToRenderer: () => {}, registerSessionForTap: () => {} });

  try {
    await test('决策会话被收进注册表，没有会话的那次不进来', async () => {
      const listed = await ipc.invoke('chuxin:lindang-sessions');
      assert.strictEqual(listed.ok, true);
      assert.strictEqual(listed.sessions.length, 1, '只有带会话身份的运行才该被采纳');
      const row = listed.sessions[0];
      assert.strictEqual(row.title, '作手林铛 · 2026-09-24');
      assert.strictEqual(row.kind, 'claude');
      assert.strictEqual(row.nativeSession.ccSessionId, RUN.session.session_id);
      assert.strictEqual(row.lindangRunId, RUN.run_id);
    });

    await test('点开 = 恢复原生会话，而且必须在左侧栏可见', async () => {
      const opened = await ipc.invoke('chuxin:open-lindang-session', { runId: RUN.run_id });
      assert.strictEqual(opened.ok, true, opened.message || '');
      const session = created.at(-1);
      // 这一条就是「能在左侧栏显示」：投研任务席位是 hidden 的，决策会话不能是。
      assert.strictEqual(session.hiddenFromSidebar, false);
      assert.strictEqual(session.purpose, 'lindang-decision');
      assert.strictEqual(session.resumeCCSessionId, RUN.session.session_id, '必须 --resume 到那次决策本身');
      assert.strictEqual(session.title, '作手林铛 · 2026-09-24');
    });

    await test('没采纳过的运行不给猜一个会话', async () => {
      const opened = await ipc.invoke('chuxin:open-lindang-session', { runId: '20260101-000000-zzzz' });
      assert.strictEqual(opened.ok, false);
      assert.strictEqual(opened.error, 'not-found');
    });

    await test('后端不在也不能崩，只能如实报错', async () => {
      process.env.CHUXIN_API_BASE = 'http://127.0.0.1:1';
      delete require.cache[require.resolve('../main/ipc/chuxin-handlers.js')];
      const fresh = require('../main/ipc/chuxin-handlers.js');
      const ipc2 = fakeIpc();
      fresh.registerChuxinIpc(ipc2.ipcMain, { sessionManager, sendToRenderer: () => {}, registerSessionForTap: () => {} });
      const listed = await ipc2.invoke('chuxin:lindang-sessions');
      assert.strictEqual(listed.ok, false);
      assert.ok(listed.error, '要说清为什么取不到');
    });
  } finally {
    server.close();
    fs.rmSync(registryRoot, { recursive: true, force: true });
  }
}

main();
