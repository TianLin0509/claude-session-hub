'use strict';

const assert = require('assert');
const { registerSessionIpc } = require('../main/ipc/session-handlers.js');

function run() {
  const handlers = new Map();
  const ipcMain = {
    handle(name, fn) { handlers.set(name, fn); },
    on() {},
  };
  const created = [];
  const sessionManager = {
    createSession(kind, opts) {
      created.push({ kind, opts });
      return { id: `s${created.length}`, kind, cwd: opts.cwd };
    },
    getAllSessions() { return []; },
  };
  let scratchCount = 0;
  const workspaceCalls = [];
  const workspaceService = {
    resolveForSession(cwd, meta) {
      workspaceCalls.push({ cwd, meta });
      if (cwd) return { path: cwd };
      scratchCount += 1;
      return { path: `C:\\Workspaces\\_scratch\\inbox-${scratchCount}` };
    },
  };
  registerSessionIpc(ipcMain, {
    registerSessionForTap() {},
    sendToRenderer() {},
    sessionManager,
    workspaceService,
  });

  const create = handlers.get('create-session');
  const first = create(null, 'claude');
  assert.strictEqual(first.cwd, 'C:\\Workspaces\\_scratch\\inbox-1');
  const second = create(null, { kind: 'codex', opts: { cwd: 'C:\\repo' } });
  assert.strictEqual(second.cwd, 'C:\\repo');
  create(null, { kind: 'kimi', opts: { cwd: 'C:\\Workspaces\\_scratch\\inbox-ui', workspaceDraft: true } });
  assert.strictEqual(created[2].opts.workspaceDraft, true, 'UI-created scratch must stay marked as a draft');
  assert.strictEqual(workspaceCalls[2].meta.draft, true, 'session IPC must not demote a UI-created scratch draft');
  const resume = create(null, 'claude-resume');
  assert.strictEqual(resume.cwd, undefined, 'native resume picker must not be forced into a new scratch cwd');
  assert.strictEqual(scratchCount, 1);
  assert.strictEqual(created.length, 4);
  console.log('unit-workspace-session-ipc: PASS');
}

run();
