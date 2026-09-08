'use strict';
// T2 冷杉 v2 · 舞台头部瘦身的契约。
//
// 头部原来同时挂着八件事：标题、状态药丸、模型徽章、目录 chip、API 用时、
// 缩放、文件/记忆、关闭，另外还有三个绝对定位浮层（视图切换、完成通知、复制对话）
// 压在右上角。结果是「我在哪」这件最基本的事要在三个地方各读一遍，
// 而模型名同时出现在头部徽章、卡片状态行和 composer chip 上 —— 三处必然分叉。
//
// T2 之后头部只回答三件事：
//   左 = 我在哪（面包屑：工作区 › 会话标题 + 状态点）
//   中 = 我在看什么（卡片 / PTY 分段控件）
//   右 = 我能做什么（文件 / 记忆 · ⋯ / ×）
//
// 这份测试守住「哪些节点不许再回来」和「面包屑到底由什么组成」。它是源码契约
// 测试，不起 DOM —— 真实渲染由 e2e-card-runtime-status-cdp.js 那条链路验。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const renderer = read('renderer/renderer.js');
const modelUi = read('renderer/model-ui.js');
const summary = read('core/session-status-summary.js');
const toolbarCss = read('renderer/styles/toolbar.css');
const stylesCss = read('renderer/styles.css');

// ── 删掉的东西不许以任何形式回来 ────────────────────────────────────────
assert.doesNotMatch(renderer, /terminal-model-badge/,
  '头部模型徽章已删：模型名只在 composer 底栏的 chip 上出现一次');
assert.doesNotMatch(modelUi, /terminal-model-badge/,
  'model-ui 不该再造头部徽章节点');
assert.doesNotMatch(renderer, /'terminal-status'|terminal-status-label|terminal-status-meta/,
  '头部状态药丸已删：文案归 composer 状态行，头部只留一个状态点');
assert.doesNotMatch(renderer, /metric-cwd|terminal-metrics-row/,
  '目录 chip 与整条 metrics 行已删：工作目录归面包屑，实时量归终端卡覆盖层');
assert.doesNotMatch(renderer, /terminal-title-row|terminal-title-section/,
  '头部压成单行后不再有 title-row / title-section 两层包裹');

// ── 面包屑的结构 ───────────────────────────────────────────────────────
assert.match(renderer, /crumb\.className = 'terminal-crumb'/, '面包屑容器必须存在');
assert.match(renderer, /workspaceBtn\.className = 'crumb-workspace'/, '面包屑第一段是工作区按钮');
assert.match(renderer, /crumbSep\.className = 'crumb-sep'/, '两段之间要有分隔符');
assert.match(renderer, /titleSpan\.className = 'terminal-title'/, '会话标题保留 .terminal-title');
assert.match(renderer, /statusDot\.className = 'terminal-crumb-dot'/, '状态点必须存在');
assert.match(renderer, /crumb\.append\(workspaceBtn, crumbSep, titleSpan, statusDot\)/,
  '面包屑的顺序就是「工作区 › 标题 状态点」，顺序本身是它的含义');

// 会话标题仍然点得动（重命名）；工作区段点开文件面板，和「文件」按钮同一条逻辑。
assert.match(renderer, /titleSpan\.addEventListener\('click', \(\) => startRename\(sessionId, titleSpan\)\)/,
  '标题保留点击重命名');
assert.match(renderer, /function openSessionFilePanel\(session\)/,
  '面包屑与「文件」按钮共用一个打开文件面板的入口');

// 整条面包屑 hover 给完整 cwd。标题自己不设 title，靠 HTML tooltip 往祖先找，
// 否则悬在标题上会被一个更没用的提示挡掉。
assert.match(renderer, /if \(session\.cwd\) crumb\.title = session\.cwd;/,
  '整条面包屑 hover 显示完整 cwd');

// ── 状态点只上色，不再铺四个子节点 ──────────────────────────────────────
const paintStart = renderer.indexOf('function paintTerminalRuntimeStatus(');
assert.ok(paintStart > 0, '找不到 paintTerminalRuntimeStatus');
const paintBody = renderer.slice(paintStart, renderer.indexOf('\n}', paintStart));
assert.match(paintBody, /terminal-crumb-dot \$\{runtime\.state\}/,
  '状态点的颜色直接跟 runtime truth 的 state 走，不另立一套映射');
assert.doesNotMatch(paintBody, /createElement/,
  '状态点没有子节点可造 —— 药丸的四个 span 全删了');

// ── 实时量覆盖层 ───────────────────────────────────────────────────────
assert.match(renderer, /metricsOverlay\.className = 'terminal-metrics'/, '实时量覆盖层必须存在');
assert.match(renderer, /mountTarget\.append\(header, metricsOverlay, termContainer\)/,
  '覆盖层挂在面板上而不是终端体里 —— 挂进去卡片视图会被 msg-overlay 整片盖住');
const metricsStart = renderer.indexOf('function renderMetricsRow(');
const metricsBody = renderer.slice(metricsStart, renderer.indexOf('\n}', metricsStart));
assert.match(metricsBody, /ctx \$\{pct\}%/, '覆盖层要有 ctx%');
assert.match(metricsBody, /\$\{tokens\} tok/, '覆盖层要有 token 数');
assert.match(metricsBody, /formatDuration\(session\.apiMs\)/, '覆盖层要有 API 用时');
assert.doesNotMatch(metricsBody, /session\.cwd|workspaceLabel/,
  '覆盖层只放实时量，工作目录不许回来');
