'use strict';
// 无线 Tab · SuperRAN 助理 v2.7.2（2026-10-15 田哥拍板）：「Agent 执行」黑盒——初审（会话先只读出计划，助理用确定性
// 比对决定开始还是等）→ 实现 → 换模型审查 → 返修续用原实现会话、复审续用原审查会话；合入三档（B 档自动回到内部
// 审查、C 档退回执行）；合入在跑时暂缓派新任务；等待不是永久闸门。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WirelessAssistant, WAIT_REMIND_MS, parsePlan, findConflict } = require('../core/wireless-assistant/service');

const CAND = 'c'.repeat(40), CAND2 = 'd'.repeat(40), BASE = 'b'.repeat(40), TRUNK = 'e'.repeat(40);
function proposal(id, extra = {}) {
  return { id, title: '提案 ' + id, author: 'member:Zee', state: 'accepted', executor: '', content_revision: 1,
    content_sha: id.padEnd(64, '0'), result: '', note: '', plan: '', markdown: '📌 **结论**\n红灯测试：断言速率。', ...extra };
}
const delivered = (id, pr, extra = {}) => proposal(id, { state: 'reported', executor: 'wx-' + id + '-1', result: '📌 已修改', outcome: 'modified', pr_number: pr, acceptance_view: { state: 'reviewing' }, ...extra });
const task = (pr, state, extra = {}) => ({ pr, state, revision: 2, candidate: CAND, base: BASE, title: 'PR ' + pr, reviews: [], reviewed_trunk: '', rereview: '', review_rounds: 0, ...extra });
const PLAN = files => '实施范围：……\n\n### 预计改动\n' + files.map(f => '- ' + f).join('\n') + '\n';
const RED = ['native.py', 'source_srs.py', 'kernel_id.py'];

function fixture(t, { proposals = [], tasks = [], inflight = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wireless-v272-'));
  const home = path.join(root, 'home'), kit = path.join(home, '.superran', 'agent-kit', 'abc123');
  fs.mkdirSync(kit, { recursive: true });
  for (const f of ['superran-proposals.json', 'superran-proposals.py']) fs.writeFileSync(path.join(kit, f), '{}');
  fs.writeFileSync(path.join(kit, 'kit.json'), JSON.stringify({ user: 'lintian-admin', url: 'https://ai.lt-stockpartner.tech/superran-dev', expires: Math.floor(Date.now() / 1000) + 86400 * 20 }));
  const repo = path.join(root, 'SuperRAN'); fs.mkdirSync(repo);
  fs.mkdirSync(path.join(home, '.config', 'superran'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'superran', 'local-installation.json'), JSON.stringify({ root: repo, python: process.execPath, executor_config: path.join(kit, 'superran-proposals.json'), executor_user: 'lintian-admin' }));
  const script = path.join(root, 'skills', 'superran-review-merge', 'scripts', 'review_merge.py');
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, '');
  const state = { list: proposals, tasks, inflight, inflightError: null, progress: [], now: 1_800_000_000_000, sessions: new Map(), busy: new Set(), created: [], sent: [], notices: [], children: [] };
  const deps = {
    dataDir: path.join(root, 'data'), home, noTimer: true, fallbackCwd: root, worktreeRoot: 'D:/AIWork', reviewMergeScript: script,
    now: () => state.now,
    run: (file, args, opts, cb) => {
      if (args.includes('progress')) { state.progress.push(args.slice(args.indexOf('progress') + 1)); cb(null, '{}', ''); return; }
      assert.deepEqual(args.slice(-1), ['list']); cb(null, JSON.stringify({ user: 'lintian-admin', proposals: state.list }), '');
    },
    runTasks: (file, args, opts, cb) => {
      if (args[1] === 'inflight') {
        if (state.inflightError) cb(Object.assign(new Error('exit 2'), { code: 2 }), '', state.inflightError + '\n');
        else cb(null, JSON.stringify({ trunk: TRUNK, red: RED, tasks: state.inflight, errors: [] }), '');
        return;
      }
      assert.deepEqual(args, [script, 'status']);
      cb(null, JSON.stringify({ trunk: TRUNK, tasks: state.tasks }), '');
    },
    spawn: (file, args) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      child.args = args;
      child.finish = (code, out = '', err = '') => { if (out) child.stdout.emit('data', out); if (err) child.stderr.emit('data', err); child.emit('close', code); };
      state.children.push(child); return child;
    },
    getDefaults: async kind => ({ model: kind === 'codex' ? 'gpt-6-luna' : 'claude-sonnet-5-5', effort: 'high', mcpProfile: 'none' }),
    createSession: async (kind, opts) => { const s = { id: opts.id, kind, status: 'running' }; state.sessions.set(opts.id, s); state.created.push({ kind, opts }); state.busy.add(opts.id); return s; },
    sendPrompt: async (id, text) => { state.sent.push({ id, text }); state.busy.add(id); return { ok: true, receipt: { status: 'confirmed' } }; },
    getSession: id => state.sessions.get(id) || null,
    isAgentTurnActive: id => state.busy.has(id),
    onNotify: n => state.notices.push(n),
  };
  const service = new WirelessAssistant(deps);
  t.after(() => { service.close(); setImmediate(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }); });
  return { service, state };
}
const flush = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise(r => setImmediate(r)); };
const implJob = (service, id = 'n1') => service.status().jobs.find(j => j.type === 'implement' && j.proposalId === id && j.state !== 'skipped');
const idle = (state, job) => { state.busy.delete(job.sessionId); const s = state.sessions.get(job.sessionId); if (s) s.status = 'idle'; };

