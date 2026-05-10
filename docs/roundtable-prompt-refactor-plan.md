# 圆桌 Prompt 架构重构计划（Pikachu/Charmander/Squirtle 三方圆桌产出）

> 本文件是后续给 Claude 一次性落地修改的施工单。  
> 来源：通用圆桌会议 `timeline-a61f5987-f778-467e-a4bf-e6a334ad335e.md`  
> 目标文件：`C:\Users\lintian\claude-session-hub\core\roundtable-scenes.js`

## 背景：4 层架构现状

| 层 | 内容 | 位置 |
|---|---|---|
| L1 | `BASE_RULES`（核心规则） | `roundtable-scenes.js:35-79` |
| L2 | 房间公约（`COVENANT_GENERAL` + 场景叠加 `COVENANT_RESEARCH`） | `roundtable-scenes.js:152-202 / 207-245` |
| L3 | 每轮 prompt（调度上下文 + 上一轮 + 任务 + timeline 路径） | `roundtable-orchestrator.js` |
| L4 | `timeline.md`（外置历史） | `roundtable-timeline.js` |

装配：`buildSystemPrompt()` 把 L1 + scene.preset + L2 拼成 `{meetingId}-prompt.md`，CLI 启动时 `--append-system-prompt-file` 注入。

---

## P0 — L1 BASE_RULES 瘦身 ✅ 已敲定

### 当前问题

| 问题 | 行号 | 浪费原因 |
|---|---|---|
| A 股投研禁令 3 行 | line 46 | 通用圆桌每轮背一遍跟自己无关的禁令 |
| 投研数据查询（allowed tools 第 3 条） | line 51 | 与 `RESEARCH_PRESET:106-115` 完全重复 |
| 调度模式枚举（fanout/debate/summary, all/pilot/observer） | lines 63-67 | L3 调度上下文已实时输出，L1 复读是维护债 |
| "木桶原理"修辞 | line 54 | "≤ 1500 字"已覆盖语义，纯文学 |
| 席位"配置细节"（"同一家 AI 可占多个席位"） | line 59 后半 | 配置细节，对单轮回答质量无价值 |

注释自称"L1 ~250 字"，实际 ~700 字，已严重超标。

### 改动 1 — 替换 `BASE_RULES` 常量（lines 35-79）

```javascript
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
```

中文字数 ~260（vs 当前 ~700，**-63%**）。

### 改动 2 — 更新 `BASE_RULES` 顶部注释（lines 22-34）

把"L1 ~250 字"改为"L1 ~260 字 / 由 unit test 兜底"。加入 **Squirtle 的准入 3 问**：

```javascript
// L1 BASE_RULES 准入规则（新增内容必须三问全 yes，否则下沉到 scene.preset 或 COVENANT）：
//   1. 是否所有场景（general / research / 未来 scene）都需要？
//   2. 是否每一轮都值得重复读？
//   3. 如果过期是否会造成错误引导？
// 任一为 no → 不进 L1。长度预算：≤ 350 中文字（含标点），由 unit test 兜底。
```

### 改动 3 — 新增 `tests/unit-base-rules-budget.test.js`

```javascript
const { BASE_RULES } = require('../core/roundtable-scenes.js');

test('L1 BASE_RULES 中文字数在预算内', () => {
  const cn = [...BASE_RULES].filter(c => /[一-龥]/.test(c)).length;
  expect(cn).toBeLessThanOrEqual(350); // 当前 ~260，留 ~90 字 buffer
});

test('L1 不得包含投研场景专属字符串（防反弹）', () => {
  expect(BASE_RULES).not.toMatch(/cli\.py|Stock_top10|fetch_lindang|tushare|data_query/);
});
```

### 改动 4 — 验证（不改动）

1. grep `cli.py analyze` / `fetch_for_arena` / `Stock_top10` 确认在 `RESEARCH_PRESET` 命中（应已存在 `RESEARCH_PRESET:123-130`）
2. 跑 `tests/unit-roundtable-prompt-format-contract.test.js` 确认不依赖被删 L1 字符串

### 不改动的相邻文件

- `RESEARCH_PRESET` / `COVENANT_GENERAL` / `COVENANT_RESEARCH` / `RESUME_REMINDERS` —— 这些是 P1/P2 议题
- `roundtable-orchestrator.js` —— L3 不动

### 未消解分歧（待用户裁决）

- **Squirtle 主张更激进的 ~150 字极限协议版**（连席位昵称、工具枚举都删，只留两段）。本次先按 260 字版落地（Phase 1），观察 1-2 周后再评估是否进 Phase 2 极限版。

---

## P1 — L2 research 优化 ✅ 已敲定（用户选 B 路线 · 2026-05-04 第 8 轮）

### 三层分工边界（Squirtle 提出 + 三方共识）

| 层 | 性质（核心问题） | 内容归属 |
|---|---|---|
| `RESEARCH_PRESET` | 资源 / 操作（你能用什么、缺数据怎么办） | 数据入口、MCP 优先级、旧入口禁令、失败兜底、`fetch_warning` |
| `COVENANT_RESEARCH` | 判断 / 表达纪律（拿到数据后怎么推理和表达） | 4 块差量（证据优先 / 假设分层 / 分歧保留 / 输出格式）+ 红线 |
| `~/.arena/research-profile.md` ⭐**新增 L4 外置** | 用户画像（这个用户偏好什么） | 投资风格 / 权重 / 资金区间 / 场景适配 |

**长期治理闸门**（Squirtle 三条规则，写入 `roundtable-scenes.js` 顶部注释）：
1. 所有具体工具 / 数据入口 / 命令 / 旧入口禁令，只能在 `RESEARCH_PRESET`
2. 所有通用协作纪律（礼仪、timeline、留白、分歧表达）不得在 `COVENANT_RESEARCH` 重复
3. 所有"用户个人偏好"默认不视为 covenant；若暂留 L2 必须明确标 reference 或外置 profile

---

### Phase 1 — 同层去混装（保守落地）

#### 改动 1.1 — `RESEARCH_PRESET`（lines 84-134）

| 操作 | 当前位置 | 处理 |
|---|---|---|
| 🟥 删 | line 131 "纯读不写" | 与 L1 BASE_RULES "禁 Edit/Write 文件" 重复 |
| 🟧 迁出 | line 130 "圆桌产物是观点不是研报" | 移到 `COVENANT_RESEARCH`（属于判断纪律，非数据接入） |
| 🟧 瘦身 | lines 98-104 19 个 op 子命令清单 | 只留 `snapshot / gate / basic / price+indicators` 4 个最常用，其余改为"完整清单见 `C:\LinDangAgent\data\AGENT_GUIDE.md`" |
| 🟧 瘦身 | line 132 "失败兜底已内建：tushare 挂了自动 akshare→东财→baostock→sina" | 简化为"失败自动兜底；若结果含 `fetch_warning`，结论里声明数据可信度略低" |
| 🟩 保留 | "严禁旧入口"（lines 125-130）、MCP 优先级、`fetch_warning` 处理 | 操作禁令每轮必读，不动 |

预计 PRESET 从 ~50 行 → ~25 行。

#### 改动 1.2 — `COVENANT_RESEARCH`（lines 207-245）

