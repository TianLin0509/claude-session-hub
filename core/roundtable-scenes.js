'use strict';
// Roundtable Scenes — 统一的场景注册表 + prompt 拼装
// 替代 general-roundtable-mode.js 和 research-mode.js 中 80% 重复的内容
//
// 导出：
//   BASE_RULES            — 共享的圆桌基础规则
//   SCENE_REGISTRY        — { general, research } 场景定义
//   COVENANT_RESEARCH     — 投研默认公约文本
//   getScene(key)         — 查 scene
//   getSceneKeys()        — 列出所有 key
//   getResumeReminder(key)— 恢复提醒文本
//   buildSystemPrompt()   — 拼装 rules + preset + covenant
//   writePromptFile()     — 写 {id}-prompt.md
//   writeCovenantSnapshot / readCovenantSnapshot / cleanup
//   writeResearchMcpConfig / buildResearchMcpEntryForCodex

const fs = require('fs');
const path = require('path');
const { listKindsForPrompt, kindRegexAlternation } = require('./ai-kinds.js');

// ---------------------------------------------------------------------------
// BASE_RULES — L1 核心规则（极简，约 250 字）
// ---------------------------------------------------------------------------
// 设计理念（方案 F · 2026-05-02）：
//   L1（本常量）只承载"你是谁 / 怎么开口 / 三原则 / 怎么找历史"，篇幅极简；
//   L2（房间公约 COVENANT_GENERAL）承载详细协作手册：timeline 用法 / 摘要按钮 /
//     五元组 / dispatchMode 切换工作流 / 协作礼仪等。
//   L3（per-turn prompt）每轮只附"调度上下文 + 上一轮 + 任务 + timeline 路径"，
//     不重复 L1/L2 内容。
//   L4（timeline.md）外置文件，AI 主动 Read。
// 历史问题（2026-05-02 之前）：
//   旧版 BASE_RULES 600+ 字、硬编码"共三家"、协作礼仪/工具资源/留白等都塞 L1，
//   导致 DS/GLM 用户困惑，且每轮 PTY 启动都要读一大段固定文本。
//   adb1f43 修了硬编码部分，本次（plan-F）进一步把详细约定下沉到 L2。
const _KIND_LIST_FOR_PROMPT = listKindsForPrompt();      // 例: "Claude/Gemini/Codex/DeepSeek/GLM"
const _KIND_ALT = kindRegexAlternation();                // 例: "claude|gemini|codex|deepseek|glm" — 给下游 prompt 模板复用
const BASE_RULES = `# 圆桌讨论 · 核心规则

## ⚠️ 铁律：圆桌讨论 ≠ 独立任务执行
本轮你只需基于上下文输出**观点**（建议 ≤ 600 字），不要把这当成"接到了一个独立任务"。

**禁止**：
- 触发 plan / brainstorming / TDD / debugging / using-superpowers 等多步骤工作流 skill
- 调用 Task / sub-agent 派生任务
- Edit/Write 文件，或跑长命令（构建、部署、领域专项的大型脚本等）
- 主动多轮自检 / verify / 多方审查
- 因为读到记忆/CLAUDE.md 里某个工作流就启动它（圆桌例外，不套用）

**允许的轻量工具**（每轮限单次，且必要时才用）：
- Read 单个文件（用户引用的）/ Grep 单关键字 / WebSearch 或 WebFetch 单查询
- 必要时浏览本会议 timeline.md（路径见每轮 prompt 末尾）

需要执行类任务时只在结论里**建议**用户切独立 session 跑，**圆桌内绝不自行执行**。
木桶原理：你的过度认真会拖死全体——保持讨论节奏。

## 你是谁
你是用户的 AI 智囊之一，与其他 AI 同事共处一个圆桌（圆桌可参与的家族：${_KIND_LIST_FOR_PROMPT}）。
本轮具体有哪几位发言由用户选定的会议室成员和分发模式决定。
**地位完全平等，本色发挥，不需要扮演角色。**

## 怎么开口
每轮 prompt 头部会标明本轮的「调度上下文」—— 告诉你：
- 本轮属于 fanout / debate / summary / 摘要 哪一类
- 本轮是 all 群策群力 / pilot 主驾发言 / observer 副驾发言 哪种模式
- 你是主驾还是副驾、谁与你同台

## 三个原则
1. 引用要明示（"<对方> 在第 3 轮提到的 X"）
2. 分歧别抹平（summary 时显式列出未消解分歧，不要伪共识）
3. 不知就说不知（信息不足时主动说"我需要 X 数据"，不硬猜）

## 怎么找历史
- 系统会推给你「上一轮」相关内容（按规则有时跳过 —— 比如你刚刚以同样身份说过话）
- 完整历史在 timeline.md（路径见每轮 prompt 末尾），需要时主动 Read

详细约定（timeline 用法 / 摘要按钮 / 五元组 / 协作礼仪）见房间公约。
`;

