'use strict';
// 无线 Tab · SuperRAN 助理 v2.7.2（2026-10-15 田哥「都按推荐来」）：主干前进后三档合入——B 档合并脚本把任务
// 退回审查（批准保留）时助理自动换模型重审；C 档真冲突才退回返工；开工前把在途 PR 正在改的红档文件写进
// 执行提示词，必须改同一处的提案释放并写「等 PR #N 合入」，那个 PR 合入后自动重新派发，等太久只提醒不卡死。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WirelessAssistant, WAIT_REMIND_MS } = require('../core/wireless-assistant/service');

const CAND = 'c'.repeat(40), BASE = 'b'.repeat(40), TRUNK = 'e'.repeat(40);
function proposal(id, extra = {}) {
  return { id, title: '提案 ' + id, author: 'member:Zee', state: 'accepted', executor: '', content_revision: 1,
    content_sha: id.padEnd(64, '0'), result: '', note: '', markdown: '📌 **结论**\n红灯测试：断言速率。', ...extra };
}
const accepted = (id, pr, extra = {}) => proposal(id, { state: 'reported', executor: 'wx-' + id + '-1', result: '📌 已修改', outcome: 'modified', pr_number: pr, acceptance_view: { state: 'lead' }, ...extra });
const task = (pr, state, extra = {}) => ({ pr, state, revision: 2, candidate: CAND, base: BASE, title: 'PR ' + pr, reviews: [], reviewed_trunk: '', rereview: '', ...extra });

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
  const state = { list: proposals, tasks, inflight, inflightError: null, inflightCalls: 0, now: 1_800_000_000_000, sessions: new Map(), busy: new Set(), created: [], sent: [], notices: [], children: [] };
  const deps = {
    dataDir: path.join(root, 'data'), home, noTimer: true, fallbackCwd: root, worktreeRoot: 'D:/AIWork', reviewMergeScript: script,
    now: () => state.now,
    run: (file, args, opts, cb) => { assert.deepEqual(args.slice(-1), ['list']); cb(null, JSON.stringify({ user: 'lintian-admin', proposals: state.list }), ''); },
    runTasks: (file, args, opts, cb) => {
      if (args[1] === 'inflight') {
        state.inflightCalls += 1;
        if (state.inflightError) cb(Object.assign(new Error('exit 2'), { code: 2 }), '', state.inflightError + '\n');
        else cb(null, JSON.stringify({ trunk: TRUNK, tasks: state.inflight, errors: [] }), '');
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
    sendPrompt: async (id, text) => { state.sent.push({ id, text }); return { ok: true, receipt: { status: 'confirmed' } }; },
    getSession: id => state.sessions.get(id) || null,
    isAgentTurnActive: id => state.busy.has(id),
    onNotify: n => state.notices.push(n),
  };
  const service = new WirelessAssistant(deps);
  t.after(() => { service.close(); setImmediate(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }); });
  return { service, state };
}
const flush = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise(r => setImmediate(r)); };

test('B 档：合并脚本把任务退回审查（批准保留）→ 标「回到审查」→ 自动换模型重审 → 审过后按新主干再合', async t => {
  const { service, state } = fixture(t, { proposals: [accepted('a1', 21)], tasks: [task(21, 'approved')] });
  await service.poll();
  assert.equal(state.children.length, 1);
  state.children[0].finish(0, '{\n  "pr": 21,\n  "state": "submitted",\n  "tier": "B",\n  "rereview": ["src/superran/channel/native.py"],\n  "trunk": "' + TRUNK + '"\n}\n');
  state.tasks = [task(21, 'submitted', { rereview: TRUNK, approval: { actor: 'lintian-admin' } })];
  await flush();
  const merge = service.status().jobs.find(j => j.type === 'merge');
  assert.equal(merge.state, 'done');
  assert.match(merge.note, /自动回到审查.*native\.py|native\.py.*自动回到审查/);
  assert.ok(state.notices.some(n => /回到审查/.test(n.title)));
  await service.poll();
  const review = service.status().jobs.find(j => j.type === 'review');
  assert.equal(review.state, 'working', '重审是新的一轮，不被上一轮记录挡住');
  assert.match(review.id, new RegExp(TRUNK.slice(0, 12)));
  const text = state.sent.at(-1).text;
  for (const part of ['自动重审', '--trunk <prepare 读回的 trunk>', 'merged_diff_command', '测试与 git 输出']) assert.ok(text.includes(part), part);
  // 重审通过、回到已批准：按审过的新主干开新一轮合入，不被上一轮合入记录挡住。
  state.tasks = [task(21, 'approved', { reviewed_trunk: TRUNK })];
  await service.poll(); await flush();
  assert.equal(state.children.length, 2);
  assert.deepEqual(state.children[1].args.slice(1), ['merge', '21', '--candidate', CAND]);
});

test('同一候选已有在办审查时不重复派审查（例如重审期间又读到一次）', async t => {
  const { service, state } = fixture(t, { proposals: [accepted('a1', 21)], tasks: [task(21, 'submitted')] });
  await service.poll();
  state.tasks = [task(21, 'submitted', { rereview: TRUNK })];
  await service.poll();
  assert.equal(service.status().jobs.filter(j => j.type === 'review').length, 1);
  assert.equal(state.created.length, 1);
});

test('C 档：合并脚本判冲突、标 stale → 写明和主干冲突、会退回返工', async t => {
  const { service, state } = fixture(t, { proposals: [accepted('a1', 21)], tasks: [task(21, 'approved')] });
  await service.poll();
  state.children[0].finish(0, '{\n  "pr": 21,\n  "state": "stale",\n  "tier": "C",\n  "reason": "和主干有冲突：src/superran/channel/kernel_id.py"\n}\n');
  state.tasks = [task(21, 'stale')];
  await flush();
  const merge = service.status().jobs.find(j => j.type === 'merge');
  assert.equal(merge.state, 'failed');
  assert.match(merge.note, /和主干冲突|和主干有冲突/);
  assert.match(merge.note, /退回常驻助理/);
});

