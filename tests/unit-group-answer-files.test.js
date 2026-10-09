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
    fs.writeFileSync(e.ready, '', 'utf8');
    assert.equal(A.reconcile(orch), true, 'clearing the file clears its card');
    assert.equal(msg().content, '');
    assert.equal(orch.state.turns.find(t => t.n === turnNum).by.s1, '');
    assert.equal(msg().answer.state, 'missing');
    fs.writeFileSync(e.ready, '恢复的结论', 'utf8'); A.reconcile(orch);
    fs.unlinkSync(e.ready); A.reconcile(orch);
    assert.equal(msg().content, '', 'deleting the file clears its card');
    assert.equal(A.reconcile(orch), false, 'missing file does not cause repeated writes');
    assert(orch.applyAnswerFile(turnNum, 's1', { state: 'delivered', outcome: 'ready', text: '同一正文', hash: 'same' }));
    assert(orch.applyAnswerFile(turnNum, 's1', { state: 'delivered', outcome: 'rework', text: '同一正文', hash: 'same' }));
    assert.equal(msg().answer.outcome, 'rework', 'changing only the delivery outcome updates the card');
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

function acceptedCardsKeepTheirVersion() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-pinned-'));
  try {
    const run = { id: 'run1', goal: 'goal', stages: [{ members: ['m1'], after: 'end' }], steps: [] };
    run.steps.push(D.newStep(run, 0));
    const base = D.directory(dir, 'room'), step = run.steps[0]; D.prepare(base, run, step);
    const record = path.join(base, 'run.json'), save = () => fs.writeFileSync(record, JSON.stringify(run)); save();
    const orch = getOrchestrator(dir, 'room'), { turnNum } = orch.beginTurn('任务');
    const entry = A.entryFor({ dataDir: dir, meetingId: 'room', turnNum, memberId: 'm1', workflowRun: { kind: 'delivery', runId: run.id, stepIndex: 0 } });
    orch.registerAnswerFile(turnNum, 's1', entry);
    const text = D.header(run, step, 'm1') + '\n固定交付';
    fs.writeFileSync(entry.ready, text); step.deliveries.m1 = D.readDelivery(base, run, step, 'm1'); save();
    assert(A.reconcile(orch));
    const card = () => orch.state.messages.find(m => m.sid === 's1');
    fs.writeFileSync(entry.ready, '未接纳的新版本');
    assert.equal(A.reconcile(orch), false); assert.equal(card().content, '固定交付');
    fs.unlinkSync(entry.ready); assert.equal(A.reconcile(orch), false); assert.equal(card().content, '固定交付');
    fs.writeFileSync(entry.rework, text); assert.equal(A.reconcile(orch), false, 'outcome cannot change after acceptance');
    fs.renameSync(entry.rework, entry.ready);
    fs.writeFileSync(path.join(base, run.id, '已结束运行.json'), JSON.stringify(run));
    fs.writeFileSync(record, JSON.stringify({ id: 'run2', steps: [] }));
    fs.writeFileSync(entry.ready, '旧任务的未接纳修改');
    A.reconcile(orch); assert.equal(card().content, '固定交付', 'archived runs stay pinned too');
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
    assert.match(calls[1].userInput, /B 被用户跳过，没有交付。/);
    const notes = require('../core/group-chat-orchestrator').getOrchestrator(dir, m.id).state.messages.filter(x => x.systemNote);
    assert.ok(notes.some(x => x.content === '用户跳过了 B'), 'the skip is visible in the group chat');
    await assert.rejects(e.skip(m.id, 'a'), /不在当前步骤/);
    // A file handed in after the skip does not reopen the step.
    const r = read(), first = r.steps[0], p = D.paths(D.directory(dir, m.id), r, first, 'b');
    fs.writeFileSync(p.draft, D.header(r, first, 'b') + '\n\nlate', 'utf8'); fs.renameSync(p.draft, p.ready);
    e.tick(m.id); await flush(); await flush(); assert.equal(e.status(m.id).paused, false);
  } finally { e.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}

