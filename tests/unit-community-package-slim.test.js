'use strict';
// 发行包瘦身（2026-10-10 用户：离线包 310MB 超过同步上限，「主要开销是哪」）。
// 主要可减的三块：界面大图（38 张 1254px PNG 共 34MB，界面只按 24-168px 显示）、
// 没用到的旧图（v1 头像等约 13MB）、Electron 的 55 个语言包（46MB，只需要中文和英文）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'community', 'manifest.json'), 'utf8'));
assert.deepStrictEqual(manifest.package.build.electronLanguages, ['zh-CN', 'en-US'], '只打包中文和英文语言包');
assert.ok(manifest.shrinkImages['renderer/assets/ai-avatars'] >= 336, '头像最大显示 168px，2 倍屏需要至少 336px');
assert.ok(manifest.shrinkImages['renderer/assets/navigation'] >= 128, '导航图标显示约 28px');
for (const unused of ['renderer/assets/ai-avatars/v1/**', 'renderer/assets/navigation/ceramic-navigation.png', 'renderer/assets/navigation/coldwhite-enamel-v1.png']) {
  assert.ok(manifest.drop.includes(unused), '没用到的图不进发行包：' + unused);
}
// 丢掉的图确实没有被引用。
const sources = ['renderer', 'main', 'core'].flatMap(dir => {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'assets' && e.name !== 'vendor') walk(p); } else if (/\.(js|html|css)$/.test(e.name)) out.push(p); } })(path.join(root, dir));
  return out;
}).concat(path.join(root, 'main.js'));
const text = sources.map(file => fs.readFileSync(file, 'utf8')).join('\n');
for (const needle of ['ai-avatars/v1/', 'ceramic-navigation.png', 'coldwhite-enamel-v1.png']) {
  assert.ok(!text.includes(needle), '被丢掉的图仍有引用：' + needle);
}
const exporter = fs.readFileSync(path.join(root, 'scripts', 'community', 'export-community.js'), 'utf8');
assert.match(exporter, /shrink-images\.ps1/, '导出时缩图');
console.log('unit-community-package-slim: OK');
