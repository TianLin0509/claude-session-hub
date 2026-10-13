'use strict';
// 公司纯净版 v1.0（2026-10-12 用户：公司只能用 CodeAgent，其他 AI 全删，状态栏余量也不要）。
//   target.json 的 kinds → 导出写进 community-edition.json → core/distribution.kindAllowed：
//   启动中心、群聊成员、首页检测、资源页筛选、会话搜索筛选只留允许的 AI；
//   features.quotaBar / accounts 关掉底部余量和左侧账号页。主仓库与公开社区版不受影响。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const loadDistribution = (marker) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edition-kinds-'));
  fs.mkdirSync(path.join(dir, 'core'));
  fs.copyFileSync(path.join(root, 'core', 'distribution.js'), path.join(dir, 'core', 'distribution.js'));
  if (marker) fs.writeFileSync(path.join(dir, 'community-edition.json'), JSON.stringify(marker));
  return require(path.join(dir, 'core', 'distribution.js'));
};

const main = loadDistribution(null);
assert.strictEqual(main.allowedKinds, null, '主仓库：不限 AI');
assert.ok(['claude', 'codex', 'codeagent', 'powershell'].every(main.kindAllowed), '主仓库：全部 AI 都可用');
const pub = loadDistribution({ edition: 'community', version: '0.4.5' });
assert.ok(pub.kindAllowed('claude') && pub.kindAllowed('kimi-resume'), '公开社区版：全部 AI 都可用');
const pure = loadDistribution({ edition: 'community', target: 'company', version: '1.0.0', kinds: ['codeagent'], features: { quotaBar: false, accounts: false } });
assert.deepStrictEqual([...pure.allowedKinds], ['codeagent']);
assert.strictEqual(pure.kindAllowed('codeagent'), true);
assert.strictEqual(pure.kindAllowed('codeagent-resume'), true, '恢复类 kind 跟随本体');
for (const kind of ['claude', 'codex', 'deepseek', 'gemini', 'kimi', 'qwen', 'glm', 'powershell', 'claude-resume']) assert.strictEqual(pure.kindAllowed(kind), false, kind);
assert.strictEqual(pure.featureEnabled('quotaBar'), false);
assert.strictEqual(pure.featureEnabled('accounts'), false);
assert.strictEqual(pure.makeKindFilter([]).allowedKinds, null, '空列表等于不限');
// 2026-10-13 公司版改名、标注与一键更新：只有写了这些字段的发行目标才生效。
const named = loadDistribution({ edition: 'community', target: 'company', version: '1.0.1', productName: 'AI HUB-Huawei', editionBadge: '内测先锋版', update: { sources: [{ id: 'github' }] } });
assert.strictEqual(named.productName, 'AI HUB-Huawei');
assert.strictEqual(named.editionBadge, '内测先锋版');
assert.deepStrictEqual(named.updateConfig, { sources: [{ id: 'github' }] });
assert.strictEqual(pub.productName, 'AI Hub Community', '公开版沿用原名');
assert.strictEqual(pub.editionBadge, null);
assert.strictEqual(pub.updateConfig, null, '公开版没有一键更新');
assert.strictEqual(main.productName, null);
assert.strictEqual(main.updateConfig, null, '主仓库没有一键更新');

const target = JSON.parse(fs.readFileSync(path.join(root, 'community', 'targets', 'company', 'target.json'), 'utf8'));
assert.deepStrictEqual(target.kinds, ['codeagent'], '公司版只留 CodeAgent');
assert.strictEqual(target.features.quotaBar, false, '公司版不要底部余量');
assert.strictEqual(target.features.accounts, false, '公司版不要账号页');
assert.ok(Number(String(target.version).split('.')[0]) >= 1, '纯净版从 v1.0 起');
assert.ok(!target.drop.some(file => /glm\.png$/.test(file)), 'CodeAgent 的卡片头像（glm）要留着');

const exporter = fs.readFileSync(path.join(root, 'scripts', 'community', 'export-community.js'), 'utf8');
assert.match(exporter, /Array\.isArray\(targetSpec\.kinds\) \? \{ kinds: targetSpec\.kinds \} : \{\}/, '导出把 kinds 写进 community-edition.json');
const { applyTargetPackaging } = require('../scripts/community/export-community');
const manifest = { drop: ['a/**'], package: { buildFilesAppend: ['!x'], build: { nsis: { oneClick: false }, appId: 'id' } } };
applyTargetPackaging(manifest, { drop: ['b.png'], buildFilesAppend: ['!y'], build: { nsis: { differentialPackage: false } } });
assert.deepStrictEqual(manifest.drop, ['a/**', 'b.png'], '目标的 drop 追加在清单之后');
assert.deepStrictEqual(manifest.package.buildFilesAppend, ['!x', '!y']);
assert.deepStrictEqual(manifest.package.build, { nsis: { oneClick: false, differentialPackage: false }, appId: 'id' }, 'build 按键浅合并');
const untouched = { drop: ['a'] };
applyTargetPackaging(untouched, { repo: 'o/r' });
assert.deepStrictEqual(untouched.drop, ['a'], '目标没写就不改');

const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const trimAt = html.indexOf('<script src="edition-trim.js">');
assert.ok(trimAt > 0 && trimAt < html.indexOf('<script src="workspace-controller.js">'), '界面裁剪先于启动中心初始化');
assert.ok(trimAt > html.indexOf('id="new-session-menu"') && trimAt > html.indexOf('id="rail-usage"') && trimAt > html.indexOf('id="btn-rail-accounts"'),
  '裁剪脚本运行时，要裁的元素已经在页面里');
const trim = fs.readFileSync(path.join(root, 'renderer', 'edition-trim.js'), 'utf8');
assert.match(trim, /featureEnabled\('quotaBar'\)\) document\.getElementById\('rail-usage'\)\?\.remove\(\)/);
assert.match(trim, /featureEnabled\('accounts'\)/);
assert.match(trim, /\[data-launch-intent="resume"\]'\)\?\.remove\(\)/, '没有可恢复的类型时去掉「恢复会话」页');

const aiKinds = fs.readFileSync(path.join(root, 'core', 'ai-kinds.js'), 'utf8');
assert.match(aiKinds, /GROUP_MEMBER_KINDS = \[[^\]]+\]\s*\.filter\(require\('\.\/distribution'\)\.kindAllowed\)/, '群聊成员只列允许的 AI');
const pref = fs.readFileSync(path.join(root, 'renderer', 'codeagent-preference.js'), 'utf8');
assert.match(pref, /function isInstalled\(\) \{ return codeAgentOnly \|\| installed === true; \}/, '只留 CodeAgent 时默认就选它');

console.log('unit-edition-codeagent-only: OK');
