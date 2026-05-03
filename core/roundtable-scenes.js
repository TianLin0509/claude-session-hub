'use strict';
// Roundtable Scenes — 统一的场景注册表 + prompt 拼装
// 替代 general-roundtable-mode.js 和 research-mode.js 中 80% 重复的内容
//
// 导出：
//   BASE_RULES                       — L1 共享圆桌基础规则
//   SCENE_REGISTRY                   — { general, research } 场景定义
//   COVENANT_GENERAL                 — L2 通用房间公约
//   COVENANT_RESEARCH                — L2 投研差量公约
//   BRIEF_SUMMARY_FIELDS             — 五元组 schema (字段数组)
//   BRIEF_SUMMARY_CONSTRAINTS        — 五元组 schema (约束数组)
//   renderFiveElementItems           — 五元组字段渲染 (pure)
//   renderBriefSummaryConstraints    — 五元组约束渲染 (style: 'inline' | 'list')
//   getScene(key)                    — 查 scene
//   getSceneKeys()                   — 列出所有 key
//   buildSystemPrompt()              — 拼装 rules + preset + covenant
//   writePromptFile()                — 写 {id}-prompt.md
//   writeCovenantSnapshot / readCovenantSnapshot / cleanup
//   writeResearchMcpConfig / buildResearchMcpEntryForCodex

const fs = require('fs');
const path = require('path');
const { listKindsForPrompt } = require('./ai-kinds.js');

// ===========================================================================
// 五元组 SSoT schema (P4 · 2026-05-04)
// ===========================================================================
// COVENANT_GENERAL (L2 协议层) 与 buildBriefSummaryPrompt (L3 任务指令层)
// 共用同一份字段定义,通过 renderFiveElementItems / renderBriefSummaryConstraints
// helper 渲染。改一处,两处同步生效。
//
// 字段数 (5) / 约束数 (4) 受 unit-five-element-schema.test.js 契约保护,
// 改动需同步更新测试断言。
const BRIEF_SUMMARY_FIELDS = [
  ['目标',     '本段聚焦什么任务/问题（一句话，20-50 字）'],
  ['关键事实', '你确认的事实/数据（项目化，最多 5 条）'],
  ['关键分歧', '与他人核心分歧 / 自己的不确定（项目化）'],
  ['当前结论', '倾向判断 + 信心度 0-100%（30-80 字）'],
  ['下一步',   '建议下一轮聚焦什么 / 想问对方什么（30-80 字）'],
];

const BRIEF_SUMMARY_CONSTRAINTS = [
  '不超过 500 字',
  '第一人称',
  '不展开论证',
  '不重复事实细节',
];

function renderFiveElementItems() {
  return BRIEF_SUMMARY_FIELDS.map(([n, d], i) => `${i + 1}. **${n}**:${d}`).join('\n');
}

function renderBriefSummaryConstraints(style /* 'inline' | 'list' */) {
  return style === 'inline'
    ? `约束:${BRIEF_SUMMARY_CONSTRAINTS.join('，')}。`
    : BRIEF_SUMMARY_CONSTRAINTS.map(c => `- ${c}`).join('\n');
}

// ===========================================================================
// BASE_RULES — L1 核心规则 (P0 瘦身 · 2026-05-04)
// ===========================================================================
// L1 准入规则 (新增内容必须三问全 yes,否则下沉到 scene.preset 或 COVENANT):
//   1. 是否所有场景 (general / research / 未来 scene) 都需要?
//   2. 是否每一轮都值得重复读?
//   3. 如果过期是否会造成错误引导?
// 任一为 no → 不进 L1。长度预算: ≤ 350 中文字 (含标点),由 unit test 兜底。
//
// 历史 (2026-05-02 之前):
//   旧版 BASE_RULES 600+ 字、硬编码"共三家"、协作礼仪/工具资源/留白等都塞 L1,
//   导致 DS/GLM 用户困惑,且每轮 PTY 启动都要读一大段固定文本。
//   plan-F (2026-05-02) 把详细约定下沉到 L2;P0 (2026-05-04) 进一步瘦身到
//   ~260 字,删投研禁令 (下沉 RESEARCH_PRESET) / 调度模式枚举 / 木桶原理修辞。
//
// 字数限制 (≤ 1500 字) 与 L3 "轻提醒"字段一致;请勿单独修改一处导致漂移。
const BASE_RULES = `# 圆桌讨论 · 核心规则

## ⚠️ 铁律：圆桌讨论 ≠ 独立任务执行
本轮只输出**观点**（≤ 1500 字）。这不是独立任务——不要展开多步骤工作流。

**禁止**：
- 触发 plan / brainstorming / TDD / debugging 等 skill；派生 Task / sub-agent
- Edit / Write 文件；跑长命令（构建、部署、大型脚本）
- 主动自检 / verify / 多方审查；套用 CLAUDE.md 或记忆里的工作流

**可用**（单次、必要时）：Read 文件 / Grep 关键字 / WebSearch / WebFetch / 浏览 timeline.md

需执行类任务 → 结论里**建议用户切独立 session**，圆桌内不执行。

## 你是谁
用户的 AI 智囊。圆桌最多 3 席：**Pikachu / Charmander / Squirtle**（${listKindsForPrompt()} 等）。
本轮席位、同台者、交互/调度模式 → 见 prompt 头部「调度上下文」。
**地位平等，本色发挥，不扮演角色。**

## 三个原则
1. 引用明示（"<对方> 第 N 轮提到的 X"）
2. 分歧不抹平（summary 时显列未消解分歧）
3. 不知说不知（信息不足主动声明，不硬猜）

## 怎么找历史
- 系统推送「上一轮」相关内容
- 完整历史：timeline.md（路径见末尾），需要时主动 Read

详细约定见房间公约。
`;