| 操作 | 当前位置 | 处理 |
|---|---|---|
| 🟥 删 | lines 209-218 "我们能讨论什么" 6 个例子 | AI 看到"投研圆桌"自然知道范围；保留末尾"问什么答什么"合并到输出习惯 |
| 🟥 删 | lines 241-244 "留白"整段 3 句 | 与 `COVENANT_GENERAL` 留白 + L1 三原则 100% 重叠 |
| 🟥 删 | line 239 "不必非要给决策" | 与 L1 原则 #3"不知说不知"重叠 |
| 🟧 合并 | lines 220-228 "我的投资风格" + "我重点关注" | 合并为"投资画像"段，**Phase 1 暂留 covenant，标 reference**（Phase 2 外置） |
| 🟩 保留 | lines 230-233 "红线" | 唯一不可替代的差量，完整保留 |
| 🟩 保留 | lines 235-239 输出习惯前 3 条（结论先行 / 量化给数字 / 不套模板） | 真正的 research 表达约束 |
| ➕ 新增 | 从 PRESET 迁来 | "圆桌产物是观点不是研报" |

预计 COVENANT_RESEARCH 从 ~40 行 → ~20 行。

#### 改动 1.3 — 新增 `tests/unit-research-l2-budget.test.js`

```javascript
const { RESEARCH_PRESET, COVENANT_RESEARCH } = require('../core/roundtable-scenes.js');

test('RESEARCH_PRESET 不得包含通用协作纪律', () => {
  expect(RESEARCH_PRESET).not.toMatch(/timeline|摘要按钮|五元组|席位|留白/);
});

test('COVENANT_RESEARCH 不得包含通用协作纪律（防反弹）', () => {
  expect(COVENANT_RESEARCH).not.toMatch(/timeline|摘要按钮|五元组|席位|本色发挥/);
});

test('COVENANT_RESEARCH 不得包含具体工具/命令名（应在 PRESET）', () => {
  expect(COVENANT_RESEARCH).not.toMatch(/fetch_lindang|data_query|MCP|cli\.py/);
});
```

---

### Phase 2 — 用户画像外置 + 4 块差量重写（用户已选 B · 2026-05-04 拍板）

#### 改动 2.1 — 创建 `~/.arena/research-profile.md`（默认模板）

把 Phase 1 留在 covenant 的"投资画像"完整迁出：

```markdown
# 用户研究画像（参考，仅在涉及个股/板块决策时被 AI Read）

## 投资风格
- 基本面强 + 题材正宗（不蹭概念）+ 短期启动趋势已立（放量突破、均线多头）
- 风险偏好：中性偏稳，单股仓位通常 1-3 万

## 关注权重（参考，不强制套用）
基本面 15% / 预期差 35% / 资金面 30% / 技术面 20%

## 场景适配
- 单股决策：偏向资金面 / 技术面 / 预期差
- 板块研判：偏向行业景气 / 资金流向 / 政策催化
- 概念选股：强调"正宗度"（核心受益度，不是蹭概念）
```

#### 改动 2.2 — `COVENANT_RESEARCH` 重写为 4 块差量结构（采纳 Squirtle 第 6 轮提案）

```markdown
# 投研圆桌 · 研究纪律（差量层 · 仅写 research 独有约束）

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
涉及个股/板块决策时，主动 Read `~/.arena/research-profile.md` 获取用户偏好。
未读时按通用研究纪律输出，不假设用户风格。
```

#### 改动 2.3 — UI 编辑入口（**待跨议题讨论**）

让用户在 meeting 创建/编辑时填 profile（或顶部菜单"我的研究画像"独立编辑）。**本次重构暂不实现 UI**——先在 `~/.arena/research-profile.md` 提供默认模板，用户手工编辑。后续作为独立 issue 推进。

#### 改动 2.4 — 新增 unit test 兜底

```javascript
test('COVENANT_RESEARCH 不得直接写用户偏好数字（应在 profile）', () => {
  // Phase 2 后投资画像应已外置；防止反弹
  expect(COVENANT_RESEARCH).not.toMatch(/单股仓位|1-3 万|15%|35%|30%|20%/);
});
```

---

### 实施顺序（Phase 1 + 2 一起出，一次 commit）

1. 改 `RESEARCH_PRESET`（lines 84-134，按 1.1 表）
2. 改 `COVENANT_RESEARCH`（lines 207-245，按 2.2 草稿直接 Phase 2 版本）
3. 创建 `~/.arena/research-profile.md` 默认模板（2.1）
4. 顶部注释加 Squirtle 三条边界规则
5. 新增 `unit-research-l2-budget.test.js`（合并 1.3 + 2.4）
6. E2E：research 场景跑两轮（涉及决策 + 不涉及决策），观察是否 Read profile

### 不改动的相邻文件

- `COVENANT_GENERAL` — 保持稳定
- `RESUME_REMINDERS` — P2 议题
- `roundtable-orchestrator.js` — L3 不动

### 维护者声明

**P0 / P1 计划文件由 Pikachu 独家维护**，其他席位（Charmander / Squirtle）请勿另开文件，避免双文件分裂。

---

## P2 — RESUME_REMINDERS 直接删除 ✅ 已敲定（用户拍板路线 A · 2026-05-04 第 10 轮）

### 关键事实（Charmander 第 9 轮 grep 发现）

**`getResumeReminder()` 在 main.js 中调用次数 = 0** —— 是死代码。

main.js resume 流程实际走：
```
resume-session IPC → writePromptFile(meetingId, scene, covenant)
                  → claude --resume <ccSessionId> --append-system-prompt-file <promptFile>
```

L1 + L2 + scene preset 已通过 `writePromptFile` 完整重注，Claude CLI `--resume` 恢复 PTY 历史 —— AI 拿到的 system prompt 和新会话完全相同。`RESUME_REMINDERS` 是方案 F 重构时的"预留设计"，从未真正接入。

main.js `scenes.*` 调用统计：

| 方法 | 调用次数 |
|---|---|
| `getScene` | 9 |
| `writePromptFile` | 3 |
| `writeCovenantSnapshot` / `readCovenantSnapshot` | 4 |
| `writeResearchMcpConfig` | 1 |
| `cleanup` | 2 |
| **`getResumeReminder`** | **0** |

### 决议（用户拍板路线 A）

**直接删，不复活、不一行版差量化。** 论据：
- 死代码本身就该删（每改 L1 都要想"RESUME_REMINDERS 要不要同步"是无意义维护债）
- L1 + L2 完整重注 + PTY 上下文恢复已足够
- 没有证据表明 resume 后 AI 失忆
- 一行差量版（Charmander 第 10 轮路线 B）仍是重复职责（Squirtle 第 10 轮关键判断："`--resume` 已经恢复历史，模型并不缺'我在恢复'这个认知"）

### 改动清单

#### 改动 1 — `roundtable-scenes.js`

- 删 `RESUME_REMINDERS` 常量（lines 250-262）
- 删 `getResumeReminder()` 函数（lines 313-315）
- 删 `module.exports` 里 `getResumeReminder`（line 452）
- 更新顶部注释 line 11，去掉 `getResumeReminder(key)— 恢复提醒文本` 描述

#### 改动 2 — 测试清理

- 删 `tests/unit-roundtable-scenes.test.js:197-207`（测死代码的测试是更糟的债）

#### 改动 3 — 长期治理注释（**采纳 Squirtle 第 9 轮检查标准**）

加到 `roundtable-scenes.js` 顶部注释：

```javascript
// 【设计纪律】未来如需复活 resume 提醒，必须遵守差量原则：
//   "凡是新开会议系统提示也必须给的内容，都不应该写在 resume。"
// resume 只承载"恢复语境"差量（在恢复 + 第 N 轮 + timeline 路径），
// 不承载行为协议（人设/规则/方法都已在 L1/L2/scene preset 完整注入）。
```

