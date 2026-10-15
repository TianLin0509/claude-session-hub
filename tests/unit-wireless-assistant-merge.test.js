'use strict';
// 无线 Tab · SuperRAN 助理的审批合入一段（2026-10-15）：提出人验收后换一家模型独立审查；
// 审批人批准且审查通过后，助理跑合并脚本（一次一个）；退回的旧提案也能被接手返工。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WirelessAssistant, STALL_MS } = require('../core/wireless-assistant/service');

const CAND = 'c'.repeat(40), BASE = 'b'.repeat(40), CAND2 = 'd'.repeat(40);
function proposal(id, extra = {}) {
  return { id, title: '提案 ' + id, author: 'member:Zee', state: 'accepted', executor: '', content_revision: 1,
    content_sha: id.padEnd(64, '0'), result: '', note: '', markdown: '📌 **结论**\n红灯测试：断言速率。', ...extra };
}
const accepted = (id, pr, extra = {}) => proposal(id, { state: 'reported', executor: 'wx-' + id + '-1', result: '📌 已修改', outcome: 'modified', pr_number: pr, acceptance_view: { state: 'lead' }, ...extra });
const task = (pr, state, extra = {}) => ({ pr, state, revision: 2, candidate: CAND, base: BASE, title: 'PR ' + pr, reviews: [], ...extra });

function fixture(t, { proposals = [], tasks = [], settings, dataDir } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wireless-merge-'));
  const home = path.join(root, 'home'), kit = path.join(home, '.superran', 'agent-kit', 'abc123');
  fs.mkdirSync(kit, { recursive: true });
  for (const f of ['superran-proposals.json', 'superran-proposals.py']) fs.writeFileSync(path.join(kit, f), '{}');
  fs.writeFileSync(path.join(kit, 'kit.json'), JSON.stringify({ user: 'lintian-admin', url: 'https://ai.lt-stockpartner.tech/superran-dev', expires: Math.floor(Date.now() / 1000) + 86400 * 20 }));
  const repo = path.join(root, 'SuperRAN'); fs.mkdirSync(repo);
  fs.mkdirSync(path.join(home, '.config', 'superran'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'superran', 'local-installation.json'), JSON.stringify({ root: repo, python: process.execPath, executor_config: path.join(kit, 'superran-proposals.json'), executor_user: 'lintian-admin' }));
  const script = path.join(root, 'skills', 'superran-review-merge', 'scripts', 'review_merge.py');
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, '');
  const state = { list: proposals, tasks, now: 1_800_000_000_000, sessions: new Map(), busy: new Set(), created: [], sent: [], notices: [], children: [], taskError: null };
  const deps = {
    dataDir: dataDir || path.join(root, 'data'), home, noTimer: true, fallbackCwd: root, worktreeRoot: 'D:/AIWork', reviewMergeScript: script,
    now: () => state.now,
    run: (file, args, opts, cb) => { assert.deepEqual(args.slice(-1), ['list']); cb(null, JSON.stringify({ user: 'lintian-admin', proposals: state.list }), ''); },
    runTasks: (file, args, opts, cb) => {
      assert.deepEqual(args, [script, 'status']);
      if (state.taskError) cb(Object.assign(new Error('exit 1'), { code: 1 }), '', state.taskError + '\n');
      else cb(null, JSON.stringify({ trunk: BASE, tasks: state.tasks }), '');
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
  if (settings) service.setSettings(settings);
  // 重启用例里两个实例共用数据目录：后关的那个还开着库，删除放到最后、失败不算用例失败。
  t.after(() => { service.close(); if (!dataDir) setImmediate(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }); });
  return { service, state, deps, root };
}
const flush = () => new Promise(r => setImmediate(r));

test('提出人验收后：另开会话、换一家模型审查（实现是 Codex 就用 Claude），提示词带 prepare / record', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('a1')] });
  await service.poll();
  assert.equal(state.created[0].kind, 'codex', '实现用主力 Codex');
  const impl = service.status().jobs[0];
  state.list = [accepted('a1', 21, { executor: impl.slot })];
  state.tasks = [task(21, 'submitted')];
  await service.poll();
  const review = service.status().jobs.find(j => j.type === 'review');
  assert.equal(review.state, 'working');
  assert.equal(review.slot, 'wr-21-1');
  const created = state.created.at(-1);
  assert.equal(created.kind, 'claude');
  assert.equal(created.opts.model, 'claude-opus-5-5');
  assert.equal(created.opts.wirelessProposal.role, 'review');
  const text = state.sent.at(-1).text;
  for (const part of ['审查 PR #21', 'prepare 21', 'record 21 --candidate ' + CAND, '常驻助理 wr-21-1', '不批准、不合并', '一次列全']) assert.ok(text.includes(part), part);
});

test('还没验收、或不是提案带来的 PR：不审查', async t => {
  const { service, state } = fixture(t, {
    proposals: [accepted('a1', 21, { acceptance_view: { state: 'pending' } })],
    tasks: [task(21, 'submitted'), task(30, 'submitted')],
  });
  await service.poll();
  assert.equal(service.status().jobs.filter(j => j.type === 'review').length, 0);
  assert.equal(state.created.length, 0);
});

