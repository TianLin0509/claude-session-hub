# AI Hub Community

把你自己的 Claude Code、Codex、Gemini CLI、Kimi 等 AI 放进一个 Windows 桌面工作台：单独对话、多 AI 群聊、开发分工看板、历史检索、文件预览、记忆文件库与能力管理。

这是 AI Hub 的公开发行版，当前 **v0.2.0**，同步自上游 **1.6.257**（具体提交见 `community-edition.json`）。它不附带任何人的账号、聊天记录、私人模块或私人服务。MIT 开源；AI 服务的账号、订阅和用量由你自己提供。

## 一段命令安装（推荐）

Windows 10/11 x64，在 PowerShell 粘贴执行。Hub 自带运行时，**不需要 Node、Git、Python 或管理员权限**：

```powershell
$setup = Join-Path $env:TEMP ('ai-hub-install-' + [guid]::NewGuid() + '.ps1')
Invoke-WebRequest -UseBasicParsing 'https://github.com/TianLin0509/ai-hub-community/releases/download/v0.2.0/install-release.ps1' -OutFile $setup
powershell -NoProfile -ExecutionPolicy Bypass -File $setup -Version v0.2.0
```

脚本下载并校验便携 ZIP，按版本安装、创建桌面入口并启动。重复执行会复用已验证的版本，旧版本和用户数据都保留。电脑上还没有 AI CLI 时，在最后一行加 `-Provider codex` 或 `-Provider claude`，脚本会调用官方原生安装器；已有 CLI 不会重复安装。**登录授权和模型使用权仍由你本人提供。**

窗口标题会显示 `AI Hub Community v0.2.0（上游 1.6.257）`，报告问题时请带上这一行。

## 让 AI 助手帮你装

把这段话发给你的 AI 编码助手：

> 请安装 https://github.com/TianLin0509/ai-hub-community 的 v0.2.0。先读 AGENTS.md 和 docs/AGENT-QUICKSTART.md，走免 Node/Git/Python 的便携安装路线，校验下载并保留本机已有的 Hub 和 CLI。复用已有 CLI，缺少时按我的选择补装。打开官方登录让我本人授权，不读取或索取密钥。确认首次消息、群聊和重启恢复，报告实际验证结果。

完整 [Agent 安装手册](docs/AGENT-QUICKSTART.md) · [公司定制指南](docs/CUSTOMIZE.md) · [架构与复用地图](docs/ARCHITECTURE.md)。安装包的 `resources/guides` 里也有这些说明，离线可读。

## 从源码安装 / 开发

需要 Windows 10/11 x64 和 Node.js 22 以上的 LTS 版本，不需要管理员权限。

```powershell
git clone https://github.com/TianLin0509/ai-hub-community.git
cd ai-hub-community
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Launch
```

没有 Git 时，在仓库页面选 Code → Download ZIP，解压到自己的目录，双击 `install.bat`。

## 第一次打开

首页会检测本机装了哪些 AI CLI，点「登录 / 检查账号」进入账号中心。已有的 CLI 登录可以直接复用；首次授权在提供方自己的官方窗口里完成。**装了 CLI 不等于已登录，已登录也不等于有模型权限或额度。**

## 包含的功能

- Claude / Codex 在真实终端（PTY）里运行，卡片视图与终端视图可切换；停止、审批、恢复、分支会话与会话独占。
- 多 AI 群聊：通用讨论、开发分工、文件工作流和开发看板。
- 本地历史检索（昨日之我）、文件预览与文件管理、工作区、记忆文件库和按需造梦。
- 账号中心、模型与思考档位、能力（MCP / 技能 / 插件）管理、可选 API 接入。

## Hub 会改动你电脑上的哪些配置

为了知道每个 AI 何时开始、何时完成，Hub 需要在 CLI 自己的配置里登记状态回报（hook）。社区版的 hook 由系统自带的 Windows PowerShell 执行，只在 Hub 启动的会话里生效；你在终端里单独运行的 CLI 不受影响。

| 位置 | 写入内容 |
|---|---|
| `~/.claude/settings.json` | Hub 的 hook 条目；没有状态栏时补一个静默状态栏。**不改你的全局权限模式** |
| `~/.claude/scripts/` | hook 转发脚本 |
| `~/.codex/hooks.json`、`~/.codex/config.toml` | Hub 的 hook 条目与对应的信任记录；缺少时补一行上下文余量状态栏设置 |
| `~/.codex/hub-scripts/` | hook 转发脚本 |

其余数据都在 `%USERPROFILE%\.ai-hub-community`。Hub 启动的 Claude 会话使用 `--permission-mode bypassPermissions`，Codex 会话使用 Codex 的免确认模式，AI 可以直接修改工作目录里的文件并运行命令，请只在你愿意交给 AI 的目录里使用。详见 [PRIVACY.md](PRIVACY.md) 与 [INSTALL.md](INSTALL.md)。

## 开发与检查

```powershell
node scripts/doctor.js
npm test
node scripts/audit-public.js
node tests/e2e-community-cdp.js
```

安装说明：[INSTALL.md](INSTALL.md) · Agent 手册：[AGENTS.md](AGENTS.md) · 数据边界：[PRIVACY.md](PRIVACY.md) · 验证记录：[VALIDATION.md](docs/VALIDATION.md)
