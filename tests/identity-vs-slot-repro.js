// Phase 3 reproduction（已 phase 4 调整 · 2026-05-08）
//   原 phase 3 语义：identity = aiKind+model 严格隔离（Opus 4.7 ≠ Sonnet 4.6）
//   phase 4 调整：identity 退回到家族级（claude/gpt/...）；同家族跨 model 现在共享
//
// 场景 1（跨家族隔离）：Claude 坐 slot 1 写 → Gemini 坐 slot 1 读 → 应读不到（家族隔离仍生效）
// 场景 2（跨 slot 延续）：Opus 坐 slot 1 写 → 同 Claude 家族（Sonnet 等）坐 slot 2 读 → 应读到
// 场景 3（phase 4 反转）：Opus 写 → Sonnet 读 → 应读到（phase 4 同家族共享，phase 3 是隔离）

const path = require('path');
const fs = require('fs');
const os = require('os');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mem-p3-id-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const dataDir = require('../core/data-dir.js');
const store = require('../core/roundtable-memory/store.js');

const SCENE = 'general';
const root = dataDir.getSceneMemoryRoot(SCENE);
fs.mkdirSync(root, { recursive: true });

console.log('=== Phase 3 identity reproduction（scene 共享根 + identity 存储）===');
console.log('TEMP:', TEMP);
console.log('scene root:', root);

// ============================================================
// 场景 1：identity 隔离（同 slot 跨 AI 应该不串）
// ============================================================
console.log('\n--- 场景 1：identity 隔离（slot 相同，AI 不同 → memory 不串）---');

// 场 A：slot 1 = pikachu（Claude Opus）
const opusIdentity = store.makeIdentity('claude', 'claude-opus-4-7');
const wOpus = store.appendMemoryEntry({
  projectCwd: root, scene: SCENE, identity: opusIdentity,
  kind: 'preference', key: 'conclusion-first', content: 'Opus 偏好结论先行', source: 'self',
});
console.log(`场 A · Opus 坐 slot=pikachu，写入 identity=${opusIdentity}：${wOpus.ok ? 'OK' : wOpus.error}`);

// 场 B：slot 1 = pikachu（Gemini）— 同 slot 不同 AI
const geminiIdentity = store.makeIdentity('gemini', 'gemini-3-pro');
const lstGemini = store.listMemory({
  projectCwd: root, scene: SCENE, identity: geminiIdentity,
});
const geminiHits = (lstGemini.results || []).length;
console.log(`场 B · Gemini 坐 slot=pikachu（同 slot），读 identity=${geminiIdentity}：${geminiHits} 条`);

const isolated = geminiHits === 0;
console.log(isolated
  ? `✓ identity 隔离生效：Gemini 看不到 Opus 的记忆（修复前会读到混写的 pikachu.md）`
  : `✗ FAIL：identity 隔离失败，Gemini 读到了 Opus 的偏好`);

// 文件路径证据
const opusFp = path.join(root, '.arena/rooms', SCENE, 'memory', opusIdentity + '.md');
const geminiFp = path.join(root, '.arena/rooms', SCENE, 'memory', geminiIdentity + '.md');
console.log('  Opus .md:', opusFp, '· exists:', fs.existsSync(opusFp));
console.log('  Gemini .md:', geminiFp, '· exists:', fs.existsSync(geminiFp), '（应不存在 — Gemini 还未写过）');

// ============================================================
// 场景 2：identity 跨 slot 延续（同 AI 换 slot 应该看到自己上次的记忆）
// ============================================================
console.log('\n--- 场景 2：identity 跨 slot 延续（同 AI，slot 不同 → memory 仍延续）---');

// 场 C：slot 1 = pikachu，仍是 Opus（已经写过 conclusion-first，从场 A 来）
// 场 D：slot 2 = charmander，依然是 Opus —— 应该能读到 conclusion-first
const lstOpusInSlot2 = store.listMemory({
  projectCwd: root, scene: SCENE, identity: opusIdentity,
});
const opusHits = (lstOpusInSlot2.results || []).length;
const opusFound = lstOpusInSlot2.results.some(e => e.key === 'preference:conclusion-first');
console.log(`场 D · Opus 坐 slot=charmander（不同 slot），读 identity=${opusIdentity}：${opusHits} 条`);
console.log(opusFound
  ? `✓ identity 延续生效：Opus 不管坐哪个 slot，记忆都跟 identity 走（修复前会读 charmander.md = 空）`
  : `✗ FAIL：identity 延续失败`);

// ============================================================
// 场景 3（Phase 4 反转）：同家族不同 model 现在共享 claude.md
// ============================================================
console.log('\n--- 场景 3（Phase 4 反转）：Sonnet 4.6 写 → Opus 4.7 读 → 应读到（家族共享）---');

const sonnetIdentity = store.makeIdentity('claude', 'claude-sonnet-4-6'); // → 'claude'
const wSonnet = store.appendMemoryEntry({
  projectCwd: root, scene: SCENE, identity: sonnetIdentity,
  kind: 'observation', key: 'sonnet-only', content: 'Sonnet 视角观察', source: 'self',
});
console.log(`Sonnet 4.6 写入 identity=${sonnetIdentity}：${wSonnet.ok ? 'OK' : wSonnet.error}`);

// Opus 4.7 读到 Sonnet 写的（phase 4 家族共享）
const opusReadsAll = store.listMemory({ projectCwd: root, scene: SCENE, identity: opusIdentity });
const opusSeesSonnetEntry = opusReadsAll.results.some(e => e.key === 'observation:sonnet-only');
const opusSeesOwnEntry = opusReadsAll.results.some(e => e.key === 'preference:conclusion-first');
const familyShared = opusSeesSonnetEntry && opusSeesOwnEntry;
console.log(familyShared
  ? `✓ phase 4 家族共享生效：Opus 看到 Sonnet 写的 + 自己写的（claude.md 共享）`
  : `✗ FAIL：家族共享未生效（opus 看到 sonnet=${opusSeesSonnetEntry}, 自己=${opusSeesOwnEntry}）`);

// ============================================================
// 总结
// ============================================================
console.log('\n=== 总结 ===');
const allFiles = fs.readdirSync(path.join(root, '.arena/rooms', SCENE, 'memory'))
  .filter(n => n.endsWith('.md') && n !== '_profile.md').sort();
console.log('memDir 下所有 .md（家族命名）:', allFiles);

const allOk = isolated && opusFound && familyShared;
if (allOk) {
  console.log('\nPhase 3/4 reproduction PASS · 全部三个场景符合 phase 4 语义：');
  console.log('  1. 跨家族隔离：Claude 写 → Gemini 看不到');
  console.log('  2. 同家族跨 slot 延续：Opus 跨 slot 仍读到自己历史');
  console.log('  3. 同家族跨 model 共享（phase 4 反转）：Sonnet 写 → Opus 看到');
} else {
  console.log('\nFAIL · 至少一个场景未通过');
  process.exit(1);
}
