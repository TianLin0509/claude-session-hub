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
9. GLM 在 Windows 上把粘贴换行当成 Enter，多行消息会拆成多次请求；普通 Esc 也未产生取消请求。改用 Win32 键盘事件，换行使用 Shift+Enter，提交和取消明确清除修饰键。120 行中文、emoji 的真实 TUI + 本地代理逐字校验通过；云端长文、停止与后续提问通过。直接终端粘贴也使用同一转换。不支持的制表符/控制字符明确拒发，不静默改写正文。
10. 千问、GLM 的历史解析虽能返回数据，旧卡片入口却拒绝显示。已修入口，并把验收改成检查界面里真实可见的回答。Gemini 同样缺少入口和原生解析器；新增 JSON / JSONL 投影、身份校验与绑定路径持久化。
11. CLI 启动取消不再留下悬空等待；协议输出在半个 JSON 处结束会报错，不把进程正常退出当成完整回执。
12. Codex 120 行中文、emoji 首次真实提交卡在粘贴块。核对 0.153.0 源码：Windows 使用按键粘贴缓冲，Enter 会被抑制。正文之后加入不改正文的 End 键，先清空该缓冲再按原流程提交；保留唯一有界补 Enter 与语义回执。正常提交、继续、恢复重写共用此边界。
13. 最后补测发现短 `/new` 同样可能停在 CLI 输入框。将相同输入缓冲边界覆盖到斜杠命令；5d860e2 上真实 `/new`、分支、重启、历史重开和退出防护全部通过，没有增加自动重发。测试退出失败也会保存原始错误与结果，并清理临时鉴权副本。

### 不成立的初步判断

- /new 后不应立即释放旧 Codex 身份锁：实测原生进程仍持有旧 writer。保留锁，等原进程停止后再允许旧历史重开；已加入对应回归。
- 本机所有 Harness 都有可直接用的原生 TUI：GLM 的 ZCode `tui` 实际缺少 `@zcode/tui`，故复用已有 Martty；DeepSeek Harness 原生路径另遇 Token Plan `developer` role 400，未把它设成新默认。没有安装或修改共享依赖。

## 验证证据

所有 UI/CLI 证据来自独立数据目录、home、CDP 端口的后台 Hub，不重启生产 Hub。基线 Codex 状态矩阵 6 项通过（跳过长时场景）。后续新增证据：

- `node tests/e2e-cli-card-audit-cdp.js`：Codex 收发、/new、分支、重启、旧 writer 锁、原会话释放后历史重开、真实退出到 shell 后拒发通过。卡片失败与横幅删除两项采用隔离 UI 故障注入，不能等同云端异常实测。证据 `artifacts/cli-card-audit/1790447944037/result.json`。
- `node tests/e2e-provider-cli-cdp.js deepseek`：DeepSeek Codex 真实收发、卡片、完成、重启同 ID 通过。证据 `artifacts/provider-cli/1790446430753/result.json`。
- `node tests/e2e-provider-cli-cdp.js glm qwen`：GLM、千问真实收发和重启同 ID 通过。证据 `artifacts/provider-cli/1790446199306/result.json`。
- `node tests/e2e-provider-cli-cdp.js qwen --interrupt --fork`：千问停止工具、后续提问、真实分支独立 ID 通过。证据 `artifacts/provider-cli/1790447894548/result.json`。
- `node tests/e2e-provider-cli-cdp.js qwen --interrupt --long --fork`：120 行、停止后续发、可见卡片、独立分支完整通过。证据 final 工作树 `artifacts/provider-cli/1790450465518/result.json`。
- `node tests/e2e-provider-cli-cdp.js glm --interrupt --long`：120 行、停止后续发、可见卡片通过。证据 test 工作树 `artifacts/provider-cli/1790450656131/result.json`。
- `node tests/e2e-cli-pty-status-matrix-cdp.js --only=claude --skip-long`：11/11 通过，证据 test 工作树 `artifacts/cli-pty-core/status-matrix-1790447956145/report.json`。额外右栏按钮真实操作通过（1790449021598）；忙时改名真实原生落盘通过（1790450012446）。
- `node tests/e2e-gemini-card-fixture-cdp.js`：隔离界面 + 原生格式合成记录通过，截图已读；不是 Gemini 云端调用。证据 test 工作树 `artifacts/gemini-card-fixture/1790450380281/result.json`。
- `node tests/e2e-codex-native-other-providers-cdp.js`：Kimi 真实 CLI 启动及输入界面通过，未发云端请求。证据 final 工作树 `artifacts/codex-native-runtime/other-providers-1790450715574/result.json`。
- `PTY_SCENARIOS=codex-long-prompt`，`node tests/e2e-cli-pty-status-matrix-cdp.js --only=codex --audit-extras --skip-long`：修复后两次真实 120 行原文校验通过，仅一次提交；final 工作树 `status-matrix-1790451522161`、`status-matrix-1790451588886`。130 秒前台工具状态通过（`status-matrix-1790450915398` 的 codex-long；同报告的长文是修复前失败，不能称整份通过）。
- `node --test tests/unit-provider-cli.test.js tests/unit-gemini-transcript-parser.test.js tests/unit-prompt-submit-ui-contract.test.js tests/unit-pty-auto-suspend.test.js tests/unit-codex-pty-hook.test.js`：15 项通过，包括轮次错序、群聊收集、取消身份、分块 Unicode、协议截断和凭据脱敏。
- `node --test tests/unit-pty-first-prompt-ready.test.js tests/unit-groupchat-redundant-enter-guard.test.js`：就绪、shell 防护、补 Enter 边界通过。

