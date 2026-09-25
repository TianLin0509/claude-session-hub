# Claude / Codex 回到 CLI 为核心（2026-09-25）

用户在 2026-09-25 的群聊讨论后拍板：放弃 09-10 起的「原生会话优先」，回到 PTY 里跑真实 CLI、卡片视图旁读落盘记录的形态。三个验收重点：

1. 终端原汁原味，与 PTY 时代（`8c5c6928`）一致；
2. 运行 / 等待 / 完成 / 未读识别尽量准；
3. 卡片尽量逼近原生卡片，不要求逐字流动。

## 一句话结构

终端是主体和真相源；hook 报状态；落盘记录做卡片。三者由「Hub 会话 id + 原生会话 id + 记录路径」精确绑定，不再按目录和时间去猜。

## 运行时选择

`core/agent-runtime-mode.js` 是唯一入口。默认 `pty`；`native` 只能通过环境变量 `CLAUDE_HUB_AGENT_RUNTIME=native` 或 config.json 的 `runtime.agent` 打开，UI 不暴露。原生代码暂留作回退，确认稳定后另开任务删除。

PTY 会话的 info 带 `agentRuntime:'pty'`，并且显式带上 `runtimeBackend:null, nativeRuntime:null`。原因是 renderer 恢复会话时按 `{...旧, ...新}` 合并，少了这两个字段，原生时代的后端就会残留下来。`isCodexSession()` 只认显式后端或旧的 App Server 快照，不再看 kind。

## 启动

| CLI | 身份何时确定 | 方式 |
| --- | --- | --- |
| Claude 新会话 | 启动前 | Hub 生成 uuid，传 `--session-id` |
| Claude 恢复 | 启动前 | 有历史用 `--resume <id>`；原生时代分配过 id 却从未开聊，就用同一个 id 走 `--session-id` |
| Claude fork | 启动前 | `--resume <源> --fork-session --session-id <新>` |
| Codex 新会话 / 恢复 / fork | 第一个 hook | `SessionStart` / `UserPromptSubmit` 上报的 `session_id` + `transcript_path` |

Claude 的参数与原生驱动共用 `buildClaudeNativeArgs`（模型、思考档、权限、MCP、fast、群聊设置）。目录信任沿用 PTY 时代的两层做法：spawn 前预写 `hasTrustDialogAccepted`；兜底只在 `detectClaudeTrustDialog` 定位到「Yes」时才按键，绝不盲按回车。

Codex 沿用原 TUI 命令，另加 `-c features.hooks=true`。

## Codex hook 部署与信任

Codex 0.153 只执行「已信任」的 hook，信任记录存在 `config.toml` 的 `[hooks.state.'<hooks.json>:<事件>:<组>:<序号>'] trusted_hash`。`core/codex-hook-integration.js` 在每次启动 PTY Codex 前做三件事：

1. 把 `session-hub-hook.py` 复制到 `<CODEX_HOME>/hub-scripts/`；
2. 在 `hooks.json` 里补齐缺的事件。已有的 session-hub-hook 条目原样复用，不重复部署；
3. 为命令里带 `session-hub-hook` 的条目写 `trusted_hash`。这等价于用户在 `/hooks` 里点了一次信任，Hub 绝不替用户信任别的 hook。

hash 算法取自 Codex 源码 `hooks/src/engine/discovery.rs::hook_hash` 和 `config/src/fingerprint.rs::version_for_toml`：`{event_name, matcher?, hooks:[归一化 handler]}` 转成 JSON、键排序、紧凑序列化后取 sha256。单测用本机 Codex 自己写下的两个 hash 做回归。Codex 升级后如果改了算法，单测不会报警；这时 hook 被静默跳过，状态退回只靠 rollout 与屏幕识别。所以 E2E 必须断言 hook 真的到达。

## 绑定（Codex）

`main/codex-pty-hook.js` 的规则：

- 带 `agent_id` 的事件、rollout 元数据标为 subagent 的事件：一律忽略。
- 已绑定线程之后，来了不同的 `session_id`：只有 `SessionStart` 且来源是 `clear` / `resume` / `fork`，或者来源是 `startup` 且终端已回到宿主 shell（CLI 退出后被重新拉起），才允许改绑。其余情况视为 CLI 里嵌套跑的另一个 codex，直接忽略。
- `CodexTap.bindFromHook()`：文件已存在就立即绑定；还没落盘就把期望路径钉在 pending 上。扫描器看到这个文件时直接绑定，同时这条会话不再参与 cwd + 时间窗的猜测。

## 状态

| 状态 | 权威（hook） | 强（落盘） | 补充（屏幕） |
| --- | --- | --- | --- |
| 运行 | UserPromptSubmit、PreToolUse | Codex `task_started` | Working 行 + 动画在变 |
| 等待 | PermissionRequest、Notification、提问类工具的 PreToolUse（AskUserQuestion / ExitPlanMode / request_user_input） | — | 确认框 |
| 完成 | Claude Stop | Claude `stop_reason` 终态且带正文；Codex `task_complete` | 只能推向运行或等待，不能判完成 |
| 中断 | — | `[Request interrupted by user…`、`turn_aborted` | — |

Codex 的 Stop 不转发给 renderer。完成事件由 rollout 的 `task_complete` 带着正文和 turnId 发出，两路都发会让未读翻倍；只有 rollout 还没绑上时，才用 Stop hook 兜底。未读沿用 `session-attention-state` 的 turnId 去重。

等待时，卡片视图底部出现「终端在等你操作」提示条和「到终端处理」按钮（`renderer/pty-attention-controls.js`）。第一版不在卡片上直接作答：在 TUI 里模拟方向键和回车去替用户选，就是回到盲发按键的老路。

## 卡片

- Claude：`core/claude-disk-transcript.js` 把 JSONL 按「一次提问」分组，得到 `claude-native-transcript` 需要的 record，交给同一个 `claudeTranscriptTurns()`。这样过程/结果分段、工具状态与耗时、后台任务续写、中断/失败结局都与原生卡片一致。旧 DeepSeek-Claude 兼容会话保留原解析器。
- Codex：rollout 解析器照旧，它本来就输出 commentary / final 分段和工具结果。
- 视图：PTY 会话默认打开终端；用户切到卡片后按会话记住，下次打开仍停在卡片。

## 已知边界

- 卡片按段落刷新，不逐字流动；要逐字看，就看终端本体。
- Claude TUI 里 `/clear` 会换会话 id。Hub 目前没有部署 Claude 的 SessionStart hook，之后的事件会被当作外来事件忽略，卡片停在旧会话。重开会话即可恢复。
- 本机 Codex 0.153.4 没有 Interrupt hook，Esc 中断靠 rollout 的 `turn_aborted`。
- 群聊派发依然走 PTY 闭环：偶发 `stuck` 时显示「补发」按钮。

## 验证入口

- 单测：`tests/unit-agent-pty-runtime.test.js`、`unit-codex-hook-integration`、`unit-codex-pty-hook`、`unit-codex-tap-hook-binding`、`unit-claude-disk-transcript`，以及全量 `node scripts/run_unit_tests.js`。
- GUI：隔离 Hub + 真实 CLI 的状态矩阵，脚本与报告见实现手册。
