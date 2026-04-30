'use strict';
// 单元测试 core/roundtable-scenes.js — 场景注册表 + prompt 拼装
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

// === BASE_RULES 内容契约 ===
function testBaseRulesContent() {
  const r = scenes.BASE_RULES;
  assert.ok(r.includes('圆桌讨论规则'), 'BASE_RULES should contain title');
  assert.ok(r.includes('@debate'), 'BASE_RULES should mention @debate');
  assert.ok(r.includes('@summary'), 'BASE_RULES should mention @summary');
  assert.ok(r.includes('私聊'), 'BASE_RULES should mention private chat');
  // 不应包含投研特有内容
  assert.ok(!r.includes('LinDangAgent'), 'BASE_RULES MUST NOT mention LinDangAgent');
  assert.ok(!r.includes('A 股'), 'BASE_RULES MUST NOT mention A 股');
  assert.ok(!r.includes('tushare'), 'BASE_RULES MUST NOT mention tushare');
  assert.ok(!r.includes('投研'), 'BASE_RULES MUST NOT mention 投研');
  console.log('  ✓ testBaseRulesContent');
}

// === SCENE_REGISTRY 结构完整性 ===
function testRegistryStructure() {
  const keys = scenes.getSceneKeys();
  assert.deepStrictEqual(keys.sort(), ['general', 'research']);

  const requiredFields = ['name', 'icon', 'preset', 'defaultCovenant', 'mcpConfig', 'summaryHints', 'summaryTitleTag', 'dataPackEnabled'];
  for (const k of keys) {
    const s = scenes.getScene(k);
    assert.ok(s !== null, `scene ${k} should exist`);
    for (const f of requiredFields) {
      assert.ok(f in s, `scene ${k} should have field ${f}`);
    }
    assert.strictEqual(typeof s.name, 'string', `${k}.name should be string`);
    assert.strictEqual(typeof s.icon, 'string', `${k}.icon should be string`);
    assert.strictEqual(typeof s.preset, 'string', `${k}.preset should be string`);
    assert.strictEqual(typeof s.defaultCovenant, 'string', `${k}.defaultCovenant should be string`);
    assert.strictEqual(typeof s.summaryHints, 'string', `${k}.summaryHints should be string`);
    assert.strictEqual(typeof s.summaryTitleTag, 'boolean', `${k}.summaryTitleTag should be boolean`);
    assert.strictEqual(typeof s.dataPackEnabled, 'boolean', `${k}.dataPackEnabled should be boolean`);
  }
  console.log('  ✓ testRegistryStructure');
}

// === research preset 包含 LinDangAgent / 纯读不写 ===
function testResearchPreset() {
  const s = scenes.getScene('research');
  assert.ok(s.preset.includes('LinDangAgent'), 'research preset should mention LinDangAgent');
  assert.ok(s.preset.includes('纯读不写'), 'research preset should mention 纯读不写');
  console.log('  ✓ testResearchPreset');
}

// === general preset 不含 LinDangAgent，defaultCovenant 为空 ===
function testGeneralPreset() {
  const s = scenes.getScene('general');
  assert.ok(!s.preset.includes('LinDangAgent'), 'general preset MUST NOT mention LinDangAgent');
  assert.strictEqual(s.defaultCovenant, '', 'general defaultCovenant should be empty');
  console.log('  ✓ testGeneralPreset');
}

// === buildSystemPrompt：空 covenant 不加 separator ===
function testBuildSystemPrompt() {
  // general scene: defaultCovenant 为空 → 传空 covenant 应仅有 rules + preset，无 separator
  const promptEmpty = scenes.buildSystemPrompt('general', '');
  assert.ok(promptEmpty.includes(scenes.BASE_RULES), 'should contain BASE_RULES');
  assert.ok(!promptEmpty.includes('---'), 'empty covenant: no separator');

  // 非空 covenant → 加 separator
  const promptWithCov = scenes.buildSystemPrompt('general', '## 我的偏好\n简洁回答');
  assert.ok(promptWithCov.includes('---'), 'non-empty covenant: has separator');
  assert.ok(promptWithCov.includes('我的偏好'), 'non-empty covenant: has covenant text');
  console.log('  ✓ testBuildSystemPrompt');
}

