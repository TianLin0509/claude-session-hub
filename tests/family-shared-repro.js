// Phase 4 reproduction：家族级共享生效 + 跨家族隔离 + codex 合并 gpt
//
// 4 场景：
//   场景 1：同家族跨 model 共享（Opus 写 → Sonnet 读 → 应读到）
//   场景 2：跨家族隔离（Claude 写 → Gemini 读 → 应读不到）
//   场景 3：codex 合并 gpt（codex 写 → packy-gpt 读 → 应读到，都进 gpt.md）
//   场景 4：phase 3 数据迁移后不影响新写入（legacy-by-version/ 与新 claude.md 共存）

const path = require('path');
const fs = require('fs');
const os = require('os');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mem-p4-fam-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const dataDir = require('../core/data-dir.js');
const store = require('../core/roundtable-memory/store.js');

const SCENE = 'general';
const root = dataDir.getSceneMemoryRoot(SCENE);
fs.mkdirSync(root, { recursive: true });

console.log('=== Phase 4 family-shared reproduction ===');
console.log('TEMP:', TEMP);
console.log('scene root:', root);

// ============================================================
// 场景 1：同家族跨 model 共享
// ============================================================
console.log('\n--- 场景 1：同家族跨 model 共享（Opus 写 → Sonnet 读 → 应读到）---');

const opusId = store.makeIdentity('claude', 'claude-opus-4-7');
const sonnetId = store.makeIdentity('claude', 'claude-sonnet-4-6');
console.log(`Opus identity = ${opusId}, Sonnet identity = ${sonnetId}`);
const sameFamily = opusId === sonnetId;
console.log(sameFamily ? `✓ 同家族 identity 一致：'${opusId}'` : `✗ FAIL：identity 不一致`);

const wOpus = store.appendMemoryEntry({
  projectCwd: root, scene: SCENE, identity: opusId,
  kind: 'preference', key: 'conclusion-first', content: '用户喜欢结论先行', source: 'self',
});
console.log(`Opus 写入：${wOpus.ok ? 'OK' : wOpus.error}`);

const sonnetReads = store.listMemory({ projectCwd: root, scene: SCENE, identity: sonnetId });
const sonnetHits = (sonnetReads.results || []).length;
console.log(`Sonnet 读到：${sonnetHits} 条`);
const scene1Pass = sameFamily && sonnetHits === 1 && sonnetReads.results[0].key === 'preference:conclusion-first';
console.log(scene1Pass ? `✓ 场景 1 PASS：Sonnet 读到 Opus 写的偏好（家族共享）` : `✗ 场景 1 FAIL`);

// ============================================================
// 场景 2：跨家族隔离
// ============================================================
console.log('\n--- 场景 2：跨家族隔离（Claude 写 → Gemini 读 → 应读不到）---');

const geminiId = store.makeIdentity('gemini', 'gemini-3-pro');
const geminiReads = store.listMemory({ projectCwd: root, scene: SCENE, identity: geminiId });
const geminiHits = (geminiReads.results || []).length;
console.log(`Gemini identity = ${geminiId}，读到：${geminiHits} 条`);
const scene2Pass = geminiHits === 0 && opusId !== geminiId;
console.log(scene2Pass ? `✓ 场景 2 PASS：Gemini 读不到 Claude 家族的偏好` : `✗ 场景 2 FAIL`);

// ============================================================
// 场景 3：codex 合并到 gpt（统一 OpenAI 家族）
// ============================================================
console.log('\n--- 场景 3：codex 合并 gpt（codex 写 → packy-gpt 读 → 都在 gpt.md）---');

const codexId = store.makeIdentity('codex', 'gpt-5.2-codex');     // canonical → 'gpt'
const packyGptId = store.makeIdentity('gpt', 'gpt-5.5');          // 'gpt'
console.log(`codex identity = ${codexId}, packy-gpt identity = ${packyGptId}`);
const openAiSame = codexId === 'gpt' && packyGptId === 'gpt';

