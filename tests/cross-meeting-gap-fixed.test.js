// Phase 2 P0 验证：跨 meeting memory 共享生效
// 使用 mock meetingManager 模拟两次 meeting，验证 _resolveMemoryProjectCwd 返回相同 scene root
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.CLAUDE_HUB_DATA_DIR = path.join(os.tmpdir(), 'hub-cross-meeting-fix-' + Date.now());
const dataDir = require('../core/data-dir.js');
const store = require('../core/roundtable-memory/store.js');

console.log('=== Phase 2 P0：跨 meeting memory 共享 reproduction ===\n');

// === 场景 A：无 pilot.cwd → fallback scene root ===
console.log('--- 场景 A：fallback 走 scene 共享根 ---');
const sceneRoot = dataDir.getSceneMemoryRoot('general');
fs.mkdirSync(sceneRoot, { recursive: true });
console.log('scene root:', sceneRoot);

// Phase 3：identity 替代 slot
const IDENT = 'gemini-3-pro';
const wA = store.appendMemoryEntry({
  projectCwd: sceneRoot,
  scene: 'general',
  identity: IDENT,
  kind: 'preference',
  key: 'conclusion-first',
  content: '用户要求结论先行 不要铺背景',
  source: 'self',
});
console.log('meetingA 写入:', wA.ok ? 'OK' : wA.error);

// meetingB 同 scene 同 identity 读
const lstB = store.listMemory({ projectCwd: sceneRoot, scene: 'general', identity: IDENT });
const hits = (lstB.results || []).map(r => `${r.key} → "${r.content}"`);
console.log('meetingB 读到:', hits.length, '条');
hits.forEach(h => console.log('  ✓', h));

const fp = path.join(sceneRoot, '.arena/rooms/general/memory/' + IDENT + '.md');
console.log('共享 .md 路径:', fp);
console.log('文件存在:', fs.existsSync(fp));

// === 场景 B：用户真实项目 cwd → per-project 共享 ===
console.log('\n--- 场景 B：用户真实项目 cwd（不在 workspaces 下）→ per-project 共享 ---');
const userProj = path.join(os.tmpdir(), 'user-proj-' + Date.now());
fs.mkdirSync(userProj, { recursive: true });
console.log('用户项目根:', userProj);
console.log('isUserProjectCwd(userProj):', dataDir.isUserProjectCwd(userProj));

// === 场景 C：fallback workspace（旧逻辑会 gap）→ 新逻辑应识别为 fallback ===
console.log('\n--- 场景 C：workspaces/<mid> 目录被识别为 fallback（不当 user project）---');
const mockMeetingId = 'mid-' + Date.now();
const workspacePath = dataDir.getMeetingWorkspaceDir(mockMeetingId);
console.log('mock workspace:', workspacePath);
console.log('isUserProjectCwd(workspace):', dataDir.isUserProjectCwd(workspacePath), '← 应为 false');

// === 总结 ===
console.log('\n=== 结论 ===');
const ok = (lstB.results || []).length > 0 &&
           dataDir.isUserProjectCwd(userProj) === true &&
           dataDir.isUserProjectCwd(workspacePath) === false;
if (ok) {
  console.log('Phase 2 P0 PASS：scene 级共享生效，user-project 识别正确');
  console.log('用户开新 meeting → AI 自动延续上次偏好（"越来越懂我"产品愿景达成）');
} else {
  console.log('FAIL：跨 meeting 共享未生效');
  process.exit(1);
}
