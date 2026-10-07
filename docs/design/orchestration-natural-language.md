# AI 编排：只用自然语言和编排员对话（2026-10-06）

## 目标

田哥在编排群里只和编排员对话，像和普通 Agent 对话一样；编排员替他排一场群聊，田哥旁观。哪里需要停下来问田哥，由编排员判断；不需要就一路推进到结项。

## 之前的问题

- 计划须经界面按钮确认，改计划（比如跳过故障成员）要再点一次。
- 运行故障一律锁死，只认「继续」「确认」这类整句短词才解除；「deepseek有故障，后续跳过他就行，其他人继续」「你直接继续」都不算，编排员只能反复请田哥去界面点按钮。

## 现在的规则

| 事项 | 做法 |
|---|---|
| 计划 | `orch_propose_plan` 提交即生效，改计划同样直接生效；派工仍须匹配当前计划的工作段 |
| 田哥回话 | 对编排员说任何话都解除暂停（额度用满除外），这句话怎么理解、下一步做什么由编排员判断；@成员 不解除 |
| 运行故障 | 不再锁死，Hub 把失败步骤和可用手段告诉编排员：`remind`、`orch_restart_member` + `continue`、`skip`、`cancel` 后改计划；工作段启动失败同样交给编排员 |
| 反复故障 | 同一步骤累计 4 次运行故障（续跑后立刻再失败也算），或同一计划段启动失败 4 次，Hub 暂停（`repeated_failure`），编排员向田哥说明；田哥回话后解除，计数清零 |
| 额度 | 仍是硬上限。用满时编排员在对话里问，田哥同意后编排员调 `orch_grant_budget`：`sourceQuote` 必须出自田哥在额度用满之后发的消息，每条消息只能用一次；追加额度只解除额度暂停，不解除田哥的暂停或等他回话的暂停。田哥直接说了新上限时，编排员按新额度改计划，额度够了随计划恢复 |
| 跳过与报错可见 | 跳过记录写明是编排员还是田哥跳过、原因（`orch_control_workflow(skip)` 的 `note`），写进下一位成员的提示和群聊系统提示；成员调用模型报错时，回答卡片显示报错摘要与原文，工作流暂停原因也带上成员名和报错原文 |
| 结项 | 不变：全部计划段有审核或收口证据才能 `final` |
| 界面 | 去掉确认、恢复、追加额度按钮；状态条只留计划账本、暂停、结束编排（结束后可恢复编排） |

## 兼容

- 旧账本里「计划待确认」的计划在加载时直接生效，`settings.requireConfirm` 删除。
- 编排员守则随群规则一起发送；群规则指纹变化时，下一次派发会自动重发一次（`core/group-chat-orchestrator.js` 的 `buildFirstDelta`，旧回执无指纹也会补发）。所以旧编排群在下一条消息就拿到新守则。（2026-10-07 更正：此前写的「旧群仍带旧守则」不成立。）

## 代码位置

- 状态与闸门：`core/orchestration/ledger.js`（`activatePlan`、`migrate`、`canDispatch`、`FAILURE_LIMIT`）
- 工具与故障处理：`main/orchestration/service.js`（`noteRuntimeFailure`、`restartMember`、`grantBudget`、`userMessage`）
- 编排员守则：`core/orchestration/prompt.js`；工具定义：`scripts/orchestrator-mcp.js`
- 界面：`renderer/orchestration-ui.js`、`renderer/meeting-create-modal.js`