// 2026-09-08 评审阻断：contextPct 在会话刚起来时是 null，Number(null) === 0 且
// Number.isFinite(0) 为真 —— 只写 Number() 会把「还不知道」显示成确定的 ctx 0%，
// 用户会据此以为上下文还空着。判据必须先确认它真的是个 number。
assert.doesNotMatch(metricsBody, /Number\(session\.contextPct\)/,
  'contextPct 不许直接 Number()：null 会被悄悄变成 0');
assert.match(metricsBody, /typeof session\.contextPct === 'number' \? session\.contextPct : NaN/,
  '未知的上下文占比必须落到 NaN 分支，从而整段不显示');

// ── 主进程改了工作区标签，面包屑要跟着刷新 ──────────────────────────────
// 2026-09-08 评审阻断：首轮结束后 main 会把临时区的名字换成正式项目名，经
// session-updated 推下来。这个标签 T2 之前长在 metrics 的目录 chip 上，由
// updateActiveMetricsRow 顺带刷新；搬进面包屑之后必须自己刷。
const sessionUpdatedStart = renderer.indexOf("ipcRenderer.on('session-updated'");
assert.ok(sessionUpdatedStart > 0, '找不到 session-updated 处理器');
const sessionUpdatedBody = renderer.slice(sessionUpdatedStart, sessionUpdatedStart + 5200);
assert.match(sessionUpdatedBody, /local\.workspaceLabel = session\.workspaceLabel/,
  'session-updated 仍然要接收 workspaceLabel');
assert.match(sessionUpdatedBody, /updateActiveCrumbWorkspace\(\);/,
  '收到新的 workspaceLabel 之后必须重画面包屑，否则一直显示旧标签');

// ── 视图切换进头部中央 ─────────────────────────────────────────────────
assert.match(renderer, /header\.insertBefore\(viewToggle, headerActions\)/,
  '视图切换收进头部，排在动作区之前 = 视觉上的中央');
assert.match(renderer, /document\.querySelector\('\.view-toggle'\)/,
  '仍然复用 index.html 里那一个节点，靠 preserveAndClearTerminalPanel 跨会话保留');

// ── ⋯ 菜单收纳缩放与完成通知 ──────────────────────────────────────────
assert.match(renderer, /mkOverflowItem\('放大界面'/);
assert.match(renderer, /mkOverflowItem\('缩小界面'/);
assert.match(renderer, /mkOverflowItem\('重置缩放'/);
assert.match(renderer, /mkOverflowItem\('完成通知'/, '完成通知收进 ⋯ 菜单');
assert.match(renderer, /notificationToggleEl\.click\(\)/,
  '菜单项只转发点击，开关逻辑仍由 completion-notification-toggle.js 独占');
assert.match(renderer, /if \(opening\) syncNotifyItem\(\);/,
  '开菜单那一刻才读开关状态，否则展示的是过期的开/关');
assert.match(toolbarCss, /\.terminal-panel:not\(\.home-active\) > \.completion-notification-toggle \{ display: none; \}/,
  '浮层节点隐藏，但只在舞台上隐藏 —— 主页用的是同一个节点（会被搬进 #home-notification-slot），'
  + '而搬运发生在 homeWorkbench.render() 里；只要还没搬，它就仍是 terminal-panel 的直接子节点，'
  + '不加 :not(.home-active) 就会在主页上凭空消失一段时间');

// ── 动作区：文件 / 记忆 · ⋯ / × 四个 ──────────────────────────────────
assert.match(renderer, /headerActions\.append\(filesBtn, memoryBtn, overflowWrap, closeBtn\)/,
  '动作区只剩四个按钮');
assert.doesNotMatch(renderer, /<span>文件<\/span>/, '文件按钮改成纯图标');
assert.match(toolbarCss, /\.header-overflow-wrap \{\s*\n\s*margin-left: 8px;/,
  '两组动作之间留 8px：文件/记忆 是对会话做事，⋯/× 是对窗口做事');

// ── 卡片状态行不再说模型名和工作目录 ────────────────────────────────────
assert.match(summary, /function buildStageStatusSummary\(session\)/,
  '舞台状态行有自己的摘要函数');
const stageStart = summary.indexOf('function buildStageStatusSummary(');
const stageBody = summary.slice(stageStart, summary.indexOf('\n}', stageStart));
assert.doesNotMatch(stageBody, /sessionModelLabel|session\.cwd/,
  '舞台摘要里不许出现模型名和工作目录');
const cardStatusStart = renderer.indexOf('function updateCardSessionStatus(');
const cardStatusBody = renderer.slice(cardStatusStart, renderer.indexOf('\n}', cardStatusStart));
assert.doesNotMatch(cardStatusBody, /\['model'|\['cwd'/,
  'card-session-status 只渲染实时量');
assert.match(renderer, /buildStageStatusSummary\(session\)/,
  '舞台读的是舞台那份摘要，不是群聊共用的那份');
// 群聊成员行仍然要显示模型名，那是它唯一的落点 —— 共享函数不许被顺手削掉。
assert.match(summary, /function buildSessionStatusSummary\(session\)[\s\S]{0,400}sessionModelLabel\(session\)/,
  '群聊用的通用摘要必须保留 model 字段');

// ── 样式表挂上了 ───────────────────────────────────────────────────────
assert.match(stylesCss, /@import url\('\.\/styles\/toolbar\.css'\);/, 'toolbar.css 必须被引入');
assert.match(toolbarCss, /--stage-card-radius: 12px;/, '舞台卡 12px 圆角');
assert.match(toolbarCss, /--stage-header-h: 44px;/, '头部单行 44px');

console.log('terminal header slim contract ok');
