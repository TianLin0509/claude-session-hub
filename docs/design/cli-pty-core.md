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

写 `config.toml` 按 TOML 语义来，不按字符串（`core/toml-statements.js`）：
- 同一张表的单引号、双引号（含转义）、点号两侧空白、行尾注释，都认作同一张表；
- 只改两种形状：独立的 `[hooks.state.<key>]` 表，或者完全没有这个条目（在文末追加）；
- 条目若以点号键或内联表的形式写在别处，就不动它，提示用户在 `/hooks` 里手动信任；
- 写盘前用 Python `tomllib` 解析改前、改后两份文本：改前解析不了就不改；改后除 Hub 条目的 `trusted_hash` 之外，语义必须与改前完全一致，否则放弃写入。

hash 算法取自 Codex 源码 `hooks/src/engine/discovery.rs::hook_hash` 和 `config/src/fingerprint.rs::version_for_toml`：`{event_name, matcher?, hooks:[归一化 handler]}` 转成 JSON、键排序、紧凑序列化后取 sha256。单测用本机 Codex 自己写下的两个 hash 做回归。Codex 升级后如果改了算法，单测不会报警；这时 hook 被静默跳过，状态退回只靠 rollout 与屏幕识别。所以 E2E 必须断言 hook 真的到达。

## 身份跟随（Claude）

Claude 的身份在启动时就定了，但 TUI 里的 `/clear`、`/resume`，以及退出后在同一个 shell 里重新启动，都会换新的 session_id。嵌套进程（模型在 Bash 工具里跑的 `claude -p`）也会继承 Hub 环境，带着别的 id 打进 hook。只看 SessionStart 分不开这两种情况。

真机实测的事件顺序（`tests/probe-claude-session-hooks.js`）：
- `/clear`：先 `SessionEnd(旧 id, reason=clear)`，约 0.6 秒后 `SessionStart(新 id, source=clear)`；
- `/exit`：`SessionEnd(旧 id, reason=prompt_input_exit)`。

判据（`core/claude-identity-switch.js`）：只有当前绑定的会话先宣布结束，随后的新 SessionStart 才允许改绑。
- source 为 `clear` / `resume`：要求那条 SessionEnd 在 30 秒之内；
- source 为 `startup`：要求那条 SessionEnd 是真正退出的原因。

嵌套进程或子代理不可能替已绑定的会话发出 SessionEnd，所以串线照旧被拒。改绑会更新持久化的 ccSessionId 和 transcriptPath，并刷新归属；卡片随之重新加载，下一次提问时 tail 切到新文件。关闭再打开时，用新身份 `--resume`。

`/clear` 不触发 UserPromptSubmit。提交闭环以「Hub 已跟随新身份」作为这条命令的确认，不再补回车、不亮「补发」。

## 绑定（Codex）

`main/codex-pty-hook.js` 的规则：

- 带 `agent_id` 的事件、rollout 元数据标为 subagent 的事件：一律忽略。
- 已绑定线程之后，来了不同的 `session_id`：只有 `SessionStart` 且来源是 `clear` / `resume` / `fork`，或者来源是 `startup` 且终端已回到宿主 shell（CLI 退出后被重新拉起），才允许改绑。其余情况视为 CLI 里嵌套跑的另一个 codex，直接忽略。
- `CodexTap.bindFromHook()`：文件已存在就立即绑定；还没落盘就把期望路径钉在 pending 上。扫描器看到这个文件时直接绑定，同时这条会话不再参与 cwd + 时间窗的猜测。
- 钉住路径后还会每 250ms 单独查一次这个文件（最长 10 分钟，下一个 hook 会重新开始），不依赖全目录扫描器。终轮矩阵里扫描器在高负载下反复 heartbeat stale，群聊的 Codex 成员答完了也迟迟绑不上。绑定后 tail 会回放已写内容，所以晚绑不会漏掉这一轮的完成。

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

## 草稿与恢复