// 新提案派发后写好计划停下：proposal 进入 implementing、plan 写好、会话空闲。
async function planned(service, state, id, files, extra = []) {
  await service.poll();
  const job = implJob(service, id);
  state.list = [proposal(id, { state: 'implementing', executor: job.slot, plan: PLAN(files) }), ...extra];
  idle(state, job);
  await service.poll();
  return service.job(job.id);
}

test('计划解析与比对：只有红档物理文件或同一函数才算撞车', () => {
  const plan = parsePlan(PLAN(['src/superran/channel/native.py: _small_scale_channel', 'tests/test_registry.py: 模块级', 'docs/guide.md']));
  assert.deepEqual([...plan.keys()], ['src/superran/channel/native.py', 'tests/test_registry.py', 'docs/guide.md']);
  assert.deepEqual([...plan.get('src/superran/channel/native.py')], ['_small_scale_channel']);
  assert.equal(parsePlan('没有清单'), null);
  const red = new Set(RED);
  const other = (files, functions = {}) => [{ key: 'pr:17', label: 'PR #17', files: new Set(files), functions }];
  assert.match(findConflict(plan, other(['src/superran/channel/native.py']), red).reason, /红档物理文件/);
  assert.equal(findConflict(parsePlan(PLAN(['tests/test_registry.py: 模块级', 'docs/guide.md'])), other(['tests/test_registry.py', 'docs/guide.md']), red), null, '普通文件不等');
  const same = parsePlan(PLAN(['src/superran/sls/cases.py: run_cases, _seed']));
  assert.match(findConflict(same, other(['src/superran/sls/cases.py'], { 'src/superran/sls/cases.py': ['run_cases'] }), red).reason, /run_cases 两边都要改/);
  assert.equal(findConflict(same, other(['src/superran/sls/cases.py'], { 'src/superran/sls/cases.py': ['other_fn'] }), red), null, '同文件不同函数不等');
});

