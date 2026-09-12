'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDevFileEngine } = require('../main/groupchat/dev-file-engine');
const F = require('../core/dev-file-workflow');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-file-engine-'));
  let meeting = { id: 'file-test', scene: 'dev', groupChat: true, workspace: dir,
    subSessions: ['s1', 's2'], slotSpecs: [{ memberId: 'author' }, { memberId: 'merger' }], participants: [0, 1],
    serialWorkflow: { fileFlowVersion: 2, steps: [['author'], ['merger']] } };
  const calls = [], events = [], pending = [];
  let wake = async () => {};
  const deps = { getHubDataDir: () => dir, meetingManager: {
    getMeeting: () => meeting, getAllMeetings: () => [meeting],
    updateMeeting: (_id, fields) => Object.assign(meeting, fields), setParticipants: (_id, p) => { meeting.participants = p; },
  }, ensureMemberReady: (...args) => wake(...args), sendToRenderer: (name, data) => events.push({ name, data }),
  getDispatcher: () => ({ dispatchGroupChatTurn: (id, args) => {
    calls.push(args); return new Promise(resolve => pending.push(resolve));
  } }), logger: { error() {} } };
  const docs = F.directory(dir, meeting.id);
  const write = name => fs.writeFileSync(path.join(docs, name), ''); // Content deliberately empty: names are the only protocol.
  let e = createDevFileEngine(deps);
  try {
    const preset = e.kickoffPreset(meeting.id);
    assert.equal(preset.slot, 0); assert(preset.prompt.includes(docs));
    assert(!fs.existsSync(docs)); assert.equal(calls.length, 0); assert.deepEqual(meeting.participants, [0, 1]);
    fs.mkdirSync(docs, { recursive: true });
    write('开题报告.md'); e.tick(); await flush(); assert.equal(calls.length, 0);
    fs.renameSync(path.join(docs, '开题报告.md'), path.join(docs, '已完成-开题报告.md'));
    e.tick(); await flush(); assert.equal(calls.length, 1); assert.deepEqual(meeting.participants, [0]);
    for (let i = 0; i < 5; i++) e.tick(); await flush(); assert.equal(calls.length, 1);
    // Next handoff dispatches while the previous chat reply promise is still pending.
    write('已完成-实现手册-轮次1.md'); e.tick(); await flush();
    assert.equal(calls.length, 2); assert.deepEqual(meeting.participants, [1]);
    assert.deepEqual(e.interruptSids(meeting.id), ['s2']);
    assert(calls[1].userInput.includes('独立')); assert(calls[1].shouldDispatch());
    e.stop(meeting.id); assert(!calls[1].shouldDispatch());
    write('需返工-合并手册-轮次1.md'); e.tick(); await flush(); assert.equal(calls.length, 2);
    assert.deepEqual(e.interruptSids(meeting.id), ['s2'], 'late rename must not redirect interruption to the next author');
    const question = e.userTurn(meeting.id, { userInput: '现在进展如何' });
    await flush(); assert.equal(e.status(meeting.id).paused, true); assert.equal(calls.length, 3);
    pending[2]({ status: 'completed' }); await question;
    // A restart honors persistent pause and uses filenames, never a chat verdict or old phase cache.
    e.dispose(); e = createDevFileEngine(deps); e.tick(); await flush(); assert.equal(calls.length, 3);
    const resumed = e.userTurn(meeting.id, { userInput: '继续' });
    await flush(); assert.equal(calls.length, 4); assert.equal(calls[3].targetMemberIds, undefined);
    assert.equal(calls[3].userInput, '继续'); assert.equal(e.status(meeting.id).paused, false);
    assert.deepEqual(meeting.participants, [1], 'manual continue must not change the chosen recipient');
    pending[3]({ status: 'completed' }); await resumed;
    e.tick(); await flush(); assert.equal(calls.length, 4, 'reply completion must not repeat same stage');
    write('已完成-实现手册-轮次2.md');
    let wakeResolve; wake = () => new Promise(resolve => { wakeResolve = resolve; });
    e.tick(); await flush(); e.stop(meeting.id); wakeResolve(); await flush();
    assert.equal(calls.length, 4, 'stop during wake must prevent sending');
    assert(e.status(meeting.id).paused);
    wake = async () => {};
    const resumeMerge = e.userTurn(meeting.id, { userInput: '继续执行' }); await flush();
    assert.equal(calls.length, 5); assert.deepEqual(meeting.participants, [1]);
    assert.equal(calls[4].userInput, '继续执行'); assert(!calls[4].workflowRun);
    write('已完成-合并手册-轮次2.md'); e.tick(); await flush(); assert(e.status(meeting.id).done);
    pending[4]({ status: 'completed' }); await resumeMerge;
    e.tick(); await flush(); assert.equal(calls.length, 5);
    for (const resolve of pending) resolve({ status: 'completed' }); await flush();
    assert(events.some(x => x.name === 'dev-file:changed' && x.data.done));
    // A single Agent uses direct prompts, even if unrelated phase filenames exist.
    meeting.serialWorkflow.soloDevelopment = true;
    meeting.subSessions = ['s1'];
    e.tick(); await flush(); assert.equal(calls.length, 5);
    assert.equal(e.status(meeting.id).key, 'solo');
    assert.throws(() => e.kickoffPreset(meeting.id), /独立开工/);
    e.stop(meeting.id);
    const soloResume = e.userTurn(meeting.id, { userInput: '继续' }); await flush();
    assert.equal(calls.length, 6); assert.equal(calls[5].userInput, '继续');
    assert.equal(e.status(meeting.id).paused, false);
    pending[5]({status:'completed'}); await soloResume;
    // Legacy rooms never participate in the filename scanner.
    delete meeting.serialWorkflow.fileFlowVersion; e.tick(); assert.equal(e.status(meeting.id), null);
    console.log('dev-file-engine: prefill, independent handoff, idempotence, pause, restart, resume and wake race passed');
  } finally { e.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
