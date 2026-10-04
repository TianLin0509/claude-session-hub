'use strict';
// Development flow on the delivery engine: review convergence, failure modes,
// lessons, Hub test gate, start without avatar matching, legacy migration.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const D = require('../core/delivery-workflow'), S = require('../core/workflow-settings'), G = require('../core/delivery-dev-guidance');
const M = require('../core/delivery-migration'), F = require('../core/dev-file-workflow');
const Gate = require('../main/groupchat/delivery-gate');
const { createDeliveryEngine } = require('../main/groupchat/delivery-engine');
const flush = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gate-repo-')), flag = path.join(dir, '..', path.basename(dir) + '.fail');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, '.agents'));
  const check = `node -e "process.exit(require('fs').existsSync('${flag.replace(/\\/g, '/')}')?1:0)"`;
  fs.writeFileSync(path.join(dir, '.agents', 'project.json'), JSON.stringify({ trunk: 'master', test: [check] }));
  git('add', '-A'); git('commit', '-qm', 'init');
  return { dir, flag, sha: git('rev-parse', 'HEAD'), fail: on => on ? fs.writeFileSync(flag, '') : fs.rmSync(flag, { force: true }), close: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(flag, { force: true }); } };
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-devflow-unit-'));
  const people = ['a', 'b'].map(memberId => ({ memberId, title: memberId, displayName: memberId.toUpperCase() }));
  const m = { id: 'dev', groupChat: true, subSessions: ['sa', 'sb'], slotSpecs: people, serialWorkflow: S.createDeliveryConfig('development', people) };
  const calls = [], handlers = {};
  const e = createDeliveryEngine({ meetingManager: { getMeeting: () => m, getAllMeetings: () => [m], setParticipants: (_id, parts) => { m.participants = [...parts]; } },
    sessionManager: { getSession: () => ({ status: 'idle' }) }, getHubDataDir: () => dir, getMembers: () => people, ensureMemberReady: async () => {}, logger: { error() {}, warn() {} },
    getDispatcher: () => ({ dispatchGroupChatTurn: (_id, args) => { calls.push(args); args.targetMemberIds.forEach(memberId => args.onSubmission({ memberId, ok: true })); return new Promise(() => {}); } }) });
  e.registerIpc({ handle: (name, fn) => { handlers[name] = fn; } });
  const read = () => JSON.parse(fs.readFileSync(path.join(D.directory(dir, m.id), 'run.json'), 'utf8'));
  const deliver = (member, outcome = 'ready', body = 'Verified result') => {
    const r = read(), step = r.steps.at(-1), p = D.paths(D.directory(dir, m.id), r, step, member);
    fs.writeFileSync(p.draft, D.header(r, step, member) + '\n\n' + body, 'utf8'); fs.renameSync(p.draft, p[outcome]);
  };
  const advance = async () => { e.tick(m.id); await flush(); await flush(); };
  // Waits for the asynchronous Hub gate and the dispatch it unlocks.
  const until = async (pred, label) => { const end = Date.now() + 30000; while (Date.now() < end) { await advance(); if (pred()) return; await sleep(100); } throw new Error('timeout ' + label); };
  return { dir, m, e, calls, handlers, read, deliver, advance, until, close: () => { e.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function guidance() {
  const draft = S.createPreset('development', [{ memberId: 'a' }, { memberId: 'b' }]);
  const run = { kind: 'file', stages: draft.rounds, steps: [] };
  const step = index => { const s = { number: run.steps.length + 1, index }; run.steps.push(s); return s; };
  const text = (s, extras) => G.lines(run, s, { lessonsDir: 'L', ...extras }).join('\n');
  const kick = text(step(0));
  assert.match(kick, /失败模式清单/); assert.match(kick, /历史教训/);
  const build = text(step(1));
  assert.match(build, /CANDIDATE:/); assert.match(build, /逐条执行开题报告里的失败模式清单/);
  const r1 = text(step(2));
  assert.match(r1, /第 1 轮审查：一次列全/); assert.match(r1, /机械性的/); assert.match(r1, /追加到 L/);
  step(1); const r2 = text(step(2), { gate: { state: 'passed', sha: 'abc', commands: ['t'], durationMs: 120000, logPath: 'log' }, overlaps: [{ title: '别的任务', files: ['x.js'] }] });
  assert.match(r2, /第 2 轮审查（复审）/); assert.match(r2, /新发现的 P2 写进交付的「遗留清单」，不阻断合并/);
  assert.match(r2, /Hub 已在候选 abc 上跑完项目测试闸门并通过/); assert.match(r2, /别的任务.*x\.js/);
  assert.match(text(run.steps[1], { gateFailure: 'NOTE' }), /先读 NOTE/);
}

function candidateParsing() {
  const sha = 'a'.repeat(40);
  assert.deepEqual(Gate.parseCandidate(`说明\n\`CANDIDATE: C:\\wt\\x ${sha}\`\n`), { worktree: 'C:\\wt\\x', sha });
  assert.deepEqual(Gate.parseCandidate(`- CANDIDATE: "C:/wt/有 空格" ${sha.toUpperCase()}`), { worktree: 'C:/wt/有 空格', sha });
  assert.equal(Gate.parseCandidate('CANDIDATE: C:/wt abc123'), null, 'short SHA is not a candidate');
  assert.deepEqual(Gate.parseCandidate(`**CANDIDATE:** C:\\wt\\x ${sha}（已提交）`), { worktree: 'C:\\wt\\x', sha }, 'bold label and trailing words');
  const b = 'b'.repeat(40);
  assert.deepEqual(Gate.parseCandidate(`上一版 CANDIDATE: C:/old ${sha}\n本版 CANDIDATE: C:/new ${b}`), { worktree: 'C:/new', sha: b }, 'the last candidate wins');
  assert.match(Gate.preflight(null).skipped, /没有 CANDIDATE/);
  const env = (() => { process.env.CLAUDE_HUB_DATA_DIR = 'x'; try { return Gate.gateEnv(); } finally { delete process.env.CLAUDE_HUB_DATA_DIR; } })();
  assert.equal(env.CLAUDE_HUB_DATA_DIR, undefined, 'gate never inherits the Hub data directory');
}

async function gateFlow() {
  const f = fixture(), g = repo();
  const cand = `交付\nCANDIDATE: ${g.dir} ${g.sha}`;
  try {
    const started = await f.handlers['delivery:start'](null, { meetingId: f.m.id, userInput: 'goal', recipientSids: ['sb'] });
    assert.equal(started.ok, true, started.error); assert.deepEqual(f.calls[0].targetMemberIds, ['a'], 'workflow picks the kickoff owner, not the lit avatar');
    assert.match(f.calls[0].userInput, /失败模式清单/);
    f.deliver('a'); await f.advance(); assert.deepEqual(f.calls[1].targetMemberIds, ['a']); assert.match(f.calls[1].userInput, /CANDIDATE:/);
    f.deliver('a', 'ready', cand);
    await f.until(() => f.calls.length === 3, 'review after passed gate');
    assert.equal(f.read().steps[1].gate.state, 'passed');
    assert.deepEqual(f.calls[2].targetMemberIds, ['b']); assert.match(f.calls[2].userInput, /Hub 已在候选/); assert.match(f.calls[2].userInput, /第 1 轮审查/);
    f.deliver('b', 'rework', 'P1 缺陷'); await f.advance(); assert.deepEqual(f.calls[3].targetMemberIds, ['a']);
    g.fail(true); f.deliver('a', 'ready', cand);
    await f.until(() => f.calls.length === 5, 'builder retry after failed gate');
    const failed = f.read().steps[3];
    assert.equal(failed.gate.state, 'failed'); assert(fs.existsSync(failed.hubNotes[0].path));
    assert.deepEqual(f.calls[4].targetMemberIds, ['a'], 'failed gate returns to the builder, not the reviewer');
    assert.match(f.calls[4].userInput, /未通过 Hub 测试闸门/);
    assert.equal(D.reviewsInBudget(f.read()), 1, 'gate failures spend no review');
    g.fail(false); f.deliver('a', 'ready', cand);
    await f.until(() => f.calls.length === 6, 'second review');
    assert.match(f.calls[5].userInput, /第 2 轮审查（复审）/);
    f.deliver('b'); await f.advance(); assert(f.e.status(f.m.id).done);
  } finally { f.close(); g.close(); }
}

async function gateStreak() {
  const f = fixture(), g = repo(), cand = `CANDIDATE: ${g.dir} ${g.sha}`;
  try {
    await f.e.start(f.m.id, 'goal'); f.deliver('a'); await f.advance();
    g.fail(true);
    for (let n = 1; n <= 3; n++) { f.deliver('a', 'ready', cand); await f.until(() => f.read().steps.at(-1).gate?.state === 'failed' || f.e.status(f.m.id).paused || f.calls.length === 2 + n, 'gate ' + n); }
    const st = f.e.status(f.m.id);
    assert.equal(st.paused, true); assert.match(st.error, /连续 3 次未通过 Hub 测试闸门/); assert.equal(f.calls.length, 4, 'no fourth automatic retry');
    assert(!f.calls.some(c => c.targetMemberIds[0] === 'b'), 'reviewer never sees a failing candidate');
    await f.e.resume(f.m.id); assert.equal(f.calls.length, 5, 'continue grants another try'); assert.deepEqual(f.calls[4].targetMemberIds, ['a']);
  } finally { f.close(); g.close(); }
}

async function gateSkippedWithoutCandidate() {
  const f = fixture();
  try {
    await f.e.start(f.m.id, 'goal'); f.deliver('a'); await f.advance(); f.deliver('a', 'ready', '没有候选行'); await f.advance();
    assert.equal(f.calls.length, 3); assert.match(f.calls[2].userInput, /Hub 未执行测试闸门（交付中没有 CANDIDATE 行）/);
  } finally { f.close(); }
}

function migration() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-migrate-'));
  const specs = [{ memberId: 'm1' }, { memberId: 'm2' }];
  const room = (id, w, extra = {}) => ({ id, groupChat: true, slotSpecs: specs, subSessions: ['s1', 's2'], lastMessageTime: Date.now(), serialWorkflow: w, ...extra });
  const docs = (id, names) => { const d = F.directory(data, id); fs.mkdirSync(d, { recursive: true }); names.forEach(n => fs.writeFileSync(path.join(d, n), 'x')); };
  const fileflow = () => S.toConfig({}, S.createPreset('development', specs), ['m1', 'm2']);
  try {
    docs('done', ['已完成-开题报告.md', '已完成-实现手册-轮次1.md', '已完成-合并手册-轮次1.md']);
    const done = M.plan(room('done', fileflow()), data);
    assert.equal(done.action, 'migrate'); assert.equal(done.config.deliveryVersion, 1); assert.equal(done.config.deliveryKind, 'file');
    assert.deepEqual(done.config.deliveryStages.map(s => s.members[0]), ['m1', 'm1', 'm2']); assert.equal(done.config.migratedFrom.previous.fileFlowVersion, 2);
    assert.equal(done.config.fileFlowVersion, undefined);
    docs('busy', ['已完成-开题报告.md']);
    assert.equal(M.plan(room('busy', fileflow()), data).action, 'keep', 'recent unfinished legacy task stays');
    assert.equal(M.plan(room('busy', fileflow(), { lastMessageTime: Date.now() - M.STALE_MS - 1 }), data).action, 'migrate', 'abandoned legacy task moves');
    const solo = M.plan(room('solo', { ...fileflow(), soloDevelopment: true }), data);
    assert.equal(solo.config.deliveryKind, 'serial'); assert.equal(solo.config.deliveryStages.length, 1); assert.equal(solo.config.deliveryStages[0].after, 'end');
    const loop = M.plan(room('loop', { templateId: 'dev-task', enabled: false, loop: { enabled: true }, steps: [['m1'], ['m2']], loopState: { status: 'done' } }), data);
    assert.equal(loop.config.deliveryKind, 'file'); assert.deepEqual(loop.config.deliveryStages.map(s => s.members[0]), ['m1', 'm1', 'm2']);
    assert.equal(M.plan(room('live', { templateId: 'dev-task', loop: { enabled: true }, steps: [['m1'], ['m2']], loopState: { status: 'paused' } }), data).action, 'keep');
    const relay = M.plan(room('relay', { enabled: true, steps: [['m2'], ['m1']] }), data);
    assert.equal(relay.action, 'migrate'); assert.equal(relay.config.deliveryStages[0].prompt, M.RELAY_PROMPT); assert.equal(relay.config.deliveryStages.at(-1).after, 'end');
    assert.equal(M.plan(room('plain', { enabled: false, steps: [] }), data).reason, 'not-workflow', 'plain group chats are untouched');
    assert.equal(M.plan(room('off', { settingsVersion: 1, enabled: false, steps: [['m1'], ['m2']], stepConfigs: [{ name: 'a', prompt: 'x' }, { name: 'b', prompt: 'y' }] }), data).action, 'keep', 'a workflow the user switched off stays off');
    assert.equal(M.plan(room('manual', { ...fileflow(), devWorkbenchManual: true }), data).action, 'keep', 'manual takeover stays a plain chat');
    assert.equal(M.plan(room('new', S.createDeliveryConfig('development', specs)), data).reason, 'already');
    const store = new Map([['done', room('done', fileflow())], ['busy', room('busy', fileflow())]]), writes = [];
    const summary = M.migrateAll({ dataDir: data, logger: { log() {} }, meetingManager: { getAllMeetings: () => [...store.values()], updateMeeting: (id, f) => writes.push([id, f.serialWorkflow.deliveryVersion]), setParticipants: (id, p) => writes.push([id, p]) } });
    assert.deepEqual(summary.migrated.map(x => x.id), ['done']); assert.deepEqual(summary.kept.map(x => x.id), ['busy']);
    assert.deepEqual(writes, [['done', 1], ['done', [0]]]);
    assert(fs.existsSync(path.join(data, 'workflow-migration.jsonl')));
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
}

// After a task ends the room falls back to plain group chat; 开新任务 arms the next message.
async function taskModeAfterEnd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-armed-'));
  const people = ['a', 'b'].map(memberId => ({ memberId, displayName: memberId }));
  const m = { id: 'room', groupChat: true, subSessions: ['sa', 'sb'], slotSpecs: people, serialWorkflow: S.createDeliveryConfig('development', people) };
  const e = createDeliveryEngine({ meetingManager: { getMeeting: () => m, setParticipants() {}, updateMeeting: (_id, f) => Object.assign(m, f) },
    sessionManager: { getSession: () => ({ status: 'idle' }) }, getHubDataDir: () => dir, getMembers: () => people, ensureMemberReady: async () => {},
    logger: { error() {}, warn() {} }, getDispatcher: () => ({ dispatchGroupChatTurn: () => new Promise(() => {}), interruptMeetingTurn() {} }) });
  try {
    assert.equal(e.status(m.id).armed, true, 'fresh room: first message starts a task');
    await e.start(m.id, 'goal'); e.cancel(m.id);
    assert.equal(e.status(m.id).armed, false, 'ended task: plain group chat');
    assert.equal(e.setArmed(m.id, true).armed, true, '开新任务 arms the next message');
    assert.equal(e.setArmed(m.id, false).armed, false, 'and can switch back');
  } finally { e.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}

// Weak-model protocol slips seen in live runs must not stall a run.
function tolerantDeliveryReading() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tolerant-'));
  try {
    const draft = S.createPreset('development', [{ memberId: 'a' }, { memberId: 'b' }]);
    const run = { id: 'run1', goal: 'g', stages: draft.rounds, steps: [] };
    const step = D.newStep(run, 0); run.steps.push(step); D.prepare(dir, run, step);
    const p = D.paths(dir, run, step, 'a');
    fs.writeFileSync(p.ready, '整份重写、丢了文件头的交付', 'utf8');
    assert.equal(D.readDelivery(dir, run, step, 'a').outcome, 'ready', 'leftover draft + dropped ticket still accepted');
    fs.writeFileSync(p.blocked, D.header(run, step, 'a') + '\n\n阻塞', 'utf8');
    assert.throws(() => D.readDelivery(dir, run, step, 'a'), /多个交付状态/, 'conflicting final states are still an error');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Composer submission: no avatar requirement to start; typed "继续" resumes and
// never drops the words after it.
async function composerSubmit() {
  const Module = require('node:module'), realLoad = Module._load, sent = [];
  let state = { ok: true, armed: true };
  const ipcRenderer = { on() {}, invoke: async (channel, args) => { sent.push([channel, args]); return channel === 'delivery:status' ? state : { ok: true }; } };
  Module._load = function (request, ...rest) { return request === 'electron' ? { ipcRenderer } : realLoad.call(this, request, ...rest); };
  const modPath = require.resolve('../renderer/delivery-workflow-controls');
  delete require.cache[modPath];
  try {
    const C = require(modPath), meeting = { id: 'r', subSessions: ['s1', 's2'], participants: [], slotSpecs: [{ memberId: 'm1' }, { memberId: 'm2' }], serialWorkflow: { deliveryStages: [{ members: ['m1'] }] } };
    await C.submit(meeting, '做一个功能', []);
    assert.deepEqual(sent.at(-1), ['delivery:start', { meetingId: 'r', userInput: '做一个功能' }], 'starts with no avatar lit');
    // After a task ends the room is a plain group chat until the user arms 开新任务.
    state = { ok: true, runId: 'x', finished: true, done: true, armed: false }; sent.length = 0;
    assert.deepEqual(await C.submit(meeting, '现在什么进展', []), { plain: true }, 'ended task: ordinary message');
    assert.deepEqual(sent.map(s => s[0]), ['delivery:status'], 'no new task is started');
    state = { ok: true, runId: 'x', finished: true, armed: true }; sent.length = 0;
    await C.submit(meeting, '做下一件事', []); assert.equal(sent.at(-1)[0], 'delivery:start', 'armed: next message starts a task');
    state = { ok: true, runId: 'x', paused: true, finished: false }; sent.length = 0;
    const bare = await C.submit({ ...meeting, participants: [1] }, '继续', ['s2']);
    assert.equal(bare.resumed, true); assert.deepEqual(sent.map(s => s[0]), ['delivery:status', 'delivery:resume']);
    sent.length = 0;
    await C.submit({ ...meeting, participants: [1] }, '继续，改用方案 B', ['s2']);
    assert.deepEqual(sent.map(s => s[0]), ['delivery:status', 'delivery:resume', 'groupchat:user-supplement'], 'extra words become a supplement');
    assert.equal(sent[2][1].text, '继续，改用方案 B');
  } finally { Module._load = realLoad; delete require.cache[modPath]; }
}

(async () => {
  for (const fn of [guidance, candidateParsing, gateFlow, gateStreak, gateSkippedWithoutCandidate, migration, tolerantDeliveryReading, taskModeAfterEnd, composerSubmit]) { await fn(); console.log('PASS ' + fn.name); }
})().catch(error => { console.error(error); process.exitCode = 1; });
