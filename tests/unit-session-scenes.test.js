'use strict';
// 会话场景（2026-10-13）：场景库读取、系统提示拼装、按场景改写启动参数。
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scenes = require('../core/session-scenes');
const { skipsHubRules } = require('../core/hub-rules');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-scenes-'));
const home = path.join(root, 'home');
const dataDir = path.join(root, 'data');
const env = { CLAUDE_HUB_HOME_DIR: home };
fs.mkdirSync(path.join(home, '.agents', 'scenes'), { recursive: true });
fs.mkdirSync(path.join(home, '.agents', 'knowledge', 'wireless'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(home, '.agents', 'USER_CONTEXT.md'), [
  '# 个人协作约定', '', '## 身份与沟通', '', '- 林田，称「田哥」。', '', '## 输出风格', '', '- 第一行以「📌 **」起头。', '',
  '## 田哥说明书（摘要）', '', '- 背景：通信博士。', '', '## 执行与工程', '', '- 工程规则不该进非编程场景。', '',
].join('\n'));
const write = (name, text) => fs.writeFileSync(path.join(home, '.agents', 'scenes', name), text);
write('02-tech.md', '---\nid: tech\nlabel: 技术讨论\ndesc: 无线\nknowledge: wireless\n---\n# 场景：技术讨论\n\n## 你是谁\n\n同行。\n\n## 怎么讨论\n\n- 讲透。\n');
write('03-invest.md', '---\nid: invest\nlabel: 投研\ndesc: 股票\n---\n# 场景：投研\n\n## 你是谁\n\n资料员。\n\n## 怎么配合\n\n- 只陪练。\n');
write('09-bad.md', '没有 frontmatter 的文件不算场景\n');
fs.writeFileSync(path.join(home, '.agents', 'knowledge', 'wireless', 'INDEX.md'), '# 无线技术讨论知识库索引\n用法：先读主题文件。\n\n## 系统仿真口径（系统仿真口径.md）\n- W-SIM-01 默认负载：本区与邻区均 30%\n');
fs.writeFileSync(path.join(home, '.agents', 'knowledge', 'wireless', '系统仿真口径.md'), '# 系统仿真口径\n\n### W-SIM-01 a\n- 结论：x\n\n### W-SIM-02 b\n- 结论：y\n');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }

test('purpose 与场景 id 互转；编程场景不占 purpose', () => {
  assert.strictEqual(scenes.scenePurpose('tech'), 'scene-tech');
  assert.strictEqual(scenes.scenePurpose('coding'), null);
  assert.strictEqual(scenes.sceneIdOf('scene-invest'), 'invest');
  assert.strictEqual(scenes.sceneIdOf(null), 'coding');
  assert.strictEqual(scenes.isCleanPurpose('writing'), true);
  assert.strictEqual(scenes.isCleanPurpose('scene-tech'), true);
  assert.strictEqual(scenes.isCleanPurpose('hub-assistant'), false);
});

test('场景会话不带通用规则，普通会话照常带', () => {
  assert.strictEqual(skipsHubRules('scene-tech'), true);
  assert.strictEqual(skipsHubRules('writing'), true);
  assert.strictEqual(skipsHubRules(undefined), false);
  assert.strictEqual(skipsHubRules('scene-'), false);
});

test('读场景库：编程开发自动补在最前，坏文件跳过，知识库条数可见', () => {
  const list = scenes.listScenes({ env, dataDir });
  assert.deepStrictEqual(list.map(s => s.id), ['coding', 'tech', 'invest']);
  const tech = list.find(s => s.id === 'tech');
  assert.strictEqual(tech.knowledgeInfo.entries, 2);
  assert.strictEqual(tech.knowledgeInfo.indexEntries, 1);
});

test('没有场景库时返回空，界面据此不显示场景入口', () => {
  assert.deepStrictEqual(scenes.listScenes({ env: { CLAUDE_HUB_HOME_DIR: path.join(root, 'nobody') }, dataDir }), []);
});

test('拼系统提示：「关于田哥」插在「怎么」一节前，只截两节，知识库索引接在末尾', () => {
  const tech = scenes.getScene('tech', { env, dataDir });
  const text = scenes.composeScenePrompt(tech, { env, dataDir });
  assert.ok(text.indexOf('## 关于田哥') > text.indexOf('## 你是谁'));
  assert.ok(text.indexOf('## 关于田哥') < text.indexOf('## 怎么讨论'));
  assert.ok(text.includes('林田') && text.includes('通信博士'));
  assert.ok(!text.includes('工程规则不该进') && !text.includes('📌'), '输出风格和工程规则不进非编程场景');
  assert.ok(text.includes('## 知识库索引（技术讨论）') && text.includes('W-SIM-01'));
  assert.ok(text.includes('knowledge/wireless'));
  assert.strictEqual(scenes.composeScenePrompt(scenes.getScene('coding', { env, dataDir }), { env, dataDir }), '');
});

test('Claude 场景会话：换系统提示、关 CLAUDE.md/记忆/技能、去掉通用规则文件', () => {
  const o = scenes.applySceneLaunch('claude', { purpose: 'scene-tech', appendSystemPromptFile: 'rules.md', mcpConfigFile: 'm.json' }, { env, dataDir });
  assert.ok(o.systemPromptFile && fs.readFileSync(o.systemPromptFile, 'utf8').includes('## 关于田哥'));
  assert.strictEqual(o.appendSystemPromptFile, undefined);
  assert.strictEqual(o.mcpConfigFile, undefined);
  assert.strictEqual(o.mcpProfile, 'none');
  assert.strictEqual(o.extraEnv.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.strictEqual(o.extraEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.strictEqual(o.claudeOutputStyle, 'default');
  assert.strictEqual(o.disableSlashCommands, true);
  assert.deepStrictEqual(o.claudeTools, scenes.CLAUDE_TOOLS);
  assert.ok(o.addDirs.some(d => d.endsWith('.agents')), '能免审批读说明书和知识库');
  const again = scenes.applySceneLaunch('claude', { purpose: 'scene-tech' }, { env, dataDir });
  assert.strictEqual(again.systemPromptFile, o.systemPromptFile, '内容不变时复用同一份文件');
});

test('Codex / DeepSeek(Codex) 场景会话：换基础指令', () => {
  for (const kind of ['codex', 'codex-resume', 'deepseek']) {
    const o = scenes.applySceneLaunch(kind, { purpose: 'scene-invest' }, { env, dataDir });
    assert.ok(o.codexInstructionFile && fs.readFileSync(o.codexInstructionFile, 'utf8').includes('资料员'), kind);
    assert.strictEqual(o.systemPromptFile, undefined);
  }
});

test('不支持的 CLI、找不到的场景：照常启动并写明降级原因', () => {
  const g = scenes.applySceneLaunch('gemini', { purpose: 'scene-tech' }, { env, dataDir });
  assert.match(g.sceneWarning, /暂不支持场景/);
  const missing = scenes.applySceneLaunch('claude', { purpose: 'scene-nope' }, { env, dataDir });
  assert.match(missing.sceneWarning, /找不到场景/);
  assert.strictEqual(missing.systemPromptFile, undefined);
  const plain = { purpose: 'hub-assistant', model: 'x' };
  assert.strictEqual(scenes.applySceneLaunch('claude', plain, { env, dataDir }), plain);
});

test('隔离 Hub 不隐式读真实个人目录', () => {
  const o = scenes.applySceneLaunch('claude', { purpose: 'scene-tech' }, { env: { USERPROFILE: home }, dataDir });
  assert.match(o.sceneWarning || '', /找不到场景/);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`会话场景：${passed} 项通过`);
