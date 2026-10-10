'use strict';
// 发行目标的功能开关（2026-10-10 用户：公司版删掉助理，否则一直跳出运行异常的 Claude 会话）。
//   target.json 的 features → 导出写进 community-edition.json → core/distribution.featureEnabled。
//   关掉 assistant 时：主进程不起助理服务、左侧入口隐藏、旧助理会话不进侧栏。主仓库与公开社区版不受影响。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const loadDistribution = (marker) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-switch-'));
  fs.mkdirSync(path.join(dir, 'core'));
  fs.copyFileSync(path.join(root, 'core', 'distribution.js'), path.join(dir, 'core', 'distribution.js'));
  if (marker) fs.writeFileSync(path.join(dir, 'community-edition.json'), JSON.stringify(marker));
  return require(path.join(dir, 'core', 'distribution.js'));
};
assert.strictEqual(loadDistribution(null).featureEnabled('assistant'), true, '主仓库：助理开着');
assert.strictEqual(loadDistribution({ edition: 'community', version: '0.4.2' }).featureEnabled('assistant'), true, '公开社区版：助理开着');
const company = loadDistribution({ edition: 'community', target: 'company', version: '0.5.3', features: { assistant: false } });
assert.strictEqual(company.featureEnabled('assistant'), false, '公司版：助理关掉');
assert.strictEqual(company.featureEnabled('anything-else'), true, '没列出的功能照常开启');

const target = JSON.parse(fs.readFileSync(path.join(root, 'community', 'targets', 'company', 'target.json'), 'utf8'));
assert.deepStrictEqual(target.features, { assistant: false }, '公司版发行目标关掉助理');
const exporter = fs.readFileSync(path.join(root, 'scripts', 'community', 'export-community.js'), 'utf8');
assert.match(exporter, /\.\.\.\(targetSpec\.features \? \{ features: targetSpec\.features \} : \{\}\)/, '导出把 features 写进 community-edition.json');

const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
assert.match(main, /if \(require\('\.\/core\/distribution'\)\.featureEnabled\('assistant'\)\) try \{\s*assistantService = require\('\.\/main\/ipc\/assistant-handlers'\)/,
  '关掉时不起助理服务');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
assert.match(renderer, /featureEnabled\('assistant'\)\) \{\s*const assistantNav = document\.getElementById\('btn-assistant'\);/, '关掉时隐藏入口');
const list = fs.readFileSync(path.join(root, 'renderer', 'session-list-renderer.js'), 'utf8');
assert.match(list, /s\.purpose === 'hub-assistant' && !require\('\.\.\/core\/distribution'\)\.featureEnabled\('assistant'\)/, '关掉时旧助理会话不进侧栏');

console.log('unit-feature-switch-assistant: OK');