- 草稿库（`native-input-drafts.sqlite`）按 Hub 会话 id 存。PTY 的 Claude/Codex 会话与原生会话共用这一份（`agent-runtime-mode.isPtyAgentSession`），所以原生时代存下的草稿改走 PTY 后照样读得回来。revision 冲突检测、两个输入栏共用一个控制器、关闭前 flush，全部沿用原生那套。
- 一轮都没跑过的 Codex 会话，恢复时不走 `codex resume`（那只会停在「Resume a previous session」选择框，还会吞掉第一条消息），而是用同一个 Hub id 新开。
  - 判定只认正面证据：原生快照没有任何轮次，Hub 从没记录过开始、完成或记录路径，且 sid 缺失或它的 rollout 不存在。
  - 跑过但没绑上 id 的老会话仍走选择框，那是绑定失败时唯一不丢历史的兜底。
  - 用户主动选的「Codex Resume」本来就要选择框，不受影响。
- Codex 会话在绑定原生 id 之前不能关闭（08-08 起的休眠闸门）。开了没聊就想关，会提示先等本轮完成。

## 真机逼出来的规则（2026-09-25 状态矩阵）

以下几条都是单测过了、真机上才暴露的问题，改动相关代码前先读：

- **启动选择框会吞掉首条消息**，随后的回车还会替用户选中默认项。已经见过的两个：Codex 的模型退役迁移提示（`gpt-5.5` → `gpt-5.6-sol`），以及联网时第二个 default 权限 Claude 会话弹出的 Chrome 扩展提示。就绪检测把"Enter to confirm · Esc to …"、"press enter to confirm"、"Use ↑/↓ to move"当作阻断；新会话的第一条消息撞上选择框时 Hub 拒发，原文回到输入框，并提示去终端处理，**绝不替用户选**。
- **就绪检测要先把 ConPTY 字节还原成文字**。ConPTY 用光标右移（`ESC[nC`）代替单词间的空格；TUI 空闲时也会不停重画同一屏，所以稳定性按"画面末尾文字不变"判断，不能看字节长度。Codex 0.153 新会话没有 `Context` 底栏，输入行标记是 `› <占位>`，`› 1.` 是选项菜单，要排除。
- **权威终态不能被屏幕推翻**。Codex 内联界面的旧"• Working … esc to interrupt"行会残留在缓冲区里；一轮一旦由 hook 或 transcript 判定结束，屏幕识别不能单独把它拽回运行，新一轮只能由 UserPromptSubmit 或 task_started 开启。
- **权威完成与中断以"收到时刻"作为观察时刻**。完成事件要经过 400ms 防抖才送到，期间终端输出会记下时间更晚的"运行"观察，按事件时刻比较会把它判成过期丢掉。旧的轮次仍由 attention 的轮次与时间校验挡住。
- **没有正文的 `task_complete` 也要收尾**，例如 `/compact`。收尾走 turn-aborted：不出卡，不加未读。
- **Claude 的 Esc 中断没有 Stop hook**，唯一证据是 transcript 里的 `[Request interrupted by user…`。
- **Codex 同一轮会先后写 final_answer 和 task_complete**，完成与未读都只能算一次。

## 已知边界

- 卡片按段落刷新，不逐字流动；要逐字看，就看终端本体。
- 本机 Codex 0.153.4 没有 Interrupt hook，Esc 中断靠 rollout 的 `turn_aborted`。
- 群聊派发依然走 PTY 闭环：偶发 `stuck` 时显示「补发」按钮。
- Codex 的斜杠命令不触发 UserPromptSubmit，闭环拿不到确认，可能亮「补发」。状态本身不会卡住：`/compact` 由空正文的 task_complete 收尾。
- 选择框挂着时，群聊自动派发会因"CLI 未就绪"而不发送，需要有人在终端里处理。
- Claude fast 模式的交互会话是否写 transcript，这次没有在 Opus 上重测（只用 haiku 省额度，而 fast 只对 Opus 生效）。

## 验证入口

- 单测：`tests/unit-agent-pty-runtime.test.js`、`unit-codex-hook-integration`、`unit-codex-pty-hook`、`unit-codex-tap-hook-binding`、`unit-claude-disk-transcript`、`unit-claude-identity-switch`、`unit-pty-draft-and-fresh-resume`，以及全量 `node scripts/run_unit_tests.js`。
- 草稿：`node tests/e2e-cli-pty-draft-persistence-cdp.js`（Claude/Codex × 迁移、重启、跨 Hub 接续）。
- GUI：隔离 Hub + 真实 CLI 的状态矩阵，脚本与报告见实现手册。
