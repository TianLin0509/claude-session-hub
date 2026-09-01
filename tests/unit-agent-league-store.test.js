'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateDecision, validateHookReview, validateWeeklyReview } = require('../core/agent-league-accounting.js');
const { AgentLeagueStore, RUN_LEASE_TTL_MS, readMarkdownState } = require('../core/agent-league-store.js');

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-store-'));
  let tick = Date.parse('2026-08-27T00:00:00Z');
  const store = new AgentLeagueStore({ root, now: () => tick++ });
  try { return run(store, root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const philosophy = {
  key: 'chuxin-value-speculation', title: '初心基准·价值投机',
  summary: '基本面决定方向，估值和位置决定赔率。', edge: '等待未被价格充分反映的改善。',
  entry: '逻辑、预期差和位置同时成立。', exit: '逻辑证伪或定价透支。',
  horizon: '10-60 个交易日', forbidden: '不得追高。', provisional: true,
  checklist: [{ id: 'C1', text: '证据可追溯' }, { id: 'P1', text: '不追高' }, { id: 'R1', text: '仓位与证据匹配' }],
};

function decision(weight = 0.3, cash = 0.7) {
  return validateDecision({
    action_summary: weight ? '建立测试组合' : '保持现金',
    market_view: '盘前市场分歧仍大', core_conflict: '逻辑改善但价格位置一般',
    cash_target: cash,
    targets: weight ? [{
      symbol: '600001.SH', name: '测试股', target_weight: weight, conviction: 0.7, horizon_days: 20,
      rule_refs: ['C1', 'P1'], thesis: '改善证据存在', counter_evidence: '估值扩张较快',
      timing_reason: '只建与证据匹配的仓位', invalidation: '验证数据转弱',
    }] : [],
    watchlist: [], risk_notes: [], memory_note: '沿用等待纪律',
  });
}

function hook(draft) {
  return validateHookReview({
    verdict: 'PASS',
    rule_checks: [{ rule_id: 'P1', status: 'PASS', comment: '没有追高。' }],
    strongest_counter_evidence: '估值扩张可能领先业绩。', timing_check: '等待与买入已比较。',
    portfolio_check: '仓位与证据匹配。', behavior_check: '未受排名影响。', account_feasibility: '数量可按账户规则执行。',
    changes: [], final_decision: draft,
    daily_brief: {
      headline: '逻辑成立也不必重仓',
      body: '今天最重要的矛盾是改善逻辑与价格位置并不完全匹配。我保留了最强反证，并比较了立即买入、继续等待和保持现金。最终仓位没有因为排名或害怕错过而扩大；如果后续验证数据转弱，我会承认判断错误并退出。',
      hook_change: '自检后无变化，原预案已经符合个人规则。', video_hooks: ['不追高也是主动决策'],
    },
  }, { draft });
}

test('creates independent Markdown identity, checklist, weekly directory and 500k account', () => withStore((store) => {
  const row = store.createAgent({
    id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex',
    model: 'gpt-5.6-sol', philosophy,
  });
  for (const name of ['AGENT.md', 'SESSION.md', 'STRATEGY.md', 'CHECKLIST.md', 'PROMPT_DAILY.md', 'PROMPT_HOOK.md', 'PROMPT_WEEKLY.md', 'PORTFOLIO.md', 'TRADES.md', 'MEMORY.md', 'EVOLUTION.md', 'STATS.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    assert.equal(fs.existsSync(path.join(row.folder, name)), true, name);
  }
  assert.equal(fs.statSync(path.join(row.folder, 'weekly')).isDirectory(), true);
  assert.equal(row.stats.nav, 500000);
  assert.equal(row.agent.strategyPendingConfirmation, true);
  assert.equal(row.checklist.rules.length, 3);
  assert.match(fs.readFileSync(row.files.checklist, 'utf8'), /P1/);
}));

test('prompt workbench exposes every investment layer and atomically edits protected Markdown', () => withStore((store) => {
  const row = store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  let files = store.listPromptFiles('chuxin-baseline');
  assert.equal(files.length, 16);
  assert.equal(files.filter((file) => file.editable).length, 9);
  const agentFile = files.find((file) => file.key === 'agent');
  assert.equal(agentFile.content.includes('agent-league-state'), false, 'editor body should separate protected state');
  assert.equal(agentFile.machineState.id, 'chuxin-baseline');
  const edited = store.savePromptFile(
    'chuxin-baseline', 'agent', `${agentFile.content}\n\n## 我的补充原则\n\n不为排名改变投资方法。`, agentFile.sha256,
  );
  assert.match(edited.content, /不为排名改变投资方法/);
  assert.equal(readMarkdownState(row.files.agent).initialCash, 500000, 'protected metadata must survive body edits');
  assert.equal(fs.existsSync(row.files.promptHistory), true);
  assert.match(fs.readFileSync(row.files.promptHistory, 'utf8'), /AGENT\.md/);
  assert.throws(
    () => store.savePromptFile('chuxin-baseline', 'agent', edited.content, agentFile.sha256),
    error => error && error.code === 'prompt-file-conflict',
  );
  assert.throws(() => store.savePromptFile('chuxin-baseline', 'portfolio', 'tamper', ''), /只能查看/);
  assert.throws(() => store.savePromptFile('chuxin-baseline', '../outside', 'tamper', ''), /未知提示词文件/);
  files = store.listPromptFiles('chuxin-baseline');
  assert(files.find((file) => file.key === 'promptHistory').content.includes('AGENT.md'));
}));

test('CHECKLIST direct editing synchronizes rule IDs while keeping the machine block protected', () => withStore((store) => {
  const row = store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  const file = store.listPromptFiles('chuxin-baseline').find((item) => item.key === 'checklist');
  const next = [
    '# 决策检查表', '',
    '- **C1**：所有逻辑都必须有证据。',
    '- **P9**：价格位置不舒服时主动等待。', '',
    '## 变更规则', '', '周六提案、人工批准。',
  ].join('\n');
  const saved = store.savePromptFile('chuxin-baseline', 'checklist', next, file.sha256);
  assert.deepEqual(saved.machineState.rules.map((rule) => rule.id), ['C1', 'P9']);
  assert.deepEqual(store.getAgent('chuxin-baseline').checklist.rules.map((rule) => rule.id), ['C1', 'P9']);
  assert.match(fs.readFileSync(row.files.checklist, 'utf8'), /agent-league-state:v1/);
  assert.throws(() => store.savePromptFile('chuxin-baseline', 'checklist', '# 决策检查表\n\n没有结构化规则', saved.sha256), /至少保留一条/);
}));

test('persists ordinary Hub/native session binding in SESSION.md', () => withStore((store) => {
  store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  const bound = store.bindSession('chuxin-baseline', {
    hubSessionId: 'hub-1', status: 'active', nativeSession: { codexSid: 'codex-native-1' },
  });
  assert.equal(bound.session.hubSessionId, 'hub-1');
  assert.equal(bound.session.nativeSession.codexSid, 'codex-native-1');
  assert.equal(store.findByHubSessionId('hub-1').agent.id, 'chuxin-baseline');
}));

test('cross-Hub run lease permits one writer and reclaims stale owners', () => withStore((store, root) => {
  const second = new AgentLeagueStore({ root });
  const first = store.claimRunLease({ ownerHub: 'hub-a', runId: 'run-a' });
  assert.equal(first.ok, true);
  assert.equal(second.claimRunLease({ ownerHub: 'hub-b', runId: 'run-b' }).ok, false);
  assert.equal(second.renewRunLease(first.token), true);
  assert.equal(store.releaseRunLease(first.token), true);
  fs.writeFileSync(store.runLeasePath(), JSON.stringify({ token: 'stale', acquiredAt: Date.now() - RUN_LEASE_TTL_MS - 1000 }), 'utf8');
  const stale = new Date(Date.now() - RUN_LEASE_TTL_MS - 1000);
  fs.utimesSync(store.runLeasePath(), stale, stale);
  assert.equal(store.currentRunLease(), null);
}));

test('records DRAFT, Hook, FINAL and human-readable daily brief without daily strategy mutation', () => withStore((store) => {
  const row = store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  const before = fs.readFileSync(row.files.agent, 'utf8');
  const draft = decision();
  store.recordRunStart('chuxin-baseline', {
    runId: 'run-1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26', promptHash: 'draft-hash', snapshotPath: 'snapshot.md',
  });
  store.recordDraft('chuxin-baseline', {
    runId: 'run-1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26', draft, markdown: 'DRAFT RAW', hookPromptHash: 'hook-hash',
  });
  const checkedHook = hook(draft);
  const updated = store.recordDecision('chuxin-baseline', {
    runId: 'run-1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26',
    decision: checkedHook.final_decision, hook: checkedHook, dailyBrief: checkedHook.daily_brief, markdown: 'HOOK RAW',
  });
  const after = fs.readFileSync(row.files.agent, 'utf8');
  const daily = store.getDaily('chuxin-baseline', '2026-08-27');
  assert.equal(daily.status, 'decision-queued');
  assert.equal(daily.draft.targets[0].symbol, '600001.SH');
  assert.equal(daily.hook.verdict, 'PASS');
  assert.equal(daily.dailyBrief.headline, '逻辑成立也不必重仓');
  assert.equal(updated.portfolio.pendingDecision.decisionDate, '2026-08-27');
  assert.equal(updated.memory.candidates.length, 0, 'daily turn must not promote a new lesson');
  assert(before.includes('基本面决定方向') && after.includes('基本面决定方向'));
  assert.match(fs.readFileSync(store._dailyPath('chuxin-baseline', '2026-08-27'), 'utf8'), /DAILY BRIEF/);
}));

test('decision reliability keeps the latest attempt separate from the latest valid FINAL', () => withStore((store) => {
  store.createAgent({ id: 'truth-agent', name: '真相测试', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  const draft = decision();
  const checkedHook = hook(draft);
  store.recordRunStart('truth-agent', { runId: 'truth-valid', decisionDate: '2026-08-27', dataAsOf: '2026-08-26' });
  store.recordDraft('truth-agent', { runId: 'truth-valid', decisionDate: '2026-08-27', dataAsOf: '2026-08-26', draft });
  store.recordDecision('truth-agent', {
    runId: 'truth-valid', decisionDate: '2026-08-27', dataAsOf: '2026-08-26',
    decision: draft, hook: checkedHook, dailyBrief: checkedHook.daily_brief,
  });
  store.recordRunStart('truth-agent', { runId: 'truth-failed', decisionDate: '2026-08-28', dataAsOf: '2026-08-27' });
  store.recordRunFailure('truth-agent', {
    runId: 'truth-failed', decisionDate: '2026-08-28', dataAsOf: '2026-08-27',
    stage: 'draft', failureKind: 'technical-forfeit', error: 'provider output missing attempt identity',
  });

  const row = store.getAgent('truth-agent');
  assert.equal(row.latestDaily.decisionDate, '2026-08-28');
  assert.equal(row.latestDaily.status, 'failed');
  assert.equal(row.latestCompletedDaily.decisionDate, '2026-08-27');
  assert.equal(row.latestCompletedDaily.hook.verdict, 'PASS');
  assert.equal(row.decisionReliability.completedDecisions, 1);
  assert.equal(row.decisionReliability.failedDays, 1);
  assert.equal(row.decisionReliability.technicalForfeits, 1);
  assert.equal(row.decisionReliability.validRate, 0.5);
  assert.deepEqual(row.decisionReliability.recentDays.map((day) => day.decisionDate), ['2026-08-28', '2026-08-27']);
}));

test('replaying the same FINAL run repairs files without double-counting the decision', () => withStore((store) => {
  store.createAgent({ id: 'retry-agent', name: '重放测试', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  const finalDecision = decision();
  const finalHook = hook(finalDecision);
  const payload = {
    runId: 'stable-run-1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26',
    decision: finalDecision, hook: finalHook, dailyBrief: finalHook.daily_brief,
  };
  store.recordDecision('retry-agent', payload);
  store.recordDecision('retry-agent', payload);
  const row = store.getAgent('retry-agent');
  assert.equal(row.agent.decisionCount, 1);
  assert.equal(row.agent.lastDecisionRunId, 'stable-run-1');
  assert.equal(row.portfolio.pendingDecision.runId, 'stable-run-1');
  assert.equal(row.latestDaily.status, 'decision-queued');
}));

test('settles at same-day open, records result, and keeps deterministic Markdown ledger', () => withStore((store) => {
  store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  const draft = decision();
  const checkedHook = hook(draft);
  store.recordRunStart('chuxin-baseline', { runId: 'run-1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26' });
  store.recordDraft('chuxin-baseline', { runId: 'run-1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26', draft });
  store.recordDecision('chuxin-baseline', {
    runId: 'run-1', decisionDate: '2026-08-27', dataAsOf: '2026-08-26', decision: draft,
    hook: checkedHook, dailyBrief: checkedHook.daily_brief,
  });
  const open = {
    schemaVersion: 2, phase: 'open', snapshotId: 'open-1', decisionFor: '2026-08-27', asOf: '2026-08-27',
    prices: { '600001.SH': { name: '测试股', open: 10, close: 10.1, source: 'fixture' } }, candidates: [],
  };
  const settled = store.settleAgent('chuxin-baseline', open, { executionPriceField: 'open' });
  assert.equal(settled.settled, true);
  assert.equal(settled.agent.trades.rows[0].commission, 15);
  assert.equal(store.getDaily('chuxin-baseline', '2026-08-27').execution.trades.length, 1);
  const close = { ...open, phase: 'close', snapshotId: 'close-1', prices: { '600001.SH': { name: '测试股', open: 10, close: 10.5 } } };
  const marked = store.markAgent('chuxin-baseline', close, '2026-08-27');
  assert(marked.nav > 500000);
  assert(store.getDaily('chuxin-baseline', '2026-08-27').closeResult.nav > 500000);
  assert.match(fs.readFileSync(settled.agent.files.trades, 'utf8'), /BUY/);
}));

test('Saturday review alone updates memory and writes checklist proposal to EVOLUTION', () => withStore((store) => {
  const row = store.createAgent({ id: 'chuxin-baseline', name: '初心基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  store.recordWeeklyStart('chuxin-baseline', {
    runId: 'weekly-1', saturdayDate: '2026-08-29', tradingDates: ['2026-08-27', '2026-08-28'], promptHash: 'weekly-hash',
  });
  const review = validateWeeklyReview({
    summary: '本周保持了等待纪律。', process_win: '没有因上涨追入。', process_mistake: '一次仓位解释不充分。',
    lesson: '位置不舒服时等待是主动决策。', strongest_counterexample: '等待可能错失继续上涨。',
    evidence_for: ['两次等待'], evidence_against: ['一次踏空'],
    checklist_proposal: { rule_id: 'P1', old_rule: '不追高', proposed_rule: '写明等待触发条件', reason: '避免空泛', evidence: ['本周两次'] },
  });
  const updated = store.recordWeeklyReview('chuxin-baseline', {
    runId: 'weekly-1', saturdayDate: '2026-08-29', review, markdown: 'WEEKLY RAW',
  });
  assert.equal(updated.memory.candidates.length, 1);
  assert.equal(updated.evolution.proposals[0].status, 'proposed');
  assert.equal(updated.agent.weeklyReviewCount, 1);
  assert.equal(readMarkdownState(row.files.checklist).rules[1].text, '不追高', 'proposal must not auto-edit checklist');
  assert.match(fs.readFileSync(row.files.evolution, 'utf8'), /写明等待触发条件/);
}));

test('weekly replay after a partial file loss repairs the record without duplicate memory', () => withStore((store) => {
  const row = store.createAgent({ id: 'weekly-retry', name: '周复盘重放', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  const review = validateWeeklyReview({
    summary: '保持纪律。', process_win: '按规则执行。', process_mistake: '样本较少。',
    lesson: '重放必须幂等。', strongest_counterexample: '仍需更多样本。',
    evidence_for: ['一次'], evidence_against: ['样本少'], checklist_proposal: null,
  });
  const payload = { runId: 'weekly-stable-1', saturdayDate: '2026-08-29', review };
  store.recordWeeklyStart('weekly-retry', { runId: payload.runId, saturdayDate: payload.saturdayDate, tradingDates: [] });
  store.recordWeeklyReview('weekly-retry', payload);
  fs.unlinkSync(path.join(row.folder, 'weekly', '2026-08-29.md'));
  store.recordWeeklyReview('weekly-retry', payload);
  const repaired = store.getAgent('weekly-retry');
  assert.equal(repaired.agent.weeklyReviewCount, 1);
  assert.equal(repaired.agent.lastWeeklyRunId, 'weekly-stable-1');
  assert.equal(repaired.memory.candidates.filter((item) => item.runId === 'weekly-stable-1').length, 1);
  assert.equal(repaired.latestWeekly.status, 'completed');
}));

test('schedule migrates to P0 phases and exposes official calendar coverage', () => withStore((store) => {
  const schedule = store.getSchedule();
  assert.equal(schedule.decisionTime, '08:30');
  assert.equal(schedule.executionTime, '09:35');
  assert.equal(schedule.resultTime, '15:10');
  assert.equal(schedule.weeklyTime, '10:00');
  assert.equal(schedule.calendarCoverageEnd, '2026-12-31');
}));

test('open snapshot may append a late Agent symbol but can never rewrite frozen prices', () => withStore((store) => {
  const first = {
    schemaVersion: 2, phase: 'open', decisionFor: '2026-08-27', asOf: '2026-08-27', snapshotId: 'open-fixed',
    candidates: [], prices: { '600001.SH': { name: '甲', open: 10, close: 10.1 } },
  };
  store.saveSnapshot(first);
  store.saveSnapshot({ ...first, prices: { ...first.prices, '688001.SH': { name: '乙', open: 20, close: 20.2 } } }, { allowSupplement: true });
  assert.equal(Object.keys(store.getSnapshot('2026-08-27', 'open').prices).length, 2);
  assert.throws(() => store.saveSnapshot({
    ...first,
    prices: { '600001.SH': { name: '甲', open: 9.9, close: 10.1 } },
  }, { allowSupplement: true }), /不得改写/);
}));
