'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { FeishuCodexGateway, parseCommand, tailText, cleanCodexOutput } = require('../core/feishu-codex-gateway.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class FakeSessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.writes = [];
    this.closed = [];
    this.created = 0;
  }

  createSession(kind, opts) {
    this.created += 1;
    const session = {
      id: 's' + this.created,
      kind,
      title: opts.title,
      cwd: opts.cwd,
      status: 'idle',
      lastOutputPreview: '',
    };
    this.sessions.set(session.id, { info: session, buffer: '' });
    return { ...session };
  }

  writeToSession(sessionId, data) {
    this.writes.push({ sessionId, data });
  }

  closeSession(sessionId) {
    this.closed.push(sessionId);
    this.sessions.delete(sessionId);
  }

  getSession(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? { ...s.info } : undefined;
  }

  getSessionBuffer(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? s.buffer : null;
  }

  appendBuffer(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (s) s.buffer += data;
  }
}

async function testParseCommand() {
  assert.deepStrictEqual(parseCommand('新建 codex：检查项目'), { type: 'new-codex', prompt: '检查项目' });
  assert.deepStrictEqual(parseCommand('状态'), { type: 'status' });
  assert.deepStrictEqual(parseCommand('最近输出'), { type: 'recent' });
  assert.deepStrictEqual(parseCommand('停止'), { type: 'stop' });
  assert.deepStrictEqual(parseCommand('继续做'), { type: 'input', prompt: '继续做' });
  assert.deepStrictEqual(parseCommand('   '), { type: 'empty' });
  console.log('  ok parseCommand');
}

async function testNewCodexAndInitialPrompt() {
  const sm = new FakeSessionManager();
  const sent = [];
  const created = [];
  const gw = new FeishuCodexGateway({
    sessionManager: sm,
    startupDelayMs: 1,
    inputEnterDelayMs: 1,
    outputDebounceMs: 1,
    defaultCwd: 'C:\\repo',
    sendMessage: msg => sent.push(msg),
    onSessionCreated: session => created.push(session),
  });
  const res = await gw.handleIncoming({ chatId: 'c1', threadId: 't1', text: '新建 codex：列出实现计划' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.action, 'new-codex');
  assert.strictEqual(sm.created, 1);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].id, 's1');
  assert.strictEqual(gw.getBinding('t1').sessionId, 's1');
  assert.ok(sent.some(m => m.type === 'session-started'));
  await sleep(8);
  await sleep(8);
  assert.deepStrictEqual(sm.writes, [
    { sessionId: 's1', data: '列出实现计划' },
    { sessionId: 's1', data: '\r' },
  ]);
  assert.ok(sent.some(m => m.type === 'input-sent'));
  gw.dispose();
  console.log('  ok new codex + initial prompt');
}

async function testContinueStatusRecentStop() {
  const sm = new FakeSessionManager();
  const sent = [];
  const gw = new FeishuCodexGateway({
    sessionManager: sm,
    startupDelayMs: 1,
    inputEnterDelayMs: 1,
    outputDebounceMs: 1,
    defaultCwd: 'C:\\repo',
    sendMessage: msg => sent.push(msg),
  });
  await gw.handleIncoming({ chatId: 'c1', threadId: 't1', text: '新建 codex：第一步' });
  await sleep(20);
  sm.writes.length = 0;
  sent.length = 0;
  await gw.handleIncoming({ chatId: 'c1', threadId: 't1', text: '继续第二步' });
  await sleep(8);
  assert.deepStrictEqual(sm.writes.slice(-2), [
    { sessionId: 's1', data: '继续第二步' },
    { sessionId: 's1', data: '\r' },
  ]);
  await gw.handleIncoming({ chatId: 'c1', threadId: 't1', text: '状态' });
  assert.ok(sent.some(m => m.type === 'status' && m.text.includes('Codex session 状态')));
  sm.appendBuffer('s1', '\x1b[31mhello\x1b[0m\nworld');
  await gw.handleIncoming({ chatId: 'c1', threadId: 't1', text: '最近输出' });
  assert.ok(sent.some(m => m.type === 'recent-output' && m.text.includes('hello')));
  await gw.handleIncoming({ chatId: 'c1', threadId: 't1', text: '停止' });
  assert.deepStrictEqual(sm.closed, ['s1']);
  assert.strictEqual(gw.getBinding('t1'), undefined);
  gw.dispose();
  console.log('  ok continue/status/recent/stop');
}