#### 改动 4 — 验证（删之前必跑）

起 research 圆桌聊 5 轮 → 关闭 PTY → resume → 发用户问题 → 检查 AI 是否：
- 正确认出席位（Pikachu/Charmander/Squirtle）
- 能引用 timeline 历史
- 不反问"你是谁 / 我们在聊什么"

**通过** → 按改动 1-3 一次 commit；**失败** → 暂停删除，调查 resume 流程是否另有依赖。

### 关于"用户驱动语法"是否补进 COVENANT_GENERAL（采纳 Charmander 反对意见）

Pikachu 第 8 轮提议把"@debate / @summary @<slot>"等用户语法补进 COVENANT_GENERAL（避免 RESUME_REMINDERS 删除后丢失）。

Charmander 第 10 轮反对：AI 看到的是 orchestrator 解析后的 L3 任务指令（如"## 你的任务：基于上一轮内容发表新观点"），不需要识别原始 `@` 字符串。给 AI 写一份"它永远用不到的语法手册"是新增维护债。

**采纳 Charmander 反对**：直接删除用户语法说明，**不补到任何地方**。COVENANT_GENERAL 不动。

---

## P3 — GENERAL_PRESET 补强 ✅ 已敲定（用户采纳 Pikachu 第 13 轮推荐版 · 2026-05-04 第 14 轮）

### 当前状态

`GENERAL_PRESET`（lines 139-143）只有 4 行，与优化后 `RESEARCH_PRESET` 严重不对称（4 vs 25 行）：

```javascript
const GENERAL_PRESET = `## 通用圆桌
这是一个开放话题的圆桌讨论。你可以就任何话题发表观点。
善用你的工具（联网搜索、读文件、跑代码、MCP）辅助回答，能查就查不要凭印象。
不预设讨论场景，根据用户提问自适应。
`;
```

问题：**全是空话**——"善用工具"AI 不知道何时真用；"自适应"等于没说。L1/L2 一直在做减法，general 场景骨架已薄到危险线。

### 决议（三方共识 + 用户拍板）

走 **Pikachu 第 13 轮推荐版**（~210 字，介于 Squirtle 极简 150 字 / Charmander 终版 240 字之间）。核心：4 条协作策略 + 1 段场景定位。

### 改动 1 — 替换 `GENERAL_PRESET` 常量（lines 139-143）

```javascript
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
```

中文字数 ~210（vs 当前 ~50，**+4x**，但仍只有 RESEARCH_PRESET 的 1/2 体量）。

### 改动 2 — 准入闸门 5 条（顶部注释）

```javascript
// GENERAL_PRESET 准入（融合 Squirtle 第 12 轮负约束 + Charmander 跨层禁令）：
//   1. 不含场景特定知识（投研/技术辩论/写作等）
//   2. 不重复 L1（工具清单/禁令）或 COVENANT_GENERAL（席位/礼仪/timeline 机制）
//   3. 不跨层引用（如"工具集见 L1"）—— preset 应单层可读
//   4. 不依赖"当前轮模式/调度/输出风格"才成立（防 fanout/debate/summary 教学反弹）
//   5. 长度上限：≤ 350 中文字（含标点），由 unit test 兜底
```

### 改动 3 — 新增 `tests/unit-general-preset-budget.test.js`

```javascript
const { GENERAL_PRESET } = require('../core/roundtable-scenes.js');

test('GENERAL_PRESET 不含模式/调度教学（依赖当前轮模式）', () => {
  expect(GENERAL_PRESET).not.toMatch(/fanout|debate|summary|主驾|副驾|@<slot>|@pikachu/i);
});
test('GENERAL_PRESET 不含场景特定知识', () => {
  expect(GENERAL_PRESET).not.toMatch(/股票|投资|tushare|fetch_lindang|MCP/);
});
test('GENERAL_PRESET 不重复 L1/L2 协作礼仪', () => {
  expect(GENERAL_PRESET).not.toMatch(/席位|本色|不扮演|引用明示|分歧不抹平/);
});
test('GENERAL_PRESET 不跨层引用', () => {
  expect(GENERAL_PRESET).not.toMatch(/见 L1|见 BASE_RULES|见房间公约/);
});
test('GENERAL_PRESET 长度 ≤ 350 中文字', () => {
  const cn = [...GENERAL_PRESET].filter(c => /[一-鿿]/.test(c)).length;
  expect(cn).toBeLessThanOrEqual(350);
});
```

### 关于 COVENANT_GENERAL 是否补 dispatchMode 各模式发言姿态段（采纳三方第 12 轮共识）

Charmander 第 10/12 轮主张补 3 行"各模式发言姿态"到 `COVENANT_GENERAL` 的"关于 dispatchMode 切换"段。

**不补**：模式行为 AI 已通过 L3 调度上下文实时获得；orchestrator 控制谁发言（dispatcher 层），AI 不需要懂 `@` 语法。P1 决议"不动 COVENANT_GENERAL"在精神上仍生效。

### 与三方方案的差异化解

| 维度 | 终版选择 | 理由 |
|---|---|---|
| 字数 | ~210（Pikachu 中间值） | 比 Squirtle 多 1 段场景定位防"研报体"，比 Charmander 删"不强制模板"防反弹 |
| "标注未验证" | 保留 | 低成本安全网，1 句话不算膨胀 |
| "不强制模板" | 删 | Squirtle 论据强：靠 preset 本身轻就够，写出来反而暗示有模板可套 |
| "用户主导节奏" | 删 | L1 "圆桌内绝不自行执行" 已覆盖 |
| "工具集见 L1" 跨层引用 | 删 | preset 单层可读 |
| "凭印象"措辞 | 改"凭记忆" | Charmander 措辞修正：AI 没有"印象"只有训练数据 |

### 全貌效果

| 指标 | 改前 | 改后 |
|---|---|---|
| GENERAL_PRESET 中文字 | ~50 | ~210 |
| 可操作协作指引 | 0 条 | 4 条 |
| 与 RESEARCH_PRESET 重量比 | 1:7 | 1:2（合理对称） |
| 与 L1/L2 交叉重复 | 0 | 0（5 条闸门 + unit test 防护） |

---

## P4 — 五元组格式 SSoT 统一 ✅ 已敲定（用户采纳 Pikachu 第 18 轮 summary 方案 A · 2026-05-04 第 19 轮）

### 事实校正（第 14-15 轮 grep 核实）

第 1 轮 Charmander 提出"格式定义三处"——实际查证后是**两处**：

| 位置 | 行号 | 角色 |
|---|---|---|
| `COVENANT_GENERAL` 五元组段 | `roundtable-scenes.js:178-185` | L2 静态公约（system prompt 启动注入） |
| `buildBriefSummaryPrompt` 输出格式段 | `roundtable-orchestrator.js:334-345` | L3 每轮 prompt（摘要按钮触发时发送） |

第三处 `config/summary-templates.json` **代码里不存在**——是早期设计文档的规划，未实现；`core/summary-engine.js` 是 deep-summary（Gemini 会议总结）服务，与五元组无关。

### 当前两处差异（漂移而非设计）

格式条目（5 段）一致；约束措辞略不同：

| | COVENANT_GENERAL | buildBriefSummaryPrompt |
|---|---|---|
| 字数 | "不超过 500 字" | "不超过 500 字" |
| 人称 | "第一人称" | "第一人称（'我认为'）" |
| 论证 | "不展开论证" | "不展开论证、不重复事实细节" |

