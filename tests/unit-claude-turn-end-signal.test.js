'use strict';
// 2026-09-06：Claude「本轮结束」的判据回归测试。
//
// 起因是用户报的「回答还没结束，通知就弹了」。在当天真实 transcript
// （C--Users-lintian-claude-session-hub/778effee-…jsonl，claude-opus-5）里抓到了根因：
//
//   07:35:53Z  assistant  content=[thinking(空字符串)]        stop_reason="end_turn"
//   07:36:16Z  assistant  content=[text("真正的答复…")]        stop_reason="end_turn"
//
// Claude Code 会把一段交错思考单独落成一条 assistant entry —— 里面只有一个 thinking 块，
// thinking 文本还是空的（只有 signature），但 stop_reason 已经写成 end_turn，而真正的答复
// 23 秒之后才落盘。老逻辑只看 stop_reason，于是在 07:35:53 就判本轮结束，把上一句
// 「我先读取一下这个文件」当成最终答复送出去 —— 桌面通知、卡片视图、群聊 settle、
// 飞书通知、侧栏状态点全都吃这一个信号，所以是一处判错、五处一起错。
//
// 锁死的不变量：
//   1. 终态 entry 必须自己带正文，否则不算本轮结束
//   2. 真正带正文的终态 entry 照常收口，正文仍然是「整轮合并」而不是只有末条
//   3. 合并器不能被无正文的终态 entry 切轮，也不能被它把 stopReason 改成终态

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  claudeAssistantContentHasAnswerText,
  claudeEntryEndsAssistantTurn,
  isClaudeTurnStopReasonTerminal,
  parseClaudeTranscriptToTurns,
} = require(path.join(__dirname, '..', 'core', 'claude-transcript-parser.js'));
const { TranscriptTap } = require(path.join(__dirname, '..', 'core', 'transcript-tap.js'));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function tmpTranscript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-turn-end-'));
  const jsonl = path.join(dir, 'mock-session.jsonl');
  fs.writeFileSync(jsonl, '');
  return { dir, jsonl, append(obj) { fs.appendFileSync(jsonl, JSON.stringify(obj) + '\n'); } };
}

// 现场取样：空 thinking + 已经是 end_turn 的那条 entry。
function thinkingOnlyTerminalEntry(thinking = '') {
  return {
    type: 'assistant',
    timestamp: '2026-09-06T07:35:53.190Z',
    message: {
      model: 'claude-opus-5',
      content: [{ type: 'thinking', thinking, signature: 'CAISvwMKpgEIERgC' }],
      stop_reason: 'end_turn',
    },
  };
}

test('无正文的终态 entry 不算本轮结束', () => {
  assert.equal(isClaudeTurnStopReasonTerminal('end_turn'), true, 'stop_reason 本身仍然是终态');
  assert.equal(
    claudeEntryEndsAssistantTurn({ stopReason: 'end_turn', text: '' }), false,
    '空正文的 end_turn 是过程标记，本轮继续',
  );
  assert.equal(
    claudeEntryEndsAssistantTurn({ stopReason: 'end_turn', text: '   ' }), false,
    '只有空白也不算正文',
  );
  assert.equal(
    claudeEntryEndsAssistantTurn({ stopReason: 'end_turn', text: '结论是 42' }), true,
  );
  assert.equal(
    claudeEntryEndsAssistantTurn({ stopReason: 'tool_use', text: '我先读取一下' }), false,
    '有正文但还要继续干活，同样不算结束',
  );
});

test('thinking / tool_use 都不算「给用户看的正文」', () => {
  assert.equal(claudeAssistantContentHasAnswerText([{ type: 'thinking', thinking: '想了很多' }]), false);
  assert.equal(claudeAssistantContentHasAnswerText([{ type: 'tool_use', name: 'Read', input: {} }]), false);
  assert.equal(claudeAssistantContentHasAnswerText([{ type: 'text', text: '  ' }]), false);
  assert.equal(claudeAssistantContentHasAnswerText([{ type: 'text', text: '答案' }]), true);
  assert.equal(claudeAssistantContentHasAnswerText('答案'), true);
  assert.equal(claudeAssistantContentHasAnswerText(null), false);
});