async function deliverySkipByOrchestratorAndFailureReason() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-skip-orch-'));
  const people = ['a', 'b', 'c'].map(memberId => ({ memberId, title: memberId, displayName: memberId.toUpperCase() }));
  const draft = S.createPreset('custom', people);
  draft.rounds = [{ name: '分头提案', members: ['a', 'b'], prompt: 'propose', after: 'next' }, { name: '汇总', members: ['c'], prompt: 'sum', after: 'end' }];
  const m = { id: 'room2', groupChat: true, subSessions: ['sa', 'sb', 'sc'], slotSpecs: people, serialWorkflow: S.toDeliveryConfig({}, draft, ['a', 'b', 'c']) };
  const calls = [], settle = [], pushes = [];
  const deps = { meetingManager: { getMeeting: () => m, setParticipants() {} }, sessionManager: { getSession: () => ({ status: 'idle' }) }, getHubDataDir: () => dir, getMembers: () => people,
    ensureMemberReady: async () => {}, logger: { error() {}, warn() {} }, sendToRenderer: (channel, payload) => pushes.push([channel, payload]),
    getDispatcher: () => ({ dispatchGroupChatTurn: (_id, args) => { calls.push(args); return new Promise(resolve => settle.push(resolve)); } }) };
  const e = createDeliveryEngine(deps);
  const read = () => JSON.parse(fs.readFileSync(path.join(D.directory(dir, m.id), 'run.json'), 'utf8'));
  const deliver = member => { const r = read(), s = r.steps.at(-1), p = D.paths(D.directory(dir, m.id), r, s, member); fs.writeFileSync(p.draft, D.header(r, s, member) + '\n\nok', 'utf8'); fs.renameSync(p.draft, p.ready); };
  try {
    await e.start(m.id, 'goal'); deliver('a');
    // B 的模型调用报错：暂停原因带上成员名和报错原文，编排员与群里都能看懂。
    settle[0]({ status: 'completed', results: [{ sid: 'sb', label: 'B', status: 'errored', reason: 'provider_error',
      failure: { code: 'provider_error', summary: 'Agent 本轮异常结束', detail: 'API Error 404:\n model claude-x not found' } }] });
    await flush(); await flush();
    const paused = read();
    assert.equal(paused.status, 'paused');
    assert.match(paused.error, /^provider_error：B Agent 本轮异常结束（API Error 404: model claude-x not found）$/);
    await e.skip(m.id, 'b', { by: 'orchestrator', reason: '模型不存在，重启无效' });
    const r = read();
    assert.deepEqual({ by: r.steps[0].deliveries.b.skippedBy, reason: r.steps[0].deliveries.b.reason }, { by: 'orchestrator', reason: '模型不存在，重启无效' });
    await e.resume(m.id);
    assert.equal(calls.length, 2); assert.deepEqual(calls[1].targetMemberIds, ['c']);
    assert.match(calls[1].userInput, /B 被编排员跳过，没有交付（原因：模型不存在，重启无效）。/, 'the next member learns who skipped and why');
    const notes = require('../core/group-chat-orchestrator').getOrchestrator(dir, m.id).state.messages.filter(x => x.systemNote);
    assert.ok(notes.some(x => x.content === '编排员跳过了 B：模型不存在，重启无效' && x.noteKind === 'warning'));
    assert.ok(pushes.some(([channel, p]) => channel === 'dev-workbench:progress' && p.meetingId === m.id && p.revision > 0), 'the open group chat panel redraws right away');
  } finally { e.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}