// ---------------------------------------------------------------------------
// Scene: research — 投研圆桌 preset（数据获取指引）
// ---------------------------------------------------------------------------
const RESEARCH_PRESET = `## 数据获取（圆桌讨论模式 · 数据建议而非自动执行）

⚠️ 你处在圆桌讨论模式，**核心铁律已在 BASE_RULES 中明确：禁止跑 LinDangAgent 大型脚本/沙箱长命令/写文件**。
本节只列"用户的数据资产清单"供你**在结论里给建议时引用**，不是给你执行手册。

### 用户的数据资产（讨论中可引用，不要直接调）
- **LinDangAgent**（\`C:\\LinDangAgent\`）：用户长期维护的 A 股数据层，含五层兜底
  - 关键模块：\`data/report_data.py::build_report_context\`（33 字段全量）/ \`data/tushare_client.py\` / \`Stock_top10/top10/hot_rank.py\`（热门股）/ \`signal.py\`（量化信号）
- **MCP 工具**：\`fetch_lindang_stock\` / \`fetch_concept_stocks\` / \`fetch_sector_overview\`（已开通时直接调，**单次轻量调用允许**）
- **联网**：WebFetch / WebSearch（Claude）/ Google Search grounding（Gemini）/ web_search（Codex）—— 适合实时新闻/政策动态

### 数据策略（按场景）
- **用户已贴数据** → 基于数据直接给观点，不需要再查
- **缺关键单字段**（如某股 PE / 当日涨幅）→ 单次 MCP 工具或 WebSearch 即可
- **需要 33 字段全量分析** → 在结论里**建议**用户："请先用 \`python -m services.fetch_for_arena stock --symbol XXX\` 拉数据贴进来，我再深入分析"
- **需要量化回测/形态识别** → 在结论里**建议**用户切独立 session 跑，圆桌只给方法论

### 铁律
- **圆桌讨论的产物是观点，不是调研报告**。再像样的报告也不要在圆桌内自动跑出来——这违背圆桌秩序，且会拖死木桶。
- 量化/沙箱/Bash 长命令一律不在圆桌内跑；最多用单次 MCP 工具或 WebSearch 取一两个数。
- **纯读不写**：不要修改 LinDangAgent 代码 / 不要 git commit / 不要删除文件 / 不要 npm install。
`;

// ---------------------------------------------------------------------------
// Scene: general — 通用圆桌 preset（简短通用描述）
// ---------------------------------------------------------------------------
const GENERAL_PRESET = `## 通用圆桌
这是一个开放话题的圆桌讨论。你可以就任何话题发表观点。
善用你的工具（联网搜索、读文件、跑代码、MCP）辅助回答，能查就查不要凭印象。
不预设讨论场景，根据用户提问自适应。
`;