test('初审：新提案先只读出计划；碰到在途 PR 的红档文件就等，PR 合入后自动在原会话继续', async t => {
  const { service, state } = fixture(t, {
    proposals: [proposal('n1'), delivered('y1', 17)], tasks: [task(17, 'submitted')],
    inflight: [{ pr: 17, state: 'submitted', title: 'PR 17', candidate: CAND, changed: ['src/superran/channel/native.py'], functions: { 'src/superran/channel/native.py': ['_x'] }, red_files: ['src/superran/channel/native.py'] }],
  });
  await service.poll();
  let job = implJob(service);
  assert.equal(job.phase, 'precheck');
  const first = state.sent.find(s => s.id === job.sessionId).text;
  for (const part of ['初审（先只读，不改代码）', '### 预计改动', '收到「初审通过」后']) assert.ok(first.includes(part), part);
  state.list = [proposal('n1', { state: 'implementing', executor: job.slot, plan: PLAN(['src/superran/channel/native.py: _small_scale_channel']) }), delivered('y1', 17)];
  idle(state, job);
  await service.poll();
  job = service.job(job.id);
  assert.equal(job.phase, 'waiting');
  assert.equal(job.waitFor.label, 'PR #17');
  assert.match(job.note, /初审：等 PR #17 合入或终止/);
  assert.ok(state.notices.some(n => /初审：先等 PR #17/.test(n.title)));
  assert.match(state.progress.at(-1).join(' '), /--action renew --note 【执行状态】初审：等 PR #17 合入或终止｜/);
  const sentBefore = state.sent.length;
  await service.poll();
  assert.equal(service.job(job.id).phase, 'waiting', 'PR 还在途就继续等，不重复发提示');
  assert.equal(state.sent.length, sentBefore);
  state.tasks = [task(17, 'completed')]; state.inflight = [];
  await service.poll();
  job = service.job(job.id);
  assert.equal(job.phase, 'implementing');
  assert.equal(state.sent.at(-1).id, job.sessionId, '在原会话里继续');
  assert.match(state.sent.at(-1).text, /初审通过：之前要等的 PR #17 已合入或不再冲突/);
  assert.match(state.progress.at(-1).join(' '), /【执行状态】实现中（初审通过）/);
});

test('初审：只碰普通文件（测试矩阵登记、自动生成的手册）不等，直接开始实现', async t => {
  const { service, state } = fixture(t, {
    proposals: [proposal('n1')], tasks: [task(17, 'submitted')],
    inflight: [{ pr: 17, state: 'submitted', title: 'PR 17', candidate: CAND, changed: ['tests/test_registry.py', 'docs/developer-guide.html'], functions: {} }],
  });
  const job = await planned(service, state, 'n1', ['tests/test_registry.py: 模块级', 'docs/developer-guide.html']);
  assert.equal(job.phase, 'implementing');
  assert.match(state.sent.at(-1).text, /初审通过：你计划改动的位置没有和在途改动撞车（核对了 1 个在途候选/);
});

test('初审：同一函数也等；别人已开工的计划算在途，自己还在初审的不算（不会互相等）', async t => {
  const { service, state } = fixture(t, {
    proposals: [proposal('n1'), proposal('n2')], tasks: [],
    inflight: [],
  });
  await service.poll();
  const a = implJob(service, 'n1'), b = implJob(service, 'n2');
  const files = ['src/superran/sls/cases.py: run_cases'];
  state.list = [proposal('n1', { state: 'implementing', executor: a.slot, plan: PLAN(files) }), proposal('n2', { state: 'implementing', executor: b.slot, plan: PLAN(files) })];
  idle(state, a); idle(state, b);
  await service.poll();
  const phases = [service.job(a.id).phase, service.job(b.id).phase].sort();
  assert.deepEqual(phases, ['implementing', 'waiting'], '先比对的那份开始，另一份等它');
  const waiting = [service.job(a.id), service.job(b.id)].find(j => j.phase === 'waiting');
  assert.match(waiting.waitFor.label, /^提案「/);
  assert.match(waiting.waitFor.reason, /run_cases 两边都要改/);
});

test('初审等待超过 24 小时只提醒一次；点「不等了，直接开始」立即在原会话开始', async t => {
  const { service, state } = fixture(t, {
    proposals: [proposal('n1')], tasks: [task(17, 'review_failed')],
    inflight: [{ pr: 17, state: 'review_failed', title: 'PR 17', candidate: CAND, changed: ['src/superran/csi/source_srs.py'], functions: {} }],
  });
  state.list = [proposal('n1'), delivered('y1', 17, { state: 'accepted', result: '上次交付' })];
  const job = await planned(service, state, 'n1', ['src/superran/csi/source_srs.py: estimate'], [proposal('y1', { state: 'accepted', result: '上次交付', pr_number: 17 })]);
  assert.equal(job.phase, 'waiting');
  state.now += WAIT_REMIND_MS + 60000;
  await service.poll(); await service.poll();
  assert.match(service.job(job.id).attention, /24 小时/);
  assert.equal(state.notices.filter(n => /等得有点久/.test(n.title)).length, 1);
  service.act(job.id, 'force');
  await flush(6);
  assert.equal(service.job(job.id).phase, 'implementing');
  assert.match(state.sent.at(-1).text, /田哥选择不等 PR #17，直接开始实现/);
});

test('比对材料不全不算通过：读不到在途改动就停在等待并写明缺什么，恢复后自动继续；缺清单先请会话补写', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('n1')], tasks: [] });
  state.inflightError = '失败：网络不通';
  let job = await planned(service, state, 'n1', ['src/superran/channel/native.py: f']);
  assert.equal(job.phase, 'waiting');
  assert.equal(job.waitFor.key, 'material');
  assert.match(job.note, /读不到在途改动/);
  await service.poll();
  assert.equal(service.job(job.id).phase, 'waiting', '不会因为重试几次就自动放行');
  state.inflightError = null;
  await service.poll();
  assert.equal(service.job(job.id).phase, 'implementing', '材料齐了自动继续');
  // 计划没有「预计改动」：先请会话补写一次，补不上就等人决定
  const two = fixture(t, { proposals: [proposal('m1')], tasks: [] });
  await two.service.poll();
  const j2 = implJob(two.service, 'm1');
  two.state.list = [proposal('m1', { state: 'implementing', executor: j2.slot, plan: '只写了范围' })];
  idle(two.state, j2);
  await two.service.poll();
  assert.match(two.state.sent.at(-1).text, /没有「### 预计改动」清单/);
  idle(two.state, j2);
  await two.service.poll();
  job = two.service.job(j2.id);
  assert.equal((job.phase, job.waitFor.key), 'material');
  two.service.act(j2.id, 'force');
  await flush(6);
  assert.equal(two.service.job(j2.id).phase, 'implementing', '人点了才放行');
});

test('被等的 PR 所属提案撤回、或分支换了候选：不再等', async t => {
  const { service, state } = fixture(t, {
    proposals: [proposal('n1'), delivered('y1', 17)], tasks: [task(17, 'submitted')],
    inflight: [{ pr: 17, state: 'submitted', title: 'PR 17', candidate: CAND, live: true, changed: ['src/superran/channel/native.py'], functions: {} }],
  });
  const job = await planned(service, state, 'n1', ['src/superran/channel/native.py: f'], [delivered('y1', 17)]);
  assert.equal(job.phase, 'waiting');
  state.list = [proposal('n1', { state: 'implementing', executor: job.slot, plan: PLAN(['src/superran/channel/native.py: f']) }), delivered('y1', 17, { state: 'withdrawn' })];
  await service.poll();
  assert.equal(service.job(job.id).phase, 'implementing', '提案撤回优先于代码记录的状态');
});

test('初审等待不占会话名额：两个等待中的实现不挡住它们要等的审查', async t => {
  const { service, state } = fixture(t, {
    proposals: [proposal('n1'), proposal('n2'), delivered('y1', 17)], tasks: [task(17, 'review_failed')],
    inflight: [{ pr: 17, state: 'review_failed', title: 'PR 17', candidate: CAND, live: true, changed: ['src/superran/channel/native.py'], functions: {} }],
  });
  await service.poll();
  const a = implJob(service, 'n1'), b = implJob(service, 'n2');
  const plan = PLAN(['src/superran/channel/native.py: f']);
  state.list = [proposal('n1', { state: 'implementing', executor: a.slot, plan }), proposal('n2', { state: 'implementing', executor: b.slot, plan }), delivered('y1', 17)];
  idle(state, a); idle(state, b);
  await service.poll();
  assert.equal(service.job(a.id).phase, 'waiting');
  // PR 17 返修后重交，需要审查：两个等待中的会话不占名额，审查照常派出
  state.tasks = [task(17, 'submitted', { candidate: CAND2 })];
  await service.poll();
  assert.equal(service.status().jobs.find(j => j.type === 'review' && j.pr === 17)?.state, 'working');
});

test('同一候选补证据后重新送审（submit_seq 变了）：开新一轮审查，不被上一轮记录挡住', async t => {
  const { service, state } = fixture(t, { proposals: [delivered('a1', 21)], tasks: [task(21, 'submitted', { submit_seq: 1 })] });
  await service.poll();
  const first = service.status().jobs.find(j => j.type === 'review');
  state.tasks = [task(21, 'review_failed', { submit_seq: 1, review_rounds: 1 })];
  idle(state, first);
  await service.poll();
  state.tasks = [task(21, 'submitted', { submit_seq: 2, review_rounds: 1 })];
  await service.poll();
  const reviews = service.status().jobs.filter(j => j.type === 'review');
  assert.equal(reviews.length, 2);
  assert.equal(reviews.find(j => /:s2/.test(j.id)).state, 'working');
});

test('返修发回原会话时带上完整审查意见（讨论里的完整版，不用被截断的摘要）', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('n1')], tasks: [] });
  const job = await planned(service, state, 'n1', ['docs/x.md']);
  state.list = [delivered('n1', 21, { executor: job.slot })];
  idle(state, job);
  await service.poll();
  const full = ['换模型审查第 1 轮没通过（完整意见，候选 cccc）：', '', 'Physics BLOCK：' + '甲'.repeat(800) + '；Integration BLOCK：最后一条阻断'].join('\n');
  state.list = [proposal('n1', { state: 'accepted', result: '📌 已修改', pr_number: 21, rework_round: 1, note: '换模型审查第 1 轮没通过：Physics BLOCK：甲甲…（完整意见见讨论）', comments: [{ author: 'lintian-admin', markdown: full }] })];
  for (const [id, s] of state.sessions) { state.busy.delete(id); s.status = 'idle'; }
  await service.poll();
  assert.ok(state.sent.at(-1).text.includes('最后一条阻断'));
});