test('审查回写后跟进：通过 → 等批准；没通过 → 已退回返工；都会通知', async t => {
  const { service, state } = fixture(t, { proposals: [accepted('a1', 21), accepted('b2', 22)], tasks: [task(21, 'submitted'), task(22, 'submitted', { candidate: CAND2 })] });
  await service.poll();
  assert.equal(service.status().jobs.filter(j => j.type === 'review' && j.state === 'working').length, 2);
  state.tasks = [task(21, 'awaiting_approval'), task(22, 'review_failed', { candidate: CAND2 })];
  await service.poll();
  const jobs = service.status().jobs.filter(j => j.type === 'review');
  assert.match(jobs.find(j => j.pr === 21).note, /审查通过，等审批人批准/);
  assert.match(jobs.find(j => j.pr === 22).note, /审查没通过/);
  assert.ok(state.notices.some(n => /审查完成/.test(n.title)) && state.notices.some(n => /审查没通过/.test(n.title)));
});

test('主力和替补是同一家、实现也是它：不降级成同一家审查，标失败并说明怎么改', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('a1')], settings: { fallback: { kind: 'codex', model: 'gpt-6-astra', effort: 'max' } } });
  await service.poll();
  state.list = [accepted('a1', 21, { executor: service.status().jobs[0].slot })];
  state.tasks = [task(21, 'submitted')];
  await service.poll();
  const review = service.status().jobs.find(j => j.type === 'review');
  assert.equal(review.state, 'failed');
  assert.match(review.note, /没法换模型审查/);
  assert.equal(state.created.length, 1, '只开了实现会话');
});

test('审查会话停下却没回写：30 分钟后标「没跑起来」', async t => {
  const { service, state } = fixture(t, { proposals: [accepted('a1', 21)], tasks: [task(21, 'submitted')] });
  await service.poll();
  const review = service.status().jobs.find(j => j.type === 'review');
  state.busy.delete(review.sessionId); state.sessions.get(review.sessionId).status = 'idle';
  service.watch();
  state.now += STALL_MS + 60000;
  await service.poll();
  assert.equal(service.status().jobs.find(j => j.type === 'review').state, 'stalled');
});

test('批准且审查通过：跑合并脚本，一次一个；合完标已合入并通知', async t => {
  const { service, state } = fixture(t, { proposals: [accepted('a1', 21), accepted('b2', 22)], tasks: [task(21, 'approved'), task(22, 'approved', { candidate: CAND2 })] });
  await service.poll();
  assert.equal(state.children.length, 1, '完整测试占整机，一次只合一个');
  assert.deepEqual(state.children[0].args.slice(1), ['merge', '21', '--candidate', CAND]);
  assert.equal(service.status().jobs.find(j => j.pr === 21).state, 'running');
  assert.equal(state.created.length, 0, '合入不开会话、不调用模型');
  state.children[0].finish(0, 'log line\n{\n  "pr": 21,\n  "state": "completed",\n  "merged": "' + 'e'.repeat(40) + '"\n}\n');
  await flush(); await flush();
  const done = service.status().jobs.find(j => j.pr === 21);
  assert.equal(done.state, 'done');
  assert.match(done.note, /已合入 develop（eeeeeeee）/);
  assert.ok(fs.readFileSync(done.logFile, 'utf8').includes('log line'));
  assert.ok(state.notices.some(n => /已合入/.test(n.title)));
  assert.equal(state.children.length, 2, '第一个合完接着合下一个');
  assert.deepEqual(state.children[1].args.slice(1), ['merge', '22', '--candidate', CAND2]);
});

test('合入失败如实标出原因；点重来再跑', async t => {
  const { service, state } = fixture(t, { proposals: [accepted('a1', 21)], tasks: [task(21, 'approved')] });
  await service.poll();
  state.children[0].finish(1, '', 'Traceback...\n合入未完成：test_system 未通过\n');
  await flush(); await flush(); await flush();
  const failed = service.status().jobs.find(j => j.type === 'merge');
  assert.equal(failed.state, 'failed');
  assert.match(failed.note, /test_system 未通过。网络或环境问题/);
  assert.doesNotMatch(failed.note, /。。/);
  assert.ok(state.notices.some(n => /合入未完成/.test(n.title)));
  service.act(failed.id, 'retry');
  await flush(); await flush();
  assert.equal(state.children.length, 2);
});