Charmander 第 16 轮曾把这种差异定性为"故意差量"（L2 简洁/L3 详细），Pikachu 第 16 轮反驳成立——无 design doc 支撑，应当作漂移消除。Charmander 第 17 轮收回此立场。

### 决议（用户拍板方案 A · 三方实质共识）

**单一 schema · 双处可见 · 仅样式可变**：
- 结构化 schema 抽出（fields[] + constraints[]）
- L2 保留完整格式（预习价值）
- 约束 4 条独立（删"我认为"扩写，"不展开论证"与"不重复事实细节"拆开——不同失败模式）
- 字段渲染单 pure function（无语气参数）
- 约束渲染按 caller 需求 inline / list（封装为 helper，堵住 caller 手拼漂移漏洞）

### 改动 1 — `roundtable-scenes.js` 新增 schema 与 render helper

```javascript
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
  return BRIEF_SUMMARY_FIELDS.map(([n, d], i) => `${i+1}. **${n}**：${d}`).join('\n');
}

function renderBriefSummaryConstraints(style /* 'inline' | 'list' */) {
  return style === 'inline'
    ? `约束:${BRIEF_SUMMARY_CONSTRAINTS.join('，')}。`
    : BRIEF_SUMMARY_CONSTRAINTS.map(c => `- ${c}`).join('\n');
}

// module.exports 中导出 4 项
```

### 改动 2 — `COVENANT_GENERAL` 替换内联格式（lines 178-185）

```markdown
### 五元组格式（被点名摘要时严格按此输出）
${renderFiveElementItems()}

${renderBriefSummaryConstraints('inline')}
```

外包框（`### 五元组格式（被点名摘要时严格按此输出）`）由 caller 写。

### 改动 3 — `buildBriefSummaryPrompt` 替换内联格式（lines 334-345）

```javascript
parts.push('', '## 输出格式（严格按五段，不要展开论证）');
parts.push(renderFiveElementItems());
parts.push('', '## 约束');
parts.push(renderBriefSummaryConstraints('list'));
// 删除原 lines 335-344 的硬编码格式与约束
```

### 改动 4 — 新增 `tests/unit-five-element-schema.test.js`

```javascript
const {
  BRIEF_SUMMARY_FIELDS, BRIEF_SUMMARY_CONSTRAINTS,
  renderFiveElementItems, renderBriefSummaryConstraints,
  COVENANT_GENERAL,
} = require('../core/roundtable-scenes.js');

test('五元组恰好 5 字段', () => {
  expect(BRIEF_SUMMARY_FIELDS).toHaveLength(5);
});
test('五字段标题稳定', () => {
  expect(BRIEF_SUMMARY_FIELDS.map(([n]) => n)).toEqual(
    ['目标', '关键事实', '关键分歧', '当前结论', '下一步']
  );
});
test('约束恰好 4 条独立', () => {
  expect(BRIEF_SUMMARY_CONSTRAINTS).toHaveLength(4);
  expect(BRIEF_SUMMARY_CONSTRAINTS).toContain('不展开论证');
  expect(BRIEF_SUMMARY_CONSTRAINTS).toContain('不重复事实细节');
});
test('COVENANT_GENERAL 与 buildBriefSummaryPrompt 共用同一份字段渲染', () => {
  expect(COVENANT_GENERAL).toContain(renderFiveElementItems());
});
```

### 不改动的相邻文件

- `core/summary-engine.js` —— deep-summary 服务，与五元组无关（Squirtle 第 16 轮原则：不扩 scope）
- `config/summary-templates.json` —— 不存在/无运行时依赖

### 三方收敛轨迹（debate 节奏记录）

- 第 14 轮：Pikachu 核实"两处非三处"
- 第 15 轮：Charmander 推方案 A 共享常量；Squirtle 主张"L2 只讲触发"
- 第 16 轮 debate：Pikachu 反驳"故意差量"是漂移合理化；Squirtle 收回"L2 只讲触发"，提出结构化 schema + 双 render
- 第 17 轮 debate：Charmander 收回"故意差量"+"L3 扩写"；三方收敛到"4 条约束独立 + 删'我认为'举例 + 单 pure render"
- 第 18 轮 summary：方案 A 落地（双 pure helper 版）

### 整体进度

| Phase | 内容 | 状态 |
|-------|------|------|
| P0 | L1 BASE_RULES 瘦身（700→260 字） | ✅ 方案定 |
| P1 | L2 research 三层分型（B 路线 · 投资画像外置） | ✅ 方案定 |
| P2 | RESUME_REMINDERS 直接删除（路线 A） | ✅ 方案定 |
| P3 | GENERAL_PRESET 补强（4 协作策略 + 1 段场景定位 ~210 字） | ✅ 方案定 |
| P4 | 五元组 SSoT（结构化 schema + 4 约束 + 双 pure helper） | ✅ 方案定 |
| **P5** | **Arena Memory 每轮刷新** | **本轮进入讨论** |

---

## P5 — Arena Memory 直接删除 ✅ 已敲定（用户拍板路线 A · 2026-05-04 第 23 轮）

### 关键事实（Charmander 第 20 轮 grep 发现）

`core/arena-memory/` 整个模块（`injector.js` + `store.js` + `marker-parser.js`，~200 行）**从未被 main.js 导入**。grep `require.*arena-memory` 只在测试文件命中——和 RESUME_REMINDERS 一模一样的死代码模式。

### 决议（用户拍板路线 A，整个记忆系统后面再统一优化）

**直接删，不复活、不分层设计**。理由：
- 死代码本身就该删（每改 L1/L2 都要想"Arena Memory 要不要同步"是无意义维护债）
- 用户决定整个记忆系统（Arena Memory + facts.md 设计 + 跨会议同步策略）后续单独成立大议题统一审视
- 本次重构 scope 内不引入新功能负担

### 改动清单

#### 改动 1 — 删除 `core/arena-memory/` 整个目录
- `injector.js`
- `store.js`
- `marker-parser.js`

#### 改动 2 — 测试清理
- 删 `tests/arena-memory.test.js`

#### 改动 3 — 长期治理注释（写入 main.js 顶部 imports 区或 README）

```
// 【设计纪律】Arena Memory（跨会议共识快照）的概念有价值，但当前实现是死代码。
// 未来重新设计时必须考虑：
//   1. 注入路径（启动 system prompt vs L3 每轮 hint 必须明确）
//   2. user 主动写入机制（UI 入口 / 命令行）
//   3. 与 timeline.md 的边界（避免功能重叠）
//   4. 跨会议同步策略（mtime 检测 / hash 对比）
// 圆桌 22 轮讨论档案：roundtable-prompt-refactor-plan.md (P5 段)
```

### 这一次重构后续的 Memory 系统设计议题（暂存）

22 轮讨论中识别的关键设计选项（未来重启议题时参考）：
- **双路径**：启动注入 stable facts + 会中 L3 hint 变更（Squirtle 第 21 轮 MVP）
- **单路径**：仅启动注入（Charmander 档 1，被反驳"半生不熟"）
- **stable / live 分层**：stable facts.md + live-facts.md 两文件（Squirtle 第 20 轮，后自我撤回）
- **关键技术约束**：PTY 启动后 prompt 文件不可变，"每轮刷新"必须走 L3 路径

---

## P6 — L3 骨架统一 + micro-reminder 合并解决 ✅ 已敲定（用户采纳 Pikachu 第 26 轮 summary · 2026-05-04 第 26 轮）

### 议题来源