test('合入超过外层时限不强杀：结果标 timedOut，进程继续、日志继续写，退出时才关日志', async t => {
  const merger = require('../core/wireless-assistant/merger');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-merge-timeout-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const script = path.join(dir, 'review_merge.py'); fs.writeFileSync(script, '');
  let killed = false;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { killed = true; }; child.pid = undefined;
  const logFile = path.join(dir, 'merge.log');
  const res = await merger.runMerge({ python: 'python', script, pr: 21, candidate: CAND, logFile, timeoutMs: 20, spawnFn: () => child });
  assert.equal(res.timedOut, true);
  assert.equal(killed, false, '不强杀');
  child.stdout.emit('data', '闸门继续跑完：回滚收尾\n');
  child.emit('close', 1);
  await flush(6);
  assert.match(fs.readFileSync(logFile, 'utf8'), /闸门继续跑完/);
});

test('返修续用原实现会话：审查没通过退回后，把意见发回同一个会话（同一席位），不另开会话', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('n1')], tasks: [] });
  const job = await planned(service, state, 'n1', ['docs/x.md']);
  state.list = [delivered('n1', 21, { executor: job.slot })];
  state.tasks = [task(21, 'submitted')];
  idle(state, job);
  await service.poll();
  const sessions = state.created.length;
  state.list = [proposal('n1', { state: 'accepted', result: '📌 已修改', pr_number: 21, executor_member: 'lintian-admin', note: '换模型审查第 1 轮没通过：Integration BLOCK：回归缺一项' })];
  state.tasks = [task(21, 'review_failed', { review_rounds: 1 })];
  for (const [id, s] of state.sessions) { state.busy.delete(id); s.status = 'idle'; }
  await service.poll();
  const rework = service.status().jobs.find(j => j.type === 'implement' && j.returned && j.state === 'working');
  assert.ok(rework, '返修任务在做');
  assert.equal(rework.sessionId, job.sessionId, '续用原实现会话');
  assert.equal(rework.slot, job.slot);
  assert.equal(state.created.filter(c => c.opts.wirelessProposal.role === 'implement').length, 1, '没有另开实现会话');
  assert.ok(state.created.length <= sessions + 1);
  const text = state.sent.at(-1).text;
  for (const part of ['需要返修', '回归缺一项', 'claim n1 --slot ' + job.slot, '审查异议']) assert.ok(text.includes(part), part);
});

