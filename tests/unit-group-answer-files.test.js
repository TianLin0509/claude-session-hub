'use strict';
// Group chat cards come from members' Markdown answer files, never transcripts.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const A = require('../core/group-answer-files');
const { getOrchestrator } = require('../core/group-chat-orchestrator');
const S = require('../core/workflow-settings'), D = require('../core/delivery-workflow');
const { createDeliveryEngine } = require('../main/groupchat/delivery-engine');
const flush = () => new Promise(r => setImmediate(r));

function modeRules() {
  assert.equal(A.enabled({ groupChat: true }), true, 'plain group chat');
  assert.equal(A.enabled({ groupChat: true, serialWorkflow: { enabled: false, steps: [] } }), true, 'workflow switched off');
  assert.equal(A.enabled({ groupChat: true, serialWorkflow: S.createDeliveryConfig('development', [{ memberId: 'a' }, { memberId: 'b' }]) }), true, 'delivery engine');
  assert.equal(A.enabled({ groupChat: true, serialWorkflow: { fileFlowVersion: 2 } }), false, 'legacy file flow keeps transcripts');
  assert.equal(A.enabled({ groupChat: true, serialWorkflow: { loop: { enabled: true } } }), false, 'legacy loop');
  assert.equal(A.enabled({ groupChat: false }), false, 'single sessions untouched');
}

