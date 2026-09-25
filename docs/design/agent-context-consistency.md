# 同一个人的账号与 Agent 上下文（2026-09-25）

用户确认：账号仅提供额度；更换账号不应更换使用者身份、协作偏好和基础上下文。审视所有 Agent 的重复 prompt。

## 统一来源与账号边界

- 可选用户源 `~/.agents/USER_CONTEXT.md`。不存在时维持原启动行为；存在时，Hub 在启动或 Codex 账号切换前同步到当前引擎实际读取的全局入口。
- Codex / Kimi / DSH / ZCode 使用 `AGENTS.md`；Claude 使用 `CLAUDE.md`；Gemini 使用 `GEMINI.md`；Qwen 使用 `QWEN.md`，不再同时播种另一份全局 `AGENTS.md`。
- ACP 继续隔离凭据和会话 home；只把个人规则复制进各自 `.qwen` / `.dsh` / `.zcode`。不是复制整个真实 home。
- 同步写入 `.hub-user-context.json` 保存来源哈希。仅覆盖自己写入且未被独立修改的文件；现有显式 `user-context-targets.json` 可以提供首次接管的来源哈希。遇到独立修改停止同步，不静默覆盖。
- 共同策略还维护 Codex `hooks.json`、Claude 的 hooks 与 autoMemoryDirectory，避免额度账号缺少相同的文件保护或原生事件采集。不同事件/工具的守卫不是重复基础 prompt，不因字符串相同就删除。
- 隔离 Hub 不隐式导入真实个人规则；显式隔离 home 也不能写出隔离根。未修改凭据、历史身份、SQLite 归属或正在运行的 writer。

## Codex 默认设置

- 用户侧 `~/.agents/context-policy.json` 的 `codexDefaults` 是共用默认设置。启动与额度账号切换都使用同一策略；模型、权限、MCP 档位、速度等本次明确选择继续覆盖默认值。
- `model_provider`、端点、鉴权、SQLite 和会话历史路径不属于此策略允许的顶层字段。MCP 工具自己的配置可以共享，但不得把整个策略原文写进公开报告。
- 传给 Codex 的对象覆盖项序列化为 TOML inline table，内部键使用引号，避免模型名中的点被误拆为路径；禁止把 JSON 对象直接当 TOML inline table。
- 项目根同时识别 `.git` 与 `.vibe-root`。不会把根规则复制进每个临时项目。
- 显式迁移脚本统一两份订阅配置的默认模型、工具配置、功能设置和项目信任集合。冲突的项目信任必须人工审视，不取最宽权限。
- TOML 序列化保留旧 Hub 可识别的 `[projects.'路径']` 与 `[mcp_servers.名称]` 表头，避免运行中的旧版本重复追加同一项目。迁移回归测试验证该兼容性与重复执行不再写入。
- 本轮迁移采用统一人工维护的基础上下文：`features.memories=true` 保留原生记忆能力，`memories.use_memories=false` 让账号分别生成的摘要不在启动时叠加。现有原生历史库和摘要保留按需检索，生成设置不靠关闭功能来规避差异。Claude 的共同短索引仍原生加载。

## 去重：原生加载合同与 Hub 补发

本机技能清理：共同 `.agents/skills` 补齐两个只在 Codex 主账号可见的技能；归档三个实际重复技能目录，旧 img2ppt 指针改成原技能目录的链接。Claude 七个配置共用原 `.claude/skills`。Codex 保留网页生图插件的 MCP 能力，通过 `skills.config` 关闭重复的普通技能说明；同一过滤策略进入共同默认设置。修复 ai-daily-video 描述行的 YAML 引号，不改变工作流正文。

浏览器插件原先依赖主账号的临时内置市场。将本地发行内容放到 `.agents/plugins/openai-bundled`，以 `shared-local-tools` 市场注册并保留浏览器插件，两账号缓存来自同一发行内容。实际 `skills/list` 检查两账号均有 42 个启用项，名称、描述、启用状态一致；文件路径允许随系统技能 home 改变。此为本次本机目录迁移，Hub 不擅自安装未来新增插件。

`native-rule-coverage.js` 捕获本次启动的候选正文与哈希。它是去重策略的输入，不是已注入证据，绝不能放进“原生已加载”UI。

原生已覆盖的等价工作根正文，不再通过 `ai-hub-workspace-rules` 补一份。比较忽略说明注释、BOM 和 CRLF 差异；不修改用户实际发送的文本、不删不同项目的独特规则。文件变化后旧快照不再用于抑制新内容。既有提交编号的重试仍复用原始附加文本，避免改变已确认的提交。

边界：

- Codex 尊重最近 Git / 工作根标记、override 替换和默认预算；自定义文件预算、fallback 文件等无法完整确定时回到保守补发。
- Claude 检查祖先 CLAUDE 文件，特殊 exclusions、managed-only 与 settingSources 不确定时保留补发；不跨版本猜 AGENTS fallback。
- Qwen / Gemini 有自定义候选配置时不猜覆盖；DSH 与 Kimi 无 Git 根时保留工作根补发；ZCode 只选最近的一份 AGENTS。
- 规则内容相同不等于删文件的授权。迁移只对已确认正文等价的工作根三份文件统一说明注释，以适配 DSH 的原生全文判重。
- 引擎内置提示、工具协议、角色分工、历史对话并不完全相同。此改动不宣称所有供应商最终请求逐字相等，也不把未知覆盖伪装成已去重。

## 迁移与回滚

`scripts/sync-personal-agent-context.py` 默认只输出计划；`--apply` 先保存逐文件原文和哈希，再用并发检查与原子替换应用。`--home`、`--workspace`、每个 `--codex-home`、`--backup-root` 都要明确指定。首个 Codex home 为默认设置来源；凭据和历史不合并。

原 Hub 的全局账号路由已覆盖单聊和群聊。2026-09-25 早先报告只读到旧分支，误称群聊固定使用 `.codex`；沿 `prepareLaunch` 后完整链路核对，应以全局路由和已绑定历史为准。

## 验证

- `node --test tests/unit-agent-context-consistency.test.js tests/unit-memory-rule-files.test.js tests/unit-hub-memory.test.js tests/unit-acp-profiles.test.js tests/unit-codex-global-account.test.js tests/unit-codex-native-options.test.js tests/unit-memory-native-context.test.js tests/unit-prompt-submit-ui-contract.test.js tests/unit-deepseek-codex-profile.test.js`
- `node tests/e2e-agent-context-consistency-cdp.js`：独立数据、home、CDP 端口和协议子进程，检查两个 Codex 账号及 Claude 经真实 Hub 发送时不再补发等价规则；修改后仍发送新增规则。
- 本机 Codex 0.153.4 / Claude 2.1.282 到 localhost 模拟模型的请求抓取：两个 Codex 账号与 Claude，各自工作根 / 无 Git 普通子目录共六例；确认个人规则和工作根正文各出现一次。未进行云端推理。
- 测试进程先清除从当前 Codex 宿主继承的 `CODEX_SQLITE_HOME`，否则夹具会正确拒绝越出隔离目录。不得为通过测试而放宽隔离检查。
