'use strict';
// 单元测试 core/roundtable-scenes.js — 场景注册表 + prompt 拼装
// 2026-05-02 plan F：升级为 L1/L2 四层架构
//   L1 BASE_RULES：极简核心规则
//   L2 COVENANT_GENERAL：通用公约（timeline / 摘要 / 五元组 / 协作礼仪）
//   research.defaultCovenant = COVENANT_GENERAL + separator + COVENANT_RESEARCH
// 用 Node 内置 assert + 临时目录隔离

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const scenes = require('../core/roundtable-scenes');

function tmpDir() {
  const d = path.join(os.tmpdir(), 'scenes-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// === L1 BASE_RULES：极简，只承载核心规则 ===
function testL1BaseRulesIsMinimal() {
  const r = scenes.BASE_RULES;
  // 必须含的核心要素
  assert.ok(r.includes('圆桌讨论'), 'BASE_RULES should contain "圆桌讨论"');
  assert.ok(r.includes('调度上下文'), 'BASE_RULES should preview "调度上下文"');
  assert.ok(r.includes('timeline.md'), 'BASE_RULES should mention timeline.md');
  assert.ok(r.includes('房间公约'), 'BASE_RULES should reference 房间公约');
  // 三个原则的关键词
  assert.ok(r.includes('引用要明示'), 'BASE_RULES should include "引用要明示" principle');
  assert.ok(r.includes('分歧别抹平'), 'BASE_RULES should include "分歧别抹平" principle');
  assert.ok(r.includes('不知就说不知'), 'BASE_RULES should include "不知就说不知" principle');
  // L2 详细约定不应在 L1 展开（mention 作为入口指引 OK，但不应承载定义）
  // 检查：不应同时含五元组的 3+ 个字段名（说明展开了五元组定义，应只在 L2）
  const fiveSlots = ['目标', '关键事实', '关键分歧', '当前结论', '下一步'];
  const slotsInL1 = fiveSlots.filter(s => r.includes(s)).length;
  assert.ok(slotsInL1 < 3,
    `BASE_RULES should NOT expand 五元组 definition (found ${slotsInL1} slot keywords; L2 territory)`);
  assert.ok(!r.includes('LinDangAgent'), 'BASE_RULES MUST NOT mention LinDangAgent');
  assert.ok(!r.includes('A 股'), 'BASE_RULES MUST NOT mention A 股');
  assert.ok(!r.includes('投研'), 'BASE_RULES MUST NOT mention 投研');
  // 不能硬编码 "共三家" / "另外两位 AI 同事"
  assert.ok(!/共三家|另外两位\s*AI\s*同事/.test(r), 'BASE_RULES MUST NOT hardcode 共三家/另外两位 AI 同事');
  // 篇幅约束（L1 应该极简）
  assert.ok(r.length < 1500, `BASE_RULES too long: ${r.length} chars (should stay L1 minimal, < 1500)`);
  console.log('  ✓ testL1BaseRulesIsMinimal');
}

// === L2 COVENANT_GENERAL：详细协作手册 ===
function testL2CovenantGeneralExported() {
  assert.strictEqual(typeof scenes.COVENANT_GENERAL, 'string', 'COVENANT_GENERAL should be exported as string');
  const c = scenes.COVENANT_GENERAL;
  assert.ok(c.length > 500, `COVENANT_GENERAL should be substantive (got ${c.length} chars)`);
  // 必须涵盖的详细约定
  assert.ok(c.includes('timeline.md'), 'COVENANT_GENERAL should cover timeline.md usage');
  assert.ok(c.includes('摘要按钮'), 'COVENANT_GENERAL should cover 摘要按钮');
  assert.ok(c.includes('五元组'), 'COVENANT_GENERAL should cover 五元组');
  assert.ok(c.includes('dispatchMode'), 'COVENANT_GENERAL should cover dispatchMode 切换');
  assert.ok(c.includes('协作礼仪'), 'COVENANT_GENERAL should cover 协作礼仪');
  // 五元组五段必须齐
  assert.ok(c.includes('目标') && c.includes('关键事实') && c.includes('关键分歧')
            && c.includes('当前结论') && c.includes('下一步'),
    'COVENANT_GENERAL should list all 5 quintuple slots');
  console.log('  ✓ testL2CovenantGeneralExported');
}

// === SCENE_REGISTRY 结构 ===
function testRegistryStructure() {
  const keys = scenes.getSceneKeys();
  assert.deepStrictEqual(keys.sort(), ['general', 'research']);

  const requiredFields = ['name', 'icon', 'preset', 'defaultCovenant', 'mcpConfig',
                          'summaryHints', 'summaryTitleTag', 'dataPackEnabled'];
  for (const k of keys) {
    const s = scenes.getScene(k);
    assert.ok(s !== null, `scene ${k} should exist`);
    for (const f of requiredFields) {
      assert.ok(f in s, `scene ${k} should have field ${f}`);
    }
    assert.strictEqual(typeof s.name, 'string');
    assert.strictEqual(typeof s.icon, 'string');
    assert.strictEqual(typeof s.preset, 'string');
    assert.strictEqual(typeof s.defaultCovenant, 'string');
    assert.strictEqual(typeof s.summaryHints, 'string');
    assert.strictEqual(typeof s.summaryTitleTag, 'boolean');
    assert.strictEqual(typeof s.dataPackEnabled, 'boolean');
  }
  console.log('  ✓ testRegistryStructure');
}

// === research preset 仍含 LinDangAgent / 纯读不写（不变） ===
function testResearchPresetUnchanged() {
  const s = scenes.getScene('research');
  assert.ok(s.preset.includes('LinDangAgent'), 'research preset should still mention LinDangAgent');
  assert.ok(s.preset.includes('纯读不写'), 'research preset should still mention 纯读不写');
  console.log('  ✓ testResearchPresetUnchanged');
}

// === general scene defaultCovenant 现在是 COVENANT_GENERAL（plan F 改动） ===
function testGeneralDefaultCovenantIsCovenantGeneral() {
  const s = scenes.getScene('general');
  assert.strictEqual(s.defaultCovenant, scenes.COVENANT_GENERAL,
    'general scene defaultCovenant should be COVENANT_GENERAL (was empty before plan F)');
  assert.ok(!s.preset.includes('LinDangAgent'), 'general preset MUST NOT mention LinDangAgent');
  console.log('  ✓ testGeneralDefaultCovenantIsCovenantGeneral');
}

// === research scene defaultCovenant = COVENANT_GENERAL + separator + COVENANT_RESEARCH ===
function testResearchDefaultCovenantIsCombined() {
  const s = scenes.getScene('research');
  assert.ok(s.defaultCovenant.startsWith('# 房间公约 · 圆桌协作手册'),
    'research defaultCovenant should start with COVENANT_GENERAL');
  assert.ok(s.defaultCovenant.includes('# 立花道雪投研圆桌'),
    'research defaultCovenant should also include COVENANT_RESEARCH');
  assert.ok(s.defaultCovenant.includes('\n\n---\n\n'),
    'research defaultCovenant should have separator between general and research');
  console.log('  ✓ testResearchDefaultCovenantIsCombined');
}

// === buildSystemPrompt：用户传非空 covenant 覆盖 default ===
function testBuildSystemPromptUserOverride() {
  const customPrompt = scenes.buildSystemPrompt('general', '## 我的偏好\n简洁回答');
  assert.ok(customPrompt.includes(scenes.BASE_RULES), 'should contain BASE_RULES');
  assert.ok(customPrompt.includes('我的偏好'), 'should contain user covenant');
  assert.ok(!customPrompt.includes('## 关于 timeline.md'),
    'user override should NOT include default COVENANT_GENERAL');
  assert.ok(customPrompt.includes('---'), 'non-empty covenant: separator present');
  console.log('  ✓ testBuildSystemPromptUserOverride');
}

// === buildSystemPrompt：null covenant 回退到 scene.defaultCovenant ===
function testBuildSystemPromptNullFallbackGeneral() {
  // general + null → 现在会用 COVENANT_GENERAL（plan F 之前是空，现在非空）
  const prompt = scenes.buildSystemPrompt('general', null);
  assert.ok(prompt.includes(scenes.BASE_RULES), 'should contain BASE_RULES');
  assert.ok(prompt.includes('## 关于 timeline.md'), 'general null covenant should fall back to COVENANT_GENERAL');
  assert.ok(prompt.includes('---'), 'general null covenant: separator present (defaultCovenant non-empty)');
  console.log('  ✓ testBuildSystemPromptNullFallbackGeneral');
}

function testBuildSystemPromptNullFallbackResearch() {
  const prompt = scenes.buildSystemPrompt('research', null);
  assert.ok(prompt.includes(scenes.BASE_RULES), 'should contain BASE_RULES');
  assert.ok(prompt.includes('LinDangAgent'), 'research preset present');
  assert.ok(prompt.includes('## 关于 timeline.md'), 'should include COVENANT_GENERAL');
  assert.ok(prompt.includes('# 立花道雪投研圆桌'), 'should include COVENANT_RESEARCH');
  assert.ok(prompt.includes('---'), 'separator present');
  console.log('  ✓ testBuildSystemPromptNullFallbackResearch');
}

// === buildSystemPrompt：空字符串 covenant → 不回退（既有契约：传空 = 显式无 covenant） ===
function testBuildSystemPromptEmptyStringNoSeparator() {
  // 注：既有 buildSystemPrompt 实现：covenantText 是非空字符串才用，否则才回退 default
  // 传 ''（空字符串）走 trim().length > 0 检查 → false → 看 defaultCovenant
  // 现在 general.defaultCovenant 非空，所以仍会用 default。
  // 这与"用户显式传空表示无 covenant"语义不一致，但本次方案 F 不改既有行为；
  // 想要"绝对无 covenant"，调用方传 '   ' 或 null 都不行 — 仍会 fallback。这是已知边界。
  // 此测试仅记录当前行为：传空字符串等价于传 null（因 trim().length > 0 检查）
  const promptEmpty = scenes.buildSystemPrompt('general', '');
  assert.ok(promptEmpty.includes('## 关于 timeline.md'),
    'empty string covenant currently fallback to defaultCovenant (=COVENANT_GENERAL after plan F)');
  console.log('  ✓ testBuildSystemPromptEmptyStringNoSeparator (records current behavior)');
}

// === 文件管理完整链路（不变） ===
function testFileManagement() {
  const d = tmpDir();
  const mid = 'test-meeting-FM';

  const pf = scenes.writePromptFile(d, mid, 'research', '自定义公约');
  assert.ok(fs.existsSync(pf), 'prompt file should exist');
  const content = fs.readFileSync(pf, 'utf-8');
  assert.ok(content.includes(scenes.BASE_RULES), 'prompt file has BASE_RULES');
  assert.ok(content.includes('自定义公约'), 'prompt file has custom covenant');

  scenes.writeCovenantSnapshot(d, mid, '快照公约');
  const read = scenes.readCovenantSnapshot(d, mid);
  assert.strictEqual(read, '快照公约', 'covenant snapshot roundtrip');

  scenes.cleanup(d, mid);
  const promptDir = path.join(d, 'arena-prompts');
  const remaining = fs.readdirSync(promptDir).filter(f => f.startsWith(`${mid}-`));
  assert.strictEqual(remaining.length, 0, 'cleanup should remove all meeting files');
  console.log('  ✓ testFileManagement');
}

// === getScene: 已知 → 对象，未知 → null ===
function testGetScene() {
  assert.ok(scenes.getScene('general') !== null);
  assert.ok(scenes.getScene('research') !== null);
  assert.strictEqual(scenes.getScene('nonexistent'), null);
  assert.strictEqual(scenes.getScene(undefined), null);
  console.log('  ✓ testGetScene');
}

// === getResumeReminder: 两个场景各有提醒 ===
function testResumeReminder() {
  const rG = scenes.getResumeReminder('general');
  assert.ok(typeof rG === 'string' && rG.length > 0, 'general resume reminder non-empty');
  const rR = scenes.getResumeReminder('research');
  assert.ok(typeof rR === 'string' && rR.length > 0, 'research resume reminder non-empty');
  assert.ok(rR.includes('投研'), 'research reminder mentions 投研');
  const rUnknown = scenes.getResumeReminder('unknown');
  assert.ok(rUnknown === null || rUnknown === '', 'unknown scene returns null or empty');
  console.log('  ✓ testResumeReminder');
}

console.log('Running roundtable-scenes unit tests (plan F)...');
let failed = 0;
const tests = [
  testL1BaseRulesIsMinimal,
  testL2CovenantGeneralExported,
  testRegistryStructure,
  testResearchPresetUnchanged,
  testGeneralDefaultCovenantIsCovenantGeneral,
  testResearchDefaultCovenantIsCombined,
  testBuildSystemPromptUserOverride,
  testBuildSystemPromptNullFallbackGeneral,
  testBuildSystemPromptNullFallbackResearch,
  testBuildSystemPromptEmptyStringNoSeparator,
  testFileManagement,
  testGetScene,
  testResumeReminder,
];
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
