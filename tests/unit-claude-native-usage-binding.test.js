'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bindClaudeNativeSession } = require('../core/claude-native-binding');
const { SessionTokenUsageService } = require('../main/usage/session-token-usage-service');

test('late native Claude history binds cumulative usage without a legacy execution watcher', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-usage-binding-'));
  const file = path.join(root, 'exact-session.jsonl');
  const values = [];
  const service = new SessionTokenUsageService({ publish: (id, usage) => values.push({ id, usage }) });
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const driver = new EventEmitter();
  driver.closed = true; // This test supplies native events; it launches no CLI.
  driver.historyPath = () => fs.existsSync(file) ? file : null;
  const info = { id: 'hub', kind: 'claude', runtimeBackend: 'claude-stream-json' };
  const manager = new EventEmitter();
  manager.sessions = new Map([['hub', { info, pty: driver }]]);
  manager._toPublic = value => ({ ...value });
  manager.on('session-updated', session => service.bind(session));
  bindClaudeNativeSession(manager, 'hub', driver);
  driver.emit('state', { state: 'running', connection: 'connected', revision: 1 });
  assert.equal(info.transcriptPath, undefined);
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { id: 'response-1',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 200 } } }) + '\n');
  driver.emit('state', { state: 'completed', connection: 'connected', revision: 2 });
  const until = Date.now() + 3000;
  while (!values.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(info.transcriptPath, file);
  assert.equal(values.at(-1)?.usage.total, 320);
  assert.equal(info.nativeRuntime.state, 'completed');
  assert.equal(info.nativeRuntime.revision, 2);
  // A released writer must not change the replacement session's path or truth.
  manager.sessions.set('hub', { info: { id: 'hub' }, pty: {} });
  driver.emit('state', { state: 'running', revision: 3 });
  assert.deepEqual(manager.sessions.get('hub').info, { id: 'hub' });
});

test('history lookup errors remain diagnostic while native execution still advances', () => {
  const driver = new EventEmitter(); driver.closed = true;
  driver.historyPath = () => { throw new Error('history access denied'); };
  const diagnostics = [];
  const info = { id: 'hub' };
  const manager = new EventEmitter();
  manager.sessions = new Map([['hub', { info, pty: driver }]]);
  manager._toPublic = value => ({ ...value });
  manager.on('native-agent-diagnostic', event => diagnostics.push(event));
  bindClaudeNativeSession(manager, 'hub', driver);
  driver.emit('state', { state: 'completed', revision: 4 });
  assert.equal(info.nativeRuntime.state, 'completed');
  assert.equal(diagnostics[0].type, 'history-path-error');
  assert.match(diagnostics[0].message, /access denied/);
});
