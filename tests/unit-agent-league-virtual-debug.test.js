'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentLeagueStore } = require('../core/agent-league-store.js');
const {
  AgentLeagueVirtualDebug,
  VIRTUAL_DEBUG_DIRNAME,
} = require('../core/agent-league-virtual-debug.js');
const { nextTradingDay, previousTradingDay } = require('../core/agent-league-calendar.js');
const { getPhilosophy } = require('../core/agent-league-philosophies.js');

test('official calendar resolves a weekend decision to Monday and preserves the prior Friday', () => {
  assert.equal(nextTradingDay('2026-08-29'), '2026-08-31');
  assert.equal(previousTradingDay('2026-08-31'), '2026-08-28');
  assert.equal(nextTradingDay('2026-09-25'), '2026-09-28', 'official holiday must be skipped');
});

test('virtual debug clones Agent prompts into an isolated deterministic sandbox', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-virtual-unit-'));
  try {
    const live = new AgentLeagueStore({ root });
    live.createAgent({
      id: 'live-baseline', name: '正式基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol',
      philosophy: getPhilosophy('chuxin-value-speculation'),
    });
    const prompt = live.listPromptFiles('live-baseline').find((row) => row.key === 'dailyPrompt');
    live.savePromptFile('live-baseline', 'dailyPrompt', `${prompt.content}\n- LIVE-PROMPT-MARKER`, prompt.sha256);

    const lab = new AgentLeagueVirtualDebug({
      liveStore: live,
      now: () => new Date('2026-08-29T04:00:00.000Z').getTime(),
    });
    const state = lab.initialize({ scenario: 'mixed' });
    assert.equal(state.virtualDate, '2026-08-31');
    assert.equal(state.phase, 'pre-market');
    assert.equal(path.basename(state.root), VIRTUAL_DEBUG_DIRNAME);
    assert.equal(lab.store.listAgents().length, 1);
    assert.match(lab.store.listPromptFiles('live-baseline').find((row) => row.key === 'dailyPrompt').content, /LIVE-PROMPT-MARKER/);
    assert.equal(live.getAgent('live-baseline').agent.decisionCount, 0);

    const decision = await lab.buildDecisionSnapshot({ decisionFor: '2026-08-31' });
    assert.equal(decision.virtualDebug, true);
    assert.equal(decision.asOf, '2026-08-28');
    assert.equal(decision.candidates.length, 4);
    assert.equal(Object.values(decision.prices).every((row) => /虚拟调试/.test(row.source)), true);
    await assert.rejects(
      lab.buildPriceSnapshot({ decisionFor: '2026-08-31', phase: 'open', symbols: ['600001.SH'] }),
      /必须先完成.*AI 盘前决策/,
    );
    lab.store.saveSchedule({
      ...lab.store.getSchedule(),
      lastDecisionDate: '2026-08-31',
      lastRunStatus: 'completed',
    });
    const open = await lab.buildPriceSnapshot({ decisionFor: '2026-08-31', phase: 'open', symbols: ['600001.SH'] });
    await assert.rejects(
      lab.buildPriceSnapshot({ decisionFor: '2026-08-31', phase: 'close', symbols: ['600001.SH'] }),
      /必须先完成.*开盘执行/,
    );
    lab.store.saveSchedule({
      ...lab.store.getSchedule(),
      lastExecutionDate: '2026-08-31',
      lastExecutionStatus: 'completed',
    });
    const close = await lab.buildPriceSnapshot({ decisionFor: '2026-08-31', phase: 'close', symbols: ['600001.SH'] });
    assert.equal(open.prices['600001.SH'].close, open.prices['600001.SH'].open, 'open phase must not leak the future close');
    assert.notEqual(close.prices['600001.SH'].close, open.prices['600001.SH'].close);
    assert.equal(lab.selfTest().ok, true);

    lab.store.saveSchedule({
      ...lab.store.getSchedule(),
      lastResultDate: '2026-08-31',
      lastResultStatus: 'completed',
    });
    const advanced = lab.advance();
    assert.equal(advanced.virtualDate, '2026-09-01');
    assert.equal(advanced.phase, 'pre-market');
    const nextDecision = await lab.buildDecisionSnapshot({ decisionFor: '2026-09-01' });
    assert.equal(nextDecision.prices['000001.SZ'].close, close.prices['000001.SZ'].close, 'unheld candidates must carry their prior virtual close into the next day');
    assert.equal(live.getAgent('live-baseline').agent.decisionCount, 0, 'virtual activity must not mutate live state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('virtual reset deletes only the guarded sandbox and leaves formal files untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-league-virtual-reset-'));
  try {
    const live = new AgentLeagueStore({ root });
    live.createAgent({
      id: 'live-baseline', name: '正式基准', provider: 'codex-cli', kind: 'codex', model: 'gpt-5.6-sol',
      philosophy: getPhilosophy('chuxin-value-speculation'),
    });
    const formalFile = live.getAgent('live-baseline').files.agent;
    const formalBefore = fs.readFileSync(formalFile, 'utf8');
    assert.throws(() => new AgentLeagueVirtualDebug({ liveStore: live, root: path.join(os.tmpdir(), 'wrong-virtual-root') }), /virtual debug root must be/);
    const lab = new AgentLeagueVirtualDebug({ liveStore: live });
    lab.initialize({ virtualDate: '2026-08-31', scenario: 'selloff' });
    fs.writeFileSync(path.join(lab.root, 'debug-only-marker.txt'), 'debug', 'utf8');
    const reset = lab.reset({ virtualDate: '2026-08-31', scenario: 'rally' });
    assert.equal(reset.scenario, 'rally');
    assert.equal(fs.existsSync(path.join(lab.root, 'debug-only-marker.txt')), false);
    assert.equal(fs.readFileSync(formalFile, 'utf8'), formalBefore);
    assert.equal(live.getAgent('live-baseline').agent.decisionCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
