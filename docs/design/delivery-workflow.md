# 工作流设置：逐成员文件交付

2026-09-26。新设置保存后使用 `deliveryVersion: 1`。开发交付、方案圆桌、资料调研、自定义共用执行引擎。已有旧版开发交付文件的群保留原协议，不搬迁在途文件；未经保存的新建开发群仍沿用既有入口。

## 为什么改变

一轮 CLI 回答结束不意味着任务交付。反过来，文件已经交付时，CLI 可能还在汇报或收尾。旧串行流程把聊天等待超时、回答结束与业务阶段绑定，容易在长任务中暂停，或因迟到回答出现不同步。

新引擎以落盘文件决定业务接续，以 CLI 原生状态决定同一席位何时能安全接收下一条消息。屏幕、聊天文本和计时器均不能代替交付。

## 冻结任务与交付

每次开工产生新 `runId`，固定目标、工作目录、轮次、成员及共享 prompt。目录为：

`<Hub 数据目录>/task-docs/<meetingId>/deliveries/<runId>/step-<n>/<memberId>/`

每位成员只写自己的 `草稿.md`，保存并回读后原子改名为 `已交付.md`；开发审查可交 `需返工.md`；客观障碍可交 `阻塞.md`。不能同时保留草稿和结果。

文件第一行携带绑定本次任务、步骤、成员和输入版本的标识；正文非空，UTF-8、普通文件、最大 2 MiB，拒绝路径重定向。同轮全部成员交付才前进。已接纳文件及后续引用固定 SHA-256，修改或删除会暂停，不使用新内容偷偷推进。

这是合作协议与一致性校验，不是对恶意成员的权限隔离，也不自动证明报告内容正确。开发审查继续要求独立验证完整候选 SHA、真实测试、项目合并入口和后置检查。多人审查时负责人须先读取协作者的本轮交付再决定合并。

## 恢复与控制

- `run.json` 采用临时文件、fsync、同目录 rename 保存。先持久化派工意图再唤醒/发送；恢复不自动重放不确定的派工。
- 所有发送使用原 `dispatchGroupChatTurn → sendToPty` 闭环；保留 CLI hooks、真实会话绑定、原生记录与同席位收尾门禁。
- 本地串行操作与跨 Hub SQLite 归属控制避免并发派工。复用已有 `SessionOpenOwnership` 实现，在独立 `workflow-owners` 目录保存租约；释放前等 writer 关闭。崩溃由 SQLite 回滚事务，并核对进程身份后接管。
- 暂停后的晚到文件可以记录，但不接续。休眠/关闭先暂停派工，全部成员 writer 释放后归还工作流归属。应用关闭先冻结扫描，PTY 排空后释放。
- “核对并接续”只核对文件与已有意图；“继续未交付成员”仅在上一派工已经结束且成员可接收时发送补交指令。未知、排队、执行中不重发。
- 阻塞交付不覆盖；可以“结束任务”，保留历史，再输入调整后的目标。取消并不回滚已经产生的代码或外部动作。
- 最多自动执行 6 轮，返工计入；只有用户明确继续才授予下一段预算。无固定聊天超时，不以超时判断成功，也不无限自动重试。
- 普通重启不会自行唤醒历史任务。“重启并继续”识别新协议并核对交付，保留用户暂停；待核对提交在群聊显式处理。

## 文件与集成

- 协议/校验：`core/delivery-workflow.js`
- 持久执行/租约/恢复：`main/groupchat/delivery-engine.js`
- 设置：`core/workflow-settings.js`、`renderer/workflow-config-modal.js`
- 进度控制：`renderer/delivery-workflow-controls.js`
- 接入：dispatcher、loop IPC、会议室休眠/关闭、工作台、重启入口、PTY 历史收集与关闭排空。

## 验证入口

```powershell
node tests/unit-delivery-workflow.test.js
node tests/e2e-workflow-settings-a-cdp.js
node tests/e2e-delivery-workflow-cdp.js
node tests/e2e-delivery-workflow-live.js
$env:PATH = 'C:\Program Files\Git\bin;' + $env:PATH
node scripts/run_unit_tests.js --strict
```

最后一个 E2E 使用真实 Claude Haiku 与 Codex 低推理、默认 PTY；两个回答均很短，隔离数据/配置/端口，只写本次测试的交付文件。其余 GUI 协议测试使用独立进程提供方夹具，不冒充真实模型验证。测试只关闭自己的 Hub。
