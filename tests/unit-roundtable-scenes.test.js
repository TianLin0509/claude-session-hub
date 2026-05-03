'use strict';
// 单元测试 core/roundtable-scenes.js — 场景注册表 + prompt 拼装
// 2026-05-04 prompt 重构 (P0-P5):
//   P0 L1 BASE_RULES 瘦身 (~700→~260 字)
//   P1 L2 research 三层分型 (PRESET 瘦身 + COVENANT_RESEARCH 重写为 4 块差量)
//   P2 删除 RESUME_REMINDERS / getResumeReminder (死代码)
//   P3 GENERAL_PRESET 补强 (~50→~210 字, 4 协作策略 + 1 段场景定位)
//   P4 五元组格式 SSoT (BRIEF_SUMMARY_FIELDS schema + render helpers)

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
  assert.ok(r.includes('引用明示'), 'BASE_RULES should include "引用明示" principle');
  assert.ok(r.includes('分歧不抹平'), 'BASE_RULES should include "分歧不抹平" principle');
  assert.ok(r.includes('不知说不知'), 'BASE_RULES should include "不知说不知" principle');
  // L2 详细约定不应在 L1 展开
  const fiveSlots = ['目标', '关键事实', '关键分歧', '当前结论', '下一步'];
  const slotsInL1 = fiveSlots.filter(s => r.includes(s)).length;
  assert.ok(slotsInL1 < 3,
    `BASE_RULES should NOT expand 五元组 definition (found ${slotsInL1} slot keywords; L2 territory)`);
  // P0 决议: 投研专项禁令下沉到 RESEARCH_PRESET (防反弹)
  assert.ok(!r.includes('LinDangAgent'), 'BASE_RULES MUST NOT mention LinDangAgent');
  assert.ok(!r.includes('A 股'), 'BASE_RULES MUST NOT mention A 股');
  assert.ok(!r.includes('投研'), 'BASE_RULES MUST NOT mention 投研');
  assert.ok(!r.includes('cli.py'), 'BASE_RULES MUST NOT mention cli.py (P0 投研禁令下沉)');
  assert.ok(!r.includes('Stock_top10'), 'BASE_RULES MUST NOT mention Stock_top10');
  assert.ok(!r.includes('fetch_lindang'), 'BASE_RULES MUST NOT mention fetch_lindang');
  // P0 决议: 删调度模式枚举 (L3 调度上下文已实时输出)
  assert.ok(!r.includes('fanout / debate / summary'), 'BASE_RULES MUST NOT enumerate fanout/debate/summary (L3 territory)');
  assert.ok(!r.includes('all 群策群力'), 'BASE_RULES MUST NOT enumerate dispatch modes');
  // 不能硬编码 "共三家" / "另外两位 AI 同事"
  assert.ok(!/共三家|另外两位\s*AI\s*同事/.test(r), 'BASE_RULES MUST NOT hardcode 共三家');
  // 篇幅约束
  assert.ok(r.length < 1500, `BASE_RULES too long: ${r.length} chars (P0 瘦身后应 ~600 字符)`);
  console.log('  ✓ testL1BaseRulesIsMinimal');
}

// === L2 COVENANT_GENERAL：详细协作手册 + 五元组 SSoT ===
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
  // P4 SSoT: 五元组段必须用 renderFiveElementItems 渲染 (与 buildBriefSummaryPrompt 共用)
  assert.ok(c.includes(scenes.renderFiveElementItems()),
    'COVENANT_GENERAL must contain renderFiveElementItems() output (P4 SSoT)');
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

// === P1: research preset 瘦身后仍含核心 (LinDangAgent + 旧入口禁令) ===
function testResearchPresetCore() {
  const s = scenes.getScene('research');
  assert.ok(s.preset.includes('LinDangAgent'), 'research preset should still mention LinDangAgent');
  // 旧入口禁令必须保留 (操作禁令每轮必读)
  assert.ok(s.preset.includes('cli.py analyze'), 'research preset should keep cli.py 旧入口禁令');
  assert.ok(s.preset.includes('Stock_top10'), 'research preset should keep Stock_top10 禁令');
  assert.ok(s.preset.includes('fetch_for_arena'), 'research preset should keep fetch_for_arena 禁令');
  // P1 决议: "纯读不写" 已删除 (与 L1 BASE_RULES "禁 Edit/Write 文件" 重复)
  assert.ok(!s.preset.includes('纯读不写'), 'P1 decision: "纯读不写" removed (overlap with L1)');
  // P1 决议: "圆桌产物是观点不是研报" 已迁出到 COVENANT_RESEARCH
  assert.ok(!s.preset.includes('圆桌产物是观点'), 'P1 decision: "圆桌产物是观点" moved to COVENANT_RESEARCH');
  console.log('  ✓ testResearchPresetCore');
}

