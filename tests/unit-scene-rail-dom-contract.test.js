'use strict';

/**
 * 场景 rail 的 DOM 契约（冷杉 B v2 · T0）。
 *
 * 守的是「搬家搬干净了」这一件事：四个场景按钮从 .sidebar-header 移进 #scene-rail，
 * 而且是**同一批节点**，不是照着抄了一遍。抄一遍的后果不是样式不对，是 renderer.js /
 * chuxin.js / study.js / ran.js 那几处 getElementById 拿到的是旧节点（或两个同 id
 * 节点里的第一个），点了没反应而且不报错 —— 静默失灵最难查，所以在这里拦。
 *
 * 用正则读 index.html，不起浏览器：这类结构问题在字符串层面就能判死，
 * 而 CDP e2e 起一次要十几秒。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const railCss = fs.readFileSync(path.join(ROOT, 'renderer', 'styles', 'rail.css'), 'utf8');
const stylesManifest = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (err.message || err));
  }
}

const SCENE_IDS = ['btn-home', 'btn-research', 'btn-study', 'btn-ran'];

/** 取出 <nav id="scene-rail"> … </nav> 的内容。rail 里没有嵌套的 nav。 */
function railInner() {
  const start = html.indexOf('<nav class="scene-rail" id="scene-rail"');
  assert.ok(start >= 0, '缺少 <nav id="scene-rail">');
  const end = html.indexOf('</nav>', start);
  assert.ok(end > start, 'scene-rail 没有闭合');
  return html.slice(start, end);
}

/** 取出 <div class="session-sidebar" id="session-sidebar"> 到 rail 之后那一段。 */
function sidebarInner() {
  const start = html.indexOf('<div class="session-sidebar" id="session-sidebar">');
  assert.ok(start >= 0, '缺少 #session-sidebar');
  const end = html.indexOf('<button class="btn-expand-sidebar"', start);
  assert.ok(end > start, '找不到 #session-sidebar 的结尾锚点 btn-expand-sidebar');
  return html.slice(start, end);
}

test('rail 是 #app-body 的第一个子节点', () => {
  const body = html.indexOf('<div class="app-body" id="app-body">');
  assert.ok(body >= 0, '缺少 #app-body');
  const after = html.slice(body + '<div class="app-body" id="app-body">'.length);
  const firstTag = after.match(/<(nav|div|button|section|main)\b[^>]*>/);
  assert.ok(firstTag, '#app-body 里没有元素');
  assert.match(firstTag[0], /id="scene-rail"/,
    '#app-body 的第一个元素应当是 #scene-rail，实际是：' + firstTag[0]);
});

test('四个场景按钮都在 #scene-rail 里', () => {
  const rail = railInner();
  for (const id of SCENE_IDS) {
    assert.ok(rail.includes('id="' + id + '"'), id + ' 应当在 #scene-rail 内');
  }
});

test('#session-sidebar 里不再有场景按钮 / 选项按钮 / 主题选择器', () => {
  const sidebar = sidebarInner();
  for (const id of SCENE_IDS.concat(['btn-options', 'options-menu', 'options-theme-picker', 'btn-theme'])) {
    assert.ok(!sidebar.includes('id="' + id + '"'), id + ' 不应再出现在 #session-sidebar 内');
  }
});

test('每个 id 全文只出现一次（搬家不是复制）', () => {
  for (const id of SCENE_IDS.concat(['btn-options', 'options-theme-picker', 'scene-rail', 'rail-usage', 'btn-theme'])) {
    const hits = html.split('id="' + id + '"').length - 1;
    assert.strictEqual(hits, 1, id + ' 在 index.html 里出现了 ' + hits + ' 次，应当只有 1 次');
  }
});

test('搬家保留了 data-* 入口与可访问名', () => {
  const rail = railInner();
  // chuxin.js / study.js / ran.js 用这些属性选中按钮，丢了等于场景入口静默失效
  assert.match(rail, /id="btn-research"[^>]*data-chuxin-entry/);
  assert.match(rail, /id="btn-study"[^>]*data-study-entry/);
  assert.match(rail, /id="btn-ran"[^>]*data-ran-entry/);
  // 文案留在 DOM 里（由 rail.css 收掉），tooltip 用原 title
  for (const [id, label] of [['btn-home', '主页'], ['btn-research', '投研'], ['btn-study', '学习'], ['btn-ran', '开发']]) {
    assert.ok(rail.includes('<span class="btn-label">' + label + '</span>'), id + ' 的 btn-label 应当保留');
  }
  assert.match(rail, /id="btn-home"[^>]*title="/);
});

test('rail 的排布顺序：logo → 四场景 → 弹性空位 → 用量占位 → 主题 → 选项', () => {
  const rail = railInner();
  const order = ['rail-logo', 'btn-home', 'btn-research', 'btn-study', 'btn-ran',
    'rail-spacer', 'rail-usage', 'btn-theme', 'btn-options'];
  let cursor = -1;
  for (const token of order) {
    const at = rail.indexOf(token, cursor + 1);
    assert.ok(at > cursor, token + ' 的位置不对（应当排在 ' + order[order.indexOf(token) - 1] + ' 之后）');
    cursor = at;
  }
});

test('rail 样式表已经挂进清单，且 rail 是 52px / 按钮 34px', () => {
  assert.match(stylesManifest, /@import url\('\.\/styles\/rail\.css'\);/);
  assert.match(stylesManifest, /@import url\('\.\/styles\/sidebar-v2\.css'\);/);
  assert.match(railCss, /\.scene-rail\s*\{[^}]*width:\s*52px/);
  assert.match(railCss, /width:\s*34px;\s*\n\s*height:\s*34px/);
});

test('折叠只作用在侧栏：rail 没有任何 sidebar-collapsed 的隐藏规则', () => {
  assert.ok(!/sidebar-collapsed[^{]*\.scene-rail/.test(railCss),
    'rail 不该跟着侧栏一起折叠');
  // 展开按钮要让开 rail（原来贴在 app-body 左边 8px，正压在 logo 上）
  assert.match(railCss, /#app-body > \.btn-expand-sidebar\s*\{[^}]*left:\s*60px/);
});

console.log('Running scene rail DOM contract tests...');
console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