// === buildSystemPrompt：null covenant 回退到 scene.defaultCovenant ===
function testBuildSystemPromptDefaultCovenant() {
  // research: defaultCovenant 非空 → null 应回退
  const prompt = scenes.buildSystemPrompt('research', null);
  assert.ok(prompt.includes('---'), 'null covenant on research: should fallback to defaultCovenant with separator');
  assert.ok(prompt.includes('投研圆桌'), 'should contain research covenant content');

  // general: defaultCovenant 为空 → null 也不加 separator
  const promptG = scenes.buildSystemPrompt('general', null);
  assert.ok(!promptG.includes('---'), 'null covenant on general: no separator (defaultCovenant is empty)');
  console.log('  ✓ testBuildSystemPromptDefaultCovenant');
}

// === 文件管理完整链路 ===
function testFileManagement() {
  const d = tmpDir();
  const mid = 'test-meeting-FM';

  // writePromptFile
  const pf = scenes.writePromptFile(d, mid, 'research', '自定义公约');
  assert.ok(fs.existsSync(pf), 'prompt file should exist');
  const content = fs.readFileSync(pf, 'utf-8');
  assert.ok(content.includes(scenes.BASE_RULES), 'prompt file has BASE_RULES');
  assert.ok(content.includes('自定义公约'), 'prompt file has custom covenant');

  // writeCovenantSnapshot + readCovenantSnapshot
  scenes.writeCovenantSnapshot(d, mid, '快照公约');
  const read = scenes.readCovenantSnapshot(d, mid);
  assert.strictEqual(read, '快照公约', 'covenant snapshot roundtrip');

  // cleanup
  scenes.cleanup(d, mid);
  const promptDir = path.join(d, 'arena-prompts');
  const remaining = fs.readdirSync(promptDir).filter(f => f.startsWith(`${mid}-`));
  assert.strictEqual(remaining.length, 0, 'cleanup should remove all meeting files');
  console.log('  ✓ testFileManagement');
}

// === getScene: 已知 key → 对象，未知 key → null ===
function testGetScene() {
  assert.ok(scenes.getScene('general') !== null, 'known key returns object');
  assert.ok(scenes.getScene('research') !== null, 'known key returns object');
  assert.strictEqual(scenes.getScene('nonexistent'), null, 'unknown key returns null');
  assert.strictEqual(scenes.getScene(undefined), null, 'undefined key returns null');
  console.log('  ✓ testGetScene');
}

// === getResumeReminder: 两个场景各有对应提醒 ===
function testResumeReminder() {
  const rGeneral = scenes.getResumeReminder('general');
  assert.ok(typeof rGeneral === 'string' && rGeneral.length > 0, 'general resume reminder non-empty');
  assert.ok(rGeneral.includes('通用圆桌') || rGeneral.includes('Roundtable'), 'general reminder mentions roundtable');

  const rResearch = scenes.getResumeReminder('research');
  assert.ok(typeof rResearch === 'string' && rResearch.length > 0, 'research resume reminder non-empty');
  assert.ok(rResearch.includes('投研'), 'research reminder mentions 投研');

  // 未知 key 返回 null 或空
  const rUnknown = scenes.getResumeReminder('unknown');
  assert.ok(rUnknown === null || rUnknown === '', 'unknown scene returns null or empty');
  console.log('  ✓ testResumeReminder');
}

console.log('Running roundtable-scenes unit tests...');
testBaseRulesContent();
testRegistryStructure();
testResearchPreset();
testGeneralPreset();
testBuildSystemPrompt();
testBuildSystemPromptDefaultCovenant();
testFileManagement();
testGetScene();
testResumeReminder();
console.log('All passed.');