// === P3: GENERAL_PRESET 补强 (4 协作策略 + 1 场景定位) ===
function testGeneralPresetEnhanced() {
  const s = scenes.getScene('general');
  // 必须含 4 条协作策略关键词
  assert.ok(s.preset.includes('协作策略'), 'GENERAL_PRESET should have "协作策略" section');
  assert.ok(s.preset.includes('上下文已够'), 'GENERAL_PRESET should have 上下文已够 strategy');
  assert.ok(s.preset.includes('涉及代码/文件/事实'), 'GENERAL_PRESET should have 事实核实 strategy');
  assert.ok(s.preset.includes('依赖项目细节'), 'GENERAL_PRESET should have 项目细节 strategy');
  assert.ok(s.preset.includes('问题有多解'), 'GENERAL_PRESET should have 多解澄清 strategy');
  // 场景定位
  assert.ok(s.preset.includes('场景定位'), 'GENERAL_PRESET should have "场景定位" section');
  assert.ok(s.preset.includes('可讨论的判断'), 'GENERAL_PRESET should clarify output is judgment');
  // P3 准入闸门: 不含场景特定知识 / 模式教学
  assert.ok(!s.preset.includes('LinDangAgent'), 'GENERAL_PRESET MUST NOT contain research-specific terms');
  assert.ok(!/fanout|debate|summary|@pikachu/i.test(s.preset),
    'GENERAL_PRESET MUST NOT contain mode/dispatch teaching');
  console.log('  ✓ testGeneralPresetEnhanced');
}

// === general scene defaultCovenant = COVENANT_GENERAL ===
function testGeneralDefaultCovenantIsCovenantGeneral() {
  const s = scenes.getScene('general');
  assert.strictEqual(s.defaultCovenant, scenes.COVENANT_GENERAL,
    'general scene defaultCovenant should be COVENANT_GENERAL');
  assert.ok(!s.preset.includes('LinDangAgent'), 'general preset MUST NOT mention LinDangAgent');
  console.log('  ✓ testGeneralDefaultCovenantIsCovenantGeneral');
}

// === research scene defaultCovenant = COVENANT_GENERAL + separator + COVENANT_RESEARCH ===
function testResearchDefaultCovenantIsCombined() {
  const s = scenes.getScene('research');
  assert.ok(s.defaultCovenant.startsWith('# 房间公约 · 圆桌协作手册'),
    'research defaultCovenant should start with COVENANT_GENERAL');
  assert.ok(s.defaultCovenant.includes('# 投研圆桌 · 研究纪律'),
    'research defaultCovenant should include new COVENANT_RESEARCH (P1 重写)');
  assert.ok(s.defaultCovenant.includes('\n\n---\n\n'),
    'research defaultCovenant should have separator between general and research');
  console.log('  ✓ testResearchDefaultCovenantIsCombined');
}

// === P1: COVENANT_RESEARCH 重写为 4 块差量结构 ===
function testCovenantResearchDifferential() {
  const c = scenes.COVENANT_RESEARCH;
  // 4 块判断纪律
  assert.ok(c.includes('证据优先'), 'COVENANT_RESEARCH should have 证据优先 block');
  assert.ok(c.includes('假设分层'), 'COVENANT_RESEARCH should have 假设分层 block');
  assert.ok(c.includes('分歧保留'), 'COVENANT_RESEARCH should have 分歧保留 block');
  // 红线
  assert.ok(c.includes('红线'), 'COVENANT_RESEARCH should keep 红线');
  assert.ok(c.includes('蹭概念'), 'COVENANT_RESEARCH should mention 蹭概念 red line');
  // 用户画像指针 (B 路线: 外置)
  assert.ok(c.includes('research-profile.md'), 'COVENANT_RESEARCH should reference external profile');
  // P1 准入: 不重复 GENERAL/L1
  assert.ok(!c.includes('timeline.md 路径'), 'COVENANT_RESEARCH MUST NOT duplicate timeline 机制');
  assert.ok(!c.includes('五元组'), 'COVENANT_RESEARCH MUST NOT duplicate 五元组 definition');
  // P1 准入: 不含具体工具/命令 (应在 PRESET)
  assert.ok(!c.includes('fetch_lindang'), 'COVENANT_RESEARCH MUST NOT contain MCP tool names (PRESET territory)');
  assert.ok(!c.includes('cli.py'), 'COVENANT_RESEARCH MUST NOT contain CLI commands (PRESET territory)');
  // P1 准入: 不直接写用户偏好数字 (应在 profile)
  assert.ok(!/15%|35%|30%|20%/.test(c), 'COVENANT_RESEARCH MUST NOT contain weight numbers (profile territory)');
  assert.ok(!/单股仓位|1-3 万/.test(c), 'COVENANT_RESEARCH MUST NOT contain user portfolio amounts');
  console.log('  ✓ testCovenantResearchDifferential');
}

