'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateDecision } = require('../core/agent-league-accounting.js');
const { AgentLeagueStore, RUN_LEASE_TTL_MS, readMarkdownState } = require('../core/agent-league-store.js');

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-store-'));
  let tick = Date.parse('2026-08-25T10:00:00Z');
  const store = new AgentLeagueStore({ root, now: () => tick++ });
  try { return run(store, root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const philosophy = {
  key: 'trend', title: '右侧趋势确认',
  summary: '只参与被市场确认且尚未明显耗竭的趋势。',
  edge: '趋势延续概率高于随机选择。',
  entry: '量价确认后进入。', exit: '结构破坏后退出。',
  horizon: '3-15 个交易日', forbidden: '不得追逐无量加速。',
};

test('creates a fully independent Markdown agent folder and provider instructions', () => withStore((store) => {
  const row = store.createAgent({
    id: 'wave-rider', name: '逐浪', provider: 'codex-cli', kind: 'codex',
    model: 'gpt-5.6-sol', philosophy, initialCash: 1_000_000,
  });
  for (const name of ['AGENT.md', 'SESSION.md', 'STRATEGY.md', 'PORTFOLIO.md', 'TRADES.md', 'MEMORY.md', 'EVOLUTION.md', 'STATS.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    assert.equal(fs.existsSync(path.join(row.folder, name)), true, name);
  }
  assert.equal(row.stats.nav, 1_000_000);
  assert.equal(row.stats.totalReturn, 0);
  assert.match(fs.readFileSync(row.files.agent, 'utf8'), /只参与被市场确认/);
  assert.match(fs.readFileSync(path.join(row.folder, 'AGENTS.md'), 'utf8'), /只能提交目标组合/);
}));

test('persists Hub/native session binding in SESSION.md', () => withStore((store) => {
  store.createAgent({ id: 'wave-rider', name: '逐浪', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  const bound = store.bindSession('wave-rider', {
    hubSessionId: 'hub-1', status: 'active', nativeSession: { codexSid: 'codex-native-1' },
  });
  assert.equal(bound.session.hubSessionId, 'hub-1');
  assert.equal(bound.session.nativeSession.codexSid, 'codex-native-1');
  assert.equal(store.findByHubSessionId('hub-1').agent.id, 'wave-rider');
}));

test('cross-Hub run lease permits one writer and reclaims stale owners', () => withStore((store, root) => {
  const second = new AgentLeagueStore({ root });
  const firstLease = store.claimRunLease({ ownerHub: 'hub-a', runId: 'run-a' });
  assert.equal(firstLease.ok, true);
  assert.equal(second.claimRunLease({ ownerHub: 'hub-b', runId: 'run-b' }).ok, false);
  assert.equal(second.renewRunLease(firstLease.token), true);
  assert.equal(store.releaseRunLease(firstLease.token), true);
  const secondLease = second.claimRunLease({ ownerHub: 'hub-b', runId: 'run-b' });
  assert.equal(secondLease.ok, true);
  assert.equal(second.releaseRunLease(secondLease.token), true);

  fs.writeFileSync(store.runLeasePath(), JSON.stringify({
    token: 'stale', ownerHub: 'dead', acquiredAt: Date.now() - RUN_LEASE_TTL_MS - 1000,
  }), 'utf8');
  const staleTime = new Date(Date.now() - RUN_LEASE_TTL_MS - 1000);
  fs.utimesSync(store.runLeasePath(), staleTime, staleTime);
  assert.equal(store.currentRunLease(), null);
  assert.equal(fs.existsSync(store.runLeasePath()), false);
}));

test('records daily evolution without rewriting the frozen philosophy', () => withStore((store) => {
  const created = store.createAgent({ id: 'wave-rider', name: '逐浪', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  const before = fs.readFileSync(created.files.agent, 'utf8');
  const checked = validateDecision({
    action_summary: '测试决策', market_view: '测试市场', cash_target: 0.7,
    targets: [{ symbol: '600001.SH', name: '测试股', target_weight: 0.3, conviction: 0.7, horizon_days: 10, thesis: '逻辑', invalidation: '失效' }],
    risk_notes: [], reflection: { kept: '纪律', mistake: '过早', lesson_candidate: '等待量价确认', evidence_for: ['样本1'], evidence_against: [] },
    strategy_proposal: { hypothesis: '过滤弱突破', proposed_change: '提高成交量门槛', success_metric: '回撤下降', expires_after_days: 10 },
  }, { allowedSymbols: new Set(['600001.SH']) });
  const row = store.recordDecision('wave-rider', {
    runId: 'run-1', asOf: '2026-08-25', decision: checked, markdown: '原始回复', promptHash: 'abc',
  });
  const after = fs.readFileSync(created.files.agent, 'utf8');
  assert.match(after, /只参与被市场确认/);
  assert.equal(row.agent.decisionCount, 1);
  assert.equal(row.agent.evolutionDays, 1);
  assert.equal(row.memory.candidates.length, 1);
  assert.equal(row.evolution.proposals.length, 1);
  assert.equal(row.portfolio.pendingDecision.decisionAsOf, '2026-08-25');
  assert.equal(fs.existsSync(path.join(row.folder, 'daily', '2026-08-25.md')), true);
  assert.equal(readMarkdownState(row.files.agent).decisionCount, 1);
  assert(before.includes('只参与被市场确认') && after.includes('只参与被市场确认'));
}));

test('freezes snapshots and settles queued decisions into Markdown stats and trades', () => withStore((store) => {
  store.createAgent({ id: 'wave-rider', name: '逐浪', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol', philosophy });
  const snapshotA = {
    schemaVersion: 1, snapshotId: 'snap-a', asOf: '2026-08-25', createdAt: '2026-08-25T10:00:00Z',
    candidates: [{ symbol: '600001.SH', name: '测试股', mode: 'chase', score: 90, close: 10, summary: '测试' }],
    prices: { '600001.SH': { name: '测试股', close: 10, source: 'fixture' } },
  };
  store.saveSnapshot(snapshotA);
  const checked = validateDecision({
    action_summary: '测试', market_view: '测试', cash_target: 0.7,
    targets: [{ symbol: '600001.SH', name: '测试股', target_weight: 0.3, thesis: '逻辑', invalidation: '失效' }],
    reflection: { kept: '保持纪律', mistake: '无', lesson_candidate: '继续验证' }, risk_notes: [],
  }, { allowedSymbols: new Set(['600001.SH']) });
  store.recordDecision('wave-rider', { runId: 'run-1', asOf: '2026-08-25', decision: checked, markdown: 'reply' });
  const result = store.settleAgent('wave-rider', {
    schemaVersion: 1, snapshotId: 'snap-b', asOf: '2026-08-26',
    prices: { '600001.SH': { name: '测试股', close: 10, source: 'fixture' } }, candidates: [],
  });
  assert.equal(result.settled, true);
  assert.equal(result.agent.trades.rows.length, 1);
  assert.equal(result.agent.stats.tradeCount, 1);
  assert.equal(result.agent.portfolio.pendingDecision, null);
  assert.match(fs.readFileSync(result.agent.files.trades, 'utf8'), /BUY/);
  assert.match(fs.readFileSync(result.agent.files.stats, 'utf8'), /最大回撤/);
}));
