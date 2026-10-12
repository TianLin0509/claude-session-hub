'use strict';
// 手机直接对话会话（App 2.1）：发话、排队、停止、按键、订阅推送、只读边界与对话记录。
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { PhoneChannel } = require('../core/hub-phone/channel'), { seal, open, credentials } = require('../core/hub-phone/crypto');
const { renderScreen, screenOptions, cardOf } = require('../core/hub-phone/session-chat');

function setup({ busy = false, waiting = false, open: isOpen = true } = {}) {
  const c = credentials(), s = { credentials: c, enabled: true, cursor: 0, created: 1, inbox: [], outbox: [], notices: [], phoneCaps: ['session_chat', 'profile'] };
  const remote = [], sent = [], keys = [], stops = [], logs = [], resumed = [];
  const live = { s1: { id: 's1', kind: 'claude', title: '信道对比', status: busy ? 'running' : 'idle', needsUserInput: waiting, waitingText: waiting ? 'Claude needs your permission to use Bash' : null, ccSessionId: 'cc1' } };
  const turns = [{ id: 'u1', role: 'user', text: '跑一下对比', ts: 1 }, { id: 'a1', role: 'assistant', text: '好的，开始跑', ts: 2, toolCalls: [{ name: 'Bash', input: { description: '运行仿真' } }] }];
  const state = { busy, waiting };
  const deps = {
    getSession: id => isOpen ? live[id] : undefined,
    getSessionMetadata: id => ({ ...live[id], id }),
    resumeSession: async id => { resumed.push(id); isOpen = true; },
    readSessionTurns: async () => ({ turns: turns.slice() }),
    sendPrompt: async (id, text, rid) => { sent.push({ id, text, rid }); return { ok: true, receipt: { status: 'confirmed' } }; },
    sessionKeys: (id, data) => keys.push([id, data]),
    interruptSession: async id => { stops.push(id); },
    readTerminalScreen: () => ({ text: 'Bash command\r\n\r\n  rm -rf build\r\n\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don\'t ask again\r\n  3. No, and tell Claude what to do differently (esc)\r\n', cols: 80, rows: 12 }),
  };
  const sessions = [{ id: 's1', title: '信道对比', kind: 'claude', isOpen: true, hubState: { state: 'idle', label: '就绪' } },
    { id: 'g1', title: '圆桌成员', kind: 'codex', isOpen: true, meetingId: 'm1', hubState: { state: 'idle', label: '就绪' } }];
  const assistant = { deps, sessions: () => sessions.map(x => x.id === 's1' && state.waiting ? { ...x, hubState: { state: 'wait', label: '等你响应' } } : x),
    sessionBusy: () => state.busy, overview: () => ({ status: 'idle' }), notifications: () => ({ notifications: [] }), logDialog: e => logs.push(e),
    readLiveFinal: () => ({ records: [] }), currentProfile: () => null };
  const channel = new PhoneChannel({ assistant, journal: { state: s, change: fn => fn(s) }, transcribe: async () => '帮我跑测试' });
  channel.request = async route => route === '/poll' ? { messages: remote.splice(0) } : { ok: true };
  let seq = 0; const incoming = value => { const id = crypto.randomUUID(); remote.push({ seq: ++seq, id, payload: seal(c.key, c.channel, id, 'phone', value) }); return id; };
  const packets = type => s.outbox.map(r => r.payload && open(c.key, c.channel, r.id, 'hub', r.payload)).filter(r => r && r.type === type);
  return { channel, s, sent, keys, stops, logs, resumed, incoming, packets, state, turns, live, setOpen: v => { isOpen = v; } };
}
const statusOf = (x, id) => x.packets('status').filter(p => p.requestId === id).map(p => p.state);

test('text goes straight to the selected session through the prompt pipeline, never the assistant', async () => {
  const x = setup(); const id = x.incoming({ type: 'session_send', sessionId: 's1', text: '继续' });
  await x.channel.tick();
  assert.deepEqual(x.sent.map(r => [r.id, r.text, r.rid]), [['s1', '继续', id]]);
  assert.deepEqual(statusOf(x, id), ['received']);
  assert.match(x.logs.find(l => l.role === 'user').text, /^手机 → 「信道对比」：继续$/);
  // 跑完后把会话最后一张回答记进对话记录
  x.s.inbox.find(r => r.id === id).sentAt = Date.now() - 5000; await x.channel.tick();
  assert.equal(x.logs.find(l => l.lane === 'session').text, '好的，开始跑');
});

test('a busy or waiting session holds the message and sends it once it is idle', async () => {
  const x = setup({ busy: true }); const id = x.incoming({ type: 'session_send', sessionId: 's1', text: '按你推荐的做' });
  await x.channel.tick(); await x.channel.tick();
  assert.equal(x.sent.length, 0); assert.deepEqual(statusOf(x, id), ['held']);
  x.state.busy = false; await x.channel.tick();
  assert.equal(x.sent.length, 1); assert.deepEqual(statusOf(x, id), ['held', 'received']);
});