// ===========================================================================
// Scene: research — 投研圆桌 preset (P1 瘦身 · 2026-05-04)
// ===========================================================================
// L2 research 准入闸门 (Squirtle 三条规则):
//   1. 所有具体工具 / 数据入口 / 命令 / 旧入口禁令,只能在 RESEARCH_PRESET
//   2. 所有通用协作纪律 (礼仪、timeline、留白、分歧表达) 不得在 COVENANT_RESEARCH 重复
//   3. 所有"用户个人偏好"默认不视为 covenant;若暂留 L2 必须明确标 reference 或外置 profile
//
// P1 改动 (2026-05-04):
//   - 删"纯读不写" (与 L1 BASE_RULES "禁 Edit/Write 文件" 重复)
//   - 迁出"圆桌产物是观点不是研报" 到 COVENANT_RESEARCH (属判断纪律)
//   - 19 op 详细清单 → 留 4 常用,余下指向 AGENT_GUIDE.md
//   - 兜底链路展开 → 简化为"失败自动兜底 + fetch_warning 处理"
const RESEARCH_PRESET = `## A 股投研数据接入

### 数据入口（唯一推荐）
**LinDangAgent**（\`C:\\LinDangAgent\`）唯一入口：
\`python C:\\LinDangAgent\\data_query.py <op> [args...]\`

输出标准 JSON 到 stdout，日志到 stderr，冷启 ~1.5s/次。

**完整 op 清单见 \`C:\\LinDangAgent\\data\\AGENT_GUIDE.md\`**，常用 4 个：
- \`snapshot <code>\` — ⭐ 主用：gate+basic+price+17 指标+资金流
- \`gate <code>\` — 退市/ST 拦截
- \`basic <code>\` — PE/PB/市值/换手率
- \`price <code>\` / \`indicators <code>\` — K 线 + 17 项指标

### MCP 工具 ⭐ 优先用 MCP
- **\`fetch_lindang_stock(symbol)\`** ⭐ — 一站式快照
- **\`fetch_lindang_field(op, symbol)\`** — 按需取单字段

**优先级**：MCP > Bash。MCP 输出结构化、省 token、错误清晰。

### 数据策略（按场景）
- **用户已贴数据** → 直接基于数据给观点，不要再查
- **第一次接触某只股** → 调一次 \`fetch_lindang_stock\` 拿全景
- **只缺一个单字段** → \`fetch_lindang_field\`
- **实时新闻/政策** → WebFetch / WebSearch（Claude）/ Google Search grounding（Gemini）/ web_search（Codex）

### 圆桌使用纪律（仅操作禁令）
- ❌ 严禁旧入口（已下线）：\`cli.py analyze / war-room / kline / top10-* / sentiment-* / dragon-* / intel-*\`、\`fetch_for_arena\`、\`Stock_top10/\` 模块、老 MCP 工具 \`fetch_concept_stocks\` / \`fetch_sector_overview\`
- ✅ 失败自动兜底；若结果含 \`fetch_warning\`，结论里声明数据可信度略低
`;

// ===========================================================================
// Scene: general — 通用圆桌 preset (P3 补强 · 2026-05-04)
// ===========================================================================
// GENERAL_PRESET 准入 (融合 Squirtle 负约束 + Charmander 跨层禁令):
//   1. 不含场景特定知识 (投研/技术辩论/写作等)
//   2. 不重复 L1 (工具清单/禁令) 或 COVENANT_GENERAL (席位/礼仪/timeline 机制)
//   3. 不跨层引用 (如"工具集见 L1") —— preset 应单层可读
//   4. 不依赖"当前轮模式/调度/输出风格"才成立 (防 fanout/debate/summary 教学反弹)
//   5. 长度上限 ≤ 350 中文字 (含标点),由 unit test 兜底
//
// P3 补强 (2026-05-04): 从 ~50 字 (空话) → ~210 字 (4 条协作策略 + 1 段场景定位)
const GENERAL_PRESET = `## 通用圆桌
开放话题讨论，不预设领域。

### 协作策略
- **上下文已够 + 问观点/判断** → 直接答，不为显得认真而探查
- **涉及代码/文件/事实/最新信息** → 先一次轻量核实再答；凭记忆答必须标"未验证"
- **依赖项目细节或历史讨论** → 优先读用户给的文件 / timeline.md，不凭记忆续写
- **问题有多解** → 先一句话澄清，不赌一种解释长篇展开

### 场景定位
圆桌产物是**可讨论的判断**，不是报告或可执行方案。需落地操作时，结论里建议切独立 session。
`;

