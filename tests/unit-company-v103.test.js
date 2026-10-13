'use strict';
// 公司版 v1.0.3（2026-10-13）：大 .cac.json 也能读出模型；读不懂时退回文本扫描；按修改时间缓存；
// 卡片里的用户头像完整显示不裁切。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const models = require('../core/codeagent-models');
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name + '\n    ' + (error.stack || error.message)); }
}
const MODEL_SECTIONS = {
  tieredModelConfig: { large: 'GLM-5.2-WX', small: 'GLM-5.2', vision: 'Qwen3.6-27B-CodeAgent-VL' },
  tierModelParams: { 'MiniMax-M2.7-CodeAgentCLI': { temperature: 1 } },
  modelParam: { 'deepseek0731-wx-chat': { maxTokens: 8192 } },
};
const EXPECTED = ['GLM-5.2-WX', 'GLM-5.2', 'Qwen3.6-27B-CodeAgent-VL', 'MiniMax-M2.7-CodeAgentCLI', 'deepseek0731-wx-chat'];
function bigHistory(targetBytes) {
  // 像真机一样：projects 里塞大量历史，里面混着转义的 JSON 片段和句子里的模型名，都不该被当成模型。
  const projects = {};
  const entry = { display: '试试 GLM-9.9 和 deepseek-v9 怎么样 {\"model\":\"GLM-7.7\"} '.repeat(20), pastedContents: {} };
  let i = 0;
  while (JSON.stringify(projects).length < targetBytes) projects['D:/work/p' + (i++)] = { history: Array.from({ length: 20 }, () => entry) };
  return projects;
}

test('超过 8 MB 的 .cac.json 仍能读出模型段里的模型，聊天记录里的不算', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-big-'));
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
    fs.writeFileSync(path.join(dir, '.cac.json'), JSON.stringify({ ...MODEL_SECTIONS, projects: bigHistory(9 * 1024 * 1024) }));
    assert(fs.statSync(path.join(dir, '.cac.json')).size > 8 * 1024 * 1024, '造出来的配置要超过旧上限');
    const found = models.configuredModels(dir);
    assert.deepStrictEqual(new Set(found.models), new Set([...EXPECTED, 'GLM-5.2-WX-Auto']));
    assert.strictEqual(found.defaultModel, 'GLM-5.2-WX-Auto');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('JSON 坏了（例如写到一半）也能从文本里找出模型段的模型', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-bad-'));
  try {
    const text = JSON.stringify({ projects: { 'D:/x': { history: [{ display: '聊天里写 \"model\": \"GLM-8.8\" 也不算' }] } }, ...MODEL_SECTIONS });
    fs.writeFileSync(path.join(dir, '.cac.json'), text.slice(0, -1) + ',"truncated": ');
    const found = models.configuredModels(dir);
    assert.deepStrictEqual(new Set(found.models), new Set(EXPECTED));
    assert(!found.models.includes('GLM-8.8'), '聊天记录里转义过的 model 键不算');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('文件没变就用缓存，不重复读大文件；文件变了才重新读', () => {
  const files = new Map([['C:\\cac\\settings.json', { text: JSON.stringify({ model: 'GLM-5.2-WX-Auto' }), mtimeMs: 1 }],
    ['C:\\cac\\.cac.json', { text: JSON.stringify(MODEL_SECTIONS), mtimeMs: 1 }]]);
  let reads = 0;
  const fsModule = {
    statSync: p => { const f = files.get(p); if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { size: f.text.length, mtimeMs: f.mtimeMs }; },
    readFileSync: p => { reads++; return files.get(p).text; },
  };
  const first = models.configuredModels('C:\\cac', fsModule);
  assert.strictEqual(reads, 2);
  models.configuredModels('C:\\cac', fsModule);
  models.configuredModels('C:\\cac', fsModule);
  assert.strictEqual(reads, 2, '打开菜单多少次都不重读');
  files.get('C:\\cac\\.cac.json').text = JSON.stringify({ modelParam: { 'Qwen9-Next': {} } });
  files.get('C:\\cac\\.cac.json').mtimeMs = 2;
  const second = models.configuredModels('C:\\cac', fsModule);
  assert.strictEqual(reads, 3, '只重读改过的那个');
  assert(first.models.includes('GLM-5.2-WX') && second.models.includes('Qwen9-Next') && !second.models.includes('GLM-5.2-WX'));
});

test('卡片里的用户头像完整显示：不裁圆、不套底色、图片按框缩放', () => {
  const css = fs.readFileSync(path.join(root, 'renderer/styles/simple-chat.css'), 'utf8');
  assert.match(css, /\.msg-overlay \.turn-card\[data-chat-style='message'\] \.turn-avatar\.av-user \{ background: transparent; border-radius: 0; overflow: visible; \}/);
  assert.match(css, /\.msg-overlay \.turn-card \.turn-avatar\.av-user img,[\s\S]*?\{ width: 100%; height: 100%; object-fit: contain; border-radius: 0; \}/);
  assert.doesNotMatch(css, /\.turn-avatar\.av-user img \{ width: 30px; height: 30px; \}/, '不再用比框大的固定尺寸');
});

test('公司版 1.0.3：发布说明不点名雇主', () => {
  const target = JSON.parse(fs.readFileSync(path.join(root, 'community/targets/company/target.json'), 'utf8'));
  assert.strictEqual(target.version, '1.0.3');
  assert(target.releaseNotes.length >= 3);
  // 泄露闸门中英文都拦（产品名 AI HUB-Huawei 本身由 leakAllow 放行，发布说明里别单写）。
  assert(!/华为|huawei/i.test(JSON.stringify(target.releaseNotes)));
});

if (failed) { console.error(`\n${failed} 个用例失败`); process.exit(1); }
console.log('\nunit-company-v103: all passed');
