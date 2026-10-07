# 公司内网：用内部 Code Agent 跑 AI Hub

这份手册写给**公司内部的编码 Agent**（下文统称 Code Agent）直接执行。场景：内网不能使用 Claude Code、Codex 等外部 CLI，只有一个公司自研 CLI；它的命令行与交互方式接近 Codex CLI，后端可选 GLM、MiniMax 等模型。目标是让 Hub 多出一个「Code Agent」会话种类，单聊、群聊、卡片、恢复都像 Claude/Codex 一样可用。

固定基线：**@@COMMUNITY_TAG@@**（上游 @@UPSTREAM_VERSION@@）。

## 结论先说

- Hub 已经有一条现成路线：**DeepSeek 会话就是「借 Codex CLI 运行时、换模型和配置目录」实现的**。如果 Code Agent 是 Codex 的改版（命令行参数、配置文件、会话记录格式基本一致），照这条路线新增一个 `codeagent` 种类，主要工作是把写死的 `codex` 命令名和 `~/.codex` 目录改成可配置，工作量中等。
- 如果 Code Agent 与 Codex 差异较大（没有 hook、会话记录格式不同），仍可接入，但状态判断只能退化为「屏幕识别 + 输出静默」，可靠性低一档，需要在界面上如实标注。
- 不论哪条路线，**先探测、再编码**：第 1 步的探测结果决定走哪条路，不允许凭「它像 Codex」直接假设。

## 可以直接交给 Code Agent 的任务

> 以 AI Hub Community @@COMMUNITY_TAG@@ 的源码为基线（源码 ZIP 或仓库 tag），先读 AGENTS.md、docs/ARCHITECTURE.md 和 docs/COMPANY-CODE-AGENT.md。在独立目录建立我们自己的分支。按手册第 1 步探测本机 Code Agent CLI，把结果写成 `codeagent-probe.md`；按第 2 步的判定表选路线并说明理由；按第 3 步新增 `codeagent` 会话种类；按第 4 步完成单测、隔离窗口测试和一条真实消息验收；按第 5 步打包内部安装包。不得捏造 CLI 参数或内部接口，不确定的能力在界面上显示「不支持」；不得把未确认的提交当成成功；每一步交付源码改动、实际运行的命令、结果和未覆盖项。做不下去时，按第 6 步输出失败报告。

## 第 0 步：把 Hub 带进内网

内网能访问 GitHub 时，直接 clone 或下载 Release；不能访问时，在外网取同一个 Release 的文件，经公司批准的渠道转入：

| 文件 | 用途 |
|---|---|
| `install-release.ps1`、`AIHubCommunity-@@COMMUNITY_VERSION@@-win-x64.zip`、`SHA256SUMS.txt` | 便携安装，先确认 Hub 本身能在内网电脑启动 |
| `AIHubCommunity-source-@@COMMUNITY_VERSION@@.zip` | 源码，做 Code Agent 适配用 |

离线安装命令见 [AGENT-QUICKSTART.md](AGENT-QUICKSTART.md) 路线 B。源码开发需要 Node.js 22+ 和能用的 npm 源（公司 npm 镜像）；Electron 二进制若下载不了，设置公司提供的 `ELECTRON_MIRROR`。先跑通 `install.ps1 -NoShortcut`、`npm test`、`node tests/e2e-community-cdp.js`（它用模拟 CLI，不需要任何账号），证明基线在内网可用，再开始改代码。

## 第 1 步：探测 Code Agent CLI（只读，不发真实任务）

逐项执行并把**原始输出**记进 `codeagent-probe.md`。命令名以实际为准，下文用 `codeagent` 代称。

| 要回答的问题 | 怎么查 | Hub 用它做什么 |
|---|---|---|
| 可执行文件名与位置 | `where.exe codeagent`；`codeagent --version` | 首页检测、启动命令 |
| 顶层参数 | `codeagent --help` 全文 | 免确认执行参数、模型参数、`-c key=value` 覆盖 |
| 恢复与分支 | `codeagent resume --help`、`codeagent fork --help`（若有） | 重启后恢复同一原生会话 |
| 配置目录 | 帮助或文档里的 `CODEX_HOME` 等价环境变量；默认目录（如 `~/.codeagent`）的文件清单 | 隔离配置、写 hook、信任项目目录 |
| 配置文件格式 | 默认目录里的 `config.toml`（**只记录键名，不要贴出 token**） | 模型提供方、上下文、主题、hook 开关 |
| 会话记录 | 默认目录下 `sessions/` 的层级与文件名；一条记录的前 20 行（脱敏） | 绑定原生 ID、读取回答、恢复历史 |
| hook 能力 | 是否认 `hooks.json`、`features.hooks`；有哪些事件（SessionStart / UserPromptSubmit / Stop 等） | **完成状态的权威来源** |
| 模型 | 模型选择参数；可选模型清单与名称（如 GLM、MiniMax） | 创建会话时的模型下拉 |
| 推理档位 | 是否有 reasoning effort 之类参数 | 思考档位按钮；没有就不显示 |
| 登录 | 登录与状态查询命令（如 `codeagent login status`）；公司 SSO 方式 | 账号中心「检查登录」 |
| 规则文件 | 是否读取项目里的 `AGENTS.md` | 群聊规则、项目规则注入 |
| MCP | 是否支持 MCP 服务器配置 | 群聊成员之间的通信工具 |
| 交互界面特征 | 启动后输入框的提示文字、底部状态栏样式；粘贴多行文本时的表现 | 判断「已就绪」「已收到」 |