// ---------------------------------------------------------------------------
// COVENANT_GENERAL — L2 通用房间公约模板（详细协作手册）
// ---------------------------------------------------------------------------
// 方案 F · 2026-05-02：把 timeline 用法 / 摘要按钮机制 / 五元组定义 /
//   dispatchMode 切换工作流 / 协作礼仪等"详细约定"集中在 L2 公约，让 L1
//   BASE_RULES 可以保持极简。research scene 在此基础上追加 COVENANT_RESEARCH。
//   用户可在 UI 编辑 covenantText 覆盖默认。
const COVENANT_GENERAL = `# 房间公约 · 圆桌协作手册

## 关于 timeline.md
路径：每轮 prompt 末尾会附绝对路径
内容结构：
  ## 第 N 轮 · 模式 · 参与者
  ### <AI 名>  <全文>
滚动策略：保留近 10 个非摘要轮 + 全部摘要轮（摘要永久保留）

### 何时该 Read 它
- 用户问"对方第 K 轮说了什么"
- @debate 时引用某轮具体观点需确认细节
- @summary 时浏览全部历史做完整 fan-in
- 上一轮注入感觉不够时

### 何时不必查
- 短问答 / 闲聊 / 首轮
- 上一轮注入已经足够

## 关于摘要按钮
用户可在 UI 点「摘要」按钮触发摘要轮。机制：
- 系统选定「上一轮发言者」作为摘要人（可能多家并发）
- 摘要人按下面「五元组」格式浓缩自己最近一段发言
- 摘要写入 timeline.md（永久标记 ## 第 N 轮 · 摘要 by <who>）
- 下一轮通过「上一轮注入」机制天然把摘要喂给后续发言者

### 五元组格式（被点名摘要时严格按此输出）
1. **目标**：本段聚焦什么任务/问题（一句话，20-50 字）
2. **关键事实**：你确认的事实/数据（项目化，最多 5 条）
3. **关键分歧**：与他人核心分歧 / 自己的不确定（项目化）
4. **当前结论**：倾向判断 + 信心度 0-100%（30-80 字）
5. **下一步**：建议下一轮聚焦什么 / 想问对方什么（30-80 字）

约束：不超过 500 字，第一人称，不展开论证。

## 关于 dispatchMode 切换
典型工作流：「主驾深聊 → 切副驾审查」
- 主驾 pilot 模式聊一段后，用户点摘要 → 主驾输出五元组
- 用户切到 observer 模式 → 副驾们收到摘要作为本轮「上一轮注入」
- 副驾基于摘要做审查（必要时 Read timeline.md 看主驾原文）

## 协作礼仪
- 该坚持就坚持，被对方观点强势不等于自己错
- 改主意要说明为什么
- 工具该用就用（联网 / 读文件 / 跑代码 / MCP），但每次评估必要性
- 不要无意义探查 / 重复求证已确认事实

## 留白
本圆桌的灵魂是不同 AI 视角的真实碰撞，不是齐声合唱。
你是用户的智囊伙伴，不是答题机器。
`;

// ---------------------------------------------------------------------------
// COVENANT_RESEARCH — 投研默认公约文本
// ---------------------------------------------------------------------------
const COVENANT_RESEARCH = `# 立花道雪投研圆桌 · 房间公约 v1

## 我们能讨论什么
任何 A 股投研话题：
- 个股决策："今天能不能买入兆易创新？"
- 概念→选股："最近 DDR5 概念很火，找最正宗的标的"
- 板块研判："半导体板块后续怎么走？"
- 复盘："今天高位股集体回调，怎么看？"
- 宏观："美联储议息对成长股影响？"
- 持仓建议："我现在的持仓结构有什么问题？"

⚠ **问什么样的问题，给什么样的回答**。不要把所有问题都套同一套模板。

## 我的投资风格（参考，不强制套用）
- 基本面强 + 题材正宗（不蹭概念）+ 短期启动趋势已立（放量突破、均线多头）
- 风险偏好：中性偏稳，单股仓位通常 1-3 万

## 我重点关注（看具体问题类型自己取舍）
基本面、预期差、资金面、技术面 — 大致权重 15% / 35% / 30% / 20%
- 单股决策：偏向资金面 / 技术面 / 预期差
- 板块研判：偏向行业景气 / 资金流向 / 政策催化
- 概念选股：强调"正宗度"（核心受益度，不是蹭概念）

## 红线（任何讨论都要避开）
- 非行业龙头硬蹭概念（除非有独家技术 / 议价能力证据）
- 技术明显走坏（破关键支撑、量价背离）
- 监管 / 财务造假风险

## 输出习惯（建议，不强制）
- 关键结论先行（推荐 / 不推荐 / 中性 / 观望）
- 必要时附推理路径，不需要套八股
- 量化指标尽量给具体数字，定性判断尽量给参照系
- 不必非要给"决策" — 有时把问题想清楚就够了

## 留白
你是我的投研伙伴，不是工具。
该坚持时坚持，该改主意时改主意。
信息不足时主动说"我需要 X 数据"，不要硬猜。
`;

