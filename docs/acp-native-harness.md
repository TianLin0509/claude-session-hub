# 原生 Harness / ACP 接入

AI Hub 将千问、DeepSeek 原生 Harness、智谱 ZCode 作为与 Codex App Server 并列的会话后端。模型调用、工具执行和模型上下文仍由各家的原生程序处理；ACP 负责把消息、工具、授权及结果带入 Hub。

## 配置入口

打开「启动」旁的下拉菜单 →「配置原生 Harness / 套餐」。填写套餐专属 Key、外部 Node 可执行文件及三个 Harness 入口。保存后新建「千问 · Qwen Code」「DeepSeek · 原生 Harness」「智谱 · ZCode」。已有 DeepSeek 官方 API 会话保留原路线。

套餐 profile 固定使用 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。配置错误会显式失败，不回落到其他供应商。Key 留空保存表示保留原 Key；读取设置不会把已保存 Key 送到渲染层。`AI_HUB_TOKEN_PLAN_KEY` 可替代配置文件中的 Key，用于隔离验证。

当前经过真实套餐调用的模型是 `qwen3.8-max`、`deepseek-v4-pro`、`glm-5.2`。每个会话保留自己的模型；运行时只确认 Harness 明确提供的配置值。确认套餐端点连通与确认账单抵扣是两件事，本实现没有读取账户账单或套餐剩余额度。

## 独立工具链

Hub 的 `node_modules` 无新增依赖。Harness 应安装到独立目录，不在复用生产依赖的 worktree 中执行安装。

本轮验证工具链位于 `C:\AIWork\20260911-acp-tools-codex1`，Node 为 `C:\Program Files\nodejs\node.exe`（v24.14.0）。入口相对于工具目录如下：

| 组件 | 验证版本 | 入口 |
| --- | --- | --- |
| Qwen Code | 0.23.3 | `node_modules\@qwen-code\qwen-code\cli-entry.js` |
| DeepSeek Harness | 0.1.5-rc.1，dsh-base 0.1.5-rc.2 | `node_modules\@deepseek-ai\dsh\lib\bin.js` |
| DeepSeek 完整 ACP 插件 | @openma/deepseek-harness-acp 0.4.31 | 配置包目录 `node_modules\@openma\deepseek-harness-acp` |
| ZCode ACP 桥 | zcode-acp-server 0.37.1 | `node_modules\zcode-acp-server\dist\index.js` |
| ZCode 原生后端 | 桌面包 3.11.2，CLI 0.16.5 | `zcode-extracted\resources\glm\zcode.cjs` |

DeepSeek 的完整 ACP 插件和 ZCode 桥都是社区组件。DeepSeek 的原生 Agent 循环不变，Hub 的 `core/acp-dsh-stdio.mjs` 仅补接原生持久化分叉。ZCode 桥启动实际 `zcode.cjs`，使用独立的自定义 provider，关闭远程桥模式。

已核对随包 LICENSE：Qwen Code、DeepSeek 社区插件及 ZCode ACP 桥使用 Apache-2.0，DSH 使用 MIT。ZCode 原生后端仍按厂商软件条款提供；本仓库不分发其二进制。

在新机器上，可在另一个专用目录安装上述固定版本：

```powershell
npm.cmd install --prefix C:\AIWork\ai-hub-acp-toolchain --ignore-scripts --save-exact @qwen-code/qwen-code@0.23.3 @deepseek-ai/dsh@0.1.5-rc.1 @openma/deepseek-harness-acp@0.4.31 zcode-acp-server@0.37.1 7zip-bin@5.2.0
```

验证时使用 `--ignore-scripts` 是因为该版本 ZCode npm 安装脚本包含不兼容 Windows 的 shell 重定向；本轮直接验证了 Node 入口。保留工具目录的 `package-lock.json` 才能固定传递依赖，只有顶层版本号不足以完全复现。

