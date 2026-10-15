'use strict';
// 无线 Tab · SuperRAN 助理：读协作台 → 排队 → 每个提案新开会话 → 主力失败换替补 → 跟进交付。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WirelessAssistant, STALL_MS } = require('../core/wireless-assistant/service');
const { scanProposal } = require('../core/wireless-assistant/risk');
const { buildExecutionPrompt } = require('../core/wireless-assistant/prompt');

function proposal(id, extra = {}) {
  return { id, title: '提案 ' + id, author: 'member:Zee', state: 'accepted', executor: '', content_revision: 1,
    content_sha: id.padEnd(64, '0'), result: '', note: '', markdown: '📌 **结论**\n## 给人看\n红灯测试：断言 2T4R 速率高于 1T4R。', ...extra };
}

function fixture(t, { proposals, createSession, settings } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wireless-'));
  const home = path.join(root, 'home'), kit = path.join(home, '.superran', 'agent-kit', 'abc123');
  fs.mkdirSync(kit, { recursive: true });
  fs.writeFileSync(path.join(kit, 'superran-proposals.json'), '{}');
  fs.writeFileSync(path.join(kit, 'superran-proposals.py'), '');
  fs.writeFileSync(path.join(kit, 'kit.json'), JSON.stringify({ user: 'lintian-admin', url: 'https://ai.lt-stockpartner.tech/superran-dev', expires: Math.floor(Date.now() / 1000) + 86400 * 20 }));
  const repo = path.join(root, 'SuperRAN'); fs.mkdirSync(repo);
  fs.mkdirSync(path.join(home, '.config', 'superran'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'superran', 'local-installation.json'), JSON.stringify({ root: repo, executor_config: path.join(kit, 'superran-proposals.json'), executor_user: 'lintian-admin' }));
  const state = { list: proposals || [], now: 1_800_000_000_000, sessions: new Map(), busy: new Set(), created: [], sent: [], notices: [], runs: 0 };
  const service = new WirelessAssistant({
    dataDir: path.join(root, 'data'), home, noTimer: true, fallbackCwd: root, worktreeRoot: 'D:/AIWork',
    now: () => state.now,
    run: (file, args, opts, cb) => { state.runs++; assert.deepEqual(args.slice(-1), ['list']); assert.ok(args.includes('-I')); cb(null, JSON.stringify({ user: 'lintian-admin', proposals: state.list }), ''); },
    getDefaults: async kind => ({ model: kind === 'codex' ? 'gpt-6-luna' : 'claude-sonnet-5-5', effort: 'high', mcpProfile: 'none', ...(kind === 'codex' ? { codexSpeedTier: 'fast' } : {}) }),
    createSession: async (kind, opts) => {
      if (createSession) await createSession(kind, opts);
      const s = { id: opts.id, kind, purpose: opts.purpose, status: 'running' };
      state.sessions.set(opts.id, s); state.created.push({ kind, opts }); state.busy.add(opts.id); return s;
    },
    sendPrompt: async (id, text) => { state.sent.push({ id, text }); return { ok: true, receipt: { status: 'confirmed' } }; },
    getSession: id => state.sessions.get(id) || null,
    isAgentTurnActive: id => state.busy.has(id),
    onNotify: n => state.notices.push(n),
  });
  if (settings) service.setSettings(settings);
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, state };
}

