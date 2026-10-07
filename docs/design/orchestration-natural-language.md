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
| 运行故障 | 不再锁死，Hub 把失败步骤和可用手段告诉编排员：`remind`、`orch_restart_member` + `continue`、`skip`、`cancel` 后改计划 |
| 反复故障 | 同一步骤累计 4 次运行故障，Hub 暂停（`repeated_failure`），编排员向田哥说明，田哥回话后解除 |
| 额度 | 仍是硬上限。用满时编排员在对话里问，田哥同意后编排员调 `orch_grant_budget`，`sourceQuote` 必须出自田哥本群原话，同一句只能用一次 |
| 结项 | 不变：全部计划段有审核或收口证据才能 `final` |
| 界面 | 去掉确认、恢复、追加额度按钮；状态条只留计划账本、暂停、结束编排（结束后可恢复编排） |

## 兼容

- 旧账本里「计划待确认」的计划在加载时直接生效，`settings.requireConfirm` 删除。
- 编排员守则只在首次进群时发送，旧群的编排员仍带旧守则；工具说明、Hub 通知与 `orch_status` 的处理建议已按新规则更新。新建的编排群完整使用新守则。

## 代码位置

- 状态与闸门：`core/orchestration/ledger.js`（`activatePlan`、`migrate`、`canDispatch`、`FAILURE_LIMIT`）
- 工具与故障处理：`main/orchestration/service.js`（`noteRuntimeFailure`、`restartMember`、`grantBudget`、`userMessage`）
- 编排员守则：`core/orchestration/prompt.js`；工具定义：`scripts/orchestrator-mcp.js`
- 界面：`renderer/orchestration-ui.js`、`renderer/meeting-create-modal.js`