// === P4: 五元组 SSoT schema ===
function testFiveElementSchema() {
  // schema 数组导出
  assert.ok(Array.isArray(scenes.BRIEF_SUMMARY_FIELDS), 'BRIEF_SUMMARY_FIELDS should be exported array');
  assert.strictEqual(scenes.BRIEF_SUMMARY_FIELDS.length, 5, '五元组恰好 5 字段');
  // 字段标题稳定
  const titles = scenes.BRIEF_SUMMARY_FIELDS.map(([n]) => n);
  assert.deepStrictEqual(titles, ['目标', '关键事实', '关键分歧', '当前结论', '下一步'], '五字段标题稳定');
  // 约束 4 条独立
  assert.ok(Array.isArray(scenes.BRIEF_SUMMARY_CONSTRAINTS), 'BRIEF_SUMMARY_CONSTRAINTS should be exported array');
  assert.strictEqual(scenes.BRIEF_SUMMARY_CONSTRAINTS.length, 4, '约束恰好 4 条独立');
  assert.ok(scenes.BRIEF_SUMMARY_CONSTRAINTS.includes('不展开论证'), 'should contain 不展开论证');
  assert.ok(scenes.BRIEF_SUMMARY_CONSTRAINTS.includes('不重复事实细节'), 'should contain 不重复事实细节');
  // render helpers
  assert.strictEqual(typeof scenes.renderFiveElementItems, 'function', 'renderFiveElementItems should be function');
  assert.strictEqual(typeof scenes.renderBriefSummaryConstraints, 'function', 'renderBriefSummaryConstraints should be function');
  // render output 结构
  const items = scenes.renderFiveElementItems();
  assert.ok(items.includes('1. **目标**'), 'render: index 1 = 目标');
  assert.ok(items.includes('5. **下一步**'), 'render: index 5 = 下一步');
  // 约束渲染 inline / list 风格
  const inline = scenes.renderBriefSummaryConstraints('inline');
  assert.ok(inline.startsWith('约束:'), 'inline style starts with 约束:');
  assert.ok(inline.includes('，'), 'inline style uses 顿号');
  const list = scenes.renderBriefSummaryConstraints('list');
  assert.ok(list.startsWith('- 不超过 500 字'), 'list style uses - prefix');
  // SSoT: COVENANT_GENERAL 必须包含 render 输出 (与 buildBriefSummaryPrompt 共用)
  assert.ok(scenes.COVENANT_GENERAL.includes(items),
    'COVENANT_GENERAL must use renderFiveElementItems() output (P4 SSoT)');
  console.log('  ✓ testFiveElementSchema');
}

// === P2: RESUME_REMINDERS / getResumeReminder 已删除 ===
function testResumeRemindersDeleted() {
  // P2 决议: 死代码删除 (main.js 调用次数 = 0)
  assert.strictEqual(scenes.getResumeReminder, undefined,
    'P2: getResumeReminder must be removed (was dead code, never called by main.js)');
  assert.strictEqual(scenes.RESUME_REMINDERS, undefined,
    'P2: RESUME_REMINDERS constant should not be exported');
  console.log('  ✓ testResumeRemindersDeleted');
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
  const prompt = scenes.buildSystemPrompt('general', null);
  assert.ok(prompt.includes(scenes.BASE_RULES), 'should contain BASE_RULES');
  assert.ok(prompt.includes('## 关于 timeline.md'), 'general null covenant should fall back to COVENANT_GENERAL');
  assert.ok(prompt.includes('---'), 'general null covenant: separator present');
  console.log('  ✓ testBuildSystemPromptNullFallbackGeneral');
}

function testBuildSystemPromptNullFallbackResearch() {
  const prompt = scenes.buildSystemPrompt('research', null);
  assert.ok(prompt.includes(scenes.BASE_RULES), 'should contain BASE_RULES');
  assert.ok(prompt.includes('LinDangAgent'), 'research preset present');
  assert.ok(prompt.includes('## 关于 timeline.md'), 'should include COVENANT_GENERAL');
  assert.ok(prompt.includes('# 投研圆桌 · 研究纪律'), 'should include new COVENANT_RESEARCH');
  assert.ok(prompt.includes('---'), 'separator present');
  console.log('  ✓ testBuildSystemPromptNullFallbackResearch');
}

// === buildSystemPrompt：空字符串 covenant → 不回退 ===
function testBuildSystemPromptEmptyStringNoSeparator() {
  const promptEmpty = scenes.buildSystemPrompt('general', '');
  assert.ok(promptEmpty.includes('## 关于 timeline.md'),
    'empty string covenant currently fallback to defaultCovenant');
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

console.log('Running roundtable-scenes unit tests (P0-P5 prompt 重构)...');
let failed = 0;
const tests = [
  testL1BaseRulesIsMinimal,
  testL2CovenantGeneralExported,
  testRegistryStructure,
  testResearchPresetCore,
  testGeneralPresetEnhanced,
  testGeneralDefaultCovenantIsCovenantGeneral,
  testResearchDefaultCovenantIsCombined,
  testCovenantResearchDifferential,
  testFiveElementSchema,
  testResumeRemindersDeleted,
  testBuildSystemPromptUserOverride,
  testBuildSystemPromptNullFallbackGeneral,
  testBuildSystemPromptNullFallbackResearch,
  testBuildSystemPromptEmptyStringNoSeparator,
  testFileManagement,
  testGetScene,
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
