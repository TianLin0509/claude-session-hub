'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DshCliSession, readDshCliTranscript } = require('../core/dsh-cli-session');
test('DSH raw native turns preserve receipts, history, and non-success reasons', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dsh-cli-unit-'));
  const s = new DshCliSession({ home, id: 'hub', kind: 'deepseek-acp', cwd: home });
  s.waitForComposer = async () => {}; const events = []; s.on('lifecycle', e => events.push(e));
  const rows = [{ type: 'bound', sessionId: 'native', cwd: home, events: [] }];
  let seq = 0;
  function event(type, data) { const row = { type: 'event', sessionId: 'native', event: { type, seq: seq++, time: 10000 + seq, data } }; rows.push(row); s.observe(row); }
  try {
    s.observe(rows[0]); let receipt;
    s.pending = { id: 'submission', text: '中文🙂', resolve: r => receipt = r };
    event('turn/start', { turn: 1 });
    event('user/message', { id: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '中文🙂' }] });
    assert.equal(receipt.clientSubmissionId, 'submission'); assert.equal(receipt.turnId, '1');
    s.observe({ type: 'stream', sessionId: 'native', frame: { type: 'start', attemptId: 'stream' } });
    s.observe({ type: 'stream', sessionId: 'native', frame: { type: 'chunk', attemptId: 'stream', chunk: { type: 'text-delta', index: 0, text: '正在回答' } } });
    assert.equal(s.finalText(), '正在回答');
    assert.equal(s.runtime.state, 'running');
    event('assistant/message', { message: { content: [{ type: 'text', text: '回答' }] } });
    event('turn/end', { turn: 1, reason: { kind: 'completed' } });
    assert.equal(s.runtime.state, 'completed'); assert.equal(s.finalText(), '回答');
    assert.equal(s.readTranscript().at(-1).providerTurnId, '1');
    // Status idle is not completion authority and cannot erase a native failure.
    for (const [kind, expected] of [['error', 'failed'], ['blocked', 'failed'], ['aborted', 'interrupted']]) {
      event('turn/start', { turn: seq });
      event('user/message', { id: 'u' + seq, source: { kind: 'user' }, content: [{ type: 'text', text: kind }] });
      event('turn/end', { turn: s.activeTurn, reason: { kind } });
      s.observe({ type: 'status', sessionId: 'native', status: 'idle' });
      assert.equal(s.runtime.state, expected);
    }
    fs.writeFileSync(s.log, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    assert.deepEqual(readDshCliTranscript(s.log).map(c => [c.role, c.text, c.providerTurnId]),
      s.readTranscript().map(c => [c.role, c.text, c.providerTurnId]));
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 1);
    s.routeChecked = true;
    s.observe({ type: 'bound', sessionId: 'other', cwd: home, events: [] });
    assert.equal(s.routeChecked, false); assert.equal(s.lastOutcome, null);
    assert.equal(s.runtime.turnId, null); assert.equal(s.records.length, 0);
  } finally { s.kill(); fs.rmSync(home, { recursive: true, force: true }); }
});
test('DSH CLI profiles keep both consumption routes and never load ACP', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dsh-profile-unit-'));
  const modules = path.join(root, 'runtime/node_modules');
  for (const file of ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-harness-tui/dsh-tui/package.json']) {
    fs.mkdirSync(path.dirname(path.join(modules, file)), { recursive: true }); fs.writeFileSync(path.join(modules, file), '{}');
  }
  const config = { deepseekApiKey: 'api-secret', acp: { nodePath: process.execPath, apiKey: 'plan-secret',
    providers: { 'deepseek-acp': { cliRoot: path.join(root, 'runtime'), model: 'deepseek-v4.1-flash' } } } };
  const links = [];
  try {
    for (const deepseekRoute of ['tokenplan', 'api']) {
      const o = require('../core/dsh-cli-profile').buildDshCliOptions('deepseek-acp', { id: deepseekRoute, cwd: root, deepseekRoute }, config, root, {});
      links.push(path.join(o.home, '.dsh/profiles/hub-cli/node_modules'));
      const patch = JSON.parse(fs.readFileSync(o.launch.args.at(-1), 'utf8'));
      assert(!patch.some(p => /acp/.test(p.id || '')));
      assert(!o.launch.args.includes('acp')); assert.equal(o.launch.env.AI_HUB_DSH_BRIDGE, undefined);
      assert.equal(o.launch.env.BAILIAN_API_KEY, deepseekRoute === 'api' ? 'api-secret' : 'plan-secret');
      assert.equal(o.model, deepseekRoute === 'api' ? 'deepseek-flash' : 'deepseek-v4.1-flash');
      assert.equal(o.launch.env.DSH_TUI_BACKEND, 'dsh');
      assert.equal(o.launch.env.DSH_TUI_NO_LAUNCHPAD, '1');
    }
  } finally {
    for (const link of links) { assert(fs.lstatSync(link).isSymbolicLink()); if (process.platform === 'win32') fs.rmdirSync(link); else fs.unlinkSync(link); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