test('已推进、无人接手的提案：每个新开一个会话，主力 GPT-6 Astra · 最高 · 标准速度，同时最多 2 个', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('a1'), proposal('b2'), proposal('c3'), proposal('d4', { state: 'submitted' }), proposal('e5', { state: 'implementing', executor: 'someone' })] });
  await service.poll();
  assert.equal(state.created.length, 2);
  for (const { kind, opts } of state.created) {
    assert.equal(kind, 'codex');
    assert.equal(opts.model, 'gpt-6-astra');
    assert.equal(opts.effort, 'max');
    assert.equal(opts.codexSpeedTier, 'standard');
    assert.equal(opts.purpose, 'wireless-proposal');
    assert.equal(opts.autonomous, true);
    assert.ok(opts.cwd.endsWith('SuperRAN'));
  }
  assert.notEqual(state.created[0].opts.id, state.created[1].opts.id, '每个提案一个会话');
  const s = service.status();
  assert.deepEqual(s.jobs.filter(j => j.state === 'working').map(j => j.proposalId).sort(), ['a1', 'b2']);
  assert.deepEqual(s.jobs.filter(j => j.state === 'queued').map(j => j.proposalId), ['c3']);
  const text = state.sent[0].text;
  assert.match(text, /编号 a1/);
  assert.match(text, /--slot wx-a1-1/);
  assert.match(text, new RegExp('\\[SuperRAN proposal:a1:' + 'a1'.padEnd(64, '0') + '\\]'));
  assert.match(text, /安全底线/);
  assert.doesNotMatch(text, /srk_/, '接入包已在本机，不带一次性接入码');
  // 再查一次不会重复派发。
  await service.poll();
  assert.equal(state.created.length, 2);
});

test('主力开不起来就换替补 Opus 5.5 · 最高', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('a1')], createSession: async kind => { if (kind === 'codex') throw new Error('Codex 额度用完'); } });
  await service.poll();
  const job = service.status().jobs[0];
  assert.equal(job.state, 'working');
  assert.equal(job.route, 'fallback');
  assert.equal(state.created.at(-1).kind, 'claude');
  assert.equal(state.created.at(-1).opts.model, 'claude-opus-5-5');
  assert.equal(state.created.at(-1).opts.effort, 'max');
  assert.equal(job.attempts.length, 2);
  assert.match(job.attempts[0].error, /额度用完/);
});

test('主力会话停下却没接手：30 分钟后换替补重来；替补也没接手就标「没跑起来」并通知', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('a1')] });
  await service.poll();
  const first = service.status().jobs[0];
  state.busy.delete(first.sessionId); state.sessions.get(first.sessionId).status = 'idle';
  service.watch();
  state.now += STALL_MS + 60000;
  await service.poll();
  const second = service.status().jobs[0];
  assert.equal(second.route, 'fallback');
  assert.equal(second.state, 'working');
  assert.notEqual(second.sessionId, first.sessionId);
  state.busy.delete(second.sessionId); state.sessions.get(second.sessionId).status = 'idle';
  service.watch();
  state.now += STALL_MS + 60000;
  await service.poll();
  assert.equal(service.status().jobs[0].state, 'stalled');
  assert.ok(state.notices.some(n => /没跑起来/.test(n.title)));
});

test('跟进：交付后标已交付并通知；被别人接手的排队提案不再处理', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('a1'), proposal('b2'), proposal('c3')] });
  await service.poll();
  const a = service.status().jobs.find(j => j.proposalId === 'a1');
  state.list = [proposal('a1', { state: 'implementing', executor: a.slot }), proposal('b2'), proposal('c3', { state: 'implementing', executor: 'codex1-manual' })];
  await service.poll();
  assert.equal(service.status().jobs.find(j => j.proposalId === 'a1').claimed, true);
  assert.equal(service.status().jobs.find(j => j.proposalId === 'c3').state, 'skipped');
  state.list[0] = proposal('a1', { state: 'reported', executor: a.slot, outcome: 'modified', pr_number: 14 });
  await service.poll();
  const done = service.status().jobs.find(j => j.proposalId === 'a1');
  assert.equal(done.state, 'done');
  assert.match(done.note, /PR #14/);
  assert.ok(state.notices.some(n => /已交付/.test(n.title) && n.sessionId === a.sessionId));
});