async function deliveryOwnerSkipEnds() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-skip-owner-'));
  const people = ['a', 'b'].map(memberId => ({ memberId, displayName: memberId.toUpperCase() }));
  const m = { id: 'dev', groupChat: true, subSessions: ['sa', 'sb'], slotSpecs: people, serialWorkflow: S.createDeliveryConfig('development', people) };
  const interrupts = [];
  const e = createDeliveryEngine({ meetingManager: { getMeeting: () => m, setParticipants() {} }, sessionManager: { getSession: () => ({ status: 'idle' }) }, getHubDataDir: () => dir, getMembers: () => people,
    ensureMemberReady: async () => {}, logger: { error() {}, warn() {} }, getDispatcher: () => ({ dispatchGroupChatTurn: () => new Promise(() => {}), interruptMeetingTurn(...args) { interrupts.push(args); } }) });
  try {
    await e.start(m.id, 'goal');
    const st = await e.skip(m.id, 'a');
    assert.equal(st.finished, true); assert.equal(st.done, false, 'ends, not a pass'); assert.match(st.error, /已请求停止/);
    assert.deepEqual(interrupts, [[m.id, { reason: 'user_interrupt', targetSids: m.subSessions }]]);
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
    // 编排群的标签由 renderer/orchestration-ui.js 提供；普通群聊下它们都返回空。
    OrchUI: { roleBadge: () => '', peek: () => '', defaultMinimized: () => false },
    _gcFailReasonLabel: reason => ((reason && reason.code) || reason) === 'provider_error' ? 'Agent 本轮异常结束' : '',
  });
  const meeting = { id: 'g', groupChat: true }, members = { s: { slotIndex: 0, kind: 'claude', displayLabel: 'Claude 1' } };
  const old = render({ id: 'a1-m1', sid: 's', role: 'assistant', content: '升级前的历史回答' }, meeting, members);
  assert(old.includes('升级前的历史回答') && !old.includes('还没交'), 'history keeps its text');
  const missing = render({ id: 'a2-m1', sid: 's', role: 'assistant', content: '' }, meeting, members);
  assert(missing.includes('还没交') && !missing.includes('undefined'));
  const failed = render({ id: 'a4-m1', sid: 's', role: 'assistant', content: '', status: 'errored',
    failure: { code: 'provider_error', summary: 'Agent 本轮异常结束', detail: 'API Error: model claude-x\n not found' } }, meeting, members);
  assert(failed.includes('这一轮没完成：Agent 本轮异常结束') && failed.includes('报错原文：API Error: model claude-x not found') && !failed.includes('还没交'),
    'a member whose turn errored shows the error instead of "not handed in"');
  const draft = render({ id: 'a3-m1', sid: 's', role: 'assistant', content: '写了一半', answer: { state: 'draft' } }, meeting, members);
  assert(draft.includes('草稿') && draft.includes('写了一半'));
  // Missing output cannot prove non-delivery: expose inspection and archived
  // input, while keeping the explicit resend for completed answers in 更多.
  const menuOf = html => (html.match(/<details class="gc-journal-menu">[\s\S]*?<\/details>/) || [''])[0];
  assert(missing.includes('data-gc-open-cli="s"') && !missing.includes('data-gc-resend-member'), 'a missing card defaults to read-only CLI inspection');
  assert(!missing.includes('data-gc-copy-prompt'), 'no copy shortcut without a complete archive');
  const archived = render({ id: 'a2-m1', sid: 's', role: 'assistant', content: '',
    status: 'errored', sourcePrompt: '完整问题、前序回答和写回要求' }, meeting, members);
  assert(archived.includes('data-gc-copy-prompt="a2-m1"') && archived.includes('data-gc-open-cli="s"') && !archived.includes('data-gc-resend-member'), 'an uncertain answer offers copying and inspection without automatic submission');
  const done = render({ id: 'a4-m1', sid: 's', role: 'assistant', turnNum: 4, content: '结论', answer: { state: 'delivered' } }, meeting, members);
  assert(menuOf(done).includes('data-gc-resend-member="s"'), 'in 更多 on a delivered card');
}

async function resendMemberIpc() {
  const handlers = {}, sent = [];
  let state = 'idle';
  const meeting = { id: 'room', groupChat: true, subSessions: ['s1', 's2'], slotSpecs: [{ memberId: 'm1' }, { memberId: 'm2' }] };
  const orch = { state: { currentTurn: 3, currentMode: 'group', messages: [{ role: 'user', turnNum: 3, content: '原问题' }] } };
  require('../main/ipc/groupchat-recovery-handlers').registerGroupchatRecoveryIpc({ handle: (n, fn) => { handlers[n] = fn; } }, {
    dispatchGroupChatTurn: (_id, args) => { sent.push(args); return new Promise(() => {}); },
    getHubDataDir: () => '', getActiveWatchers: () => new Map(), groupchat: { getOrchestrator: () => orch },
    meetingManager: { getMeeting: () => meeting }, logger: { error() {}, log() {}, warn() {} }, sendToRenderer() {},
    sessionManager: { getSession: () => ({ agentRuntime: 'pty', status: 'running', cliRuntime: { state, connection: 'connected' } }) }, transcriptTap: {} });
  const call = args => handlers['groupchat:resend-member'](null, { meetingId: 'room', sid: 's2', ...args });
  state = 'running';
  assert.equal((await call()).reason, 'member_busy', 'a busy member needs confirmation'); assert.equal(sent.length, 0);
  const forced = await call({ force: true });
  assert.equal(forced.ok, true, 'returns without waiting for the answer, even while the turn is still running');
  assert.deepEqual({ target: sent[0].targetMemberIds, turn: sent[0].reuseTurnNum, input: sent[0].userInput, append: sent[0].appendUserMessage },
    { target: ['m2'], turn: 3, input: '原问题', append: false }, 'same turn, same question, only this member');
  state = 'idle'; assert.equal((await call({ turnNum: 3 })).ok, true);
  meeting.answerSource = 'transcript'; assert.equal((await call()).reason, 'not_answer_file_room', 'legacy rooms keep their own retry');
}

(async () => {
  for (const fn of [modeRules, readStates, cardsOnlyShowFiles, acceptedCardsKeepTheirVersion, answerCardRendering, resendMemberIpc, deliverySkip, deliverySkipByOrchestratorAndFailureReason, deliveryOwnerSkipEnds]) { await fn(); console.log('PASS ' + fn.name); }
})().catch(error => { console.error(error); process.exitCode = 1; });
