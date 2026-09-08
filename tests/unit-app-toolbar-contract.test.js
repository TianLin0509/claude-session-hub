'use strict';
// T6 冷杉 v2 · 统一工具栏的契约。
//
// 原生标题栏隐掉之后，#app-toolbar 就是窗口最顶上那 44px：它同时是标题栏
// （可拖动、双击最大化、右端给系统三键留位）和 T2 那条舞台头部的常驻版。
//
// 这份测试守三件事，都是「错了不会有人当场发现、但每天都在硌人」的那类：
//   1. 节点顺序。左中右三段的次序就是它的含义，顺序错了整条栏就读不通。
//   2. drag / no-drag 标记。少标一个 no-drag，那个按钮**连 click 都收不到** ——
//      表现是「点了没反应」，很容易被误判成业务逻辑坏了。
//   3. 逃生口。CLAUDE_HUB_NATIVE_TITLEBAR=1 必须能把原生标题栏整个还回来，
//      并且此时不许再调 setTitleBarOverlay（那个调用在原生模式下会抛）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const html = read('renderer/index.html');
const renderer = read('renderer/renderer.js');
const mainJs = read('main.js');
const toolbarCss = read('renderer/styles/toolbar.css');

// ── 1. 节点顺序：侧栏开关 › 面包屑 › 视图切换 › 动作区 › 系统按钮留位 ──────
const toolbarStart = html.indexOf('<header class="app-toolbar" id="app-toolbar">');
assert.ok(toolbarStart > 0, '#app-toolbar 必须在 index.html 里');
const toolbarHtml = html.slice(toolbarStart, html.indexOf('</header>', toolbarStart));
const order = [
  'id="btn-expand-sidebar"',
  'id="toolbar-crumb"',
  'class="view-toggle"',
  'id="toolbar-actions"',
  'id="toolbar-window-controls"',
];
let cursor = -1;
for (const marker of order) {
  const at = toolbarHtml.indexOf(marker);
  assert.ok(at > 0, `工具栏里缺少 ${marker}`);
  assert.ok(at > cursor, `工具栏节点顺序错了：${marker} 应该排在前一项之后`);
  cursor = at;
}

// 工具栏必须在 #app-container 顶部、在配额 ticker 之前 —— 它是窗口最上面那一行，
// 顶上再压任何东西，「隐藏标题栏」这件事就白做了。
const containerAt = html.indexOf('<div class="app-container" id="app-container">');
assert.ok(containerAt > 0 && containerAt < toolbarStart, '工具栏必须在 #app-container 内');
assert.ok(toolbarStart < html.indexOf('id="quota-ticker"'), '工具栏必须排在配额 ticker 之前');

// 这两个节点已经从 #terminal-panel 里搬走了。留在原地 = 两份同名节点，
// querySelector 会随机命中一个。
const panelAt = html.indexOf('id="terminal-panel"');
const panelHtml = html.slice(panelAt, html.indexOf('id="meeting-room-panel"'));
assert.doesNotMatch(panelHtml, /class="view-toggle"/,
  '视图切换已上移到工具栏，不许在 #terminal-panel 里留一份');
assert.doesNotMatch(panelHtml, /id="btn-expand-sidebar"/,
  '侧栏开关已上移到工具栏，不许在 #terminal-panel 里留一份');

// ── 2. 拖动区标记 ──────────────────────────────────────────────────────
// 整条 drag，可点的东西逐个标回 no-drag。顺序不能反：在 drag 区里，
// 没标 no-drag 的元素连 click 事件都收不到。
const toolbarRuleAt = toolbarCss.indexOf('.app-toolbar {');
assert.ok(toolbarRuleAt > 0, 'toolbar.css 里要有 .app-toolbar 规则');
const toolbarRule = toolbarCss.slice(toolbarRuleAt, toolbarCss.indexOf('}', toolbarRuleAt));
assert.match(toolbarRule, /-webkit-app-region: drag;/, '整条工具栏可拖窗口');
const noDragAt = toolbarCss.indexOf('-webkit-app-region: no-drag;');
assert.ok(noDragAt > toolbarRuleAt, '必须把可点元素标回 no-drag');
const noDragSelectors = toolbarCss.slice(toolbarCss.lastIndexOf('.app-toolbar button', noDragAt), noDragAt);
for (const selector of ['.app-toolbar button', '.view-toggle', '.header-overflow-menu']) {
  assert.ok(noDragSelectors.includes(selector), `no-drag 名单缺少 ${selector}`);
}

// ── 3. 逃生口 ──────────────────────────────────────────────────────────
assert.match(mainJs, /const nativeTitleBar = process\.env\.CLAUDE_HUB_NATIVE_TITLEBAR === '1';/,
  '必须有 CLAUDE_HUB_NATIVE_TITLEBAR 逃生口');