用户在第 23 轮提出"L3 涉及每轮，非常重要，22 轮没专门审视过"——Pikachu 第 23 轮承认"骨架不一致是 attention 协议成本，不是美学问题"，撤回 YAGNI 立场。同时 P6 micro-reminder（attention decay 议题）在本议题中自动消解（融入字段化调度上下文的"轻提醒"字段），无需独立 Phase。

### 当前问题（第 23-26 轮三方收敛）

#### 问题 1：4 个 build 函数骨架不一致

`core/roundtable-orchestrator.js` 4 个 prompt 构造器结构差异显著：

| 段 | fanout | debate | summary | brief |
|---|:-:|:-:|:-:|:-:|
| `[scene · 第N轮 · mode]` 标签 | ✅ | ✅ | ✅ | ✅ |
| `## 调度上下文` | ✅ | ✅ | ✅ | ❌ |
| 上一轮注入 | ✅ | ✅ | ✅ | ❌ |
| `## 数据接入` | ✅* | ❌ | ❌ | ❌ |
| `## 用户问题 / 用户补充 / 你的任务 / 任务` | 各异 | 各异 | 各异 | 各异 |
| 行为提示独立段 | ✅ | ❌（合任务）| ❌（合任务）| ❌ |
| `## 输出格式 / 约束` | ❌ | ❌ | 部分 | ✅ |
| timeline footer | ✅ | ✅ | ✅ | ✅ |

AI 在不同模式间切换时要重新找锚点，是 attention 协议层面的真问题（Charmander/Squirtle 第 24 轮独立指出）。

#### 问题 2：行为提示散落在 prompt 头尾

fanout 中"请独立回答（你看不到其他人本轮观点）"在用户问题之**后**——AI 先读大块"上一轮"再读到行为约束，时序错误。

#### 问题 3：调度上下文段不字段化

当前 `## 调度上下文` 仅 2 行（"模式：X / 同台：Y"），但缺"我是谁 / 回答方式 / 轻提醒"等关键运行时信息。Squirtle 第 26 轮提出字段化结构。

#### 问题 4：L1/L2 attention decay（P6 议题）

L1/L2 在 system prompt 启动时注入一次，PTY 运行期间不可变。长对话（22+ 轮）中关键铁律（"≤ 1500 字"、"不写文件"）会被 recency 稀释。需要 L3 每轮强化。

### 决议（用户采纳 Pikachu 第 26 轮 summary + 第 28 轮 free 模式覆盖）

**统一 L3 5 段骨架 + 字段化调度上下文 + footer 压缩 + 覆盖 pilot + free 双路径** —— 三方第 26 轮收敛 + 第 28 轮用户拍板 A1+B1+C1：

- **覆盖范围**：pilot 路径 4 个 build 函数（`roundtable-orchestrator.js`）+ **free 路径 3 个 build 函数**（`roundtable-free.js`，新增）
- 4 + 3 共 7 个 build 函数统一为同一 5 段骨架
- 保留 `## 调度上下文` 独立段（Squirtle 强论据：协议层锚点）
- 行为约束 + micro-reminder **字段化进调度上下文**（不另起独立段）
- timeline footer 压缩为 `> 完整历史:<path>`（保留绝对路径恢复力，视觉减重）
- brief-summary 纳入统一壳（仅 pilot 路径有此模式；free 路径无）

### 第 28 轮新增：free 模式覆盖（用户拍板 A1+B1+C1）

**关键事实**：free 模式（2026-05-04 同期开发）是新建会议的**默认模式**，但其 prompt 形态与 P6 决议完全不同：
- 第一行：`# 自由模式 第 N 轮 fanout — 你是 ⚡ Pikachu`（一级标题）
- 上下文段：`[本轮上下文]` 仅 3 字段
- 缺：轻提醒字段（attention decay 无防护）+ timeline footer（无恢复力锚点）+ ## 调度上下文 协议块名

如不覆盖，主要使用场景（默认 free）失去 P6 收益。

**用户拍板**：
- **A1（覆盖范围）**：P6 完全覆盖 free 模式（free 3 个 build 函数也改成统一骨架）
- **B1（第一行格式）**：free 改用 pilot 格式 `[<scene.name> · 第 N 轮 · <模式中文>]`，撤销原 `# 自由模式 第 N 轮 ...` 格式（pilot/free 头部统一便于 hub 解析）
- **C1（轻提醒）**：注入 free 模式（解决主场景 attention decay）

### Free 模式与 pilot 模式字段差异

字段名层面，free 沿用现有"本轮发言人"语义（含自己），pilot 保留"同台"语义（不含自己）：

| 字段 | pilot 模式 | free 模式 |
|---|---|---|
| 你是 | `X（副驾/主驾）` | `X`（无角色括注，free 取消主驾/副驾概念） |
| 同台/参与者 | `同台:Y / Z`（不含自己） | `参与者:X / Y / Z`（含自己，对应 participants 勾选） |
| 模式 | 群策群力 / 主驾深聊 / 副驾审查 | 自由（参与者勾选） |
| 轮次性质 | fanout / debate / summary / brief | fanout / debate / summary（无 brief） |
| 回答方式 | 同 P6 决议 | 同 P6 决议 |
| 轻提醒 | ≤ 1500 字 / 不写文件 / 不展开多步骤工作流 | 同 pilot |

### L3 终版统一骨架

```
[<scene.name> · 第 N 轮 · <轮次性质中文>]   ← 第一行保留原 scene tag 格式（鲁棒性保护依赖，hub 解析头部时需识别此格式，禁止改成 ## 标题形式）
                                              ← 4 模式 scene tag 实例：
                                              ←   fanout : [通用圆桌 · 第 N 轮 · 默认提问]
                                              ←   debate : [通用圆桌 · 第 N 轮 · @debate]
                                              ←   summary: [通用圆桌 · 第 N 轮 · @summary @Pikachu]
                                              ←   brief  : [通用圆桌 · 第 N 轮 · 摘要轮 · by Pikachu]

## 调度上下文
- 你是:X（副驾/主驾）
- 同台:Y
- 模式:群策群力 / 主驾深聊 / 副驾审查
- 轮次性质:fanout / debate / summary / brief
- 回答方式:<独立回答 / 引用回应 / 综合总结 / 五元组压缩>
- 轻提醒:≤ 1500 字 / 不写文件 / 不展开多步骤工作流

## 上一轮（第 N-1 轮 · mode · dispatchMode）   [可选,按 injection 规则]
> 提示:本段是上一轮内容...
[内容]

## 数据接入   [仅 research fanout 模式]
[数据包内容]

## 用户问题 / ## 用户补充 / ## 你的任务   [4 模式差量,标题不同]
<内容>

## 输出格式   [仅 summary / brief]
[格式约束]

> 完整历史:<timelinePath>   [压缩版,保留绝对路径]
```

### 4 + 3 模式具体差异（仅"调度上下文"字段值 + 主体段标题不同）

**Pilot 路径（4 模式）**：

| 模式 | scene tag 第一行 | "回答方式"字段值 | 主体段标题 |
|---|---|---|---|
| fanout | `[<scene.name> · 第 N 轮 · 默认提问]` | 独立回答（看不到他人本轮观点） | `## 用户问题` |
| debate | `[<scene.name> · 第 N 轮 · @debate]` | 引用并回应上一轮他人观点 | `## 你的任务` |
| summary | `[<scene.name> · 第 N 轮 · @summary @<X>]` | 综合全部讨论给最终意见，显列未消解分歧 | `## 你的任务` |
| brief | `[<scene.name> · 第 N 轮 · 摘要轮 · by <X>]` | 五元组压缩你最近发言 | `## 任务` |