test('Hub 重启时合入可能仍在后台：标「后台核对中」，不重跑、不开新合入；协作台显示已合入就收尾', async t => {
  const first = fixture(t, { proposals: [accepted('a1', 21), accepted('b2', 22)], tasks: [task(21, 'merging'), task(22, 'approved', { candidate: CAND2 })] });
  await first.service.poll();
  assert.equal(first.state.children.length, 1);
  first.service.close();
  const second = fixture(t, { proposals: [accepted('a1', 21), accepted('b2', 22)], tasks: [task(21, 'merging'), task(22, 'approved', { candidate: CAND2 })], dataDir: first.deps.dataDir });
  await second.service.poll();
  const job = () => second.service.status().jobs.find(j => j.type === 'merge' && j.pr === 21);
  assert.equal(job().state, 'detached');
  assert.equal(second.state.children.length, 0, '后台可能还在合：不重跑，也不开下一个合入');
  second.state.tasks = [task(21, 'completed'), task(22, 'approved', { candidate: CAND2 })];
  await second.service.poll();
  assert.equal(job().state, 'done');
  assert.match(job().note, /Hub 重启期间在后台完成/);
  await flush();
  assert.equal(second.state.children.length, 1, '收尾后接着合下一个');
});

test('后台核对超过合入时限仍没完成：标失败，提示点重来', async t => {
  const first = fixture(t, { proposals: [accepted('a1', 21)], tasks: [task(21, 'merging')] });
  await first.service.poll();
  first.service.close();
  const second = fixture(t, { proposals: [accepted('a1', 21)], tasks: [task(21, 'merging')], dataDir: first.deps.dataDir });
  second.state.now = first.state.now + 91 * 60000;
  await second.service.poll();
  const job = second.service.status().jobs.find(j => j.type === 'merge');
  assert.equal(job.state, 'failed');
  assert.match(job.note, /超过时限/);
});

test('审查超过半小时、交完结论才停下：等读回协作台再判断，不误报「没跑起来」', async t => {
  const { service, state } = fixture(t, { proposals: [accepted('a1', 21)], tasks: [task(21, 'submitted')] });
  await service.poll();
  const review = service.status().jobs.find(j => j.type === 'review');
  state.now += 40 * 60000;
  state.tasks = [task(21, 'awaiting_approval')];
  state.busy.delete(review.sessionId); state.sessions.get(review.sessionId).status = 'idle';
  service.watch();
  assert.equal(service.status().jobs.find(j => j.type === 'review').state, 'working', '手上的还是旧状态，不判卡住');
  await service.poll();
  const done = service.status().jobs.find(j => j.type === 'review');
  assert.equal(done.state, 'done');
  assert.match(done.note, /审查通过/);
});

test('读会话默认配置出错也算主力没开起来，换替补', async t => {
  const { service, state, deps } = fixture(t, { proposals: [proposal('a1')] });
  const original = deps.getDefaults;
  deps.getDefaults = async kind => { if (kind === 'codex') throw new Error('读不到 Codex 配置'); return original(kind); };
  await service.poll();
  const job = service.status().jobs[0];
  assert.equal(job.state, 'working');
  assert.equal(job.route, 'fallback');
  assert.equal(state.created.at(-1).kind, 'claude');
});

test('合入在跑时不派审查（合并机目录在试合并中），合完再派', async t => {
  const { service, state } = fixture(t, { proposals: [accepted('a1', 21), accepted('b2', 22)], tasks: [task(21, 'approved'), task(22, 'submitted', { candidate: CAND2 })] });
  await service.poll();
  assert.equal(state.children.length, 1);
  assert.equal(service.status().jobs.find(j => j.type === 'review').state, 'queued');
  state.children[0].finish(0, JSON.stringify({ pr: 21, state: 'completed', merged: 'e'.repeat(40) }, null, 2) + String.fromCharCode(10));
  await flush(); await flush(); await flush();
  assert.equal(service.status().jobs.find(j => j.type === 'review').state, 'working');
});

test('完整测试没过、协作台已标合入未完成：提示审批人退回返工，不叫你点重来', async t => {
  const { service, state } = fixture(t, { proposals: [accepted('a1', 21)], tasks: [task(21, 'approved')] });
  await service.poll();
  state.tasks = [task(21, 'merge_failed')];
  state.children[0].finish(1, '', '合入未完成：python 未通过；保留现场，详细证据在合并机私有日志。\n');
  await flush(); await flush(); await flush();
  const failed = service.status().jobs.find(j => j.type === 'merge');
  assert.match(failed.note, /审批人在第 4 步看原因/);
  assert.doesNotMatch(failed.note, /点「重来」/);
});

test('v2.6 退回时留下旧席位的提案：照样接手返工，新席位不撞名，也不会被误判为已释放', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('a1', { executor: 'wx-a1-1', result: '📌 已修改', note: '回归没跑全', pr_number: 21 })] });
  await service.poll();
  const job = service.status().jobs[0];
  assert.equal(job.state, 'working');
  assert.equal(job.slot, 'wx-a1-2');
  assert.match(state.sent[0].text, /沿用同一个分支和 PR/);
  await service.poll();
  assert.equal(service.status().jobs[0].state, 'working', '旧席位不算本次接手');
});

test('代码交付记录读不到：照常自动实现，审查与合入暂停并写明原因', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('a1')] });
  state.taskError = '协作台返回 401';
  await service.poll();
  assert.equal(state.created.length, 1);
  assert.match(service.status().last.taskError, /401/);
});
