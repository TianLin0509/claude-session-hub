'use strict';
// 集成测试 dev scene · plan-dev-scenario.md
//   验证 orchestrator buildFanoutPrompt / buildDebatePrompt 在 dev 场景下
//   按 trigger 真实注入 L2b 段, 且其他场景 (general/research) 不被污染。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const scenes = require('../core/roundtable-scenes');
const { RoundtableOrchestrator } = require('../core/roundtable-orchestrator');

function tmpDir() {
  const d = path.join(os.tmpdir(), 'dev-scene-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeOrch(sceneKey) {
  return new RoundtableOrchestrator(tmpDir(), 'm-dev-test-' + sceneKey, scenes.getScene(sceneKey));
}

// === fanout 首轮 dev scene → 注入 clarify L2b ===
function testFanoutFirstTurnDevInjectsClarify() {
  const orch = makeOrch('dev');
  const prompt = orch.buildFanoutPrompt(
    /* turnNum */ 1,
    /* userInput */ '我想给 Hub 加个开发圆桌',
    /* dataPack */ null,
    /* dispatchSpec */ { mode: 'all', selfRole: 'pilot', sameStageLabels: ['Charmander', 'Squirtle'], pilotLabel: 'Pikachu' },
    /* injectionPayload */ null,
    /* timelinePath */ null,
    /* mySid */ 'sid-pikachu',
    /* sidLabelFn */ () => 'Pikachu',
  );
  assert.ok(prompt.includes('clarify 详细规则 · 本轮触发追注'),
    'dev 首轮 fanout 必须注入 clarify L2b');
  assert.ok(prompt.includes('[必答] ≤2'), '必含必答字段说明');
  assert.ok(prompt.includes('## 用户问题'), '用户问题段必须保留');
  // L2b 在用户问题前 (cache 友好顺序)
  const idxL2b = prompt.indexOf('clarify 详细规则');
  const idxUser = prompt.indexOf('## 用户问题');
  assert.ok(idxL2b < idxUser && idxL2b > 0, 'L2b 必须在 ## 用户问题之前');
  console.log('  ✓ testFanoutFirstTurnDevInjectsClarify');
}

// === fanout 中间轮 + 用户输入 "生成交接单" → 注入 handoff L2b ===
function testFanoutHandoffKeywordInjectsHandoff() {
  const orch = makeOrch('dev');
  const prompt = orch.buildFanoutPrompt(
    3, '生成交接单',
    null,
    { mode: 'all', sameStageLabels: ['Charmander', 'Squirtle'] },
    null, null, 'sid-pikachu', () => 'Pikachu',
  );
  assert.ok(prompt.includes('handoff 两步法 · 本轮触发追注'), 'dev "生成交接单" → handoff L2b');
  assert.ok(prompt.includes('Decision Recall'), 'handoff 含 Decision Recall');
  assert.ok(prompt.includes('Open Questions'), 'handoff 含 Open Questions');
  assert.ok(!prompt.includes('clarify 详细规则'), 'handoff 命中后不应同时含 clarify');
  console.log('  ✓ testFanoutHandoffKeywordInjectsHandoff');
}

// === fanout 中间轮 + 用户输入 "审一下" → 注入 review L2b ===
function testFanoutReviewKeywordInjectsReview() {
  const orch = makeOrch('dev');
  const prompt = orch.buildFanoutPrompt(
    5, '审一下我刚改的 core/foo.js',
    null,
    { mode: 'all', sameStageLabels: ['Charmander', 'Squirtle'] },
    null, null, 'sid-pikachu', () => 'Pikachu',
  );
  assert.ok(prompt.includes('review 三段式 · 本轮触发追注'), 'dev "审一下" → review L2b');
  assert.ok(prompt.includes('已验证事实'), 'review 含已验证事实');
  console.log('  ✓ testFanoutReviewKeywordInjectsReview');
}

// === fanout 中间轮 + 无关键词 → 不注入 L2b (沿用 L2a 自选, 轻任务直通) ===
function testFanoutMidTurnNoKeywordNoInjection() {
  const orch = makeOrch('dev');
  const prompt = orch.buildFanoutPrompt(
    3, 'foo 函数应该怎么改',
    null,
    { mode: 'all', sameStageLabels: ['Charmander', 'Squirtle'] },
    null, null, 'sid-pikachu', () => 'Pikachu',
  );
  assert.ok(!prompt.includes('clarify 详细规则'), '中间轮无关键词不应强制 clarify');
  assert.ok(!prompt.includes('handoff 两步法'), '无关键词不注 handoff');
  assert.ok(!prompt.includes('review 三段式'), '无关键词不注 review');
  console.log('  ✓ testFanoutMidTurnNoKeywordNoInjection');
}

// === fanout general scene → 无 dev L2b 污染 ===
function testFanoutGeneralSceneNotPolluted() {
  const orch = makeOrch('general');
  const prompt = orch.buildFanoutPrompt(
    1, '生成交接单',
    null,
    { mode: 'all', sameStageLabels: ['Charmander', 'Squirtle'] },
    null, null, 'sid-pikachu', () => 'Pikachu',
  );
  assert.ok(!prompt.includes('handoff 两步法'), 'general 场景即使输入 handoff 关键词也不应注入 dev L2b');
  assert.ok(!prompt.includes('clarify 详细规则'), 'general 首轮不应注入 dev clarify');
  console.log('  ✓ testFanoutGeneralSceneNotPolluted');
}

// === fanout research scene → 无 dev L2b 污染 ===
function testFanoutResearchSceneNotPolluted() {
  const orch = makeOrch('research');
  const prompt = orch.buildFanoutPrompt(
    1, '审一下兆易创新',
    null,
    { mode: 'all', sameStageLabels: ['Charmander', 'Squirtle'] },
    null, null, 'sid-pikachu', () => 'Pikachu',
  );
  assert.ok(!prompt.includes('review 三段式'), 'research 场景即使含 review 关键词也不应注入 dev L2b');
  assert.ok(!prompt.includes('开发圆桌 · L1 永真规则'), 'research 不应含 dev L1');
  console.log('  ✓ testFanoutResearchSceneNotPolluted');
}

// === debate dev scene + handoff 关键词 → 注入 ===
function testDebateDevHandoffInjects() {
  const orch = makeOrch('dev');
  const prompt = orch.buildDebatePrompt(
    4, '可以开工',
    { mode: 'all', sameStageLabels: ['Charmander', 'Squirtle'] },
    null, null, 'sid-pikachu', () => 'Pikachu',
  );
  assert.ok(prompt.includes('handoff 两步法'), 'dev debate "可以开工" 也应触发 handoff L2b');
  console.log('  ✓ testDebateDevHandoffInjects');
}

const tests = [
  testFanoutFirstTurnDevInjectsClarify,
  testFanoutHandoffKeywordInjectsHandoff,
  testFanoutReviewKeywordInjectsReview,
  testFanoutMidTurnNoKeywordNoInjection,
  testFanoutGeneralSceneNotPolluted,
  testFanoutResearchSceneNotPolluted,
  testDebateDevHandoffInjects,
];

console.log('Running dev scenario integration tests...');
let failed = 0;
for (const t of tests) {
  try { t(); }
  catch (e) {
    console.error('  ✗', t.name);
    console.error('    ', e.message);
    failed++;
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