**Free 路径（3 模式 · 第一行用 pilot 格式 B1）**：

| 模式 | scene tag 第一行 | "回答方式"字段值 | 主体段标题 |
|---|---|---|---|
| fanout | `[<scene.name> · 第 N 轮 · 默认提问]` | 独立回答（与其他参与者互相看不到本轮发言） | `## 用户问题` |
| debate | `[<scene.name> · 第 N 轮 · @debate]` | 反驳/呼应其他参与者观点（可看到对方本轮言论） | `## 你的任务` |
| summary | `[<scene.name> · 第 N 轮 · @summary @<X>]` | 综合上述历史给出总结 | `## 你的任务` |

### 改动 1 — 重写 `_renderDispatchContext`（字段化输出）

```javascript
_renderDispatchContext(dispatchSpec, mySid, sceneName) {
  if (!dispatchSpec) return null;
  const lines = ['## 调度上下文'];
  lines.push(`- 你是:${this._sidLabel(mySid)}（${this._roleLabel(dispatchSpec, mySid)}）`);
  if (dispatchSpec.companions && dispatchSpec.companions.length) {
    lines.push(`- 同台:${dispatchSpec.companions.map(s => this._sidLabel(s)).join(' / ')}`);
  }
  lines.push(`- 模式:${this._dispatchModeLabel(dispatchSpec.mode)}`);
  lines.push(`- 轮次性质:${this._turnKindLabel(dispatchSpec.turnKind)}`);
  lines.push(`- 回答方式:${this._answerStyleLabel(dispatchSpec.turnKind)}`);
  lines.push(`- 轻提醒:≤ 1500 字 / 不写文件 / 不展开多步骤工作流`);
  return lines.join('\n');
}
```

### 改动 2 — 重写 4 个 pilot build 函数为统一骨架（roundtable-orchestrator.js）

```javascript
buildFanoutPrompt(turnNum, userInput, dataPack, dispatchSpec, mySid, injectionPayload, timelinePath) {
  // 第一行保留原 scene tag 格式（鲁棒性保护：hub 头部解析依赖此格式）
  const parts = [`[${this.scene.name} · 第 ${turnNum} 轮 · 默认提问]`];
  // debate / summary / brief 同样保留原 scene tag：
  //   `[${this.scene.name} · 第 ${turnNum} 轮 · @debate]`
  //   `[${this.scene.name} · 第 ${turnNum} 轮 · @summary @${summarizerLabel}]`
  //   `[${this.scene.name} · 第 ${turnNum} 轮 · 摘要轮 · by ${summarizerLabel}]`
  parts.push('', this._renderDispatchContext(dispatchSpec, mySid));
  
  const last = this._renderLastTurnSection(injectionPayload, timelinePath);
  if (last) parts.push('', last);
  
  if (this.scene.dataPackEnabled && dataPack && dataPack.trim()) {
    parts.push('', '## 数据接入', dataPack);
  }
  
  parts.push('', '## 用户问题', userInput || '');
  parts.push('', this._renderTimelineFooter(timelinePath));
  return parts.join('\n');
}

// debate / summary / brief 同样结构,仅主体段标题和"回答方式"字段值不同
```

### 改动 2b — 重写 3 个 free build 函数为统一骨架（roundtable-free.js）

新增 free 模式专用的字段化 helper 与 footer renderer（可共用 pilot 的 `_renderTimelineFooter` 逻辑，但 free 是独立模块需各自维护或共用导出）：

```javascript
// roundtable-free.js 新增
function _renderFreeDispatchContext({ selfSlot, participants, sceneName, turnKind, answerStyle }) {
  const lines = ['## 调度上下文'];
  lines.push(`- 你是:${_slotLabel(selfSlot)}`);  // free 模式:无"副驾/主驾"角色括注
  lines.push(`- 参与者:${_formatParticipantList(participants)}`);  // 含自己
  lines.push(`- 模式:自由（参与者勾选）`);
  lines.push(`- 轮次性质:${turnKind}`);  // fanout / debate / summary
  lines.push(`- 回答方式:${answerStyle}`);
  lines.push(`- 轻提醒:≤ 1500 字 / 不写文件 / 不展开多步骤工作流`);
  return lines.join('\n');
}

function _renderFreeTimelineFooter(timelinePath) {
  if (!timelinePath || typeof timelinePath !== 'string') return null;
  return `> 完整历史:${timelinePath}`;
}

function buildFreeFanoutPrompt({ meeting, selfSlot, participants, userInput, lastTurnInjection, turnNum, sceneName, timelinePath }) {
  // 第一行改为 pilot 格式（B1 决议 · 鲁棒性保护：hub 头部解析依赖此格式）
  // 撤销原 `# 自由模式 第 N 轮 fanout — 你是 ⚡ Pikachu` 一级标题格式
  const parts = [`[${sceneName} · 第 ${turnNum} 轮 · 默认提问]`];
  parts.push('', _renderFreeDispatchContext({
    selfSlot, participants, sceneName,
    turnKind: 'fanout',
    answerStyle: '独立回答（与其他参与者互相看不到本轮发言）',
  }));
  
  const inj = _renderInjection(lastTurnInjection);
  if (inj) parts.push(inj);
  
  parts.push('', '## 用户问题', userInput || '');
  
  const footer = _renderFreeTimelineFooter(timelinePath);
  if (footer) parts.push('', footer);
  
  return parts.join('\n');
}