test('接手后又释放（如测试异议）：标已释放，同一版本不再自动重派；提出人修订后按新版本重新排队', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('a1')] });
  await service.poll();
  const job = service.status().jobs[0];
  state.list = [proposal('a1', { state: 'implementing', executor: job.slot })];
  await service.poll();
  state.list = [proposal('a1', { note: '测试异议：期望与 38.901 矛盾' })];
  await service.poll();
  assert.equal(service.status().jobs[0].state, 'released');
  assert.equal(state.created.length, 1);
  state.list = [proposal('a1', { content_sha: 'f'.repeat(64), content_revision: 2 })];
  await service.poll();
  assert.equal(state.created.length, 2);
});

test('退回返工的提案（已推进且带上次交付）按新一轮派发，提示词写明退回意见', async t => {
  const { state, service } = fixture(t, { proposals: [proposal('a1', { result: '📌 已修改', note: '回归没跑全' })] });
  await service.poll();
  assert.match(state.sent[0].text, /上次交付被退回，退回意见：回归没跑全/);
  assert.equal(service.status().jobs[0].returned, true);
});

test('正文含删除、上传或读凭据的提案先停在「待你放行」，放行后才派发', async t => {
  const risky = proposal('r1', { markdown: '红灯测试：\n```python\nimport shutil\nshutil.rmtree("C:/Users")\n```' });
  const { service, state } = fixture(t, { proposals: [risky] });
  await service.poll();
  assert.equal(state.created.length, 0);
  const held = service.status().jobs[0];
  assert.equal(held.state, 'held');
  assert.match(held.risks[0].why, /删除/);
  assert.ok(state.notices.some(n => /待你放行/.test(n.title)));
  service.act(held.id, 'approve');
  await service.dispatchQueued();
  assert.equal(state.created.length, 1);
});

test('自动接手关闭时只列出、不派发；设置校验模型与深度', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('a1')], settings: { enabled: false } });
  await service.poll();
  assert.equal(state.created.length, 0);
  assert.equal(service.status().jobs[0].state, 'queued');
  assert.throws(() => service.setSettings({ maxParallel: 9 }), /1–4/);
  assert.throws(() => service.setSettings({ primary: { kind: 'codex', model: 'no-such-model' } }), /没有模型/);
  service.setSettings({ enabled: true });
  await service.dispatchQueued();
  assert.equal(state.created.length, 1);
});

test('协作台读不到时如实记录原因，不派发', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('a1')] });
  service.deps.run = (file, args, opts, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), '', '服务返回 401：凭据失效\n');
  await service.poll();
  assert.match(service.status().last.error, /401/);
  assert.equal(state.created.length, 0);
});

test('安全预检不误伤普通无线提案；提示词保留协作台执行步骤', () => {
  assert.deepEqual(scanProposal({ markdown: '修正 CDL 簇内射线角度；pytest tests/test_physics_invariants.py -k cdl；token bucket 调度不变' }), []);
  assert.ok(scanProposal({ markdown: 'cat ~/.ssh/id_rsa' }).length);
  const text = buildExecutionPrompt(proposal('a1'), { install: { user: 'lintian-admin', site: 'https://x/superran-dev/', kitDir: 'C:/k' }, slot: 'wx-a1-1', day: '20261014' });
  for (const part of ['superran-ready.py --expected-user "lintian-admin"', 'claim a1 --slot wx-a1-1', '测试异议', 'progress a1 --action report --outcome modified', '你只提交候选，不验收、不批准、不合入', 'D:/AIWork/20261014-superran-a1-wx-a1-1']) assert.ok(text.includes(part), part);
});

test('同一轮发现的多份提案按协作台列表顺序排队', async t => {
  const { service, state } = fixture(t, { proposals: [proposal('b2'), proposal('a1'), proposal('c3')], settings: { maxParallel: 1 } });
  await service.poll();
  assert.equal(state.created.length, 1);
  assert.match(state.sent[0].text, /编号 b2/);
  assert.deepEqual(service.status().jobs.filter(j => j.state === 'queued').map(j => j.order).sort(), [1, 2]);
});
