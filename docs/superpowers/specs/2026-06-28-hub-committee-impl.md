# Hub 玻璃房投委会 · 落地实施 spec (2026-06-28)

> 设计已锁定并经 mock 确认：`C:\Users\lintian\Desktop\claude-artifacts\hub-committee-usage-mock.html`
> 本 spec = 落地接入测绘 + 五幕设计 + 文件清单 + 任务映射。给并行兄弟会话 + 用户审。

## 目标
在 Hub `research` 投研群聊之上加「一房两档」：自由讨论 ⇄「开投委会」弹窗(输股票+轮次) 一键全自动五幕(立会→建库→点评→辩论→收敛) → 自动退出回自由聊（只开启入口、无退出键）。

## 核心原则：轻（避免旧投委会覆辙）
旧投委会(`committee-scene.js`+`committee-conductor.js`+五席+`LinDangAgent\committee` 包+dashboard+记忆落盘)曾 E2E 跑通，但**被群聊判定过重而废弃**（见 `DEPLOY_NOTE-20260611/0616-committee`），那批文件从未 commit、已随工作区清理消失。
本次**复用现有 research scene 底座**(6 帽子 + `RESEARCH_SCENE_PROMPT` + research-mcp)，conductor 只做**五幕编排**一件事。不复活重型部分。**B2 记忆库排 P2，动手前再详谈，本期不动。**

## 接入点测绘（已读源码验证）
| 接入点 | 位置 | 接入方式 |
|---|---|---|
| 一幕执行器 | `dispatcher.js` `dispatchGroupChatTurn`(return L769→`runGroupChatTurn` L598) | conductor 调 `(meetingId,{userInput:幕prompt, targetMemberIds:选委员, silent:true, turnTimeoutMs})`；`silent:true`→`dispatchInternalPrompt`→返回 `{results:[{label,text,status}]}` |
| 战法纪律底色 | `group-chat-orchestrator.js` `buildSystemPromptText` L62 research 分支 | 加 `COMMITTEE_DISCIPLINE` 常量（常驻="纪律底色"） |
| 三面映射帽子 | `meeting-room.js` `_DUTY_HATS_BY_SCENE.research` L763（6 帽：空头/多头/裁判/催化/技术/核验） | 技术帽→技术面 · 催化帽→消息面 · 多空+核验→基本面 · 裁判→主席 |
| screener_score MCP | `research-mcp-server.js` `TOOLS` L80 + CallTool 分发 L355 | 两处加；**本地读 data.json**（不走 postFetch 后端） |
| 开投委会弹窗+面板 | `renderer/meeting-room.js` + `meeting-create-modal.js`(modal 模式参考) | 按钮+弹窗(股票+轮次)+幕次进度/双榜面板 |
| IPC 路由 | `main/ipc/groupchat-turn-handlers.js` + `main.js` 装配 | `committee:start`→conductor.run；`committee:progress`→renderer |

## 五幕设计
| 幕 | 模式 | targetMembers | prompt 要点 | 产出 |
|---|---|---|---|---|
| 1 立会 | 主席单发 | 主席 | 注入标的/轮次 + 派活(DS技术/CL基本/CX消息) + 战法纪律 | 开庭 + 分工 |
| 2 建库 | 委员并行 | 全委员 | 各按帽子调研建公共信息库(玻璃房 CLI 可见) | 各委员调研 |
| 3 点评 | 委员并行 | 全委员 | 两段式(自然语言 + 末尾 JSON：三面分/chase/ambush/lean/top3/veto) | 抽 JSON→双榜雏形 |
| 4 辩论 | 委员并行 + 主席串行收口（迭代 rounds 轮） | 委员并行→主席 | 委员看他人改分；主席每轮收口点名下轮焦点 | 分数更新 + 矛盾探针 |
| 5 收敛 | 主席换帽子 | 主席 | 换帽子中立总指挥，套笼头只综合，出双榜+跨策略+矛盾裁决(涉己更严)+风险隔离+附言 | 主席报告 |

委员↔帽子：DS=技术帽 · CX=催化帽 · CL=多空/核验(基本面)+裁判帽(主席兼任)。
主席三道保险：①换帽子中立 ②涉己(基本面)矛盾自我更严 ③玻璃房+矛盾探针监督。

## 文件清单
**新增**：`main/groupchat/committee-conductor.js`(五幕状态机+抽取器) · `core/screener-score.js`(读 data.json 算分) · `tests/unit-screener-score.test.js` · `tests/unit-committee-conductor.test.js`
**修改**：`core/research-mcp-server.js`(+screener_score) · `core/group-chat-orchestrator.js`(+COMMITTEE_DISCIPLINE) · `main/ipc/groupchat-turn-handlers.js`(+committee:start) · `main.js`(装配) · `renderer/meeting-room.js`(弹窗+面板) · `renderer/meeting-room*.css` · `package.json`+`renderer/index.html`(版本 bump)

## 任务映射
task #1 screener_score MCP → #2 战法纪律 → #3 conductor 五幕 → #4 两段式抽取 → #5 IPC 装配 → #6 开投委会弹窗 → #7 双榜面板 → #8 第二实例 E2E 真测(blockedBy 1-7)

## 铁律
- 全程**第二 Hub 实例**(`CLAUDE_HUB_DATA_DIR` 隔离)开发测试，**绝不碰生产 Hub**；spawn 前剥离 `CLAUDECODE`/`CLAUDE_HUB_*` 嵌套 env
- 真三家(DS/CL/CX)单股+多股实测跑通才算交付，否则 loop 修复
- 工作区可能有兄弟会话改动：不 commit/不动他人文件，留本 DEPLOY_NOTE