// buildFreeDebatePrompt / buildFreeSummaryPrompt 同样结构
//   debate: 第一行 `[<scene> · 第 N 轮 · @debate]`,主体段 `## 你的任务`
//           回答方式 `反驳/呼应其他参与者观点（可看到对方本轮言论）`
//   summary: 第一行 `[<scene> · 第 N 轮 · @summary @<X>]`,主体段 `## 你的任务`
//            回答方式 `综合上述历史给出总结`
//
// 删除原 free 三模板末尾的独立行为提示段（"请独立回答..."等）—— 已并入"回答方式"字段
//
// 注：free 路径需要新增传入 sceneName 和 timelinePath 参数（main.js 调用方提供）
```

**Free 模式调用方需要补传新参数**：原 `buildFreeFanoutPrompt({ meeting, selfSlot, participants, userInput, lastTurnInjection, turnNum })` → 新增 `sceneName`（meeting.scene 对应的中文名，如"通用圆桌"/"投研圆桌"）+ `timelinePath`。main.js 在调用 free build 函数处需补这两个参数。

### 改动 3 — `_renderTimelineFooter` 压缩

```javascript
_renderTimelineFooter(timelinePath) {
  if (!timelinePath || typeof timelinePath !== 'string') return null;
  return `> 完整历史:${timelinePath}`;  // 改前: '---\n完整历史:' 双行
}
```

### 改动 4 — 删除散落的独立行为提示段（pilot + free 双路径）

**Pilot 路径**（`buildFanoutPrompt:236-243`）：原 `if (mode === 'pilot') parts.push('请独立回答(本轮你被点名独说...)`)` 等三段独立行为提示全部删除——已并入 `_renderDispatchContext` 的"回答方式"字段。

**Free 路径**（`roundtable-free.js`）：原三个 build 函数末尾的独立行为提示段（`buildFreeFanoutPrompt` 末尾"请独立回答（与其他发言人互相看不到本轮发言，保持各自独立视角）"、`buildFreeDebatePrompt` 末尾"请反驳/呼应其他发言人的观点..."、`buildFreeSummaryPrompt` 末尾"请综合上述历史给出总结。"）全部删除——已并入 `_renderFreeDispatchContext` 的"回答方式"字段。

### 改动 5 — 新增 unit test

```javascript
// tests/unit-l3-skeleton-contract.test.js

test('pilot 路径 4 个 build 函数都包含统一骨架字段', () => {
  // 公共契约：pilot 必须含"同台"字段（不含自己）
  const checks = ['## 调度上下文', '- 你是:', '- 同台:', '- 模式:', '- 回答方式:', '- 轻提醒:'];
  for (const fn of [buildFanoutPrompt, buildDebatePrompt, buildSummaryPrompt, buildBriefSummaryPrompt]) {
    const out = fn(1, 'test', mockArgs);
    for (const c of checks) {
      expect(out).toContain(c);
    }
  }
});

test('free 路径 3 个 build 函数都包含统一骨架字段', () => {
  // free 契约：用"参与者"字段（含自己）替代 pilot 的"同台"
  const checks = ['## 调度上下文', '- 你是:', '- 参与者:', '- 模式:自由', '- 回答方式:', '- 轻提醒:'];
  for (const fn of [buildFreeFanoutPrompt, buildFreeDebatePrompt, buildFreeSummaryPrompt]) {
    const out = fn({ meeting: mockMeeting, selfSlot: 'pikachu', participants: [0, 1, 2], userInput: 'test', turnNum: 1, sceneName: '通用圆桌', timelinePath: '/tmp/t.md' });
    for (const c of checks) {
      expect(out).toContain(c);
    }
  }
});

test('free 路径第一行格式与 pilot 一致（B1 决议）', () => {
  // 防回归到原 `# 自由模式 第 N 轮 fanout — 你是 ⚡ Pikachu` 一级标题格式
  const out = buildFreeFanoutPrompt({ meeting: mockMeeting, selfSlot: 'pikachu', participants: [0,1,2], userInput: 'x', turnNum: 1, sceneName: '通用圆桌', timelinePath: null });
  const firstLine = out.split('\n')[0];
  expect(firstLine).toMatch(/^\[.+ · 第 \d+ 轮 · .+\]$/);
  expect(firstLine).not.toMatch(/^# 自由模式/);  // 防回归
  expect(firstLine).not.toMatch(/^##/);
});

test('free 路径轻提醒注入 1500 字（C1 决议）', () => {
  // 主场景 attention decay 防护必须生效
  for (const fn of [buildFreeFanoutPrompt, buildFreeDebatePrompt, buildFreeSummaryPrompt]) {
    const out = fn({ meeting: mockMeeting, selfSlot: 'pikachu', participants: [0,1,2], userInput: 'x', turnNum: 1, sceneName: '通用圆桌', timelinePath: null });
    expect(out).toContain('≤ 1500 字');
  }
});

test('free 路径独立行为提示段已删除（防回归）', () => {
  // 原三模板末尾的独立提示段必须删除（已并入"回答方式"字段）
  const out = buildFreeFanoutPrompt({ meeting: mockMeeting, selfSlot: 'pikachu', participants: [0,1,2], userInput: 'x', turnNum: 1, sceneName: '通用圆桌', timelinePath: null });
  expect(out).not.toMatch(/请独立回答（与其他发言人互相看不到本轮发言/);
  expect(out).not.toMatch(/请反驳\/呼应其他发言人的观点/);
});

test('timeline footer 压缩为单行 > 前缀', () => {
  const out = buildFanoutPrompt(1, 'test', null, mockDispatch, 'pikachu', null, '/path/timeline.md');
  expect(out).toContain('> 完整历史:/path/timeline.md');
  expect(out).not.toContain('---\n完整历史:');  // 旧格式不应再出现
});

test('独立行为提示段已删除（防回归）', () => {
  const out = buildFanoutPrompt(1, 'test', null, mockDispatch, 'pikachu', null, null);
  expect(out).not.toMatch(/请独立回答（本轮你被点名/);
  expect(out).not.toMatch(/请独立回答（你与另一位副驾/);
});

test('L3 第一行 scene tag 格式（鲁棒性保护：hub 解析依赖）', () => {
  for (const fn of [buildFanoutPrompt, buildDebatePrompt, buildSummaryPrompt, buildBriefSummaryPrompt]) {
    const out = fn(1, 'test', mockArgs);
    const firstLine = out.split('\n')[0];
    // 必须以 [ 开头, 含 scene 名 + 第 N 轮 + 模式
    expect(firstLine).toMatch(/^\[.+ · 第 \d+ 轮 · .+\]$/);
    // 防回归: 第一行禁止是 ## 标题形式（早期 P6 草稿误改方向）
    expect(firstLine).not.toMatch(/^##/);
  }
});

test('轻提醒字段限制为 1500 字（与 L1 BASE_RULES 一致）', () => {
  const out = buildFanoutPrompt(1, 'test', null, mockDispatch, 'pikachu', null, null);
  expect(out).toContain('≤ 1500 字');
  expect(out).not.toContain('≤ 600 字');  // 防回归到旧约束
});
```

### 改动面汇总（pilot + free 双路径）

| 文件 | 改动 |
|---|---|
| `core/roundtable-orchestrator.js` | 重写 4 个 pilot `build*Prompt` + 重写 `_renderDispatchContext`（字段化）+ 删 `buildFanoutPrompt:236-243` 独立行为提示段 + `_renderTimelineFooter` 压缩 |
| `core/roundtable-free.js` | 重写 3 个 `buildFree*Prompt`：第一行改 pilot 格式 `[<scene> · 第 N 轮 · <模式>]`（B1）+ 新增 `_renderFreeDispatchContext`（字段化，含"参与者"+"轻提醒"）+ 新增 `_renderFreeTimelineFooter`（压缩格式）+ 删除三模板末尾独立行为提示段 + 调用签名加 `sceneName` / `timelinePath` 参数 |
| `main.js` | free 路径 dispatch 调用处补传 `sceneName`（meeting.scene 对应中文）+ `timelinePath` 参数给 buildFree* 函数 |
| `core/roundtable-injection.js` | 不动 |
| `tests/unit-l3-skeleton-contract.test.js` | 新增（pilot 4 测 + free 3 测 + 第一行格式契约 + 轻提醒契约 + 防回归） |

总改动 ~110 行（pilot ~60 + free ~50），跨 3 个文件。

### 三方收敛轨迹（debate 节奏记录）

- 第 23 轮：Pikachu 撤回"行为提示散落是美学问题"YAGNI 立场（Charmander/Squirtle 独立指出 attention 协议成本）
- 第 24 轮 debate：Charmander 提"5 段紧凑首段"；Squirtle 提"6 段独立 ## 本轮回答方式"；Pikachu 倾向 Charmander 紧凑版
- 第 25 轮 debate：Squirtle 反驳删 footer（恢复力锚点）+ 反驳删 ## 调度上下文（协议层锚点）；Pikachu 撤回删 footer 立场
- 第 26 轮 debate：Charmander 主动转向保留 ## 调度上下文 + 主张 footer 压缩；Squirtle 提出"调度上下文字段化"；Pikachu 撤回"角色行独立"立场
- 第 26 轮 summary：5 段统一骨架 + 字段化调度上下文 + footer 压缩，**P6 micro-reminder 在"轻提醒"字段中自动消解**

### 整体进度（全部 6 个 Phase）

| Phase | 内容 | 状态 |
|-------|------|------|
| P0 | L1 BASE_RULES 瘦身（700→260 字） | ✅ 方案定 |
| P1 | L2 research 三层分型（B 路线 · 投资画像外置） | ✅ 方案定 |
| P2 | RESUME_REMINDERS 直接删除（路线 A） | ✅ 方案定 |
| P3 | GENERAL_PRESET 补强（4 协作策略 + 1 段场景定位 ~210 字） | ✅ 方案定 |
| P4 | 五元组 SSoT（结构化 schema + 4 约束 + 双 pure helper） | ✅ 方案定 |
| P5 | Arena Memory 直接删除（路线 A，记忆系统后续重启议题） | ✅ 方案定 |
| P6 | L3 骨架统一 + 字段化调度上下文 + footer 压缩 | ✅ 方案定 |

**全部 Phase 设计阶段彻底结束**。可立即切独立 session 落地执行。

---

## 决策日志

- **2026-05-03 第 4 轮 summary**：P0 决议采纳 Charmander 第 3 轮 260 字版 + Pikachu unit test 兜底，Squirtle 极限版作为 Phase 2 候选
- **2026-05-03 第 5 轮**：本文件创建；P1 进入讨论
- **2026-05-04 第 7 轮 summary**：P1 收敛到 Squirtle 三层分型（PRESET / COVENANT / PROFILE），Phase 2 候选 A/B 留待用户裁决
- **2026-05-04 第 8 轮**：用户拍板 B 路线（投资画像外置 + 4 块差量重写）；P1 章节完成；P2 RESUME_REMINDERS 进入讨论
- **2026-05-04 第 9 轮**：Charmander grep 发现 `getResumeReminder()` 是死代码（main.js 调用 = 0），P2 议题从"差量化"转为"删/复活"
- **2026-05-04 第 10 轮**：用户拍板 P2 路线 A（直接删 + 治理注释 + 验证步骤）；P2 章节完成；P3 GENERAL_PRESET 补强进入讨论
- **2026-05-04 第 11-13 轮**：P3 三方迭代收敛——共识（必须补强 / 4 条核心策略 / 模式教学不进 preset / 不跨层引用 / 5 条准入闸门），分歧（输出形态段 0/1/2 行 + 字数光谱 150/210/240）
- **2026-05-04 第 14 轮**：用户采纳 Pikachu 第 13 轮推荐版（~210 字，4 策略 + 1 段场景定位）；P3 章节完成；P4 五元组格式三处统一进入讨论
- **2026-05-04 第 14-15 轮**：grep 核实 P4 实际是"两处不是三处"；`summary-templates.json` 是 deep-summary 用，与五元组无关
- **2026-05-04 第 16-17 轮 debate**：三方化解"故意差量 vs 漂移"分歧——Charmander 收回"L3 扩写"，Squirtle 收回"L2 只讲触发"，Pikachu 撤回"3 条约束/参数化 render"
- **2026-05-04 第 18 轮 summary**：方案 A 落地（结构化 schema + 4 条独立约束 + 双 pure render helper + 删"我认为"举例）
- **2026-05-04 第 19 轮**：用户拍板方案 A；P4 章节完成；P5 Arena Memory 每轮刷新进入讨论
- **2026-05-04 第 20 轮**：Charmander grep 发现 `core/arena-memory/` 整个模块从未被 main.js 导入（与 RESUME_REMINDERS 同模式死代码）；Squirtle 提出 stable/live 双层设计
- **2026-05-04 第 21 轮 debate**：Charmander 收回"prompt 文件接线"实现错误（PTY 启动后改文件无效）；Squirtle 撤回 live-facts.md 新文件想法；Pikachu 撤回"档 1 推荐"
- **2026-05-04 第 22 轮 summary**：Pikachu 推荐 Squirtle B 路线（启动快照 + L3 hint）
- **2026-05-04 第 23 轮**：用户拍板 P5 路线 A（直接删，记忆系统后续单独成立大议题统一审视）；Pikachu 提出新议题——L1/L2 attention decay（micro-reminder 议题）
- **2026-05-04 第 23 轮**：用户提出"L3 涉及每轮非常重要，22 轮没专门审视过"，开启 L3 整体优化议题；Pikachu 撤回"行为提示散落是美学问题"YAGNI 立场
- **2026-05-04 第 24-25 轮 debate**：Charmander 主张 5 段紧凑首段 + 删 ## 调度上下文；Squirtle 反驳保留 ## 调度上下文 + 保留 footer；Pikachu 撤回删 footer 立场
- **2026-05-04 第 26 轮 debate**：Charmander 主动转向保留 ## 调度上下文 + footer 压缩；Squirtle 提出"调度上下文字段化"（最强洞察）；Pikachu 撤回"角色行独立"立场
- **2026-05-04 第 26 轮 summary**：用户拍板 L3 骨架统一方案——5 段骨架 + 字段化调度上下文 + footer 压缩。P6 micro-reminder 议题在"轻提醒"字段中自动消解，与 L3 议题合并为 P6 单一议题。**全部 Phase 设计阶段彻底结束**
- **2026-05-04 第 27 轮（用户审核修订）**：用户审核终版报告后提出两点修订：
  - **修订 1**：L3"轻提醒"字段字数限制 600 字 → **1500 字**（避免过严限制 AI 能力）；同步 P0 BASE_RULES 的字数限制也改为 1500 字（保持 L1/L3 一致，避免冲突）
  - **修订 2**：L3 第一行 scene tag 格式必须保留原样 `[<scene.name> · 第 N 轮 · <轮次性质>]`——之前 P6 草稿误改为 `## 第 N 轮 · <模式中文名>` 标题形式，与"发送/提取鲁棒性保护"改动冲突（hub 解析头部依赖 `[...]` 格式）。撤回错误改动，恢复原 scene tag。
  - 配套：P6 unit test 新增"L3 第一行 scene tag 格式契约 + 防 ## 标题回归"+"轻提醒 1500 字契约 + 防 600 字回归"两条断言
- **2026-05-04 第 28 轮（free 模式覆盖）**：用户告知 free 模式（2026-05-04 同期开发的并存模式，新建会议默认走 free）已落地。Pikachu 审查 `core/roundtable-free.js` 后发现：free 模式 prompt 形态与 P6 决议完全不同（第一行用 `# 自由模式 第 N 轮 ...` 一级标题、调度上下文用 `[本轮上下文]` 仅 3 字段、缺轻提醒、缺 timeline footer）。如不覆盖，主要使用场景失去 P6 收益。
  - 用户拍板 **A1 + B1 + C1**：
    - **A1**：P6 完全覆盖 free 模式（free 3 个 build 函数也改成统一骨架）
    - **B1**：free 第一行改用 pilot 格式 `[<scene.name> · 第 N 轮 · <模式中文>]`（撤销原 `# 自由模式 ...` 格式，hub 头部解析依赖统一）
    - **C1**：轻提醒（≤ 1500 字 / 不写文件 / 不展开）注入 free 模式
  - 字段差异：free 用"参与者"字段（含自己）替代 pilot 的"同台"（不含自己）；"你是"字段不带"副驾/主驾"角色括注（free 取消该概念）；"模式"字段值为"自由（参与者勾选）"
  - 配套：改动面新增 `core/roundtable-free.js` + `main.js`（补传 sceneName/timelinePath 参数）；unit test 增加 4 条 free 契约（骨架字段 / 第一行格式 / 轻提醒 / 防独立行为提示段回归）