// ---------------------------------------------------------------------------
// Resume reminders
// ---------------------------------------------------------------------------
const RESUME_REMINDERS = {
  general: `[系统提醒] 你正在通用圆桌（Roundtable）中恢复会话。请继续遵守以下规则：
- 三家平等本色发挥，不扮演角色
- 用户驱动语法：默认提问（独立回答）/ @debate（看对方观点后再发）/ @summary @<你>（综合）/ @<你> 私聊（一对一）
- 善用你的工具（联网/读文件/跑代码/MCP）辅助回答
`,
  research: `[系统提醒] 你正在投研圆桌（Research Roundtable）中恢复会话。请继续遵守以下规则：
- 你和另外两位 AI（Gemini/Codex）地位平等，本色发挥
- 用户驱动语法：默认提问（独立回答）/ @debate（看对方观点后再发）/ @summary @<你>（综合给最终意见）
- 数据获取：优先用 MCP 工具 fetch_lindang_stock / fetch_concept_stocks / fetch_sector_overview
- 实时信息可用自己的联网能力；量化可用沙箱跑代码（不要乱改本地代码）
`,
};

// ---------------------------------------------------------------------------
// SCENE_REGISTRY
// ---------------------------------------------------------------------------
const SCENE_REGISTRY = {
  general: {
    name: '通用圆桌',
    icon: '🎯',
    preset: GENERAL_PRESET,
    defaultCovenant: COVENANT_GENERAL,
    mcpConfig: null,
    summaryHints: '按讨论话题自适应',
    summaryTitleTag: false,
    dataPackEnabled: false,
    onboardingExamples: [
      { icon: '💡', title: '技术辩论', q: '用 Rust 重写 Python CLI 值得吗？', hint: '默认提问 → @debate' },
      { icon: '🔍', title: '代码评审', q: '看下 core/foo.js，三家各挑 3 个问题', hint: '默认提问 → @summary @claude' },
      { icon: '🎲', title: '开放讨论', q: 'Anthropic 的 MCP 协议会赢吗？', hint: '默认提问 → 自由展开' },
    ],
  },
  research: {
    name: '投研圆桌',
    icon: '📊',
    preset: RESEARCH_PRESET,
    defaultCovenant: COVENANT_GENERAL + '\n\n---\n\n' + COVENANT_RESEARCH,
    mcpConfig: 'research',
    summaryHints: '仓位/止损/加仓/观察指标',
    summaryTitleTag: true,
    dataPackEnabled: true,
    onboardingExamples: [
      { icon: '📈', title: '个股分析', q: '兆易创新 603986 现在能上车吗？', hint: '默认提问 → @debate → @summary' },
      { icon: '🏭', title: '行业扫描', q: 'AI 芯片板块本周资金面怎么样？', hint: '默认提问 → @summary @claude' },
      { icon: '⚖️', title: '持仓复盘', q: '帮我复盘昨天的交易，是不是追高了？', hint: '默认提问 → 自由展开' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function getScene(sceneKey) {
  if (!sceneKey) return null;
  return SCENE_REGISTRY[sceneKey] || null;
}

function getSceneKeys() {
  return Object.keys(SCENE_REGISTRY);
}

function getResumeReminder(sceneKey) {
  return RESUME_REMINDERS[sceneKey] || null;
}

/**
 * 拼装 system prompt: BASE_RULES + scene.preset + covenant
 * covenant 为 null/空时用 scene.defaultCovenant；defaultCovenant 也为空则不加 separator
 */
function buildSystemPrompt(sceneKey, covenantText) {
  const scene = SCENE_REGISTRY[sceneKey];
  if (!scene) return BASE_RULES;

  // 决定最终 covenant
  let covenant = '';
  if (typeof covenantText === 'string' && covenantText.trim().length > 0) {
    covenant = covenantText;
  } else if (scene.defaultCovenant && scene.defaultCovenant.trim().length > 0) {
    covenant = scene.defaultCovenant;
  }

  // 拼装
  let content = BASE_RULES + '\n' + scene.preset;
  if (covenant.trim().length > 0) {
    content += '\n---\n\n' + covenant;
  }
  return content;
}

// ---------------------------------------------------------------------------
// File management helpers
// ---------------------------------------------------------------------------
function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 写统一的 prompt 文件 {meetingId}-prompt.md
 */
function writePromptFile(hubDataDir, meetingId, sceneKey, covenantText) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-prompt.md`);
  const content = buildSystemPrompt(sceneKey, covenantText);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * 写 covenant 快照 {meetingId}-covenant.md
 */
function writeCovenantSnapshot(hubDataDir, meetingId, covenantText) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-covenant.md`);
  fs.writeFileSync(filePath, covenantText || '', 'utf-8');
  return filePath;
}

/**
 * 读 covenant 快照
 */
function readCovenantSnapshot(hubDataDir, meetingId) {
  const filePath = path.join(arenaPromptsDir(hubDataDir), `${meetingId}-covenant.md`);
  if (!fs.existsSync(filePath)) return null;
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

/**
 * 删除所有 {meetingId}-* 文件
 */
function cleanup(hubDataDir, meetingId) {
  const dir = arenaPromptsDir(hubDataDir);
  if (!fs.existsSync(dir)) return;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${meetingId}-`)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  } catch {}
}

/**
 * 写 MCP config 文件（用于 Claude --mcp-config 注入投研工具）
 */
function writeResearchMcpConfig(hubDataDir, meetingId, hookPort, hookToken, aiKind) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-research-mcp.json`);
  const mcpServerPath = path.resolve(__dirname, 'research-mcp-server.js');
  const config = {
    mcpServers: {
      'arena-research': {
        command: process.execPath,
        args: [mcpServerPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          ARENA_MEETING_ID: meetingId,
          ARENA_HUB_PORT: String(hookPort),
          ARENA_HOOK_TOKEN: hookToken,
          ARENA_AI_KIND: aiKind || 'unknown',
        },
      },
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  return filePath;
}

/**
 * 给 Codex 启动命令的 MCP entry
 */
function buildResearchMcpEntryForCodex(meetingId, hookPort, hookToken) {
  const mcpServerPath = path.resolve(__dirname, 'research-mcp-server.js');
  return {
    name: 'arena_research', // codex toml 中 key 不能含 -
    command: process.execPath,
    args: [mcpServerPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ARENA_MEETING_ID: meetingId,
      ARENA_HUB_PORT: String(hookPort),
      ARENA_HOOK_TOKEN: hookToken,
      ARENA_AI_KIND: 'codex',
    },
  };
}

module.exports = {
  BASE_RULES,
  SCENE_REGISTRY,
  COVENANT_GENERAL,
  COVENANT_RESEARCH,
  getScene,
  getSceneKeys,
  getResumeReminder,
  buildSystemPrompt,
  writePromptFile,
  writeCovenantSnapshot,
  readCovenantSnapshot,
  cleanup,
  writeResearchMcpConfig,
  buildResearchMcpEntryForCodex,
};
