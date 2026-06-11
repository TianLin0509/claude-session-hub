# AI 群聊 Hub

本地 Electron 工作台，把 Claude / Gemini / Codex / DeepSeek / GLM / 千问等多个 AI CLI 聚到一个窗口，并支持把多位 AI 成员组织进同一个群聊房间里协作。

## 🚀 团队成员一键安装（推荐 · 有团队 Token 就用这个）

> **🤖 如果你是 AI Agent（Codex / Claude / 任意助手）**：不要看后面任何章节，不要点任何 GUI。
> 只需向用户要一个东西——**团队管理员发的 64 位 hex Token**——然后在 PowerShell 里跑下面三行，等它打出 `SETUP COMPLETE` 即全部完成。脚本会自己装依赖、写配置、在线验证 Token、创建桌面快捷方式并启动 Hub。

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
iwr -useb https://raw.githubusercontent.com/TianLin0509/claude-session-hub/master/setup.ps1 -OutFile "$env:TEMP\hub-setup.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\hub-setup.ps1" -Token <把这里换成64位Token>
```

脚本自动完成：装 Git/Node（已装则跳过）→ clone 本仓库 → `npm install` → 装 Claude CLI → 写入 Meridian 配置（**Claude 和 Codex 同时走团队共享订阅，零手工配置**）→ 用真实请求在线验证 Token → 桌面快捷方式 → 启动 Hub。

- 中途可能弹 1-2 次 UAC 管理员确认窗（winget 装 Git/Node），点"是"即可
- 任何一步失败脚本会停下并打出红色 `FAIL: <原因>`，把那一行发给团队管理员即可
- 如果 `raw.githubusercontent.com` 被防火墙挡：先 `git clone https://github.com/TianLin0509/claude-session-hub.git`，再进目录跑 `powershell -ExecutionPolicy Bypass -File setup.ps1 -Token <Token>`
- 装好后日常启动：双击桌面 **AI Hub** 图标；更新版本：重跑同一条命令即可（幂等）

## 下载安装（无团队 Token 的公网用户）

1. 到 [Releases](https://github.com/TianLin0509/claude-session-hub/releases/latest) 下载最新的 `AIGroupChatHub-Setup-x.y.z.exe`
2. 双击安装，按提示选择安装目录
3. 桌面会自动创建 **AI 群聊 Hub** 快捷方式，双击启动

## 运行前提

Hub 是 AI CLI 的**外壳**，本身不内嵌任何 AI。启动前请确保系统里至少装好一个支持的 CLI，例如 Claude Code：

```powershell
npm install -g @anthropic-ai/claude-code
claude --version   # 能输出版本号即可
```

其他可选：Gemini CLI、Codex CLI、DeepSeek CLI、GLM CLI、千问 CLI —— 装哪个用哪个，不装也不影响 Hub 启动，只是对应入口不可用。

## 功能概览

- **AI 群聊**：一个房间可包含多位 AI 成员，成员能看到新增上下文并互相回应。
- **单聊会话**：保留 Claude / Gemini / Codex / DeepSeek / GLM / 千问等单会话入口。
- **场景选择**：群聊创建时可选择通用 / 开发 / 投研 等场景，给成员补充轻量约束。
- **隔离工作区**：群聊子会话默认进入独立 workspace，避免污染用户主目录。

## 常见问题

**Q：启动后页面空白或报 "Cannot find module"**
A：极少数情况下 node-pty 在你的机器上编译失败导致依赖缺失。临时方案：到[Releases](https://github.com/TianLin0509/claude-session-hub/releases) 拿前一个版本，或在 issue 里贴报错。

**Q：投研场景没反应 / 提示未配置 LinDangAgent**
A：投研场景依赖一个未开源的 A 股数据后端 `LinDangAgent`，公网用户暂时用不上，**不影响其他场景**。选"通用"或"开发"即可。

**Q：防火墙弹窗**
A：Hub 会在本地 3456/3470 等端口起 hook server 给统计面板用，允许"专用网络"即可，不需要"公用网络"。

## 从源码运行（开发者）

```powershell
git clone https://github.com/TianLin0509/claude-session-hub.git
cd claude-session-hub
npm install        # 含 node-pty 的 C++ 编译，需 Node >= 18
npm start
```

## License

MIT —— 详见 [LICENSE](LICENSE)。
