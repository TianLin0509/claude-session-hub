# AI 群聊 Hub

本地 Electron 工作台，把 Claude / Gemini / Codex / DeepSeek / GLM / 千问等多个 AI CLI 聚到一个窗口，并支持把多位 AI 成员组织进同一个群聊房间里协作。

## 🚀 团队成员一键安装（推荐 · 有团队 Token 就用这个）

挑一条最顺手的，三选一，都装到同一个可用状态：

### 方式 A · 双击安装（最省心，不碰命令行）

1. 下载这两个文件到同一个文件夹（或直接 `git clone` 本仓库）：[`install-hub.bat`](./install-hub.bat) 和 [`setup.ps1`](./setup.ps1)（`install-hub.bat` 找不到 `setup.ps1` 时会自己联网下载，所以只下 `.bat` 也行）
2. **双击 `install-hub.bat`**
3. 弹出输入框 → 粘贴团队管理员发的 **64 位 Token** → 确定
4. 全自动装完，看到绿色 `安装结束：成功` 即可。中途可能弹 1-2 次 UAC 窗，点"是"

### 方式 B · 让 AI Agent 代办（你什么都不用做）

把这句话发给你的 Codex / Claude / 任意助手即可：

> 帮我装一个工具。仓库 https://github.com/TianLin0509/claude-session-hub ，按它 README 的"团队成员一键安装"章节操作，跑到打印 `SETUP COMPLETE` 为止。我的团队 Token 是 `<把这里换成64位Token>`，中途弹 UAC 窗我会点"是"。

> **🤖 Agent 注意**：不要点任何 GUI，直接用下面方式 C 的命令。看到红色 `FAIL: <原因>` 就停下并把那行报给用户，不要瞎试。

### 方式 C · 一条命令（适合自己跑或 Agent 执行）

下面这段会**优先从 Gitee 拉脚本（国内/公司内网友好）、失败自动回退 GitHub**：

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$dst = "$env:TEMP\hub-setup.ps1"
foreach ($s in @(
  'https://gitee.com/lt17210720082/claude-session-hub/raw/master/setup.ps1',
  'https://raw.githubusercontent.com/TianLin0509/claude-session-hub/master/setup.ps1')) {
  try { iwr -useb $s -OutFile $dst; break } catch {}
}
powershell -ExecutionPolicy Bypass -File $dst -Token <把这里换成64位Token>
```

脚本自动完成：装 Git/Node（已装则跳过）→ **clone 本仓库（Gitee 优先，GitHub 兜底）** → `npm install` → 装 Claude CLI → 写入 Meridian 配置（**Claude 和 Codex 同时走团队共享订阅，零手工配置**）→ 用真实请求在线验证 Token → 桌面快捷方式 → 启动 Hub。

- 中途可能弹 1-2 次 UAC 管理员确认窗（winget 装 Git/Node），点"是"即可
- 任何一步失败脚本会停下并打出红色 `FAIL: <原因>`，把那一行发给团队管理员即可
- 镜像仓库：GitHub `https://github.com/TianLin0509/claude-session-hub` · Gitee `https://gitee.com/lt17210720082/claude-session-hub`（管理员双推保持一致，两者代码同步）
- 装好后日常启动：双击桌面 **AI Hub** 图标；更新版本：重跑同一条命令即可（幂等）

### 方式 D · 离线源安装（公司网封 git / 连不上 GitHub 时）

如果 `git clone` 通不了（公司代理常允许浏览器访问但封 git 协议），改用"先下整包、再离线装"：

1. 用浏览器下载**完整源码 zip**（任选其一，都行）：
   - GitHub：仓库页绿色 **Code → Download ZIP**，或任一 Release 的 **Source code (zip)**
   - Gitee：`https://gitee.com/lt17210720082/claude-session-hub` → **克隆/下载 → 下载ZIP**
2. 解压到一个**你会长期保留的文件夹**（别放临时目录/下载文件夹，装好后 Hub 就住在这）
3. 进解压出来的文件夹，**双击 `install-hub.bat`** → 弹框粘 Token → 确定

`setup.ps1` 会**自动识别自己就在源码里 → 跳过 git clone、直接用本地文件**装，全程不碰 GitHub。
（仍需要能访问 npm 源装依赖 + 能连 Meridian VPS 验证 Token，这两个都是下行，一般没问题。）

> 命令行等价写法（在解压文件夹里）：`powershell -ExecutionPolicy Bypass -File setup.ps1 -Token <Token>`

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