然后在一个空的测试目录里，手工运行一次 `codeagent`，发一句「只回复 OK」，确认会话记录文件生成的位置和内容（这是唯一允许的真实消息，用于取样）。

## 第 2 步：按探测结果选路线

| 探测结果 | 路线 | 说明 |
|---|---|---|
| 参数、`resume`、`config.toml`、`sessions/*.jsonl`、hooks 都与 Codex 一致或只差名字 | **A：Codex 运行时复用**（推荐） | 照 DeepSeek 的实现方式加 `codeagent` 种类，复用 Codex 的 hook、记录解析、恢复、卡片 |
| 大体一致，但记录格式或 hook 事件有差异 | **A + 适配层** | 仍走 A，在记录解析 / hook 解析处加 `codeagent` 分支；差异逐项写测试夹具 |
| 支持 ACP（Agent Client Protocol，stdio 上的 JSON-RPC 会话协议） | **B：ACP 种类** | 参照 `core/acp-profiles.js` 里 qwen / glm 的分支新增一项 |
| 都不支持，只有交互式终端 | **C：屏幕识别兜底** | 能聊天，但「完成」只能靠输出静默推断；界面必须标明「状态为推断」，不能宣称与 Claude/Codex 同等可靠 |

## 第 3 步：路线 A 的改动地图

以「DeepSeek 跑在 Codex CLI 上」为模板：`deepseek` 在 `core/ai-kinds.js` 里属于 `CODEX_CLI_KINDS`，`core/session-manager.js` 里用 `isCodexRuntime` 判断走 Codex 启动链路，配置目录由 `core/deepseek-codex-profile.js` 的 `ensureDeepSeekCodexProfile` 生成。新增 `codeagent` 时按下表逐项改；每处先读现有 `codex` / `deepseek` 分支，再加自己的分支，不重写共用逻辑。

| 层 | 文件与位置 | 要做的事 |
|---|---|---|
| 种类登记 | `core/ai-kinds.js`：`ALL_AI_KINDS`、`CODEX_CLI_KINDS`、`PASTE_SENSITIVE_KINDS`、`KIND_LABELS`、`FAMILY_KINDS`、`canonicalAiKind` | 加 `codeagent` 与 `codeagent-resume`，显示名「Code Agent」 |
| 命令名与目录 | 新建 `core/codeagent-profile.js`（参照 `deepseek-codex-profile.js`） | 集中定义：可执行文件名、配置目录环境变量名、默认配置目录、默认模型、可选模型；允许用 `hub-config` 或环境变量覆盖（如 `AI_HUB_CODEAGENT_COMMAND`、`AI_HUB_CODEAGENT_HOME`） |
| 查找可执行文件 | `main/codex-windows-command.js`：`resolveWindowsCodex`、`locateWindowsCodex`、`ensureCodexOnSessionPath` | 抽出「按命令名查找」的参数，`codeagent` 用自己的名字和安装目录 |
| 启动命令 | `core/session-manager.js`：拼 `codex …` 的几处（新建、`resume <sid>`、`fork <sid>`、`resume --last`，以及 relaunch） | 命令名按种类取；免确认参数、模型参数、`-c` 覆盖按探测结果映射，**Code Agent 不认的参数不要传** |
| 配置目录与信任 | `session-manager.js`：`ensureCodexCwdTrusted`；`main.js`：`ensureCodexContextConfig` | 写到 Code Agent 自己的配置目录，不碰 `~/.codex` |
| 状态回报 hook | `core/codex-hook-integration.js`、`main/codex-pty-hook.js`、`core/hook-payload.js` | 在 Code Agent 配置目录登记 hook；事件字段不同就在 `hook-payload.js` 加映射并补夹具 |
| 会话记录 | `core/codex-transcript-parser.js`（`DEFAULT_CODEX_SESSIONS_ROOT`、`findCodexRolloutBySid`）、`core/transcript-tap.js`（`CodexTap`） | 增加 Code Agent 的 sessions 根目录；格式差异加解析分支 |
| 模型与档位 | `core/model-options.js`（`normalizeDeepSeekModel` 旁边加 `normalizeCodeAgentModel`）、`core/codex-model-catalog.js`、`core/codex-speed-tier.js` | 模型清单来自探测结果；没有档位或速度档就不显示，不要默认降档 |
| 账号 | `core/cli-auth.js`、`core/account-adapters.js`、`core/account-center.js` | 「检查登录」调用 Code Agent 自己的状态命令；SSO 由用户本人完成，凭据不进日志 |
| 首页检测 | `core/community-setup.js` 的 `PROVIDERS`；`core/community-provider.js` | 加 Code Agent 一行（名称、命令、登录命令、内部文档链接） |
| 界面 | `renderer/index.html` 新建会话选项与恢复选项、`renderer/workspace-controller.js`、`renderer/meeting-create-modal.js` 的 `GROUP_MEMBER_KINDS`、`renderer/model-ui.js`、`renderer/session-welcome.js`、`renderer/chat-avatar.js`、`renderer/config-modal.js` | 新建会话、群聊成员、模型下拉、头像都能选 Code Agent |
| 图标与样式 | `renderer/assets/ai-logos/`、`renderer/styles/card-view.css`、`composer.css`、`meeting-room-chat-flow.css` | 加 `codeagent` 图标和配色 |
| 测试 | `tests/` 下与 ai-kinds、群聊成员覆盖、自动标题相关的单测 | 把 `codeagent` 加进覆盖清单；新增 profile、命令拼装、记录解析的单测 |