test('a reply that ends with a question does not hold the next message', async () => {
  const x = setup({ waiting: true }); const id = x.incoming({ type: 'session_send', sessionId: 's1', text: '选 A' });
  await x.channel.tick();
  assert.equal(x.sent.length, 1); assert.deepEqual(statusOf(x, id), ['received']);
  x.incoming({ type: 'session_watch', sessionId: 's1', on: true }); await x.channel.tick();
  const live = x.packets('session_live').at(-1).state; assert.equal(live.waiting, false); assert.equal(live.needsReply, true); assert.equal(live.label, '等你回复');
});

test('a held message can be cancelled before it is sent', async () => {
  const x = setup({ busy: true }); const id = x.incoming({ type: 'session_send', sessionId: 's1', text: '先别发' });
  await x.channel.tick(); x.incoming({ type: 'session_cancel', sessionId: 's1', target: id }); await x.channel.tick();
  x.state.busy = false; await x.channel.tick();
  assert.equal(x.sent.length, 0); assert.deepEqual(statusOf(x, id), ['held', 'cancelled']);
});

test('voice is transcribed then sent to the session, with the transcript returned for display', async () => {
  const x = setup(); const id = x.incoming({ type: 'session_send', sessionId: 's1', pcm: 'AQI=', durationMs: 900 });
  await x.channel.tick();
  assert.equal(x.sent[0].text, '帮我跑测试'); assert.equal(x.packets('transcript').at(-1).text, '帮我跑测试');
  assert.equal(x.s.inbox.find(r => r.id === id).pcm, undefined);
});

test('group members and the assistant are read-only from the phone', async () => {
  const x = setup(); const id = x.incoming({ type: 'session_send', sessionId: 'g1', text: '插一句' });
  await x.channel.tick();
  assert.equal(x.sent.length, 0); assert.deepEqual(statusOf(x, id), ['rejected']);
  assert.match(x.packets('status').at(-1).text, /群聊/);
});

test('a closed session is resumed by native identity before sending', async () => {
  const x = setup({ open: false }); x.incoming({ type: 'session_send', sessionId: 's1', text: '继续' });
  await x.channel.tick();
  assert.deepEqual(x.resumed, ['s1']); assert.equal(x.sent.length, 1);
});

test('stop only fires while running or waiting, and repeated taps send one interrupt', async () => {
  const x = setup(); const idle = x.incoming({ type: 'session_stop', sessionId: 's1' }); await x.channel.tick();
  assert.equal(x.stops.length, 0); assert.match(x.packets('status').find(p => p.requestId === idle).text, /已经停下/);
  x.state.busy = true; x.incoming({ type: 'session_stop', sessionId: 's1' }); x.incoming({ type: 'session_stop', sessionId: 's1' }); await x.channel.tick();
  assert.deepEqual(x.stops, ['s1']);
});

test('keys are accepted only while the session waits or runs; unknown keys are rejected at validation', async () => {
  const x = setup(); const early = x.incoming({ type: 'session_key', sessionId: 's1', key: '1' }); await x.channel.tick();
  assert.deepEqual(statusOf(x, early), ['rejected']); assert.equal(x.keys.length, 0);
  x.state.waiting = true; x.state.busy = true; x.live.s1.needsUserInput = true; x.incoming({ type: 'session_key', sessionId: 's1', key: '1' }); x.incoming({ type: 'session_key', sessionId: 's1', key: 'enter' }); await x.channel.tick();
  assert.deepEqual(x.keys, [['s1', '1'], ['s1', '\r']]);
  const bad = x.incoming({ type: 'session_key', sessionId: 's1', key: 'rm -rf' }); await x.channel.tick();
  assert.deepEqual(statusOf(x, bad), ['rejected']); assert.equal(x.keys.length, 2);
});

test('watching pushes live cards and state only when something changes, with the waiting screen and options', async () => {
  const x = setup(); x.incoming({ type: 'session_watch', sessionId: 's1', on: true }); await x.channel.tick();
  let live = x.packets('session_live'); assert.equal(live.length, 1); assert.deepEqual(live[0].turns.map(t => t.id), ['u1', 'a1']);
  assert.equal(live[0].turns[1].tools.recent[0].text, '运行仿真'); assert.equal(live[0].screen, null);
  x.channel.sessionChat.watches.get('s1').last = 0; await x.channel.tick(); assert.equal(x.packets('session_live').length, 1);
  x.state.waiting = true; x.state.busy = true; Object.assign(x.live.s1, { needsUserInput: true, waitingText: 'Claude needs your permission to use Bash' }); x.channel.sessionChat.watches.get('s1').last = 0; await x.channel.tick();
  live = x.packets('session_live').at(-1); assert.equal(live.state.waiting, true); assert.match(live.state.waitingText, /permission/);
  assert.deepEqual(live.screen.options.map(o => o.key), ['1', '2', '3']); assert.equal(live.screen.options[0].selected, true);
  x.incoming({ type: 'session_watch', sessionId: 's1', on: false }); await x.channel.tick(); assert.equal(x.channel.sessionChat.watches.size, 0);
});