test('开工前避撞：执行提示词列出在途 PR 正在改的红档文件；排除自己的 PR、已撤回提案的 PR 和没有提案的旧 PR', async t => {
  const { service, state } = fixture(t, {
    proposals: [proposal('n1', { pr_number: 30, result: '上次交付', note: '审查没通过' }), accepted('y1', 17), proposal('w1', { state: 'withdrawn', pr_number: 18 })],
    tasks: [task(17, 'submitted'), task(18, 'returned'), task(6, 'returned'), task(30, 'review_failed')],
    inflight: [
      { pr: 17, state: 'submitted', title: 'PR 17', red_files: ['src/superran/channel/native.py'] },
      { pr: 18, state: 'returned', title: 'PR 18', red_files: ['src/superran/csi/srs_resource.py'] },
      { pr: 6, state: 'returned', title: 'PR 6', red_files: ['src/superran/data/generate.py'] },
      { pr: 30, state: 'review_failed', title: 'PR 30', red_files: ['src/superran/sls/config.py'] },
      { pr: 19, state: 'submitted', title: 'PR 19', red_files: [] },
    ],
  });
  await service.poll();
  const impl = service.status().jobs.find(j => j.type === 'implement' && j.proposalId === 'n1');
  assert.equal(impl.state, 'working');
  const text = state.sent.find(s => s.id === impl.sessionId).text;
  assert.ok(text.includes('【在途改动（开工前避撞）】'));
  assert.ok(text.includes('PR #17（提案 y1）：src/superran/channel/native.py'));
  assert.ok(text.includes('等 PR #<号> 合入'));
  for (const other of ['srs_resource.py', 'generate.py', 'sls/config.py']) assert.ok(!text.includes(other), other);
  assert.deepEqual(impl.collisions, [17]);
});

test('读不到在途改动：照常派发，提示词不写避撞一段', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('n1')], tasks: [] });
  state.inflightError = '失败：网络不通';
  await service.poll();
  assert.equal(service.status().jobs[0].state, 'working');
  assert.ok(!state.sent[0].text.includes('在途改动'));
});

test('释放并写「等 PR #17 合入」：进入等待，不算失败；PR 合入后自动重新派发（新席位）', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('n1'), accepted('y1', 17)], tasks: [task(17, 'approved')] });
  await service.poll();
  const impl = service.status().jobs.find(j => j.type === 'implement');
  state.list = [proposal('n1', { state: 'implementing', executor: impl.slot }), accepted('y1', 17)];
  await service.poll();
  state.busy.delete(impl.sessionId);
  state.list = [proposal('n1', { note: '等 PR #17 合入：要改同一段 SRS 端口映射' }), accepted('y1', 17)];
  await service.poll();
  let job = service.job(impl.id);
  assert.equal(job.state, 'waiting');
  assert.equal(job.waitPr, 17);
  assert.match(job.note, /等 PR #17 合入/);
  assert.ok(state.notices.some(n => /等别的 PR 合入/.test(n.title)));
  const sessions = state.created.length;
  await service.poll();
  assert.equal(service.job(impl.id).state, 'waiting', 'PR 还在途就继续等');
  assert.equal(state.created.length, sessions);
  state.tasks = [task(17, 'completed')];
  await service.poll();
  job = service.job(impl.id);
  assert.equal(job.state, 'working', 'PR 合入后重新排队并派发');
  assert.equal(job.slot, 'wx-n1-2');
  assert.equal(state.created.length, sessions + 1);
});

test('等太久只提醒一次、不永久卡住；点「不等了，直接开工」立即派发', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('n1'), accepted('y1', 17)], tasks: [task(17, 'review_failed')] });
  await service.poll();
  const impl = service.status().jobs.find(j => j.type === 'implement');
  state.list = [proposal('n1', { state: 'implementing', executor: impl.slot }), accepted('y1', 17)];
  await service.poll();
  state.busy.delete(impl.sessionId);
  state.list = [proposal('n1', { note: '等 PR #17 合入：同一个函数' }), accepted('y1', 17)];
  await service.poll();
  assert.equal(service.job(impl.id).state, 'waiting');
  state.now += WAIT_REMIND_MS + 60000;
  await service.poll();
  await service.poll();
  const job = service.job(impl.id);
  assert.equal(job.state, 'waiting');
  assert.match(job.attention, /24 小时/);
  assert.equal(state.notices.filter(n => /等得有点久/.test(n.title)).length, 1, '只提醒一次');
  service.act(impl.id, 'retry');
  await flush(); await service.dispatching;
  assert.equal(service.job(impl.id).state, 'working');
});

test('等待中的提案被撤回或改了版本：不再等', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('n1'), accepted('y1', 17)], tasks: [task(17, 'submitted')] });
  await service.poll();
  const impl = service.status().jobs.find(j => j.type === 'implement');
  state.list = [proposal('n1', { state: 'implementing', executor: impl.slot }), accepted('y1', 17)];
  await service.poll();
  state.busy.delete(impl.sessionId);
  state.list = [proposal('n1', { note: '等 PR #17 合入' }), accepted('y1', 17)];
  await service.poll();
  state.list = [proposal('n1', { state: 'withdrawn' }), accepted('y1', 17)];
  await service.poll();
  assert.equal(service.job(impl.id).state, 'skipped');
});
