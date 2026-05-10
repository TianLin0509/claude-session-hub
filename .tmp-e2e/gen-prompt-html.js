'use strict';
const fs = require('fs');
const path = require('path');
const s = require('../core/roundtable-scenes.js');

const data = {
  base: s.BASE_RULES,
  preset: s.SCENE_REGISTRY.general.preset,
  covenant: s.COVENANT_GENERAL,
  total: s.buildSystemPrompt('general', null),
};

const escape = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sepLen = data.total.length - data.base.length - data.preset.length - data.covenant.length;
const pct = n => (n / data.total.length * 100).toFixed(1) + '%';

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>通用圆桌 prompt 汇报 · 2026-05-09</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d;
    --text: #c9d1d9; --dim: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --orange: #d29922; --red: #f85149;
    --code-bg: #1f2937; --hl: #1f6feb22;
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; line-height: 1.6; max-width: 1100px; margin-left: auto; margin-right: auto; }
  h1 { color: var(--accent); border-bottom: 2px solid var(--border); padding-bottom: 8px; margin-top: 0; }
  h2 { color: var(--accent); margin-top: 32px; padding: 6px 12px; background: var(--panel); border-left: 4px solid var(--accent); border-radius: 4px; }
  h3 { color: var(--text); margin-top: 24px; }
  .meta { display: flex; gap: 16px; flex-wrap: wrap; padding: 12px; background: var(--panel); border-radius: 6px; margin-bottom: 16px; font-size: 13px; }
  .meta-item { display: flex; flex-direction: column; }
  .meta-label { color: var(--dim); font-size: 11px; text-transform: uppercase; }
  .meta-value { color: var(--text); font-size: 14px; font-weight: 600; }
  .meta-value.green { color: var(--green); }
  .meta-value.orange { color: var(--orange); }
  pre.prompt { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 16px; overflow-x: auto; white-space: pre-wrap; font-family: "SF Mono", Consolas, monospace; font-size: 13px; line-height: 1.55; color: #d4d4d4; }
  .layer-block { margin-bottom: 24px; }
  .layer-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px 6px 0 0; border-bottom: none; }
  .layer-title { font-weight: 600; font-size: 15px; }
  .layer-tag { background: var(--accent); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
  .layer-tag.l2 { background: var(--green); }
  .layer-tag.l3 { background: var(--orange); }
  .layer-stat { color: var(--dim); font-size: 12px; }
  .layer-block pre { margin: 0; border-radius: 0 0 6px 6px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  th { background: var(--panel); color: var(--accent); font-weight: 600; font-size: 13px; }
  td { font-size: 13px; }
  td.num { text-align: right; font-family: "SF Mono", Consolas, monospace; }
  .info { padding: 12px 16px; background: var(--hl); border-left: 3px solid var(--accent); border-radius: 4px; margin: 12px 0; font-size: 14px; }
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--dim); font-size: 12px; text-align: center; }
  code { background: var(--code-bg); padding: 1px 6px; border-radius: 3px; font-family: "SF Mono", Consolas, monospace; font-size: 12px; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; margin-right: 4px; }
  .pill.green { background: #3fb95022; color: var(--green); }
  .pill.orange { background: #d2992222; color: var(--orange); }
  .pill.gray { background: #8b949e22; color: var(--dim); }
  details summary { cursor: pointer; padding: 8px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; user-select: none; }
  details[open] summary { border-radius: 4px 4px 0 0; }
</style>
</head>
<body>

<h1>通用圆桌 system prompt · 当前快照</h1>

<div class="meta">
  <div class="meta-item"><div class="meta-label">日期</div><div class="meta-value">2026-05-09</div></div>
  <div class="meta-item"><div class="meta-label">commit</div><div class="meta-value"><code>9b285d7</code></div></div>
  <div class="meta-item"><div class="meta-label">总字符</div><div class="meta-value green">${data.total.length}</div></div>
  <div class="meta-item"><div class="meta-label">vs 重构前 5168</div><div class="meta-value green">-${(100 - data.total.length / 5168 * 100).toFixed(1)}%</div></div>
  <div class="meta-item"><div class="meta-label">物理结构</div><div class="meta-value">4 层</div></div>
  <div class="meta-item"><div class="meta-label">scene</div><div class="meta-value">general</div></div>
</div>

<h2>📊 长度分布</h2>
<table>
  <thead>
    <tr><th>层级</th><th>常量</th><th>角色</th><th class="num">字符</th><th class="num">占比</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><span class="pill green">L1</span></td>
      <td><code>BASE_RULES</code></td>
      <td>跨场景通用铁律 · 每轮 prompt 必带</td>
      <td class="num">${data.base.length}</td>
      <td class="num">${pct(data.base.length)}</td>
    </tr>
    <tr>
      <td><span class="pill orange">L2a</span></td>
      <td><code>GENERAL_PRESET</code></td>
      <td>通用圆桌场景知识 · 由 SCENE_REGISTRY.general.preset 注入</td>
      <td class="num">${data.preset.length}</td>
      <td class="num">${pct(data.preset.length)}</td>
    </tr>
    <tr>
      <td><span class="pill orange">L2b</span></td>
      <td><code>COVENANT_GENERAL</code></td>
      <td>通用房间公约 · timeline 用法 + MEMORY 协议</td>
      <td class="num">${data.covenant.length}</td>
      <td class="num">${pct(data.covenant.length)}</td>
    </tr>
    <tr>
      <td><span class="pill gray">分隔符</span></td>
      <td colspan="2"><code>'\\n---\\n\\n'</code> 拼装边界</td>
      <td class="num">${sepLen}</td>
      <td class="num">${pct(sepLen)}</td>
    </tr>
    <tr style="border-top: 2px solid var(--accent);">
      <td colspan="3"><strong>合计（buildSystemPrompt('general', null)）</strong></td>
      <td class="num"><strong style="color: var(--accent)">${data.total.length}</strong></td>
      <td class="num">100%</td>
    </tr>
    <tr>
      <td><span class="pill gray">L3</span></td>
      <td>per-turn 调度上下文</td>
      <td>由 orchestrator 在每轮 prompt 头部动态注入（不进 system prompt）</td>
      <td class="num">~150</td>
      <td class="num">运行时</td>
    </tr>
  </tbody>
</table>

<div class="info">
  <strong>拼装公式</strong>：<code>BASE_RULES + '\\n' + GENERAL_PRESET + '\\n---\\n\\n' + COVENANT_GENERAL</code><br>
  <strong>来源</strong>：<code>core/roundtable-scenes.js</code> 的 <code>buildSystemPrompt('general', null)</code>
</div>

<h2>🧱 L1 · BASE_RULES（核心铁律）</h2>

<div class="layer-block">
  <div class="layer-header">
    <span><span class="layer-tag">L1</span> <span class="layer-title">跨场景通用规则</span></span>
    <span class="layer-stat">${data.base.length} 字符</span>
  </div>
  <pre class="prompt">${escape(data.base)}</pre>
</div>

<div class="info">
  <strong>关键设计点</strong>：
  <ul style="margin: 6px 0 0 20px; padding: 0;">
    <li>禁止主动调 6 个核心 skill（plan/brainstorming/TDD/debugging/SDD/review）+ 「等」覆盖其余</li>
    <li>明示 <code>/agents</code> / <code>/init</code> / <code>/clear</code> 为 AI 主动禁用，但用户输入 <code>/model</code> <code>/compact</code> <code>/clear</code> 是用户基本操作放行</li>
    <li>区分「项目文件」vs「memory 文件」：Auto-memory 写入显式白名单</li>
    <li>4 条输出原则（引用明示 / 分歧不抹平 / 不知说不知 / fanout 禁引同轮他人发言）</li>
    <li>字数量级：默认 ≤600 字 / 多点对比 ≤1500 / 简短确认 ≤200 · 首句给结论</li>
    <li>写文件两档：明确请求→直接写；未明确→提议待许可</li>
  </ul>
</div>

<h2>🎯 L2a · GENERAL_PRESET（场景知识）</h2>

<div class="layer-block">
  <div class="layer-header">
    <span><span class="layer-tag l2">L2a</span> <span class="layer-title">通用圆桌场景</span></span>
    <span class="layer-stat">${data.preset.length} 字符</span>
  </div>
  <pre class="prompt">${escape(data.preset)}</pre>
</div>

<div class="info">
  <strong>设计准入闸门</strong>：不含场景特定知识 / 不重复 L1 / 不跨层引用 / 不依赖当前轮模式 / ≤350 字
</div>

<h2>📜 L2b · COVENANT_GENERAL（房间公约）</h2>

<div class="layer-block">
  <div class="layer-header">
    <span><span class="layer-tag l2">L2b</span> <span class="layer-title">详细协作手册 + MEMORY 协议</span></span>
    <span class="layer-stat">${data.covenant.length} 字符</span>
  </div>
  <pre class="prompt">${escape(data.covenant)}</pre>
</div>

<div class="info">
  <strong>仅剩两段</strong>（摘要功能 2026-05-08 整体下线后）：
  <ol style="margin: 6px 0 0 20px; padding: 0;">
    <li><strong>关于 timeline.md</strong> — 路径 / 内容结构 / 滚动策略（保留近 10 轮历史）/ 何时该 Read</li>
    <li><strong>MEMORY PROTOCOL</strong> — 三类该记 / 不要记 / 两个硬要求 / source 字段 / 工具不可用兜底</li>
  </ol>
  <strong>已删段</strong>：摘要按钮机制 / 五元组定义 / dispatchMode 切换工作流 / 协作礼仪 / 留白 / 何时不必查
</div>

<h2>⏱ L3 · per-turn 调度上下文（运行时动态）</h2>

<div class="layer-block">
  <div class="layer-header">
    <span><span class="layer-tag l3">L3</span> <span class="layer-title">orchestrator._renderDispatchContext / free._renderFreeDispatchContext</span></span>
    <span class="layer-stat">~150 字符 / 轮</span>
  </div>
  <pre class="prompt">## 调度上下文
- 你是:⚡ 皮卡丘
- 同台:🔥 小火龙 / 💎 杰尼龟    （pilot 模式）
- 参与者:⚡ 皮卡丘 / 🔥 小火龙 / 💎 杰尼龟    （free 模式）
- 模式:群策群力（参与者同台独立回答）
- 轮次性质:fanout
- 回答方式:独立回答（看不到他人本轮观点）
- 轻提醒:≤ 1500 字 / 写文件按用户表达：明确要求→写；未明确→提议 / 不展开多步骤工作流</pre>
</div>

<div class="info">
  <strong>注入位置</strong>：每轮 per-turn user message 之前，不进 system prompt cache。
</div>

<h2>🧬 演化沿革</h2>

<table>
  <thead><tr><th>阶段</th><th>commit</th><th>关键变化</th><th class="num">总字符</th></tr></thead>
  <tbody>
    <tr><td>原始</td><td><code>~93034b5 之前</code></td><td>4 层未瘦身（夹杂摘要/dispatchMode/留白/礼仪等）</td><td class="num">5168</td></tr>
    <tr><td>第一阶段</td><td><code>7347a2c</code></td><td>-64% 字符精简：删 5 段 covenant + 用户主动放行段 + skill 枚举压 6 个 + 加 fanout 红线/字数/写文件三档</td><td class="num">1863</td></tr>
    <tr><td>第二阶段</td><td><code>ed5b716</code></td><td>彻底删摘要功能（buildBriefSummaryPrompt + UI 按钮 + 五元组 helpers）+ 写文件按用户表达 + dead import + MEMORY 三处补强</td><td class="num">1901</td></tr>
    <tr><td><strong>当前</strong></td><td><code>9b285d7</code></td><td>摘要代码路径彻底清理（timeline isSummary / archive 整文件 / codex-ctx / orchestrator）+ GENERAL_PRESET 写文件冲突消除 + MEMORY 工具不可用兜底</td><td class="num"><strong style="color: var(--accent)">1973</strong></td></tr>
  </tbody>
</table>

<h2>📦 完整 system prompt（拼装结果）</h2>

<details>
  <summary>展开 / 折叠 完整 system prompt（${data.total.length} 字符）</summary>
  <pre class="prompt" style="margin-top: 0; border-radius: 0 0 6px 6px;">${escape(data.total)}</pre>
</details>

<div class="footer">
  通用圆桌 prompt 快照 · 由 <code>buildSystemPrompt('general', null)</code> 实时拼装 · 2026-05-09
</div>

</body>
</html>
`;

const outPath = 'C:\\Users\\lintian\\.arena\\artifacts\\general-prompt-snapshot-2026-05-09.html';
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf8');
console.log('written:', outPath);
console.log('size:', html.length, 'bytes');
