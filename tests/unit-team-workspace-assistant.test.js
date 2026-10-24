'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-queue-'));
  const f = { owner: 'owner-a', online: true, sent: [], interrupted: [], finals: [], busy: false };
  const a = new CompanyAssistant({ dataDir: dir, noTools: true, noTimer: true,
    getSession: id => id === 'team-session' ? { id, status: f.busy ? 'running' : 'idle' } : null,
    sendPrompt: async (id, prompt) => { f.sent.push({ id, prompt }); return { ok: true }; },
    readFinals: () => f.finals,
    interruptSession: async id => { f.interrupted.push(id); f.busy = false; },
  });
  a.auth.status = () => ({ state: f.online ? 'online' : 'unknown', login: { uid: f.owner, ok: f.online } });
  a.ensureSession = async () => 'team-session';
  a.ensureTeamSession = async () => 'team-session';
  a.instructions = () => '公司助理说明';
  a.cli = () => '';
  a.ppt.citationNote = async () => '';
  f.a = a;
  t.after(() => { a.queue = []; a.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return f;
}
const settle = () => new Promise(resolve => setImmediate(resolve));
// 负载高时发送链路要多走几拍：最多等 2 秒，条件成立即返回。
const eventually = async (check, ms = 2000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); };

test('团队口令锁定取消排队/运行任务并隐藏助理中的团队记录，普通对话保留', async t => {
  const f=setup(t),a=f.a;let unlocked=true;
  a.deps.assertTeamAccess=()=>{if(!unlocked)throw Error('团队未解锁');};
  const active=a.ask('运行中的私人分析',{teamOwner:'owner-a'});await settle();f.busy=true;
  const pending=a.ask('排队中的私人分析',{teamOwner:'owner-a'});
  a.ask('普通问题');
  unlocked=false;await a.revokeTeamAccess();await settle();
  assert.deepEqual(f.interrupted,['team-session']);
  for(const id of [active.id,pending.id])assert.equal(a.chat().find(x=>x.id===id).state,'error');
  assert.deepEqual(a.status().chat.map(x=>x.q),['普通问题']);
  assert.throws(()=>a.retryChat(pending.id),/未解锁/);
  assert.equal(f.sent.filter(x=>x.prompt.includes('排队中的私人')).length,0);
  await eventually(()=>f.sent.some(x=>x.prompt.includes('普通问题')));
  assert.ok(f.sent.some(x=>x.prompt.includes('普通问题')));
  unlocked=true;assert.equal(a.status().chat.length,3);
});

test('团队在创建会话期间锁定，即使随后解锁也不继续发原任务', async t => {
  const f=setup(t),a=f.a;let release;
  a.ensureTeamSession=()=>new Promise(r=>{release=r;});
  const item=a.ask('未发出的团队分析',{teamOwner:'owner-a'});
  await a.revokeTeamAccess();release('team-session');await settle();
  assert.equal(f.sent.length,0);assert.equal(a.chat().find(x=>x.id===item.id).state,'error');
});

test('真实 CompanyAssistant 队列：换号后旧 owner 任务不发送，重试不丢绑定', async t => {
  const f = setup(t), a = f.a;
  a.pumping = true;
  const item = a.ask('团队本机文件分析', { teamOwner: 'owner-a' });
  assert.equal(a.queue[0].teamOwner, 'owner-a');
  f.owner = 'owner-b'; a.pumping = false;
  await a.pump();
  assert.equal(f.sent.length, 0);
  assert.equal(a.chat().find(c => c.id === item.id).state, 'error');
  assert.throws(() => a.retryChat(item.id), /账号已退出或改变/);
  assert.equal(a.status().chat.length, 0, '换号后助理页同样隐藏旧团队分析');
  f.owner = 'owner-a'; assert.equal(a.status().chat.length, 1);
  await settle();
});

test('打开原生会话期间换号也不发送，普通助理任务不受团队 guard 影响', async t => {
  const f = setup(t), a = f.a;
  a.ensureTeamSession = async () => { f.owner = 'owner-b'; return 'team-session'; };
  const team = a.ask('团队分析', { teamOwner: 'owner-a' });
  await settle();
  assert.equal(f.sent.length, 0); assert.equal(a.chat().find(c => c.id === team.id).state, 'error');
  a.ask('普通助理提问'); await settle();
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].prompt, /普通助理提问/);
});

test('运行中换号只中断本团队任务，拒收其回答，当前账号无法看到原任务', async t => {
  const f = setup(t), a = f.a;
  const item = a.ask('团队分析', { teamOwner: 'owner-a' });
  await settle(); assert.equal(f.sent.length, 1);
  f.busy = true; f.owner = 'owner-b';
  await a.collectJob();
  assert.deepEqual(f.interrupted, ['team-session']);
  f.finals.push({ id: 'late-final', text: '旧账号分析结果' });
  await a.collectJob();
  const saved = a.chat().find(c => c.id === item.id);
  assert.equal(saved.state, 'error'); assert.equal(saved.a, undefined);
  assert.equal(a.status().chat.length, 0);
  await settle();
});

test('正常同账号队列完成可归集，退出登录后即使保留 uid 也不可读团队记录', async t => {
  const f = setup(t), a = f.a;
  const item = a.ask('团队分析', { teamOwner: 'owner-a' });
  await settle();
  f.finals.push({ id: 'final-1', text: '已核对的分析' });
  await a.collectJob();
  assert.equal(a.chat().find(c => c.id === item.id).state, 'done');
  f.online = false; assert.equal(a.status().chat.length, 0);
  assert.throws(() => a.ask('重发', { teamOwner: 'owner-a' }), /账号已退出/);
  await settle();
});

test('A、B 团队和普通助理使用不同原生 session 及工作目录，团队不继承普通上下文或管理 MCP', async t => {
  const f = setup(t), a = f.a, sessions = new Map(), created = [];
  delete a.ensureTeamSession; delete a.ensureSession;
  a.prepareWorkspace = () => {};
  a.deps.getSession = id => sessions.get(id);
  a.deps.createSession = async (kind, opts) => {
    created.push(opts); sessions.set(opts.id, { ...opts, status: 'idle' });
    if (opts.title === '团队关注分析') assert.deepEqual(a.sessionPlan({ opts }), {}, '禁止团队挂管理或桥接 MCP');
    return { id: opts.id };
  };
  a.memory.context = () => '普通助理的私有记忆';
  a.ask('owner-a 的团队输入', { teamOwner: 'owner-a' }); await settle();
  const aId = f.sent[0].id; f.finals.push({ id: 'a-final', text: 'A结果' }); await a.collectJob();
  f.owner = 'owner-b'; a.ask('owner-b 的团队输入', { teamOwner: 'owner-b' }); await settle();
  const bId = f.sent[1].id; f.finals.push({ id: 'b-final', text: 'B结果' }); await a.collectJob();
  a.ask('普通提问'); await settle(); const ordinaryId = f.sent[2].id;
  assert.equal(new Set([aId, bId, ordinaryId]).size, 3);
  assert.equal(new Set(created.map(c => c.cwd)).size, 3);
  assert.equal(a.state().sessionId, ordinaryId);
  assert.deepEqual(new Set(Object.values(a.state().teamSessionIds)), new Set([aId, bId]));
  assert.doesNotMatch(f.sent[0].prompt, /普通助理的私有记忆|公司助理说明/);
  assert.doesNotMatch(f.sent[1].prompt, /普通助理的私有记忆|公司助理说明/);
  assert.match(f.sent[2].prompt, /普通助理的私有记忆/);
  f.owner = 'owner-a'; assert.equal(await a.ensureTeamSession('owner-a'), aId);
});
