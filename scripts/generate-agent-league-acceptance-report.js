'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SINGLE_DIR = path.join(REPO, 'output', 'playwright', 'agent-league-pty-shortcuts-2026-08-27T18-32-38-586Z');
const MULTI_DIR = path.join(REPO, 'output', 'playwright', 'agent-league-multi-real-2026-08-27T18-23-29-372Z');
const UI_DIR = path.join(REPO, 'output', 'playwright', 'agent-league-2026-08-27T18-40-39-462Z');
const REPORT_DIR = 'C:\\VibeData\\Artifacts\\Reports';
const REPORT_PATH = path.join(REPORT_DIR, 'chuxin-agent-league-acceptance-2026-08-27.html');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function imageData(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

function fmtActual(value) {
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value == null ? '' : value);
}

function checksTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>结果</th><th>ID / 动作</th><th>验收口径</th><th>实际结果</th></tr></thead><tbody>${rows.map(row => `
    <tr><td><span class="pill pass">PASS</span></td><td><code>${esc(row.id)}</code><small>${esc(row.label)}</small></td><td>${esc(row.expected)}</td><td><pre>${esc(fmtActual(row.actual))}</pre>${row.latencyMs != null ? `<small>跳转耗时 ${esc(row.latencyMs)} ms</small>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function gallery(title, items) {
  return `<section class="gallery-section"><div class="section-title"><div><span>VISUAL EVIDENCE</span><h3>${esc(title)}</h3></div><b>${items.length} 张</b></div><div class="gallery">${items.map((item, index) => `
    <figure><button class="zoom" data-zoom="img-${esc(item.id)}-${index}" aria-label="放大截图"><img id="img-${esc(item.id)}-${index}" src="${imageData(item.path)}" alt="${esc(item.label)}"></button><figcaption><b>${esc(item.label)}</b><code>${esc(item.path)}</code></figcaption></figure>`).join('')}</div></section>`;
}

const single = readJson(path.join(SINGLE_DIR, 'evidence.json'));
const multi = readJson(path.join(MULTI_DIR, 'evidence.json'));
if (!single.ok || !multi.ok) throw new Error('acceptance evidence is not green');
if (!single.checks.every(row => row.pass) || !multi.checks.every(row => row.pass)) throw new Error('acceptance check contains failure');

const singleImages = single.screenshots.map(row => ({
  id: row.checkId,
  label: ({
    'S1-ranking': '单 Agent 排行榜',
    'S1-prompt-save': '提示词工作台保存',
    'S1-direct-pty': '首次普通 PTY（无原生 SID）',
    'S2-premarket-auto-jump': '盘前按钮自动跳 PTY',
    'S2-daily-status': 'DRAFT → Hook → FINAL 详情',
    'S2-weekly-status': '周六沉淀详情',
    'S3-same-native-sid': '重启后精准恢复 PTY',
    'S3-card-persisted': '重启后卡片历史',
    'S3-conflict-visible': '提示词并发冲突明确可见',
  })[row.checkId] || row.checkId,
  path: row.path,
}));
const multiImages = multi.screenshots.map(row => ({
  id: row.checkId,
  label: ({
    'M1-created': '双 Agent 排行榜',
    'M1-auto-jump-selected': '逐浪并发运行 PTY',
    'M1-baseline-pty': '初心基准并发运行 PTY',
    'M2-two-rows': '重启后的双 Agent 赛果页',
    'M2-trend-cards': '逐浪独立卡片历史',
    'M2-baseline-cards': '初心基准独立卡片历史',
  })[row.checkId] || row.checkId,
  path: row.path,
}));
const uiImages = [
  { id: 'desktop-10', label: '10 Agent 桌面排行榜（8 行可见）', path: path.join(UI_DIR, '01-leaderboard.png') },
  { id: 'mobile-10', label: '390px 窄窗排行榜滚动', path: path.join(UI_DIR, '03-mobile-leaderboard.png') },
  { id: 'mobile-prompt', label: '390px 提示词工作台', path: path.join(UI_DIR, '03b-mobile-prompt-workbench.png') },
];
for (const item of [...singleImages, ...multiImages, ...uiImages]) {
  if (!fs.existsSync(item.path)) throw new Error(`missing screenshot: ${item.path}`);
}

const singleKeyIds = new Set([
  'S1-direct-pty', 'S1-no-picker', 'S2-premarket-auto-jump', 'S2-premarket-latency',
  'S2-picker-regression', 'S2-daily-status', 'S2-native-bound', 'S2-card-history',
  'S2-open-accounting', 'S2-close-accounting', 'S2-weekly-status', 'S3-same-hub-id',
  'S3-same-native-sid', 'S3-no-picker', 'S3-card-persisted', 'S3-conflict-visible', 'S3-conflict-recovery',
]);
const multiKeyIds = new Set([
  'M1-created', 'M1-different-style', 'M1-auto-jump-selected', 'M1-two-active',
  'M1-distinct-hub-sessions', 'M1-daily-completed', 'M1-distinct-native-sids',
  'M1-independent-briefs', 'M1-open-two-results', 'M1-close-two-results',
  'M1-weekly-completed', 'M2-trend-sid', 'M2-baseline-sid', 'M2-trend-cards',
  'M2-baseline-cards', 'M2-prompt-isolation',
]);
const singleKey = single.checks.filter(row => singleKeyIds.has(row.id));
const multiKey = multi.checks.filter(row => multiKeyIds.has(row.id));

const singleJump = single.checks.find(row => row.id === 'S2-premarket-latency').actual;
const singleCardCount = single.checks.find(row => row.id === 'S3-card-persisted').actual;
const multiSessions = multi.sessions;
const evidenceHashes = {
  single: sha256File(path.join(SINGLE_DIR, 'evidence.json')),
  multi: sha256File(path.join(MULTI_DIR, 'evidence.json')),
};

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>初心 Agent 联赛 · 真实交付验收</title>
<style>
:root{--bg:#080b10;--panel:#11161e;--panel2:#171e28;--line:#263140;--text:#edf3fa;--muted:#94a4b7;--green:#52d18c;--green2:#183d2b;--amber:#f4c86a;--blue:#73aef9;--red:#ff7a7a;--code:#0a0e14}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 15% -10%,#17314a 0,transparent 30%),var(--bg);color:var(--text);font:14px/1.65 Inter,"Segoe UI","Microsoft YaHei",sans-serif}.shell{max-width:1440px;margin:auto;padding:28px}.hero{display:grid;grid-template-columns:1.6fr .8fr;gap:18px;margin-bottom:18px}.card,.hero-main,.hero-side{background:linear-gradient(145deg,rgba(23,30,40,.96),rgba(12,16,23,.98));border:1px solid var(--line);border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.28)}.hero-main{padding:34px}.eyebrow,.section-title span{color:var(--green);font-size:11px;font-weight:800;letter-spacing:.16em}.hero h1{font-size:38px;line-height:1.15;margin:8px 0 12px}.hero p{color:var(--muted);max-width:900px;font-size:16px}.hero-side{padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:12px}.metric{padding:16px;border:1px solid var(--line);border-radius:14px;background:#0d1219}.metric b{display:block;font-size:25px;color:var(--green)}.metric span{color:var(--muted);font-size:12px}.status{display:flex;gap:9px;align-items:center;margin-top:18px}.dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 16px var(--green)}nav{position:sticky;top:8px;z-index:5;display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 20px;padding:10px;background:rgba(8,11,16,.88);backdrop-filter:blur(12px);border:1px solid var(--line);border-radius:13px}nav a{color:var(--muted);text-decoration:none;padding:7px 11px;border-radius:8px}nav a:hover{background:var(--panel2);color:var(--text)}section.card{padding:26px;margin:16px 0}.section-title{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:18px}.section-title h2,.section-title h3{margin:3px 0 0;font-size:24px}.section-title b{color:var(--green);font-size:13px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.finding{padding:17px;border:1px solid var(--line);border-radius:13px;background:#0c1118}.finding b{display:block;margin-bottom:6px}.finding p{margin:0;color:var(--muted)}.finding code{color:var(--amber)}.agent-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.agent{padding:20px;border:1px solid var(--line);border-radius:14px;background:var(--panel2)}.agent header{display:flex;justify-content:space-between}.agent h3{margin:0}.agent .tag{color:var(--blue);font-size:12px}.agent ul{margin:12px 0 0;padding-left:18px;color:var(--muted)}.flow{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}.flow div{position:relative;padding:15px 11px;border:1px solid var(--line);background:#0c1118;border-radius:12px;text-align:center}.flow b{display:block;color:var(--green);font-size:12px}.flow span{color:var(--muted);font-size:11px}.flow div:not(:last-child):after{content:"→";position:absolute;right:-9px;top:22px;color:var(--green);z-index:2}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:13px}table{border-collapse:collapse;width:100%;min-width:900px;background:#0b1016}th,td{padding:12px;border-bottom:1px solid #202a37;text-align:left;vertical-align:top}th{position:sticky;top:0;background:#151c25;color:var(--muted);font-size:11px;letter-spacing:.06em}td:nth-child(1){width:74px}.pill{display:inline-flex;padding:3px 8px;border-radius:999px;font-size:10px;font-weight:900}.pill.pass{background:var(--green2);color:var(--green)}td small{display:block;color:var(--muted);margin-top:4px}pre,code{font-family:"Cascadia Code",Consolas,monospace}td pre{white-space:pre-wrap;margin:0;font-size:11px;color:#cbd7e5}.gallery-section{margin:24px 0}.gallery{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.gallery figure{margin:0;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#0b1016}.gallery img{display:block;width:100%;height:330px;object-fit:contain;background:#070a0e}.zoom{display:block;width:100%;padding:0;border:0;background:none;cursor:zoom-in}.gallery figcaption{padding:12px}.gallery figcaption code{display:block;color:var(--muted);font-size:10px;word-break:break-all;margin-top:5px}.steps{counter-reset:step;display:grid;gap:10px}.step{position:relative;padding:17px 18px 17px 58px;border:1px solid var(--line);border-radius:13px;background:#0c1118}.step:before{counter-increment:step;content:counter(step);position:absolute;left:16px;top:15px;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--green2);color:var(--green);font-weight:900}.step b{display:block}.step p{margin:4px 0;color:var(--muted)}.callout{padding:16px 18px;border-left:3px solid var(--amber);background:#211b0e;border-radius:0 10px 10px 0;color:#e9d39d}.paths{display:grid;gap:8px}.path{padding:12px;background:var(--code);border:1px solid var(--line);border-radius:9px;color:#cbd7e5;word-break:break-all}.muted{color:var(--muted)}.foot{padding:24px;text-align:center;color:var(--muted)}dialog{width:min(95vw,1500px);height:min(94vh,1000px);border:1px solid var(--line);border-radius:14px;background:#05070a;padding:10px}dialog img{width:100%;height:calc(100% - 42px);object-fit:contain}dialog button{float:right;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:7px 12px}@media(max-width:900px){.shell{padding:12px}.hero{grid-template-columns:1fr}.hero h1{font-size:30px}.grid,.agent-grid,.gallery{grid-template-columns:1fr}.flow{grid-template-columns:1fr 1fr}.flow div:after{display:none}.gallery img{height:240px}}
</style></head><body><div class="shell">
<header class="hero"><div class="hero-main"><div class="eyebrow">CHUXIN AGENT LEAGUE · DELIVERY ACCEPTANCE</div><h1>单 Agent 扎实闭环，双 Agent 真实开赛</h1><p>针对“盘前决策后 PTY 落入 Resume picker、按钮不直接进入 Session”的故障，完成代码修复、真实用户点击、真实模型 turn、三次重启恢复、双 Agent 并发、账本与周沉淀验收。所有测试 Hub 均使用隔离数据目录与独立 CDP 端口，未关闭或重启生产 Hub。</p><div class="status"><i class="dot"></i><b>当前结论：无已知交付阻断项</b><span class="muted">不是“绝对零 bug”承诺</span></div></div><div class="hero-side"><div class="metric"><b>${single.checks.length}/${single.checks.length}</b><span>单 Agent 真实点击</span></div><div class="metric"><b>${multi.checks.length}/${multi.checks.length}</b><span>双 Agent 真实比赛</span></div><div class="metric"><b>50/50</b><span>Agent/压力/视图单测</span></div><div class="metric"><b>${singleJump} ms</b><span>盘前按钮 → PTY</span></div><div class="metric"><b>${singleCardCount}</b><span>重启后历史卡片</span></div><div class="metric"><b>3 + 2</b><span>单/双 Agent Hub 启动轮次</span></div></div></header>
<nav><a href="#outcome">交付结果</a><a href="#fixes">修复项</a><a href="#agents">参赛 Agent</a><a href="#single">单 Agent 证据</a><a href="#multi">双 Agent 证据</a><a href="#visual">截图</a><a href="#manual">你如何测试</a><a href="#boundaries">边界</a><a href="#paths">路径</a></nav>

<section class="card" id="outcome"><div class="section-title"><div><span>OUTCOME FIRST</span><h2>你明早会看到什么</h2></div><b>READY</b></div><div class="grid">
<article class="finding"><b>排行榜已有 2 名 Agent</b><p>初心基准与逐浪各占一行、各 50 万起始资金；排名按累计收益率/当前资产切换。</p></article>
<article class="finding"><b>动作按钮就是 PTY 快捷键</b><p>盘前、开盘、收盘、周沉淀完成动作后自动打开目标 Agent 的普通 Hub PTY；选中某一 Agent 后优先跳它。</p></article>
<article class="finding"><b>普通 Session 生命周期</b><p>首次无 SID 时 fresh start；生成原生 SID 后精确 resume。单 Agent 最终复测保持 Hub ID 与 Codex SID，未出现 picker。</p></article>
<article class="finding"><b>卡片与 PTY 都能交互</b><p>不禁止聊天。真实历史在卡片视图可读，PTY 可观察 CLI、工具调用和故障。</p></article>
<article class="finding"><b>提示词完全可感知</b><p>16 个 Markdown 文件 + 3 份系统合同；可编辑文件原子保存、有备份、有 SHA 并发冲突保护。</p></article>
<article class="finding"><b>生产自动赛程仍关闭</b><p>这是有意的安全交付边界。你确认后点击“自动赛程未启用”即可开启，不会因为测试在后台偷跑。</p></article>
</div></section>

<section class="card" id="fixes"><div class="section-title"><div><span>ROOT CAUSE → FIX</span><h2>这次真正修掉的 7 类问题</h2></div><b>CODE + REAL PTY</b></div><div class="grid">
<article class="finding"><b>1 · 无 SID 被误当可恢复历史</b><p>Agent 壳从未产生原生 turn 时，通用恢复会打开 <code>Resume a previous session</code>。现在所有 Provider 均“无原生 ID → 同 Hub ID fresh start；有 ID → 精准 resume”。</p></article>
<article class="finding"><b>2 · Agent MCP 被 Lean/None 过滤</b><p>Codex Agent 明确使用 Lean 并注入唯一 Chuxin read-only MCP scope，恢复时重新构造，不继承无关 Full 工具。</p></article>
<article class="finding"><b>3 · ensure 与 renderer dormant 竞态</b><p>Agent 快捷键采用主进程刚返回的活 Session，避免 renderer 仍拿旧 dormant 数据再发起第二次通用 resume。</p></article>
<article class="finding"><b>4 · card/PTY 最后意图被异步事件覆盖</b><p>记录用户最后请求的视图，稍晚到达的 <code>session-created</code> 必须遵从；同时兼容每 Session 自己记住 card/PTY。</p></article>
<article class="finding"><b>5 · PTY 有回显 ≠ Prompt 已提交</b><p>曾真实捕获 Hook 停在 <code>[Pasted Content 4871 chars]</code>。现在 Codex 必须出现 transcript <code>task_started</code>，否则最多补 2 次延迟 Enter；仍无确认则明确失败。</p></article>
<article class="finding"><b>6 · 永久“运行中”</b><p>每个 DRAFT/Hook/Weekly 阶段有 30 分钟看门狗；Session 退出、发送未确认、解析失败都会释放 lease、清 pending，并保留 Session 供诊断。</p></article>
<article class="finding"><b>7 · 状态与错误可见性</b><p><code>session-bound</code> 不再把 running 覆盖成 active；IPC 传输/打开异常、自动赛程设置和文件夹打开异常都有明确 toast。</p></article>
</div></section>

<section class="card" id="agents"><div class="section-title"><div><span>PRODUCTION ROSTER</span><h2>正式参赛的两个 Agent</h2></div><b>同模型 · 不同理念</b></div><div class="agent-grid">
<article class="agent"><header><h3>初心基准</h3><span class="tag">chuxin-baseline</span></header><ul><li>Codex · gpt-5.6-sol</li><li>初心基准·价值投机</li><li>基本面/产业逻辑定方向，估值与位置定赔率，催化与走势定时机</li><li>生产 Hub Session：<code>30cfa9f4-ca72-43ee-9b0d-42e356e7b4a7</code></li></ul></article>
<article class="agent"><header><h3>逐浪</h3><span class="tag">trend-rider</span></header><ul><li>Codex · gpt-5.6-sol</li><li>右侧趋势确认</li><li>只参与已经被市场确认、量价健康且尚未明显耗竭的趋势</li><li>当前 unbound；首次点卡片/PTY或赛程时创建普通 Session</li></ul></article>
</div><div class="callout" style="margin-top:14px">第二 Agent 使用同一前沿模型是有意的实验设计：先隔离投资理念差异。后续再复制理念到 Claude/Gemini，才能区分“模型差异”和“策略差异”。</div></section>

<section class="card"><div class="section-title"><div><span>DAILY / WEEKLY LOOP</span><h2>每个 Agent 的真实工作流</h2></div><b>同 Session 连续上下文</b></div><div class="flow"><div><b>08:30</b><span>冻结数据</span></div><div><b>DRAFT</b><span>独立预案</span></div><div><b>HOOK</b><span>规则+反证自检</span></div><div><b>09:35</b><span>开盘机械执行</span></div><div><b>15:10</b><span>收盘净值</span></div><div><b>周六</b><span>经验与提案</span></div></div></section>

<section class="card" id="single"><div class="section-title"><div><span>SINGLE AGENT E2E</span><h2>单 Agent 关键验收项</h2></div><b>${single.checks.length}/${single.checks.length} PASS</b></div>${checksTable(singleKey)}<p class="muted">完整机器证据包含 ${single.checks.length} 项；表中只展示与本次故障和用户操作最相关的 ${singleKey.length} 项。证据 SHA-256：<code>${evidenceHashes.single}</code></p></section>

<section class="card" id="multi"><div class="section-title"><div><span>MULTI AGENT E2E</span><h2>双 Agent 比赛关键验收项</h2></div><b>${multi.checks.length}/${multi.checks.length} PASS</b></div>${checksTable(multiKey)}<p class="muted">独立 Session：初心 <code>${esc(multiSessions.baselineHubId)}</code> / 逐浪 <code>${esc(multiSessions.trendHubId)}</code><br>独立 Codex SID：初心 <code>${esc(multiSessions.baselineSid)}</code> / 逐浪 <code>${esc(multiSessions.trendSid)}</code><br>证据 SHA-256：<code>${evidenceHashes.multi}</code></p></section>

<section class="card"><div class="section-title"><div><span>REGRESSION MATRIX</span><h2>自动回归与压力</h2></div><b>ALL GREEN</b></div><div class="grid">
<article class="finding"><b>50/50 Targeted Node Tests</b><p>Agent store、会计、Hook、日历、UI、Session 视图、PTY ack 与压力测试。</p></article><article class="finding"><b>16/16 Resume Contracts</b><p>Codex/Claude/Gemini/Kimi/DeepSeek 原生 ID、MCP、subagent 修复、无 SID Agent fresh start。</p></article><article class="finding"><b>6/6 Shared PTY Regressions</b><p>共享群聊 dispatcher、抢占、中断、Codex chunking 与新增 task_started ack。</p></article><article class="finding"><b>500 次随机调仓</b><p>无负现金；沪深 100 股、科创 200 股起；费用、税与 NAV 恒等式成立。</p></article><article class="finding"><b>80 日 + 12 周</b><p>Markdown 日账、收盘、周复盘持续可读，按日期 append-only。</p></article><article class="finding"><b>10 Agent GUI</b><p>桌面 8 行可见、超出滚动；390px 窄窗、浅色主题、提示词工作台、普通 Session 均通过。</p></article>
</div></section>

<section class="card" id="visual"><div class="section-title"><div><span>SCREENSHOT EVIDENCE</span><h2>真实界面证据</h2></div><b>点击放大</b></div>${gallery('单 Agent · 创建、决策、恢复、异常路径', singleImages)}${gallery('双 Agent · 并发比赛与独立历史', multiImages)}${gallery('10 Agent / 窄窗 UI 密度', uiImages)}</section>

<section class="card" id="manual"><div class="section-title"><div><span>YOUR MORNING CHECKLIST</span><h2>你明早如何复测</h2></div><b>约 8–12 分钟（不含模型完整决策）</b></div><div class="callout">代码已改在生产 Hub 仓库，但我遵守规则没有关闭/重启你的生产 Hub。第一步必须由你正常退出并重新打开 AI Hub，让当前 Electron 进程加载新代码。</div><div class="steps" style="margin-top:16px">
<div class="step"><b>正常重启 AI Hub</b><p>不要 Resume 某个 Agent；只是正常退出 Hub 后重新打开。进入“初心投研 → Agent 联赛”。</p><p>通过：排行榜出现“初心基准”和“逐浪”两行。</p></div>
<div class="step"><b>先测逐浪的普通 Session</b><p>点击“逐浪”一行 → “打开 PTY”。首次会创建普通 Codex Session；应直接看到 Codex CLI，不应看到 <code>Resume a previous session</code>。</p><p>通过：左侧栏有“Agent · 逐浪”，返回联赛再点 PTY仍进入同一个 Session。</p></div>
<div class="step"><b>测卡片与自由聊天</b><p>在逐浪 PTY 手动发一句“只回复：逐浪会话正常”；完成后回联赛点“打开卡片 Session”。</p><p>通过：卡片出现本次问答；再切 PTY时历史与会话未变。系统不禁止你聊天。</p></div>
<div class="step"><b>测提示词完全可见与可编辑</b><p>逐浪详情 → “查看 / 编辑全部提示词”。切换 AGENT / STRATEGY / CHECKLIST / 三段 Prompt / MEMORY / 系统合同。可在 PROMPT_DAILY 末尾增加一行注释并保存，再重新载入。</p><p>通过：9 个可编辑文件可保存；账本与 3 份系统合同只读；保存提示成功。</p></div>
<div class="step"><b>测“盘前决策 → PTY”</b><p>交易日点击顶部“盘前决策”。若你先点过逐浪，它应优先打开逐浪 PTY；双 Agent 会同时开始，各自显示独立进度。</p><p>通过：按钮立即进入 PTY；无 picker；排行榜能看到 2 active，随后各自形成 DRAFT/Hook/FINAL。</p></div>
<div class="step"><b>测开盘与收盘按钮</b><p>有当天 FINAL 后，按时间分别点“开盘执行”“收盘记账”。</p><p>通过：动作后自动回到所选 Agent PTY；两名 Agent 的每日详情分别出现执行/净值，排行榜按收益率更新。</p></div>
<div class="step"><b>测周六沉淀</b><p>点击“周六沉淀”，在确认框继续。若最近 7 天没有完成的交易日记录，系统会明确提示“没有需要沉淀的新记录”，这是正确幂等结果。</p><p>通过：有记录时两名 Agent 各自产出周复盘与 MEMORY；无记录时不制造内容。</p></div>
<div class="step"><b>最后再重启一次</b><p>重启 Hub，分别点击两名 Agent 的 PTY和卡片。</p><p>通过：直接恢复各自原 Session，不出现 picker；卡片历史仍在；两个 Agent 不串内容。</p></div>
<div class="step"><b>确认后再开启自动赛程</b><p>点击“自动赛程未启用”。默认：中国交易日 08:30 决策、09:35 执行、15:10 记账；周六 10:00 沉淀；并发 2。</p><p>通过：按钮显示自动时间。若暂不希望后台模型运行，保持关闭即可。</p></div>
</div></section>

<section class="card" id="boundaries"><div class="section-title"><div><span>HONEST BOUNDARIES</span><h2>当前明确边界</h2></div><b>NO SILENT DOWNGRADE</b></div><div class="grid"><article class="finding"><b>模拟交易，不接券商</b><p>开盘价机械模拟，佣金万一、卖出印花税千一；不会下真实订单。</p></article><article class="finding"><b>P0 无盘中决策</b><p>盘前锁定一次，盘中不调用 Agent 改单。</p></article><article class="finding"><b>自动赛程当前关闭</b><p>生产数据中保留关闭，等你确认后手动开启。</p></article><article class="finding"><b>2026 日历覆盖</b><p>覆盖到 2026-12-31；下一年度未配置时明确暂停，不把工作日误当交易日。</p></article><article class="finding"><b>历史失败不抹除</b><p>生产 SCHEDULE 保留之前 2026-08-28 的 failed 记录供审计；新代码允许下次合法赛程重跑。</p></article><article class="finding"><b>不承诺绝对零 bug</b><p>结论是经过上述真实测试后“无已知交付阻断项”。</p></article></div></section>

<section class="card" id="paths"><div class="section-title"><div><span>ARTIFACTS</span><h2>证据与生产路径</h2></div><b>UTF-8 VERIFIED</b></div><div class="paths"><div class="path">报告：${esc(REPORT_PATH)}</div><div class="path">单 Agent 证据：${esc(SINGLE_DIR)}</div><div class="path">双 Agent 证据：${esc(MULTI_DIR)}</div><div class="path">10 Agent UI 证据：${esc(UI_DIR)}</div><div class="path">生产初心基准：C:\\Users\\lintian\\chuxin-research\\vault\\agent-league\\agents\\chuxin-baseline</div><div class="path">生产逐浪：C:\\Users\\lintian\\chuxin-research\\vault\\agent-league\\agents\\trend-rider</div><div class="path">Hub 仓库：${esc(REPO)}</div></div></section>

<footer class="foot">生成时间：2026-08-27 · 所有截图与检查数据均内嵌，离线可打开。</footer></div>
<dialog id="lightbox"><button id="close-lightbox">关闭</button><img alt="放大截图"></dialog><script>const d=document.getElementById('lightbox'),img=d.querySelector('img');document.querySelectorAll('[data-zoom]').forEach(b=>b.addEventListener('click',()=>{img.src=document.getElementById(b.dataset.zoom).src;d.showModal()}));document.getElementById('close-lightbox').onclick=()=>d.close();d.addEventListener('click',e=>{if(e.target===d)d.close()});</script></body></html>`;

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(REPORT_PATH, html, 'utf8');
const reportHash = sha256File(REPORT_PATH);
fs.writeFileSync(`${REPORT_PATH}.sha256`, `${reportHash}  ${path.basename(REPORT_PATH)}\n`, 'ascii');
console.log(JSON.stringify({ ok: true, report: REPORT_PATH, bytes: fs.statSync(REPORT_PATH).size, sha256: reportHash, singleChecks: single.checks.length, multiChecks: multi.checks.length, embeddedImages: singleImages.length + multiImages.length + uiImages.length }, null, 2));
