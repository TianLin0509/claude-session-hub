# CLI 命令与原文卡片

用户要求：在 Hub 继续使用 `/goal`、`/loop` 等 CLI 命令；卡片保留 `/goal xxxx` 原文；完成验证后合入 master。

## 最终行为

- `session:send-prompt` 在提交 AI 斜杠命令前，把原文及提交 ID 写入 Hub 数据目录的 `command-transcript.sqlite`。包括 Codex、Claude、ACP 与原有 PTY provider；不改变 PowerShell 等宿主 shell 的输入行为。
- 命令发送时立即出现用户卡片。历史读取合并命令记录；优先按提交 ID 去重。没有 ID 的 PTY 回显按原文、相近时间一对一匹配，重复输入同样内容仍分别保留。
- 失败和未确认的输入也保留；同一提交 ID 不自动执行第二次。结果保存失败不会伪报成功。
- Claude 继续把引擎支持的命令交给双向 stream-json，包括 bundled `/loop` 与其他 skill；保留同一个提交 ID，避免原文卡和引擎回显重复。
- Codex `/goal` 返回原生目标及状态；支持查询、设置、edit、pause、resume、clear。active goal 的执行由 App Server 自己触发，Hub 不额外 `turn/start`。
- Codex 新增模型目录、带任务的 `/plan`、自定义 `/review`、`/skills` 及同名 skill 原生输入、`/hooks`、`/apps`、`/plugins`、`/usage`、`/context`、`/debug-config`、`/diff`、`/ps`、`/stop`、`/init`。

## 能力边界

- 命令按当前 provider 的能力执行，不把 Claude 的 `/loop` 伪装成 Codex 内置命令。Codex 同名 skill 必须真实存在于引擎返回的目录中。
- CLI 的纯终端交互设置、账号登录及部分会话导航命令尚无对应原生操作时，会明确提示使用 Hub 或独立 CLI 入口，原文仍保留。这次不宣称全部 TUI 命令一比一实现。
- 命令历史仅用于显示，不生成伪造的 provider turn，也不参与运行状态判定。未通过 Hub 发送的历史记录不会凭空补造 raw 命令。
- SQLite 随 Hub 数据目录隔离；不修改 provider 转录、生产登录文件或生产进程。

## 验证

- `node --test tests/unit-command-transcript.test.js tests/unit-codex-native-session.test.js tests/unit-claude-native-commands.test.js tests/unit-prompt-submit-ipc-contract.test.js`
- `node tests/unit-prompt-submit-ui-contract.test.js`
- `node tests/e2e-cli-command-cards-cdp.js`：真实隔离 Hub + 协议 fixture；普通会话、Codex goal/skill、Claude loop、失败命令、切换与 renderer reload、原文去重及普通对话。
- `node tests/diag-real-native-goal.js`：真实 App Server 0.153.4，保持 `gpt-6-astra / xhigh / fast`；设置目标自动启动并返回指定答案，原生目标状态为完成；get/clear 成功。
- `node tests/diag-real-claude-loop.js`：真实 Claude，保持用户模型 `opus[1m]`、effort max；bundled `/loop` 实际调用 CronCreate 成功。关闭本次测试引擎后，内存定时任务结束；临时凭据已删除。
- 全量与合并验证结果见交付报告，不能用上面的定向结果代替项目合并门禁。

原生协议参考：https://learn.chatgpt.com/docs/app-server

Claude `/loop` 参考：https://code.claude.com/docs/en/scheduled-tasks