test('复审续用原审查会话：候选更新后第 2 轮发回同一个审查会话', async t => {
  const { service, state } = fixture(t, { proposals: [delivered('a1', 21)], tasks: [task(21, 'submitted')] });
  await service.poll();
  const first = service.status().jobs.find(j => j.type === 'review');
  assert.equal(first.state, 'working');
  state.tasks = [task(21, 'review_failed', { review_rounds: 1 })];
  idle(state, first);
  await service.poll();
  state.tasks = [task(21, 'submitted', { candidate: CAND2, review_rounds: 1 })];
  await service.poll();
  const second = service.status().jobs.find(j => j.type === 'review' && j.candidate === CAND2);
  assert.equal(second.state, 'working');
  assert.equal(second.sessionId, first.sessionId, '续用原审查会话');
  assert.equal(second.round, 2);
  assert.equal(state.created.filter(c => c.opts.wirelessProposal.role === 'review').length, 1);
  assert.match(state.sent.at(-1).text, /第 2 轮审查（最多 3 轮）/);
});

test('提案停在「等提出人判断分歧」：不派发、不复审', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('n1', { state: 'disputed', result: '📌 已修改', pr_number: 21 })], tasks: [task(21, 'review_failed', { review_rounds: 3 })] });
  await service.poll();
  assert.equal(service.status().jobs.length, 0);
  assert.equal(state.created.length, 0);
});