async function testUnboundHelp() {
  const sm = new FakeSessionManager();
  const sent = [];
  const gw = new FeishuCodexGateway({ sessionManager: sm, sendMessage: msg => sent.push(msg) });
  const res = await gw.handleIncoming({ chatId: 'c1', threadId: 't1', text: '继续' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not-bound');
  assert.ok(sent[0].text.includes('新建 codex'));
  gw.dispose();
  console.log('  ok unbound help');
}

async function testOutputAndApprovalPush() {
  const sm = new FakeSessionManager();
  const sent = [];
  const gw = new FeishuCodexGateway({
    sessionManager: sm,
    startupDelayMs: 1,
    inputEnterDelayMs: 1,
    outputDebounceMs: 1,
    sendMessage: msg => sent.push(msg),
  });
  await gw.handleIncoming({ chatId: 'c1', threadId: 't1', text: '新建 codex：任务' });
  await sleep(8);
  sent.length = 0;
  sm.emit('output', { sessionId: 's1', data: '\x1b[32m正在读取文件\x1b[0m' });
  await sleep(8);
  assert.ok(sent.some(m => m.type === 'output-digest' && m.text.includes('正在读取文件')));
  sm.emit('tool-use-preview', { sessionId: 's1', toolName: 'shell_command', toolInput: { command: 'node --check main.js' } });
  assert.ok(sent.some(m => m.type === 'approval' && m.text.includes('node --check main.js')));
  gw.dispose();
  console.log('  ok output digest + approval');
}

async function testCleanOutputAndTranscriptPreference() {
  const noisy = [
    'gpt-5.5 medium  Context 75% left  ~\\claude-session-hub',
    '> Improve documentation in @filename',
    '› Use /skills to list available skills',
    '真正结论：优先复用 transcript 作为飞书摘要。',
  ].join('\n');
  const clean = cleanCodexOutput(noisy, 400);
  assert.ok(!clean.includes('gpt-5.5 medium'));
  assert.ok(!clean.includes('Context 75% left'));
  assert.ok(!clean.includes('/skills'));
  assert.ok(!clean.includes('Improve documentation in @filename'));
  assert.ok(clean.includes('真正结论'));

  const sm = new FakeSessionManager();
  const transcriptTap = new EventEmitter();
  const sent = [];
  const gw = new FeishuCodexGateway({
    sessionManager: sm,
    startupDelayMs: 1,
    inputEnterDelayMs: 1,
    outputDebounceMs: 1,
    transcriptTap,
    getCleanOutput: () => 'Transcript final answer\n- file: core/feishu-codex-gateway.js',
    sendMessage: msg => sent.push(msg),
  });
  await gw.handleIncoming({ chatId: 'c1', threadId: 't1', text: '新建 codex：任务' });
  await sleep(8);
  sent.length = 0;
  sm.emit('output', { sessionId: 's1', data: noisy });
  await sleep(8);
  assert.strictEqual(sent.length, 0, 'transcript-backed gateway should not push PTY digest before final transcript');
  transcriptTap.emit('turn-complete', { hubSessionId: 's1', text: 'Transcript final answer\n- file: core/feishu-codex-gateway.js' });
  const digest = sent.find(m => m.type === 'output-digest');
  assert.ok(digest);
  assert.strictEqual(digest.source, 'transcript');
  assert.ok(digest.text.includes('Transcript final answer'));
  assert.ok(!digest.text.includes('gpt-5.5 medium'));
  sent.length = 0;
  transcriptTap.emit('turn-complete', { hubSessionId: 's1', text: 'Transcript final answer\n- file: core/feishu-codex-gateway.js' });
  assert.strictEqual(sent.length, 0, 'duplicate transcript digest should be skipped');
  transcriptTap.emit('turn-complete', { hubSessionId: 's1', text: 'New transcript answer' });
  assert.ok(sent.some(m => m.type === 'output-digest' && m.text.includes('New transcript answer')));
  gw.dispose();
  console.log('  ok clean output + transcript preference');
}

async function testTailText() {
  const out = tailText('\x1b[31mabc\x1b[0m\n' + 'x'.repeat(20), 10);
  assert.strictEqual(out, 'xxxxxxxxxx');
  console.log('  ok tailText');
}

async function testReportLinksAppended() {
  const sm = new FakeSessionManager();
  const sent = [];
  const reportPublisher = {
    publishLinksFromText(text) {
      assert.ok(text.includes('C:\\repo\\docs\\demo.html'));
      return [{
        name: 'demo.html',
        type: 'html',
        sourcePath: 'C:\\repo\\docs\\demo.html',
        url: 'http://127.0.0.1:3470/reports/id/demo.html?token=t',
      }];
    },
  };
  const gw = new FeishuCodexGateway({
    sessionManager: sm,
    outputDebounceMs: 1,
    sendMessage: msg => sent.push(msg),
    reportPublisher,
  });
  const session = sm.createSession('codex', { title: 'Report test', cwd: 'C:\\repo' });
  gw.bindings.set('t1', { key: 't1', chatId: 'c1', threadId: 't1', messageId: 'm1', sessionId: session.id });
  gw.sessionToThread.set(session.id, 't1');
  sm.emit('output', { sessionId: session.id, data: 'generated C:\\repo\\docs\\demo.html' });
  await sleep(8);
  const digest = sent.find(m => m.type === 'output-digest');
  assert.ok(digest);
  assert.ok(digest.text.includes('手机查看报告'));
  assert.ok(digest.text.includes('[打开 HTML：demo.html]'));
  assert.deepStrictEqual(digest.reportFiles, [{
    path: 'C:\\repo\\docs\\demo.html',
    name: 'demo.html',
    type: 'html',
  }]);
  gw.dispose();
  console.log('  ok report links appended');
}

(async () => {
  console.log('Running Feishu Codex gateway tests...');
  await testParseCommand();
  await testNewCodexAndInitialPrompt();
  await testContinueStatusRecentStop();
  await testUnboundHelp();
  await testOutputAndApprovalPush();
  await testCleanOutputAndTranscriptPreference();
  await testTailText();
  await testReportLinksAppended();
  console.log('All passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