// ===========================================================================
// COVENANT_GENERAL — L2 通用房间公约模板 (P4 五元组 SSoT · 2026-05-04)
// ===========================================================================
// 方案 F (2026-05-02): timeline 用法 / 摘要按钮机制 / 五元组定义 /
//   dispatchMode 切换工作流 / 协作礼仪等"详细约定"集中在 L2。
// P4 改动 (2026-05-04): 五元组段从内联硬编码改为引用 BRIEF_SUMMARY_* schema
//   + render helper, 与 buildBriefSummaryPrompt (L3) 共用同一真相源。
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
${renderFiveElementItems()}

${renderBriefSummaryConstraints('inline')}

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

// ===========================================================================
// COVENANT_RESEARCH — L2 投研差量公约 (P1 重写 · 2026-05-04 · B 路线)
// ===========================================================================
// P1 决议: 投资画像外置到 ~/.arena/research-profile.md (避免模型反向硬套权重),
//   covenant 重写为 4 块判断纪律差量结构 + 红线 + profile 指针。
const COVENANT_RESEARCH = `# 投研圆桌 · 研究纪律（差量层 · 仅写 research 独有约束）

## 1. 证据优先
- 先引用数据，再给判断；二手表述低于原始数据源
- 没数据就明确缺口（"我需要 X 数据才能判断 Y"），不硬编

## 2. 假设分层
- 区分**已知事实 / 推断 / 待验证假设**，不把"可能"包装成"确定"
- 区分**短期催化 / 中期逻辑 / 长期结构**，不混为一谈

## 3. 分歧保留
- 同时保留多条解释路径，不为追求统一结论而强行收口
- summary 时明确"主分歧点"

## 4. 输出格式
- 关键结论先行（推荐 / 不推荐 / 中性 / 观望）
- 量化给数字，定性给参照系；问什么答什么，不套模板
- 圆桌产物是观点不是研报——一次 snapshot 给观点足够，别循环调多个 op 拼"完整研报"

## 红线（任何讨论都要避开）
- 非行业龙头硬蹭概念（无独家技术 / 议价能力证据除外）
- 技术明显走坏（破关键支撑、量价背离）
- 监管 / 财务造假风险

## 用户画像
涉及个股/板块决策时，主动 Read \`~/.arena/research-profile.md\` 获取用户偏好。
未读时按通用研究纪律输出，不假设用户风格。
`;

// ===========================================================================
// SCENE_REGISTRY
// ===========================================================================
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
      { icon: '🔍', title: '代码评审', q: '看下 core/foo.js，三席各挑 3 个问题', hint: '默认提问 → @summary @pikachu' },
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
      { icon: '🏭', title: '行业扫描', q: 'AI 芯片板块本周资金面怎么样？', hint: '默认提问 → @summary @pikachu' },
      { icon: '⚖️', title: '持仓复盘', q: '帮我复盘昨天的交易，是不是追高了？', hint: '默认提问 → 自由展开' },
    ],
  },
};

// ===========================================================================
// 【设计纪律】关于已删除的 RESUME_REMINDERS / Arena Memory (P2 / P5 · 2026-05-04)
// ===========================================================================
// RESUME_REMINDERS (P2 删):
//   未来如需复活,必须遵守差量原则 (Squirtle 第 9 轮检查标准):
//   "凡是新开会议系统提示也必须给的内容,都不应该写在 resume。"
//   resume 只承载"恢复语境"差量 (在恢复 + 第 N 轮 + timeline 路径),
//   不承载行为协议 (人设/规则/方法都已在 L1/L2/scene preset 完整注入)。
//
// Arena Memory (P5 删 core/arena-memory/ 整目录):
//   跨会议共识快照概念有价值,但当前实现是死代码。
//   未来重启议题时必须考虑:
//     1. 注入路径 (启动 system prompt vs L3 每轮 hint 必须明确)
//     2. user 主动写入机制 (UI 入口 / 命令行)
//     3. 与 timeline.md 的边界 (避免功能重叠)
//     4. 跨会议同步策略 (mtime 检测 / hash 对比)
//   圆桌 22 轮讨论档案: docs/roundtable-prompt-refactor-plan.md (P5 段)

// ===========================================================================
// Public API
// ===========================================================================

function getScene(sceneKey) {
  if (!sceneKey) return null;
  return SCENE_REGISTRY[sceneKey] || null;
}

function getSceneKeys() {
  return Object.keys(SCENE_REGISTRY);
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

// ===========================================================================
// File management helpers
// ===========================================================================
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
  BRIEF_SUMMARY_FIELDS,
  BRIEF_SUMMARY_CONSTRAINTS,
  renderFiveElementItems,
  renderBriefSummaryConstraints,
  getScene,
  getSceneKeys,
  buildSystemPrompt,
  writePromptFile,
  writeCovenantSnapshot,
  readCovenantSnapshot,
  cleanup,
  writeResearchMcpConfig,
  buildResearchMcpEntryForCodex,
};