test('合入在跑时暂缓派新的实现和审查会话（已有的继续），合完再派', async t => {
  const { service, state } = fixture(t, { proposals: [delivered('a1', 21), proposal('n1'), delivered('b2', 22)], tasks: [task(21, 'approved'), task(22, 'submitted', { candidate: CAND2 })] });
  await service.poll();
  assert.equal(state.children.length, 1, '合入开始');
  assert.equal(state.created.length, 0, '合入期间不开新会话');
  assert.equal(service.status().code.paused, '合入进行中，暂缓派新任务');
  state.children[0].finish(0, '{\n  "pr": 21,\n  "state": "completed",\n  "merged": "' + 'f'.repeat(40) + '"\n}\n');
  state.tasks = [task(21, 'completed'), task(22, 'submitted', { candidate: CAND2 })];
  await flush(6);
  await service.poll();
  assert.equal(service.status().code.paused, null);
  assert.equal(state.created.length, 2, '合完后实现和审查都派出去了');
});

test('B 档：合并脚本退回内部审查（批准保留）→ 不打扰人 → 自动换模型重审 → 审过后按新主干再合', async t => {
  const { service, state } = fixture(t, { proposals: [delivered('a1', 21, { acceptance_view: { state: 'lead' } })], tasks: [task(21, 'approved')] });
  await service.poll();
  state.children[0].finish(0, '{\n  "pr": 21,\n  "state": "submitted",\n  "tier": "B",\n  "rereview": ["src/superran/channel/native.py"],\n  "trunk": "' + TRUNK + '"\n}\n');
  state.tasks = [task(21, 'submitted', { rereview: TRUNK, approval: { actor: 'lintian-admin' } })];
  await flush(6);
  const merge = service.status().jobs.find(j => j.type === 'merge');
  assert.equal(merge.state, 'done');
  assert.match(merge.note, /native\.py.*自动回到审查/);
  assert.ok(!state.notices.some(n => /回到审查/.test(n.title)), '人不感知');
  await service.poll();
  const review = service.status().jobs.find(j => j.type === 'review');
  assert.equal(review.state, 'working');
  assert.match(review.id, new RegExp(TRUNK.slice(0, 12)));
  assert.ok(state.sent.at(-1).text.includes('自动重审'));
  state.tasks = [task(21, 'approved', { reviewed_trunk: TRUNK })];
  await service.poll(); await flush(6);
  assert.equal(state.children.length, 2);
});

test('C 档：合并脚本判冲突 → 写明退回「Agent 执行」、要重新验收和批准', async t => {
  const { service, state } = fixture(t, { proposals: [delivered('a1', 21)], tasks: [task(21, 'approved')] });
  await service.poll();
  state.children[0].finish(0, '{\n  "pr": 21,\n  "state": "stale",\n  "tier": "C",\n  "reason": "和主干有冲突：src/superran/channel/kernel_id.py"\n}\n');
  state.tasks = [task(21, 'stale')];
  await flush(6);
  const merge = service.status().jobs.find(j => j.type === 'merge');
  assert.equal(merge.state, 'failed');
  assert.match(merge.note, /退回「Agent 执行」/);
});

test('收回审批权后排队的合入被跳过，别人重新批准同一候选时恢复排队（独立审查第 8 条）', async t => {
  const { service, state } = fixture(t, { proposals: [delivered('b1', 31), delivered('c1', 32)], tasks: [task(31, 'approved'), task(32, 'approved', { candidate: CAND2 })] });
  await service.poll();
  assert.equal(state.children.length, 1, 'PR 31 在合，PR 32 排队');
  state.tasks = [task(31, 'approved'), task(32, 'awaiting_approval', { candidate: CAND2 })];
  await service.poll();
  assert.equal(service.status().jobs.find(j => j.pr === 32).state, 'skipped');
  state.tasks = [task(31, 'approved'), task(32, 'approved', { candidate: CAND2 })];
  await service.poll();
  assert.equal(service.status().jobs.find(j => j.pr === 32).state, 'queued', '重新批准后恢复排队');
  state.children[0].finish(0, JSON.stringify({ pr: 31, state: 'completed', merged: 'f'.repeat(40) }, null, 2) + '\n');
  await flush(6);
  assert.equal(state.children.length, 2);
  assert.deepEqual(state.children[1].args.slice(1, 3), ['merge', '32']);
});

