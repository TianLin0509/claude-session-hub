'use strict';

/**
 * 左侧栏分组入口的 DOM 契约（2026-10-24）。
 *
 * 守的是三件事：
 *   1. 四个入口收成一个之后，成员按钮仍是**原来那批节点** —— id、data-*、可访问名、
 *      aria-controls 一字未改，只是父节点从 .rail-navigation 变成了 .rail-group-menu。
 *      抄一遍的后果不是样式不对，是 rules.js / hub-workspaces.js / chuxin.js 里的
 *      getElementById 命中空气，点了没反应也不报错。
 *   2. 展开条默认不渲染（hidden + aria-expanded=false），只有悬停/聚焦才出现；
 *      成员不占 rail 的行高。
 *   3. 社区版导出能过：整段应用组包在 @community-strip 里，剥完不留悬空标记、
 *      不留空的 dock。
 *
 * 静态读文件，不起浏览器 —— 这类结构问题在字符串层面就能判死。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { applyStripMarkers } = require('../scripts/community/strip-markers');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const shellCss = fs.readFileSync(path.join(ROOT, 'renderer', 'styles', 'coldwhite-workspace.css'), 'utf8');

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

function railInner() {
  const start = html.indexOf('<nav class="scene-rail" id="scene-rail"');
  assert.ok(start >= 0, '缺少 <nav id="scene-rail">');
  const end = html.indexOf('</nav>', start);
  assert.ok(end > start, 'scene-rail 没有闭合');
  return html.slice(start, end);
}

// 标签栈：取「片段首元素」的直接子元素 id。深度正好比容器多一层才算直接子元素，
// 这样 dock 里的成员（比 .rail-navigation 深两层）不会混进一级入口。
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function directChildIds(fragment) {
  const ids = [];
  let depth = 0;
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  while ((match = re.exec(fragment))) {
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const attrs = match[3] || '';
    const selfClose = match[4] === '/';
    if (closing) { depth = Math.max(0, depth - 1); continue; }
    if (depth === 1) {
      const id = /\bid="([^"]+)"/.exec(attrs);
      if (id) ids.push(id[1]);
    }
    if (!selfClose && !VOID_TAGS.has(name)) depth += 1;
  }
  return ids;
}

const GROUP_SPECS = [
  { key: 'rules', trigger: 'btn-rail-group-rules', menu: 'rail-group-rules-menu',
    members: ['btn-rules', 'btn-rail-capabilities', 'btn-rail-accounts', 'btn-rail-memo'] },
  { key: 'applications', trigger: 'btn-rail-group-applications', menu: 'rail-group-applications-menu',
    members: ['btn-research', 'btn-study', 'btn-writing', 'btn-wireless'] },
];

test('两个分组都在 #scene-rail 里，各有一个入口和一排四个成员', () => {
  const rail = railInner();
  assert.strictEqual((rail.match(/class="rail-group"/g) || []).length, 2, '应当正好两个 .rail-group');
  for (const spec of GROUP_SPECS) {
    const block = rail.slice(rail.indexOf(`data-rail-group="${spec.key}"`));
    const end = block.indexOf('</div>\n      </div>');
    const scope = end > 0 ? block.slice(0, end) : block;
    for (const id of spec.members) {
      assert.ok(scope.includes(`id="${id}"`), `${spec.key} 组里缺少 ${id}`);
    }
  }
});

test('成员顺序与产品要求一致', () => {
  const rail = railInner();
  for (const spec of GROUP_SPECS) {
    let cursor = rail.indexOf(`data-rail-group="${spec.key}"`);
    for (const id of spec.members) {
      const at = rail.indexOf(`id="${id}"`, cursor + 1);
      assert.ok(at > cursor, `${id} 应当排在 ${spec.members[spec.members.indexOf(id) - 1] || '入口'} 之后`);
      cursor = at;
    }
  }
});

test('出口收成一个：rail 一级入口只剩 主页 / 规则组 / 助理 / 应用组 / 开发 / 云端', () => {
  const rail = railInner();
  const navStart = rail.indexOf('<div class="rail-navigation">');
  const nav = rail.slice(navStart);
  const order = ['btn-home', 'btn-rail-group-rules', 'btn-assistant', 'btn-rail-group-applications', 'btn-ran', 'btn-cloud'];
  let cursor = -1;
  for (const token of order) {
    const at = nav.indexOf(`id="${token}"`, cursor + 1);
    assert.ok(at > cursor, token + ' 的位置不对');
    cursor = at;
  }
  // 用标签栈取出 .rail-navigation 的直接子元素：成员必须都在分组容器里面，不能是同级入口。
  const direct = directChildIds(nav);
  for (const id of ['btn-rules', 'btn-rail-capabilities', 'btn-rail-accounts', 'btn-rail-memo', 'btn-research', 'btn-study', 'btn-writing', 'btn-wireless']) {
    assert.ok(!direct.includes(id), id + ' 不应再是 .rail-navigation 的一级入口');
  }
  for (const id of ['btn-home', 'btn-assistant', 'btn-ran', 'btn-cloud', 'rail-group-rules', 'rail-group-applications']) {
    assert.ok(direct.includes(id), id + ' 仍应是 .rail-navigation 的一级入口');
  }
});

test('成员节点的入口属性一字未改', () => {
  const rail = railInner();
  const attrs = {
    'btn-rules': ['data-rules-entry'],
    'btn-rail-capabilities': ['data-action="open-capabilities"', 'aria-controls="hub-workspace"'],
    'btn-rail-memo': ['data-action="open-review"', 'aria-controls="hub-workspace"'],
    'btn-rail-accounts': ['aria-controls="account-page"'],
    'btn-research': ['data-chuxin-entry'],
    'btn-study': ['data-study-entry'],
    'btn-writing': ['data-writing-entry'],
  };
  for (const [id, needles] of Object.entries(attrs)) {
    const at = rail.indexOf(`id="${id}"`);
    assert.ok(at > 0, '缺少 ' + id);
    const tag = rail.slice(rail.lastIndexOf('<button', at), rail.indexOf('>', at) + 1);
    for (const needle of needles) assert.ok(tag.includes(needle), id + ' 丢了 ' + needle);
  }
  // 短标签仍是入口名
  for (const [id, label] of [['btn-rules', '规则'], ['btn-rail-capabilities', '资源'], ['btn-rail-accounts', '账号'],
    ['btn-rail-memo', '回顾'], ['btn-research', '投研'], ['btn-study', '学习'], ['btn-writing', '写作'], ['btn-wireless', '无线']]) {
    const at = rail.indexOf(`id="${id}"`);
    const block = rail.slice(at, rail.indexOf('</button>', at));
    assert.ok(block.includes(`<span class="btn-label">${label}</span>`), id + ' 的短标签应当是 ' + label);
  }
});

test('展开条默认收起：hidden + aria-expanded=false + aria-controls 指向真实菜单', () => {
  const rail = railInner();
  for (const spec of GROUP_SPECS) {
    const at = rail.indexOf(`id="${spec.trigger}"`);
    const tag = rail.slice(at, rail.indexOf('>', at));
    assert.ok(tag.includes('aria-expanded="false"'), spec.trigger + ' 初始应当 aria-expanded=false');
    assert.ok(tag.includes(`aria-controls="${spec.menu}"`), spec.trigger + ' 应当 aria-controls=' + spec.menu);
    const menuAt = rail.indexOf(`id="${spec.menu}"`);
    assert.ok(menuAt > 0, '缺少菜单 ' + spec.menu);
    const menuTag = rail.slice(rail.lastIndexOf('<div', menuAt), rail.indexOf('>', menuAt) + 1);
    assert.ok(/\shidden(\s|>)/.test(menuTag), spec.menu + ' 应当默认 hidden');
  }
});

test('每个 id 全文只出现一次（搬家不是复制）', () => {
  for (const id of ['btn-rules', 'btn-rail-capabilities', 'btn-rail-accounts', 'btn-rail-memo', 'btn-memory',
    'btn-research', 'btn-study', 'btn-writing', 'btn-wireless', 'btn-rail-group-rules', 'btn-rail-group-applications',
    'rail-group-rules-menu', 'rail-group-applications-menu']) {
    const hits = html.split(`id="${id}"`).length - 1;
    assert.ok(hits <= 1, id + ' 出现了 ' + hits + ' 次');
  }
  for (const id of ['btn-rail-group-rules', 'btn-rail-group-applications', 'rail-group-rules-menu', 'rail-group-applications-menu']) {
    assert.strictEqual(html.split(`id="${id}"`).length - 1, 1, id + ' 应当正好出现 1 次');
  }
});

test('样式表按顺序接在冷白工作区之后，rail 宽度变量没被改', () => {
  const navCss = html.indexOf('styles/navigation-hover.css');
  const groupCss = html.indexOf('styles/rail-groups.css');
  assert.ok(html.includes('styles/coldwhite-workspace.css'));
  assert.ok(navCss > 0 && groupCss > navCss, 'rail-groups.css 应当接在 navigation-hover.css 之后');
  assert.match(shellCss, /--hub-rail-slot:\s*162px/);
  assert.ok(fs.existsSync(path.join(ROOT, 'renderer', 'styles', 'rail-groups.css')));
  assert.ok(fs.existsSync(path.join(ROOT, 'renderer', 'rail-groups.js')));
});

test('分组交互先于长按排序安装，排序只管一级入口', () => {
  const first = fs.readFileSync(path.join(ROOT, 'renderer', 'session-first-navigation.js'), 'utf8');
  const groupAt = first.indexOf("require('./rail-groups')");
  const orderAt = first.indexOf("require('./navigation-order')");
  assert.ok(groupAt > 0, 'session-first-navigation.js 应当安装 rail-groups');
  assert.ok(orderAt > groupAt, '先装 rail-groups、再装 navigation-order（后者要读标题后缀）');
  const order = fs.readFileSync(path.join(ROOT, 'renderer', 'navigation-order.js'), 'utf8');
  assert.ok(order.includes('[...list.children]') && !order.includes("list.querySelectorAll('.btn-shell-nav')"),
    '长按排序只能排一级入口，不能把 dock 里的成员 append 出来');
});

test('社区版导出可过：应用组整段剥离，规则组保留，无悬空标记', () => {
  const stripped = applyStripMarkers(html, 'renderer/index.html');
  assert.ok(stripped.regions >= 3, '应当处理到多处剥离段');
  assert.ok(!stripped.text.includes('@community-'), '剥完不应残留社区标记');
  for (const id of ['btn-research', 'btn-study', 'btn-writing', 'btn-wireless', 'btn-rail-group-applications']) {
    assert.ok(!stripped.text.includes(`id="${id}"`), id + ' 应当已在社区版里剥掉');
  }
  assert.ok(stripped.text.includes('id="btn-rail-group-rules"'), '规则组在社区版里保留');
  assert.ok(stripped.text.includes('id="btn-rules"') && stripped.text.includes('id="btn-rail-capabilities"'), '规则组成员保留');
  assert.strictEqual((stripped.text.match(/class="rail-group"/g) || []).length, 1, '社区版只剩一个分组入口');
});

console.log('Running rail group navigation contract tests...');
console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
