// 试用 3 reproduction：证明跨 meeting memory gap 是结构性的
const path = require('path');
const fs = require('fs');
process.env.CLAUDE_HUB_DATA_DIR = 'C:/temp/hub-cross-meeting-test';
const dataDir = require('../core/data-dir.js');
const store = require('../core/roundtable-memory/store.js');

const meetingA = 'meeting-A-' + Date.now();
const meetingB = 'meeting-B-' + (Date.now() + 1);
const cwdA = dataDir.getMeetingWorkspaceDir(meetingA);
const cwdB = dataDir.getMeetingWorkspaceDir(meetingB);
fs.mkdirSync(cwdA, { recursive: true });
fs.mkdirSync(cwdB, { recursive: true });

console.log('--- 模拟用户开第一次圆桌 (meetingA) ---');
const w = store.appendMemoryEntry({
  projectCwd: cwdA,
  scene: 'general',
  slot: 'charmander',
  kind: 'preference',
  key: 'conclusion-first',
  content: '用户要求结论先行 不要铺背景',
  source: 'self',
});
console.log('charmander 写入偏好 conclusion-first:', w.ok ? 'OK' : w.error);

console.log('\n--- 用户关掉圆桌 → 重开同 scene 第二次圆桌 (meetingB) ---');
const lst = store.listMemory({ projectCwd: cwdB, scene: 'general', slot: 'charmander' });
const hits = (lst.results || []).map(r => `${r.kind}/${r.key}`);
console.log('charmander 读到的偏好条数:', (lst.results || []).length);
console.log('命中:', hits.length ? hits : '(空)');

console.log('\n--- 文件系统证据 ---');
const fpA = path.join(cwdA, '.arena/rooms/general/memory/charmander.md');
const fpB = path.join(cwdB, '.arena/rooms/general/memory/charmander.md');
console.log('A 存在:', fs.existsSync(fpA), '→', fpA);
console.log('B 存在:', fs.existsSync(fpB), '→', fpB);

console.log('\n=== 结论 ===');
if ((lst.results || []).length === 0) {
  console.log('GAP 已证实：meetingB 完全读不到 meetingA 的偏好');
  console.log('影响：用户每开新圆桌，AI 从 0 开始，不会"越来越懂我"');
} else {
  console.log('GAP 不存在：跨 meeting 共享生效');
}