test('AirView：有关的提案初审建议问公司、审查必须问公司并按上限等待；无关不问；旧提案标未核实', () => {
  const { buildExecutionPrompt, buildReviewPrompt, buildReReviewPrompt } = require('../core/wireless-assistant/prompt');
  const install = { user: 'u', site: 'https://x/', kitDir: 'k' };
  const t0 = { pr: 13, candidate: CAND, base: BASE };
  const opts = { script: 'C:/s/scripts/review_merge.py', slot: 'wr-13-1', reviewer: 'Opus', companyWaitMinutes: 90 };
  const related = proposal('r1', { airview: { state: 'related', refs: ['src/ul/GUlMeasure.cc（selServArrayForJT）'] } });
  const exec = buildExecutionPrompt(related, { install, slot: 'wx-r1-1', precheck: true });
  for (const part of ['AirView 对齐（初审时建议做）', 'align-list', 'ask_company', 'GUlMeasure.cc', '不要求发成段源码']) assert.ok(exec.includes(part), part);
  const review = buildReviewPrompt(t0, related, opts);
  for (const part of ['公司 CodeAgent 对齐检查（必须）', '等回执最多 90 分钟', 'followup_company', '有意偏离', '待公司核实', 'AirView｜', '变异测试', '--report-file', '作者自测不能写成审查复跑']) assert.ok(review.includes(part), part);
  assert.ok(buildReReviewPrompt(t0, related, opts).includes('公司 CodeAgent 对齐检查'));
  const unrelated = proposal('u1', { airview: { state: 'unrelated', refs: [] } });
  assert.ok(!buildExecutionPrompt(unrelated, { install, slot: 'wx-u1-1', precheck: true }).includes('ask_company'));
  assert.ok(!buildReviewPrompt(t0, unrelated, opts).includes('ask_company'), '无关不询问');
  const old = proposal('o1');
  assert.match(buildReviewPrompt(t0, old, opts), /没写 AirView 关系（旧提案）：不问公司，报告里 AirView 对齐标「未核实」/);
});

test('等公司回执的上限可在设置里改（10–480 分钟）', async t => {
  const { service } = fixture(t, {});
  assert.equal(service.settings().companyWaitMinutes, 120);
  service.setSettings({ companyWaitMinutes: 60 });
  assert.equal(service.settings().companyWaitMinutes, 60);
  assert.throws(() => service.setSettings({ companyWaitMinutes: 5 }), /10–480/);
});

test('初审：PR 已关闭或所属提案已撤回的候选不算在途，取不到它也不挡比对（独立审查 r3 第 4 条）', async t => {
  const { service, state } = fixture(t, {
    proposals: [proposal('n1'), delivered('y1', 17, { state: 'withdrawn' })], tasks: [task(17, 'submitted', { pr_state: 'open' }), task(18, 'submitted', { pr_state: 'closed' })],
    inflight: [{ pr: 18, state: 'submitted', pr_state: 'closed', candidate: CAND, live: true, changed: ['src/superran/channel/native.py'], functions: {} }],
  });
  state.inflight = [{ pr: 18, state: 'submitted', pr_state: 'closed', candidate: CAND, live: true, changed: ['src/superran/channel/native.py'], functions: {} }];
  const job = await planned(service, state, 'n1', ['src/superran/channel/native.py: f'], [delivered('y1', 17, { state: 'withdrawn' })]);
  assert.equal(job.phase, 'implementing', '已关闭的 PR 不等');
});

test('返修提示带完整审查意见，提出人裁决只作附加说明（独立审查 r3 第 5 条）', () => {
  const { latestFindings } = require('../core/wireless-assistant/service');
  const full = '换模型审查第 3 轮没通过（完整意见，候选 cccc）：' + '甲'.repeat(900) + '最后一条阻断';
  const p = { comments: [{ markdown: '换模型审查第 2 轮没通过（完整意见，候选 bbbb）：旧' }, { markdown: full }, { markdown: '需要提出人判断：审查连续 3 轮没通过。' }, { markdown: '提出人决定按审查意见改：先补回归' }] };
  const text = latestFindings(p);
  assert.ok(text.includes('最后一条阻断'));
  assert.ok(text.includes('提出人决定按审查意见改'));
  assert.ok(!text.includes('第 2 轮'));
});