ZCode 后端取自[官方 3.11.2 Windows 安装包](https://cdn-zcode.z.ai/zcode/electron/releases/3.11.2/windows-x64/ZCode-3.11.2-win-x64.exe)，只解压 `resources/glm` 与所需 `resources/ripgrep`，不运行安装器、不启动桌面 ZCode。校验值：

- 安装包 SHA-256：`4db76b6785c10fbc852dd9c9d257f574ea46f2a889d0beb9398ae0885d716717`
- `zcode.cjs` SHA-256：`e9f1868c0fdb863537ed910ee3828b9be96b8c2fd805473f63b439e1113266b8`
- 本轮外部工具锁文件 SHA-256：`d7c8ff9692287f5a23de4c5e010bb8f283e523f8c583da8fd073e062c7e0f15a`

## 会话行为

输入、停止、分支、关闭后恢复、模型设置及原生执行设置沿用 Hub 界面。后台文字区域用于查看真实输出与诊断，输入走统一提交管线。默认权限分别为 Qwen `default`、DeepSeek `workspace-write`、ZCode `build`，原生授权请求由 Hub 展示并回复。DeepSeek 的 workspace-write 同时允许系统临时目录，这符合其原生策略。

同一会话同时只运行一轮；不同会话有独立原生进程、HOME、配置和历史。分支同时取得新的原生会话 ID、独立配置目录及继承的 Hub 卡片历史。Hub 展示历史与模型恢复上下文分别验证，不能互相替代。

写入 stdio 不是模型接收确认。收到关联的真实更新/交互或原生 prompt 结果后才确认接收；原生 `stopReason` 决定完成/中断/失败。断连或超时不能当成已完成，结果不明时禁止自动重发，需要核对会话。重启前的旧授权按钮无效。

`/status`、`/help` 和 `/model` 由 Hub 接入；`/quota` 只说明套餐余量未知及百炼控制台入口，不调用其他供应商的额度接口。其他原生命令由 Harness 执行，三家 `/compact` 后的原生上下文记忆均已实测。新建、恢复、分支及账号管理使用 Hub 菜单，避免原生 CLI 在后台偷偷更换会话身份。模型命名空间限定于当前套餐，不允许把配置值切到其他供应商。

## MCP 与图片

每家配置可引用一个 UTF-8 MCP 配置文件，内容为 ACP server 数组。例如：

```json
[
  {
    "name": "my_tools",
    "command": "C:\\Program Files\\nodejs\\node.exe",
    "args": ["C:\\MyTools\\server.js"],
    "env": []
  }
]
```

HTTP / SSE 只在 Harness 握手声明支持时接受；未支持的传输会阻止启动，不静默丢弃配置。不要把含密钥的 MCP 配置放进 Git。各家原生 MCP 连接仍由上游实现负责，本轮用独立记录调用的真实本地 MCP 服务逐家验证。

粘贴/拖入本机图片后，Hub 将显式图片路径转为 ACP 图片内容，并保留历史缩略图。支持含空格的引号路径、一次多图；本地总大小限制为 10 MB，数量按原生能力限制（默认最多四张）。当前套餐 Qwen 模型支持图片；DeepSeek V4 和 GLM-5.2 为文本模型，发送前明确阻止图片，普通输入框保留草稿。文档路径仍交给原生工具读取。

上下文已用量来自 ACP 的 usage 更新。累计输入/输出 token、估算费用及套餐余量没有可靠数据时保持未知，不把上下文占用当成累计消耗。Harness 未提供思考正文时，Hub 不伪造思考或逐字动画。

当前 ZCode 桥可能仅返回 `Thinking…` 状态提示，它不是模型完整思考正文。原生 `/auto`、`/goal` 等厂商扩展仍应按上游能力理解，本轮不把未测的自主循环当成已经验证的 Hub 自动任务。

## 验证入口和回退

确定性测试：`node tests/unit-acp-session.test.js`、`node tests/unit-acp-profiles.test.js`、`node tests/unit-acp-cancellation.test.js`；全量入口：`node scripts/run_unit_tests.js`。

点击停止立即锁定该轮交互：迟到权限/提问和仍在写入队列中的旧允许响应均取消。Main 快照以 `cancellation.status=pending` 表示“正在停止”，执行状态保持未结束；普通页面与群聊都等待原 prompt 结果确认。15 秒仍未收到终态时，连接关闭、结果显示未知，禁止自动重发；需核对原生记录后继续。已在停止之前送达并执行的操作无法撤销。

`node tests/e2e-acp-cancel-race-cdp.js` 用真实隔离 Hub + stdio fixture 验证普通/群聊停止、迟到请求、旧按钮和缺失回执，截图与结果写入 `artifacts/acp-round2`。这是故障注入 GUI 证据；真实三家停止另跑 `node tests/acp-cancellation-real.js`。

真实验收脚本使用 `ACP_TOOLS_ROOT` 和 `ACP_TEST_KEY_FILE` 两个环境变量引用外部工具及受限凭据文件：

```powershell
node tests/acp-native-lifecycle-real.js
node tests/acp-native-extensions-real.js
node tests/acp-cancellation-real.js
node tests/acp-process-cleanup-real.js
node tests/e2e-acp-native-real-cdp.js
node tests/e2e-acp-dev-real-cdp.js
```

普通 GUI 脚本可加 `ACP_GUI_INTERACTIONS=1` 验证真实权限/问答，`ACP_GUI_RECOVERY=1` 验证真实分支与重启，`ACP_GUI_IMAGES=1` 验证多图及能力阻止，`ACP_GUI_GROUP=1` 验证三家 ACP 与真实 Codex 混合群聊。后两种混合群聊脚本读取当前 Codex 身份，复制到测试专用 HOME，结束后删除测试副本；不改变当前 Codex 模型或思考档。

证据写入 `artifacts/acp`。脚本结果中的 `passed` 与实际命令退出码一起判定；旧失败证据保留用于追溯，不能被新结果改称通过。最终验收矩阵与候选 SHA 见任务目录的实现手册。

确定性渲染性能另用 `node tests/e2e-acp-event-performance-cdp.js`：真实隔离 Hub、fixture ACP 事件、三轮相同回放；脚本通过真实“展开全文”按钮观察完整消息。该测试排除了模型和网络耗时。Main 的历史写入开销由 `node tests/acp-event-performance.js` 单独记录，不能拿它代替界面延迟。

回退时停止新建 ACP 会话即可，保留原生 ID 与历史。现有 Codex、Claude 和 DeepSeek API 入口继续独立工作；不要把 ACP 历史重标成其他后端，也不要为回退重启生产 Hub。