assert.match(mainJs, /\.\.\.\(nativeTitleBar \? \{\} : \{\s*\n\s*titleBarStyle: 'hidden',/,
  '逃生口打开时整段隐藏标题栏的配置都不下发，而不是下发之后再想办法撤销');
assert.match(mainJs, /titleBarOverlay: \{ \.\.\.HUB_TITLE_BAR_OVERLAY_DEFAULT \}/,
  '系统窗口按钮由 titleBarOverlay 提供');
assert.match(mainJs, /height: 44,/, 'overlay 高度要和工具栏的 44px 对齐');
const applyAt = mainJs.indexOf('function applyHubTitleBarOverlay(');
assert.ok(applyAt > 0, '找不到 applyHubTitleBarOverlay');
const applyBody = mainJs.slice(applyAt, mainJs.indexOf('\n}', applyAt));
assert.match(applyBody, /if \(mainWindow\._hubNativeTitleBar\) return null;/,
  '原生标题栏模式下不许调 setTitleBarOverlay —— 那个调用在这种模式下会抛');
assert.match(applyBody, /try \{[\s\S]*setTitleBarOverlay/,
  '换个颜色而已，失败不该让异常冒泡');
assert.match(renderer, /process\.env\.CLAUDE_HUB_NATIVE_TITLEBAR === '1'/,
  '渲染层也要知道逃生口开着：右端那 138px 留位在原生模式下是多余的');
assert.match(toolbarCss, /\.app-container\.native-titlebar \.toolbar-window-controls \{ display: none; \}/,
  '原生模式下不留系统按钮位');

// ── 窗口标题与任务栏识别不许被动到 ────────────────────────────────────
// 桌面上会同时挂着好几个 Hub 实例，标题里的 PID + 版本号是唯一能分辨
// 「这个窗口跑的是不是我刚改的代码」的信号。
assert.match(mainJs, /title: _hubTitle,/, '窗口标题保持不变');
assert.match(mainJs, /mainWindow\.on\('page-title-updated', \(e\) => \{ e\.preventDefault\(\); \}\);/,
  'page-title-updated 的 preventDefault 保持不变，否则标题会被页面 <title> 盖掉');

// ── 面包屑常驻 + 按视图刷新 ────────────────────────────────────────────
assert.match(renderer, /function paintAppToolbarForSession\(sessionId, session, cached\)/,
  '会话视图的面包屑与动作区由这一处画');
assert.match(renderer, /function paintAppToolbarForView\(label\)/,
  '非会话视图只写视图名');
const viewPaintAt = renderer.indexOf('function paintAppToolbarForView(label)');
const viewPaintBody = renderer.slice(viewPaintAt, renderer.indexOf('\n}', viewPaintAt));
assert.match(viewPaintBody, /toolbarActionsEl\.hidden = true;/,
  '主页 / 投研 / 学习 / 开发下动作区必须整块收起 —— 那四个动作都是对某个会话做的');
assert.match(renderer, /\{ id: 'chuxin-panel', label: '投研' \}/);
assert.match(renderer, /\{ id: 'study-panel', label: '学习' \}/);
assert.match(renderer, /\{ id: 'ran-panel', label: '开发' \}/);
assert.match(renderer, /return '主页';/, '舞台处于 home-active 时面包屑显示「主页」');
assert.match(renderer, /new MutationObserver\(scheduleAppToolbarRefresh\)/,
  '视图切换分散在好几个模块里，工具栏按屏幕反推而不是等每个切换者通知');

// 舞台不再自己画头部。
assert.match(renderer, /if \(!embedded\) paintAppToolbarForSession\(sessionId, session, cached\);/,
  'showTerminal 只负责请工具栏刷新，不再造头部节点');
assert.doesNotMatch(renderer, /header\.className = 'terminal-header'/,
  '舞台头部已删：终端直接顶到卡片顶边');

// ── 双击最大化 ─────────────────────────────────────────────────────────
assert.match(mainJs, /ipcMain\.handle\('hub:toggle-maximize'/, '双击要有人真的去最大化窗口');
assert.match(renderer, /appToolbarEl\.addEventListener\('dblclick'/, '双击工具栏空白处最大化 / 还原');
const dblAt = renderer.indexOf("appToolbarEl.addEventListener('dblclick'");
const dblBody = renderer.slice(dblAt, renderer.indexOf('\n  });', dblAt));
assert.match(dblBody, /event\.target\.closest\('button, a, input, select, \.terminal-crumb, \.view-toggle'\)/,
  '只认空白处：落在控件上的双击是在操作那个控件，不该顺手改变窗口大小');

// ── 皮肤切换时窗口按钮区跟色 ──────────────────────────────────────────
assert.match(renderer, /function syncTitleBarOverlayColors\(\)/, '皮肤换了要把新颜色发给主进程');
assert.match(renderer, /attributeFilter: \['data-theme'\]/,
  'theme-controller.js 本轮禁改，所以盯 <html> 的 data-theme，而不是去它内部挂回调');
assert.match(renderer, /ipcRenderer\.send\('hub:titlebar-overlay'/);
assert.match(mainJs, /ipcMain\.on\('hub:titlebar-overlay'/);
// 主进程只做格式校验和兜底，不再存第二份调色板 —— 否则加一套皮肤要改两个地方，
// 而那两个地方没有任何机制保证一致。
assert.match(mainJs, /function normalizeOverlayColor\(value, fallback\)/);

// ── 舞台卡：没有头部之后，让位量必须归零 ──────────────────────────────
// --term-header-h 由 observeTerminalPanelChrome 按真实 header 高度写，头部没了
// 就是 0。但兜底值还写 44px 的话，观察器跑第一帧之前会凭空空出一条带子。
assert.doesNotMatch(toolbarCss, /var\(--term-header-h, 44px\)/,
  '舞台已经没有头部，--term-header-h 的兜底值必须是 0');

console.log('app toolbar contract ok');