const wCodex = store.appendMemoryEntry({
  projectCwd: root, scene: SCENE, identity: codexId,
  kind: 'fact', key: 'main-language', content: 'Python 是用户主语言', source: 'self',
});
console.log(`codex 写入 ${codexId}.md：${wCodex.ok ? 'OK' : wCodex.error}`);

const gptReads = store.listMemory({ projectCwd: root, scene: SCENE, identity: packyGptId });
const gptHits = (gptReads.results || []).length;
console.log(`packy-gpt 读 ${packyGptId}.md：${gptHits} 条`);
const scene3Pass = openAiSame && gptHits === 1 && gptReads.results[0].key === 'fact:main-language';
console.log(scene3Pass ? `✓ 场景 3 PASS：codex 与 packy-gpt 共享 gpt.md（OpenAI 家族合并）` : `✗ 场景 3 FAIL`);

// 文件证据
const expectedFile = path.join(root, '.arena/rooms', SCENE, 'memory', 'gpt.md');
console.log(`gpt.md 路径：${expectedFile}`);
console.log(`exists:`, fs.existsSync(expectedFile));

// ============================================================
// 场景 4：phase 3 legacy 数据与新 phase 4 文件共存
// ============================================================
console.log('\n--- 场景 4：legacy-by-version/ 与新 claude.md 共存 ---');

const memDir = path.join(root, '.arena/rooms', SCENE, 'memory');
const legacyVersionDir = path.join(memDir, 'legacy-by-version');
fs.mkdirSync(legacyVersionDir, { recursive: true });
fs.writeFileSync(path.join(legacyVersionDir, 'claude-opus-4-7.md'), '# legacy phase 3 entry\n', 'utf-8');

// 新写入到 claude.md
const wAfterMig = store.appendMemoryEntry({
  projectCwd: root, scene: SCENE, identity: 'claude',
  kind: 'observation', key: 'after-migration', content: 'phase 4 新写入 — 不应触碰 legacy', source: 'self',
});
console.log(`phase 4 新写入：${wAfterMig.ok ? 'OK' : wAfterMig.error}`);

const claudeFp = path.join(memDir, 'claude.md');
const legacyFp = path.join(legacyVersionDir, 'claude-opus-4-7.md');
const newFileExists = fs.existsSync(claudeFp);
const legacyFileIntact = fs.existsSync(legacyFp);
const claudeContent = fs.readFileSync(claudeFp, 'utf-8');
const noLegacyContamination = !claudeContent.includes('legacy phase 3 entry');
const scene4Pass = newFileExists && legacyFileIntact && noLegacyContamination;
console.log(scene4Pass
  ? `✓ 场景 4 PASS：legacy-by-version/ 完好 + 新 claude.md 不混 legacy 内容`
  : `✗ 场景 4 FAIL`);

// listAllIdentities 应该不识别 legacy-by-version 子目录
const ids = store.listAllIdentities(root, SCENE);
console.log(`listAllIdentities：${ids.join(', ')}`);
const noLegacyInIds = !ids.includes('legacy-by-version') && !ids.includes('claude-opus-4-7');
console.log(noLegacyInIds ? `✓ listAllIdentities 不误识 legacy 目录` : `✗ FAIL：误识 legacy`);

// ============================================================
// 总结
// ============================================================
console.log('\n=== 总结 ===');
const finalFiles = fs.readdirSync(memDir).filter(n => n.endsWith('.md')).sort();
console.log('memDir 顶层 .md:', finalFiles);
console.log('legacy-by-version/:', fs.readdirSync(legacyVersionDir));

const allPass = scene1Pass && scene2Pass && scene3Pass && scene4Pass && noLegacyInIds;
if (allPass) {
  console.log('\nPhase 4 family-shared reproduction PASS · 4 场景全过：');
  console.log('  1. 同家族跨 model 共享（Opus ↔ Sonnet 共用 claude.md）');
  console.log('  2. 跨家族隔离（Claude ≠ Gemini）');
  console.log('  3. codex 合并 gpt（统一 OpenAI 家族）');
  console.log('  4. legacy-by-version 与新文件无干扰共存');
} else {
  console.log('\nFAIL · 至少一个场景未通过');
  process.exit(1);
}
