# Claude 卡片对齐 Codex：后台续接、发两遍与 journal 体积

用户以自己调教过的 Codex 卡片为准（一轮一张卡：头部一次、`时间 | 正文` 的进展行、末尾一条结果），要求 Claude 做到基本一致，并修掉"一条消息发两遍"。

## 根因（2026-09-13 生产会话实测）

Claude Code 2.1.269 在后台子 agent 完成后，会以 `origin.kind = task-notification` 的注入输入发起一轮新的回答。磁盘 jsonl 的顺序是 `user(有 uuid) → assistant → stop_hook`，但 stream-json 的 wire 顺序是 **assistant 帧先到，回放的 user 帧（无 uuid、content 为空）在 result 前约 3 ms 才到**。Hub 收到 assistant 帧时既无活跃人类提交也无当前活动，`owner()` 为 null，帧被当作 `unassociated-event` 丢弃：

- 活动记录只剩 `result.result` 文本，没有 message id，`historyExclusions()` 排不掉磁盘上的同一轮，于是磁盘版（带模型名、进展行、工具）和内存版（"Claude 后台活动"）各画一张卡 —— 这就是发两遍。
- 每次通知都开一张带头像和"Claude 后台活动"副标题的独立卡，而不是 Codex 那样的进展行。
- 同一会话中，子 agent 的每一条迟到帧都触发 `persistLateOutput` 把整份 430+ 条 transcript 重新追加进 journal：397 次 × 0.9 MB = 378 MB，每次 Hub 启动都要整份读回。

## 处理

| 层 | 改动 |
| --- | --- |
| `core/claude-native-activities.js` | 无人认领的顶层 assistant 帧先开一条 `origin.kind = pending` 的临时活动承接；随后的注入 user 帧（`inject`）或非人类 result（`finish`）认领它，不再开第二个身份。两种到达顺序都由 `tests/unit-claude-continuation-parity.test.js` 守住。 |
| `core/claude-native-transcript.js` | `groupClaudeRecords`：`task-notification` 活动若在某条人类轮**已结算之后**开始，则作为该轮的续接合并进同一张卡（进展行 + 最后一条结果），`continuations` 记录其 id；人类轮仍在运行或来源是 `channel` 等则保持独立卡。`tailClaudeRecords` 按分组切尾，live 刷新不会把续接切成孤卡。 |
| `core/claude-transcript-parser.js` | 磁盘历史同样把 `<task-notification>` 输入后的回答并回上一张卡（`continued` 计数），之前的结果降为进展。 |
| `core/native-agent-journal.js` | 迟到帧改为 `transcriptAppend` 增量（按 uuid/message.id 合并去重）；加载时若文件 ≥ 4 MB 且存在被覆盖的旧快照，原子重写为每个身份一条（临时文件 + rename，失败保留原文件）。 |
| `renderer/turn-card-renderer.js` | 去掉正文上方的"Claude 后台活动"大字；仍独立成卡的引擎自发回合只在头部挂一枚"后台"小 chip。 |
| `core/session-status-summary.js` + `renderer/model-ui.js` | 原生 Claude 的推理档 chip 与 Codex 一样可点（后端 `claude-native:set-effort` 早已存在，之前被前端判据锁死）。 |
| `core/claude-native-runtime.js` | waiting 时的 evidence 拼出具体问题 / 待批准工具；未连接时 confidence 降为 `none`，停止键不再在断线后亮着。 |
| `renderer/claude-native-controls.js` + IPC `claude-native:set-permission-mode` | 计划模式横幅与"切回默认模式"按钮，样式同 Codex；只在计划模式激活时挂载，避免隐藏按钮抢走审批表单的点击。 |

`/goal`、`/loop` 对 Claude 不需要新适配：引擎 `system init` 帧的 `slash_commands` 里两者都在，Hub 原样转发并等回包（真实 haiku 实测 `/goal 只回复 GOAL_OK` → `GOAL_OK`）。

## 验证

- `node --test tests/unit-claude-continuation-parity.test.js`：wire 顺序倒置的认领、无回放输入的结算、分组与尾切、增量持久化、journal 合并与压缩、磁盘续接、runtime 证据。
- 既有：`unit-claude-native-background`、`unit-claude-native-transcript`、`unit-native-agent-journal`、`unit-claude-transcript-parser`、`unit-composer-dom-contract`、`unit-native-agent-message-lifecycle`（`delegated` 场景预期改为续接）、`unit-native-agent-consumers`、`unit-claude-native-panel` 等。
- GUI（fixture，隔离 Hub）：`e2e-claude-native-cdp`、`e2e-claude-codex-parity-cdp`、`e2e-cli-command-cards-cdp`、`e2e-claude-live-progress-cdp`、`e2e-native-consumer-matrix-cdp --provider=claude --scenario=approval --view=group`。
- GUI（真实模型，隔离 Hub + 隔离凭据目录）：`node tests/e2e-claude-codex-real-cards-cdp.js`，haiku 起后台子 agent → 通知续接：一张卡、`LAUNCHED` 进展行、`FINAL_OK` 结果行、DOM 只出现一次、无"后台" chip、journal 21 KB、`/goal` 有回包、推理档 chip 可点；Codex `gpt-5.5 / low` 同形态截图对照。产物在 `artifacts/claude-codex-parity/real-cards-*/`。

## 边界

- 续接只认 `task-notification`；`channel`（远程输入）、定时任务等引擎自发回合仍是独立卡，头部带"后台" chip。
- 人类轮仍在运行时到达的注入回合不并入，避免其文本被当成该轮答案（群聊结算依赖这一点）。
- journal 压缩只在加载时做；生产会话的 378 MB 文件会在下次 Hub 重启读入后一次性重写为约 1 MB。本任务没有重启生产 Hub。
- Codex 卡片头部右侧的 `ctx · tok` 用量行与结果下方的耗时 pill 来自 Codex 线程用量通知，Claude 侧仍只在输入栏显示上下文余量，未在本任务对齐。