测试工作树：`C:/AIWork/20260926-cli-card-test-codex1`。这些是分阶段证据；集成后的全量闸门与新增场景结果在交付报告补充，不把前一提交的结果冒称最终候选结果。

### 最后补测

- DeepSeek 最终产品代码真实复测：实施工作树 `artifacts/provider-cli/1790452292989/result.json`，3 项通过，包括重启后可见原生回答。
- Codex 5d860e2：final 工作树 `artifacts/cli-card-audit/1790453103085/result.json`，9 项全部通过；截图已读取。其中明确标注的 2 项是 UI 故障/回执注入，其余为真实 CLI 场景。
- `node --test tests/unit-pty-first-prompt-ready.test.js tests/unit-groupchat-redundant-enter-guard.test.js` 在 5d860e2 的修改上通过 11 项，覆盖 Windows 斜杠输入缓冲和不增加 Enter。
- 全量 592 文件固定在 0b802963c2bb09e3633a1e81645dab8c85af18ea 上运行；它不包含最后的斜杠缓冲修正。不得把该全量结果标成 5d860e2，后者由上述定向单测与真实界面回归覆盖。最终结果见交付报告。
- `/new` 验收脚本曾错误地等待按钮禁用、立即生成新会话 ID，或普通 prompt 的确认状态。Codex 本地命令应以本次 command history 回执为准；下一条真实提问才懒创建新线程。旧失败记录仍保留。另一次失败现场明确显示 `/new` 留在 CLI 输入框，属于第 13 项修复，不能全部归咎测试脚本。

### 失败保留

- 首轮全量有 3 个文件失败：两项开发流程测试缺少 `sh`（spawn ENOENT，可复现），给测试进程 PATH 加 Git/bin 后直接复测通过；title-index 的 5ms 性能断言直接复测通过，首次失败仍保留，不能仅据复测归因为负载。
- 千问启动超时现场截图显示 CPU 100%、CLI 正在 Initializing；这仅是负载线索，未据此改大超时或认定环境已排除。后续正常启动场景通过。
- 千问中断与 GLM 恢复身份错误、Codex shell 续行检测失败均保留最初失败证据，修改后用相同真实场景复测。
- 后续全量 590 文件仍有两项失败：合并版本测试超时、工作台并发审查测试超时。正常优先级直接重测时，前者 7/7 通过，后者仍有一个 60 秒超时；未修改断言或超时预算掩盖问题。
- 早期千问、GLM 的“卡片”检查只读了后台记录，截图实际显示不支持历史；该证据不能算可见卡片通过。修正验收后，两者的真实可见卡片已通过并读图确认。
- GLM 120 行测试最初产生 53 次原生请求，取消测试最初没有原生取消请求；修复后保留同一云端场景通过证据。报告不能只展示最后成功而省略这些发现。
- 一轮 592 文件全量运行的超时问题均未重现，但旧卡片契约仍断言入口只能是手写的 Claude/Codex/Kimi 列表。更新为统一能力入口，并实际求值检查 Codex、DeepSeek、Qwen、GLM、Gemini、Kimi 支持与 shell 不支持；该文件直接复测通过。最终冻结提交重新跑全量。

## 能力边界

- Gemini、Kimi 原来已经是 CLI；Kimi 已有原生卡片解析，Gemini 本轮才补齐。本轮通用卡片失败提示与 shell 防护覆盖它们；未换引擎，不把静态审查或协议夹具说成真实云端全场景验证。
- 新千问/GLM 卡片的附件与模型切换明确提示到 CLI 操作；GLM 卡片分支隐藏，尚未接通它的原生分支回执。千问原生分支已实测。
- 旧 ACP 历史的批量迁移、跨 Hub 竞争、大型多成员长循环以及用户中途手动修改 CLI 内部设置，没有覆盖全部组合。
- 本次没有外部第二位 agent 审查；使用结构检查与真实运行两遍复核，不能称独立审查。

## 调研来源

- Qwen 官方 dual output：<https://qwenlm.github.io/qwen-code-docs/en/users/features/dual-output/>
- Qwen 官方 hooks：<https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/>
- Martty 项目：<https://github.com/openma-ai/Martty>
- Microsoft Win32 输入事件：<https://github.com/microsoft/terminal/blob/main/src/terminal/input/terminalInput.cpp>
- Codex 0.153.0 粘贴缓冲：<https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/tui/src/bottom_pane/chat_composer.rs>
- 实现另核对本机实际 Qwen 0.23.3 与 Martty 0.2.38 源码；版本能力以本机实测为准。