发送消息必须走现有的 `session:send-prompt` 提交链路（`core/pty-prompt-submit.js`：分块输入 → 等界面稳定 → 确认已收到 → 有限次补回车），不要另写「文本加回车一次写入」的捷径。

## 第 3 步补充：只有 Code Agent 时，哪些功能会降级

内网电脑没有 Claude/Codex 时，Hub 照常启动，但以下功能要改默认值或接受降级：

| 功能 | 现状 | 建议 |
|---|---|---|
| 会话自动起名、提示词润色 | 默认调用 DeepSeek API，没有 Key 时退回用首句做标题 | 可改为调用公司模型 API；不改也能用 |
| 记忆整理（造梦） | 后端可选 claude / codex / kimi / gemini / deepseek-api | 加 `codeagent` 选项，或在设置里关闭 |
| Hub 助理 | 默认后端是 codex；快速通道用阿里云 Token Plan | 把默认后端改成 `codeagent`；快速通道不配置即可 |
| 资料口播 | 依赖 claude 可执行文件 | 内网不提供或改用 codeagent |
| 群聊默认成员 | 默认 Claude + Codex | 改成 Code Agent 多席位（例如一位用 GLM、一位用 MiniMax） |
| 恢复会话的历史搜索 | 只搜 claude / codex / deepseek 的记录 | 若走路线 A，把 Code Agent 的 sessions 目录加入搜索源 |

## 第 4 步：验收（按顺序，不省略）

1. 单测：`node --test` 跑新增与修改的测试；全部社区测试 `npm test` 通过。
2. 协议夹具：用第 1 步取到的真实（脱敏）记录与 hook 样本做夹具，验证绑定原生 ID、读取回答、完成判定。
3. 隔离窗口：用 `tests/helpers/hub-launcher.js` 起隔离 Hub（独立数据目录与 CDP 端口），用鼠标键盘真实操作：新建 Code Agent 会话 → 发送 → 卡片出现回答并进入完成状态。
4. 真实账号：在用户允许的测试目录发「只回复验收通过，不修改文件」；看到回复与完成状态才算在线通过。
5. 恢复：关闭会话再打开，原生 ID 与历史一致；重启 Hub 后同样成立。
6. 群聊：两名 Code Agent 成员（可选不同模型）各自回复，群聊卡片读到各自的回答文件。
7. 故障：未登录、模型不可用、网络断开时，有可操作的中文提示；不自动换模型、不重复发送状态未知的消息。

只跑了模拟 CLI 时，报告写「GUI 通过，真实 Code Agent 未测」。

## 第 5 步：内部打包与分发

在适配分支上执行 `npm run dist`（需要独立的 node_modules，不要用别人共享的依赖目录），产出安装包与便携 ZIP。修改 `package.json` 的 `productName` / `build.appId` 以区分内部版本；默认数据目录 `%USERPROFILE%\.ai-hub-community` 可保留。按公司软件准入流程签名与分发。

## 第 6 步：做不下去时的失败报告

把下面这份报告交回给需求方（不含 token、密码和完整配置文件）：

```text
基线版本：@@COMMUNITY_TAG@@，源码提交（community-edition.json 里的 upstreamCommit）
卡在哪一步：第 N 步，具体动作
实际命令与完整输出（错误原文）：
已探测到的 Code Agent 能力（codeagent-probe.md 摘要）：
已完成的改动与对应测试结果：
判断的原因（已验证 / 推断 分开写）：
需要对方提供或决定的事项：
```

常见卡点：npm / Electron 下载不了（要公司镜像）；Code Agent 不支持免确认执行（需要在 Hub 里保留它的审批交互）；会话记录不落盘（无法恢复，只能做单次会话）；没有 hook（走路线 C 并标注）。
