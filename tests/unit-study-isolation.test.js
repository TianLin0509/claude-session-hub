'use strict';
/**
 * 学习任务的隔离边界。
 *
 * 2026-09-08 合并位在一次隔离验收里撞到的：测试 Hub 起来之后自动开了学习任务，
 * 真的往**真实**学习目录（C:\Vibe\AI\agent-study）写了新文件，还追加了 INDEX.md。
 * 两层都漏了：
 *   · 产品侧：学习的自动调度没有隔离守卫 —— 联赛那边早就有（agent-league-scheduler-safety），
 *     学习这边一直裸奔；
 *   · 测试侧：隔离启动器没有把 AGENT_STUDY_DIR 一起圈进临时目录。
 * 这个文件把两层各守一条。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluateAgentLeagueSchedulerSafety } = require('../core/agent-league-scheduler-safety.js');
const { buildIsolatedHubEnv } = require('./helpers/hub-launcher.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('study 隔离');

test('产品侧：隔离实例 + 外部学习目录 → 自动调度必须停用', () => {
  const verdict = evaluateAgentLeagueSchedulerSafety({
    leagueRoot: 'C:\\Vibe\\AI\\agent-study',
    env: { CLAUDE_HUB_DATA_DIR: 'C:\\Temp\\hub-test\\data' },
  });
  assert.strictEqual(verdict.allowed, false, '隔离实例不许自动往真实学习目录写');
  assert.strictEqual(verdict.reason, 'isolated-external-vault-blocked');
});

test('产品侧：学习目录本来就在隔离数据目录里 → 照常自动跑', () => {
  const verdict = evaluateAgentLeagueSchedulerSafety({
    leagueRoot: 'C:\\Temp\\hub-test\\data\\agent-study',
    env: { CLAUDE_HUB_DATA_DIR: 'C:\\Temp\\hub-test\\data' },
  });
  assert.strictEqual(verdict.allowed, true);
});

test('产品侧：生产 Hub（没设隔离数据目录）行为不变', () => {
  const verdict = evaluateAgentLeagueSchedulerSafety({
    leagueRoot: 'C:\\Vibe\\AI\\agent-study', env: {},
  });
  assert.strictEqual(verdict.allowed, true);
  assert.strictEqual(verdict.reason, 'production-hub');
});

test('产品侧：学习调度真的接了这道守卫，且停用时不会崩在 dispose 上', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'study-handlers.js'), 'utf8');
  assert(/evaluateAgentLeagueSchedulerSafety\(\{ leagueRoot: studyRoot\(\) \}\)/.test(src),
    '判据要按学习目录算，不是照抄联赛目录');
  assert(/if \(studySafety\.allowed\)/.test(src), '不允许时不许起那个 60 秒 tick');
  assert(/dispose: \(\) => \{ if \(schedulerTimer\) clearInterval\(schedulerTimer\)/.test(src),
    '没起过定时器时 dispose 不能炸');
});

test('测试侧：隔离启动器把 AGENT_STUDY_DIR 圈进隔离数据目录', () => {
  const dataDir = path.join(os.tmpdir(), 'study-iso-check', 'data');
  const env = buildIsolatedHubEnv(dataDir, {}, { PATH: process.env.PATH });
  assert.ok(env.AGENT_STUDY_DIR, '必须显式设，不能靠默认值落到真实目录');
  assert.strictEqual(path.resolve(env.AGENT_STUDY_DIR).startsWith(path.resolve(dataDir)), true,
    '学习产物必须落在隔离数据目录里面');
});

test('测试侧：想把 AGENT_STUDY_DIR 指到测试根之外，直接拒绝', () => {
  const dataDir = path.join(os.tmpdir(), 'study-iso-check', 'data');
  assert.throws(
    () => buildIsolatedHubEnv(dataDir, { AGENT_STUDY_DIR: 'C:\\Vibe\\AI\\agent-study' }, { PATH: process.env.PATH }),
    /AGENT_STUDY_DIR inside the test root/,
    '和其它几个隔离目录一样，越界要当场报错，不是悄悄放过');
});

console.log(`\n${pass} passed`);
