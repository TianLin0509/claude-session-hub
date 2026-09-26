# CLI 与辅助卡片统一检查（2026-09-26）

用户授权：审核 c7d25d6 已合入的修复，然后深挖 Codex，并把其他提供方统一到真实 CLI + 辅助卡片。补充要求：移除截图中的「暂未确认消息提交 / 补发 / 忽略」横幅。

基线：ecb962f，生产未提交内容不动。实施分支 fix/cli-card-audit-20260926-codex1。

## 验收范围

- 审核前轮身份切换、分支、恢复、停止、重启、提交确认改动。
- Codex 真实 UI：发送、停止、长文、斜杠命令、新线程、恢复、分支、卡片与右栏。
- 其他提供方：Claude、DeepSeek Codex、Gemini、Kimi，及千问、DeepSeek Harness、GLM 的真实 TUI、状态和持久化记录。
- 提交横幅去除；明确发送失败仍保留可见反馈与草稿。
- 不修改生产状态、凭据、进程，不在共享 node_modules 安装依赖。

## 审核结论与实现

c7d25d6 已在 master，无需重复合并。复核了身份持久化、重启、分支、/new、停止、自动继续与旧结束记录清理的调用链；真实 Codex 复测覆盖 /new、分支、重启、历史重开。其修复方向成立，但不足以解决以下后续问题。

1. CLI 退出后卡片仍可能把提问送进 PowerShell。真实现场包括普通 `PS C:\\...>` 与 `>>` 续行提示。现在发消息前拒发并恢复草稿；等待确认期间若已退回 shell，也不再补 Enter。
2. 卡片重发失败以前只写控制台，现在就地显示失败原因；移除用户指定的未确认/补发横幅，不改变后台回执的真实性。
3. 忙时 Claude 改名先排队，等本轮结束后统一走 `session:send-prompt`；分屏右栏的「到终端处理」切换所属面板。
4. 群聊自动休眠跳过仍有权威运行轮次的 PTY 成员，旧轮迟到的完成事件不能结束新轮。
5. DeepSeek Codex 补齐 PTY 标记、Codex hook 环境与部署。按用户追加决定，新建 DeepSeek 默认 Codex CLI + 现有 DeepSeek API；旧 Token Plan Harness 会话保留原引擎，不跨引擎冒用会话 ID。
6. 千问采用本机 Qwen Code 0.23.3 的真实 TUI。消息通过原生 `--input-file` 提交，状态使用 root hooks，卡片读取绑定的原生 JSONL。磁盘晚于 Stop 到达仍保留对应轮次，分段和工具记录带上群聊关联标识。
7. 千问原生取消不发 Stop hook；使用其本地 OTel 取消记录（明确 session.id、事件名、时间）确认中断。日志只落隔离会话目录，关闭 prompt 和敏感 span 属性采集。停止键走原生取消动作，每轮只发一次，防止再次 Ctrl+C 退出 CLI。
8. GLM 使用本机已经安装的 Martty 0.2.38 TUI 驱动 ZCode。Martty 内部仍使用 ACP，Hub 只观察同一条管道，不另开 ACP 控制器。观察层保留 UTF-8、背压、凭据脱敏与 MCP 配置。恢复时补 ZCODE_ACP_RESUME_SESSION，严格拒绝恢复到不同身份。

### 不成立的初步判断

- /new 后不应立即释放旧 Codex 身份锁：实测原生进程仍持有旧 writer。保留锁，等原进程停止后再允许旧历史重开；已加入对应回归。
- 本机所有 Harness 都有可直接用的原生 TUI：GLM 的 ZCode `tui` 实际缺少 `@zcode/tui`，故复用已有 Martty；DeepSeek Harness 原生路径另遇 Token Plan `developer` role 400，未把它设成新默认。没有安装或修改共享依赖。

## 验证证据

所有 UI/CLI 证据来自独立数据目录、home、CDP 端口的后台 Hub，不重启生产 Hub。基线 Codex 状态矩阵 6 项通过（跳过长时场景）。后续新增证据：

- `node tests/e2e-cli-card-audit-cdp.js`：Codex 收发、/new、分支、重启、旧 writer 锁、原会话释放后历史重开、真实退出到 shell 后拒发通过。卡片失败与横幅删除两项采用隔离 UI 故障注入，不能等同云端异常实测。证据 `artifacts/cli-card-audit/1790447944037/result.json`。
- `node tests/e2e-provider-cli-cdp.js deepseek`：DeepSeek Codex 真实收发、卡片、完成、重启同 ID 通过。证据 `artifacts/provider-cli/1790446430753/result.json`。
- `node tests/e2e-provider-cli-cdp.js glm qwen`：GLM、千问真实收发和重启同 ID 通过。证据 `artifacts/provider-cli/1790446199306/result.json`。
- `node tests/e2e-provider-cli-cdp.js qwen --interrupt --fork`：千问停止工具、后续提问、真实分支独立 ID 通过。证据 `artifacts/provider-cli/1790447894548/result.json`。
- `node --test tests/unit-provider-cli.test.js`：5 项通过，包括轮次错序、群聊收集、取消身份、分块 Unicode 和凭据脱敏。
- `node --test tests/unit-pty-first-prompt-ready.test.js tests/unit-groupchat-redundant-enter-guard.test.js`：就绪、shell 防护、补 Enter 边界通过。

测试工作树：`C:/AIWork/20260926-cli-card-test-codex1`。这些是分阶段证据；集成后的全量闸门与新增场景结果在交付报告补充，不把前一提交的结果冒称最终候选结果。

### 失败保留

- 首轮全量有 3 个文件失败：两项开发流程测试缺少 `sh`（spawn ENOENT，可复现），给测试进程 PATH 加 Git/bin 后直接复测通过；title-index 的 5ms 性能断言直接复测通过，首次失败仍保留，不能仅据复测归因为负载。
- 千问启动超时现场截图显示 CPU 100%、CLI 正在 Initializing；这仅是负载线索，未据此改大超时或认定环境已排除。后续正常启动场景通过。
- 千问中断与 GLM 恢复身份错误、Codex shell 续行检测失败均保留最初失败证据，修改后用相同真实场景复测。

## 能力边界

- Gemini、Kimi 原来已经是 CLI + 磁盘卡片。本轮通用卡片失败提示与 shell 防护覆盖它们；未换引擎，不把静态审查或协议夹具说成真实云端全场景验证。
- 新千问/GLM 卡片的附件与模型切换明确提示到 CLI 操作；GLM 卡片分支隐藏，尚未接通它的原生分支回执。千问原生分支已实测。
- 旧 ACP 历史的批量迁移、跨 Hub 竞争、大型多成员长循环以及用户中途手动修改 CLI 内部设置，没有覆盖全部组合。
- 本次没有外部第二位 agent 审查；使用结构检查与真实运行两遍复核，不能称独立审查。

## 调研来源

- Qwen 官方 dual output：<https://qwenlm.github.io/qwen-code-docs/en/users/features/dual-output/>
- Qwen 官方 hooks：<https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/>
- Martty 项目：<https://github.com/openma-ai/Martty>
- 实现另核对本机实际 Qwen 0.23.3 与 Martty 0.2.38 源码；版本能力以本机实测为准。