test('合并器不被无正文的终态 entry 切轮，stopReason 也不能被它改成终态', () => {
  const { jsonl, append } = tmpTranscript();
  append({ type: 'user', timestamp: '2026-09-06T07:22:29.344Z', message: { content: '帮我看看这个文件' } });
  append({
    type: 'assistant',
    timestamp: '2026-09-06T07:22:35.000Z',
    message: {
      model: 'claude-opus-5',
      content: [
        { type: 'text', text: '我先读取一下这个文件。' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } },
      ],
      stop_reason: 'tool_use',
    },
  });
  append(thinkingOnlyTerminalEntry());

  const open = parseClaudeTranscriptToTurns(jsonl);
  const lastOpen = open[open.length - 1];
  assert.equal(lastOpen.role, 'assistant');
  assert.notEqual(lastOpen.stopReason, 'end_turn', '这一轮还没写完，stopReason 不该是终态');
  assert.equal(claudeEntryEndsAssistantTurn(lastOpen), false);

  // 真正的答复落盘之后，整轮合并成一张卡，正文包含开场白与最终答复。
  append({
    type: 'assistant',
    timestamp: '2026-09-06T07:36:16.333Z',
    message: { model: 'claude-opus-5', content: [{ type: 'text', text: '读完了，结论是 42。' }], stop_reason: 'end_turn' },
  });
  const done = parseClaudeTranscriptToTurns(jsonl);
  const lastDone = done[done.length - 1];
  assert.equal(lastDone.stopReason, 'end_turn');
  assert.equal(claudeEntryEndsAssistantTurn(lastDone), true);
  assert.match(lastDone.text, /我先读取一下这个文件。/);
  assert.match(lastDone.text, /读完了，结论是 42。/);
  assert.equal(done.filter(t => t.role === 'assistant').length, 1, '一次提问只应合出一张 assistant 卡');
});

test('TranscriptTap 不会在无正文的 end_turn 上提前 emit turn-complete', async () => {
  const { dir, jsonl, append } = tmpTranscript();
  const tap = new TranscriptTap();
  const sid = 'turn-end-signal-' + Date.now();
  const events = [];
  tap.on('turn-complete', ev => events.push(ev));
  tap.registerSession(sid, 'claude', { cwd: dir });
  await tap.watchClaudeTranscript(sid, jsonl);

  append({
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      content: [
        { type: 'text', text: '我先读取一下这个文件。' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } },
      ],
      stop_reason: 'tool_use',
    },
  });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  await wait(300);
  assert.equal(events.length, 0, 'tool_use 阶段本来就不该 emit');

  append(thinkingOnlyTerminalEntry());
  await wait(600);
  assert.deepEqual(
    events.map(e => e.text), [],
    '无正文的 end_turn 不能把「我先读取一下这个文件」当成最终答复送出去',
  );

  append({
    type: 'assistant',
    message: { model: 'claude-opus-5', content: [{ type: 'text', text: '读完了，结论是 42。' }], stop_reason: 'end_turn' },
  });
  await wait(600);
  assert.equal(events.length, 1, '真正的答复落盘后要 emit 且只 emit 一次');
  assert.match(events[0].text, /读完了，结论是 42。/);
  assert.equal(events[0].signalSource, 'stop_reason_terminal');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('转轮：无正文的 end_turn 不能让 emit 路径与 idle 兜底用两套判据', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'transcript-tap.js'), 'utf8');
  const scheduler = src.slice(src.indexOf('_scheduleStopReasonEmit(hubSessionId) {'));
  const body = scheduler.slice(0, scheduler.indexOf('_cancelStopReasonEmit('));
  assert.match(body, /readLastTerminalAssistantTextFromClaudeTranscript/,
    'stop_reason 防抖 emit 必须走带终态过滤的读取，和 idle 兜底同一套判据');
  assert.match(src, /claudeAssistantContentHasAnswerText\(content\)/,
    'onLine 的终态判断必须要求这条 entry 自己带正文');
});