test('turn pages go backwards from the oldest loaded card', async () => {
  const x = setup(); for (let i = 0; i < 20; i++) x.turns.push({ id: 'x' + i, role: i % 2 ? 'assistant' : 'user', text: 't' + i, ts: 10 + i });
  const first = x.incoming({ type: 'session_turns_get', sessionId: 's1' }); await x.channel.tick();
  const page = x.packets('session_turns').find(p => p.requestId === first); assert.equal(page.turns.length, 8); assert.equal(page.turns.at(-1).id, 'x19'); assert.equal(page.hasMore, true);
  const older = x.incoming({ type: 'session_turns_get', sessionId: 's1', before: page.turns[0].id }); await x.channel.tick();
  const prev = x.packets('session_turns').find(p => p.requestId === older); assert.equal(prev.append, true); assert.equal(prev.turns.at(-1).id, 'x11');
});

test('profile advertises session_chat only when the Hub can read and send', async () => {
  const x = setup(); x.channel.assistant.phoneProfile = async () => ({ kind: 'claude' }); await x.channel.sendProfile();
  assert.ok(x.packets('profile').at(-1).hubCaps.includes('session_chat'));
  delete x.channel.assistant.deps.readSessionTurns; await x.channel.sendProfile();
  assert.ok(!x.packets('profile').at(-1).hubCaps.includes('session_chat'));
});

test('screen rendering keeps the last screen of a TUI redraw and parses numbered options', async () => {
  const lines = await renderScreen({ text: '\x1b[2J\x1b[Hold text\r\n\x1b[2J\x1b[H╭────╮\r\n│ Do you want to proceed? │\r\n│ ❯ 1. Yes │\r\n│   2. No (esc) │\r\n╰────╯\r\n', cols: 60, rows: 10 });
  assert.ok(lines.includes('Do you want to proceed?')); assert.ok(!lines.some(l => /old text/.test(l)));
  assert.deepEqual(screenOptions(lines).map(o => [o.key, o.selected]), [['1', true], ['2', false]]);
  assert.deepEqual(screenOptions(['只有一行 1. 不算选项']), []);
});

test('cards cap very long text and summarize the latest tools', () => {
  const card = cardOf({ id: 'a', role: 'assistant', text: 'x'.repeat(13000), toolCalls: [{ name: 'Read', input: { file_path: 'C:/a/b/c.js' } }, { name: 'Bash', input: { command: 'npm test' }, isError: true }] }, true);
  assert.equal(card.text.length, 12000); assert.equal(card.truncated, true); assert.equal(card.running, true);
  assert.deepEqual(card.tools.recent.map(t => t.text), ['b/c.js', 'npm test']); assert.equal(card.tools.recent[1].error, true);
});

test('after a phone stop, an idle terminal counts as stopped and a bounced-back prompt is cleared once', async () => {
  const x = setup({ busy: true }); let cleared = false;
  x.turns.push({ id: 'u2', role: 'user', text: '请写一篇约 1500 字的文章，介绍 HARQ', ts: 3 });
  x.channel.assistant.deps.readTerminalScreen = () => ({ text: '\x1b[2J\x1b[H● OK\r\n\r\n' + (cleared ? '❯ \r\n' : '❯ 请写一篇约 1500 字的文章，介绍 HARQ\r\n') + '\r\n  ⏵⏵ auto mode on (shift+tab to cycle)\r\n', cols: 80, rows: 10 });
  x.channel.assistant.deps.sessionKeys = (id, data) => { x.keys.push([id, data]); if (data === '\x03') cleared = true; };
  x.incoming({ type: 'session_watch', sessionId: 's1', on: true }); await x.channel.tick();
  assert.equal(x.packets('session_live').at(-1).state.busy, true);
  x.incoming({ type: 'session_stop', sessionId: 's1' }); await x.channel.tick();
  x.channel.sessionChat.watches.get('s1').last = 0; await x.channel.tick();
  const live = x.packets('session_live').at(-1).state;
  assert.equal(live.busy, false); assert.equal(live.label, '已停止'); assert.deepEqual(x.keys, [['s1', '\x03']]);
  const id = x.incoming({ type: 'session_send', sessionId: 's1', text: '换个题目' }); await x.channel.tick();
  assert.deepEqual(statusOf(x, id), ['received']);
});