function readStates() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-read-'));
  try {
    const e = A.entryFor({ dataDir: dir, meetingId: 'room', turnNum: 3, memberId: 'm1' });
    assert.equal(e.ready, path.join(dir, 'task-docs', 'room', 'answers', 'turn-3', 'm1', '回答.md'));
    assert.match(A.instruction(e), /回答\.md/);
    assert.throws(() => A.entryFor({ dataDir: dir, meetingId: '../x', turnNum: 1, memberId: 'm1' }), /路径身份无效/);
    fs.mkdirSync(e.dir, { recursive: true });
    assert.equal(A.read(e), null, 'nothing written yet');
    fs.writeFileSync(e.ready, '﻿  \n', 'utf8'); assert.equal(A.read(e), null, 'blank file is no answer');
    fs.writeFileSync(e.ready, '结论：可行', 'utf8');
    assert.deepEqual({ ...A.read(e), hash: undefined }, { state: 'delivered', outcome: 'ready', text: '结论：可行', hash: undefined });
    const d = { kind: 'delivery', draft: path.join(dir, 'd.md'), ready: path.join(dir, 'r.md'), rework: path.join(dir, 'w.md') };
    fs.writeFileSync(d.draft, '<!-- hub-delivery:abc123 -->\n\n写了一半', 'utf8');
    assert.equal(A.read(d).state, 'draft'); assert.equal(A.read(d).text, '写了一半', 'protocol header is not content');
    fs.renameSync(d.draft, d.rework);
    assert.equal(A.read(d).outcome, 'rework');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function cardsOnlyShowFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-orch-'));
  try {
    const orch = getOrchestrator(dir, 'room1');
    const { turnNum } = orch.beginTurn('问题');
    const e = A.entryFor({ dataDir: dir, meetingId: 'room1', turnNum, memberId: 'm1', speaker: 'Codex 1' });
    fs.mkdirSync(e.dir, { recursive: true });
    orch.registerAnswerFile(turnNum, 's1', e);
    orch.patchTurnResult(turnNum, 's1', { text: '从对话记录抠出来的文字', status: 'completed', memberId: 'm1' });
    const msg = () => orch.state.messages.find(m => m.role === 'assistant' && m.sid === 's1' && m.turnNum === turnNum);
    assert.equal(msg().content, '', 'transcript text never becomes the card');
    assert.equal(A.reconcile(orch), false);
    fs.writeFileSync(e.ready, '文件里的结论', 'utf8');
    assert.equal(A.reconcile(orch), true); assert.equal(msg().content, '文件里的结论'); assert.equal(msg().answer.state, 'delivered');
    assert.equal(A.reconcile(orch), false, 'unchanged file is not re-applied');
    orch.completeTurn(turnNum, '问题', [{ sid: 's1', text: '晚到的对话记录', status: 'completed' }], { s1: { memberId: 'm1', displayName: 'Codex 1' } });
    assert.equal(msg().content, '文件里的结论', 'turn settlement keeps the file answer');
    // The member corrects its answer later (e.g. the user rescued it in its own session).
    fs.writeFileSync(e.ready, '更正后的结论', 'utf8');
    assert.equal(A.reconcile(orch), true); assert.equal(msg().content, '更正后的结论');
    assert.equal(orch.state.turns.find(t => t.n === turnNum).by.s1, '更正后的结论', 'next-turn context sees the file too');
    // A peer whose cursor already passed this message still receives the late/corrected answer.
    orch.state.lastDeliveredSeq.peer = Math.max(...orch.state.messages.map(m => m.seq || 0));
    assert(!orch.buildDelta('peer', '下一问').includes('更正后的结论'), 'nothing new before the file changes');
    fs.writeFileSync(e.ready, '再次更正的结论', 'utf8');
    assert.equal(A.reconcile(orch), true);
    assert(orch.buildDelta('peer', '下一问').includes('再次更正的结论'), 'changed answer reaches peers in their next delta');
    // Rolled-back turns drop their registration, so a reused turn number never shows stale files.
    orch.rollbackTurn(turnNum); assert.equal(orch.answerFileFor(turnNum, 's1'), null);
    const again0 = orch.beginTurn('重来'); assert.equal(again0.turnNum, turnNum);
    orch.registerAnswerFile(turnNum, 's1', e);
    // Survives a reload of the persisted state.
    const again = new (Object.getPrototypeOf(orch).constructor)(dir, 'room1');
    assert.equal(again.answerFileFor(turnNum, 's1').ready, e.ready);
    // Members without a registered file (legacy rooms) keep transcript behaviour.
    orch.patchTurnResult(turnNum, 's2', { text: '旧协议文字', status: 'completed', memberId: 'm2' });
    assert.equal(orch.state.messages.find(m => m.sid === 's2').content, '旧协议文字');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function deliverySkip() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-skip-'));
  const people = ['a', 'b', 'c'].map(memberId => ({ memberId, title: memberId, displayName: memberId.toUpperCase() }));
  const draft = S.createPreset('custom', people);
  draft.rounds = [{ name: '分头提案', members: ['a', 'b'], prompt: 'propose', after: 'next' }, { name: '汇总', members: ['c'], prompt: 'sum', after: 'end' }];
  const m = { id: 'room', groupChat: true, subSessions: ['sa', 'sb', 'sc'], slotSpecs: people, serialWorkflow: S.toDeliveryConfig({}, draft, ['a', 'b', 'c']) };
  const calls = [];
  const deps = { meetingManager: { getMeeting: () => m, setParticipants() {} }, sessionManager: { getSession: () => ({ status: 'idle' }) }, getHubDataDir: () => dir, getMembers: () => people,
    ensureMemberReady: async () => {}, logger: { error() {}, warn() {} },
    getDispatcher: () => ({ dispatchGroupChatTurn: (_id, args) => { calls.push(args); return new Promise(() => {}); } }) };
  const e = createDeliveryEngine(deps);
  const read = () => JSON.parse(fs.readFileSync(path.join(D.directory(dir, m.id), 'run.json'), 'utf8'));
  const deliver = member => { const r = read(), s = r.steps.at(-1), p = D.paths(D.directory(dir, m.id), r, s, member); fs.writeFileSync(p.draft, D.header(r, s, member) + '\n\nok', 'utf8'); fs.renameSync(p.draft, p.ready); };
  try {
    await e.start(m.id, 'goal'); deliver('a'); e.tick(m.id); await flush(); await flush();
    assert.deepEqual(e.status(m.id).missingIds, ['b']);
    await e.skip(m.id, 'b');
    assert.equal(calls.length, 2, 'skipping a helper lets the flow continue'); assert.deepEqual(calls[1].targetMemberIds, ['c']);
    assert.match(calls[1].userInput, /B 被用户跳过，没有交付/);
    await assert.rejects(e.skip(m.id, 'a'), /不在当前步骤/);
    // A file handed in after the skip does not reopen the step.
    const r = read(), first = r.steps[0], p = D.paths(D.directory(dir, m.id), r, first, 'b');
    fs.writeFileSync(p.draft, D.header(r, first, 'b') + '\n\nlate', 'utf8'); fs.renameSync(p.draft, p.ready);
    e.tick(m.id); await flush(); await flush(); assert.equal(e.status(m.id).paused, false);
  } finally { e.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}

async function deliveryOwnerSkipEnds() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-skip-owner-'));
  const people = ['a', 'b'].map(memberId => ({ memberId, displayName: memberId.toUpperCase() }));
  const m = { id: 'dev', groupChat: true, subSessions: ['sa', 'sb'], slotSpecs: people, serialWorkflow: S.createDeliveryConfig('development', people) };
  const e = createDeliveryEngine({ meetingManager: { getMeeting: () => m, setParticipants() {} }, sessionManager: { getSession: () => ({ status: 'idle' }) }, getHubDataDir: () => dir, getMembers: () => people,
    ensureMemberReady: async () => {}, logger: { error() {}, warn() {} }, getDispatcher: () => ({ dispatchGroupChatTurn: () => new Promise(() => {}), interruptMeetingTurn() {} }) });
  try {
    await e.start(m.id, 'goal');
    const st = await e.skip(m.id, 'a');
    assert.equal(st.finished, true); assert.equal(st.done, false, 'ends, not a pass'); assert.match(st.error, /本次任务结束，未合并/);
  } finally { e.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}

// The card renderer: history from before the switch keeps its stored text.
function answerCardRendering() {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/meeting-room.js'), 'utf8');
  const fnSrc = source.slice(source.indexOf('function _renderAnswerCard('), source.indexOf('function _renderGroupChatMessage(')).trim();
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const render = require('node:vm').runInNewContext('(' + fnSrc + ')', {
    require: p => p === './groupchat-journal' ? require('../renderer/groupchat-journal') : p === './conversation-message-view' ? { renderMessageBody: t => `<p>${esc(t)}</p>` } : require(p),
    escapeHtml: esc, sessions: new Map(), _renderMarkdown: t => t, _activeMeetingCwd: () => '', _formatGroupChatTime: () => '', _renderGroupAvatar: () => '',
  });
  const meeting = { id: 'g', groupChat: true }, members = { s: { slotIndex: 0, kind: 'claude', displayLabel: 'Claude 1' } };
  const old = render({ id: 'a1-m1', sid: 's', role: 'assistant', content: '升级前的历史回答' }, meeting, members);
  assert(old.includes('升级前的历史回答') && !old.includes('还没交'), 'history keeps its text');
  const missing = render({ id: 'a2-m1', sid: 's', role: 'assistant', content: '' }, meeting, members);
  assert(missing.includes('还没交') && !missing.includes('undefined'));
  const draft = render({ id: 'a3-m1', sid: 's', role: 'assistant', content: '写了一半', answer: { state: 'draft' } }, meeting, members);
  assert(draft.includes('草稿') && draft.includes('写了一半'));
}

(async () => {
  for (const fn of [modeRules, readStates, cardsOnlyShowFiles, answerCardRendering, deliverySkip, deliveryOwnerSkipEnds]) { await fn(); console.log('PASS ' + fn.name); }
})().catch(error => { console.error(error); process.exitCode = 1; });
