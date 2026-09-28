# AI 群聊 Hub

本地 Electron 工作台，把 Claude / Gemini / Codex / DeepSeek / GLM / 千问等多个 AI CLI 聚到一个窗口，并支持把多位 AI 成员组织进同一个群聊房间里协作。

## 🚀 团队成员一键安装（推荐）

挑一条最顺手的，四选一，都装到同一个可用状态。

> **Token 是可选的。** 管理员发了团队 Token 就加上，Claude / Codex 直接走团队网关；
> 没有 Token 也能完整装完，装好后在 Hub 里登录你自己的 Claude / Codex 账号即可。
>
> 装完先读一遍 [组员上手（5 分钟）](docs/team-onboarding.md) —— 怎么开第一个群聊、
> 怎么更新、出问题报哪三样，都在那。

### 方式 A · 双击安装（最省心，不碰命令行）

1. 下载这两个文件到同一个文件夹（或直接 `git clone` 本仓库）：[`install-hub.bat`](./install-hub.bat) 和 [`setup.ps1`](./setup.ps1)（`install-hub.bat` 找不到 `setup.ps1` 时会自己联网下载，所以只下 `.bat` 也行）
2. **双击 `install-hub.bat`**
3. 弹出输入框 → 有 Token 就粘进去；**没有就直接留空点确定**，再点「是」继续
4. 全自动装完，看到绿色 `安装结束：成功` 即可。中途可能弹 1-2 次 UAC 窗，点"是"

### 方式 B · 让 AI Agent 代办（你什么都不用做）

把这句话发给你的 Codex / Claude / 任意助手即可：

> 帮我装一个工具。仓库 https://github.com/TianLin0509/claude-session-hub ，按它 README 的"团队成员一键安装"章节操作，跑到打印 `SETUP COMPLETE` 为止。中途弹 UAC 窗我会点"是"。

（有 Token 就在后面补一句：我的团队 Token 是 `<把这里换成64位Token>`。）

> **🤖 Agent 注意**：不要点任何 GUI，直接用下面方式 C 的命令。看到红色 `FAIL: <原因>` 就停下并把那行报给用户，不要瞎试。黄色 `WARN:` 不是失败，继续跑完。

### 方式 C · 一条命令（适合自己跑或 Agent 执行）

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$dst = "$env:TEMP\hub-setup.ps1"
iwr -useb https://raw.githubusercontent.com/TianLin0509/claude-session-hub/master/setup.ps1 -OutFile $dst
powershell -ExecutionPolicy Bypass -File $dst
```

有团队 Token 就在最后一行加 `-Token <把这里换成64位Token>`。

脚本自动完成：装 Git/Node（已装则跳过）→ **clone 本仓库（GitHub 优先，Gitee 兜底）** → `npm install` → 装 Claude CLI → 有 Token 时写入网关配置（Claude + Codex 都指向团队网关）→ 探测网关 → 桌面快捷方式 → 启动 Hub。

- 中途可能弹 1-2 次 UAC 管理员确认窗（winget 装 Git/Node），点"是"即可
- 红色 `FAIL: <原因>` 才是装不下去了，把那一行发给团队管理员；黄色 `WARN:` 只是提醒，安装会继续
- **网关探测不再阻断安装**：网关挂了或你的网络到不了，Hub 照样装完，改用自己的账号即可
- 镜像仓库：GitHub `https://github.com/TianLin0509/claude-session-hub`（**以这个为准**）· Gitee `https://gitee.com/lt17210720082/claude-session-hub`（镜像，可能滞后，仅在连不上 GitHub 时用）
- 装好后日常启动：双击桌面 **AI Hub** 图标；更新版本：重跑同一条命令即可（幂等）
- 装的是不是最新版，看 Hub 窗口顶部的 `v1.6.x`

### 方式 D · 离线源安装（公司网封 git / 连不上 GitHub 时）

如果 `git clone` 通不了（公司代理常允许浏览器访问但封 git 协议），改用"先下整包、再离线装"：

1. 用浏览器下载**完整源码 zip**：
   - GitHub（优先）：仓库页绿色 **Code → Download ZIP**，或任一 Release 的 **Source code (zip)**
   - Gitee（连不上 GitHub 时）：`https://gitee.com/lt17210720082/claude-session-hub` → **克隆/下载 → 下载ZIP**；这是镜像，可能比 GitHub 旧
2. 解压到一个**你会长期保留的文件夹**（别放临时目录/下载文件夹，装好后 Hub 就住在这）
3. 进解压出来的文件夹，**双击 `install-hub.bat`** → 有 Token 就粘，没有就留空确定

`setup.ps1` 会**自动识别自己就在源码里 → 跳过 git clone、直接用本地文件**装，全程不碰 GitHub。
（仍需要能访问 npm 源装依赖；网关探测失败不影响安装。）

> 命令行等价写法（在解压文件夹里）：`powershell -ExecutionPolicy Bypass -File setup.ps1`（有 Token 就补 `-Token <Token>`）

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
- **英灵议事（本机投研）**：研究群聊的 `@` 菜单可召唤巴菲特/利弗莫尔镜头；所有模型通过共享 MCP 读取同一规则包与哈希，英灵只提供建议、不执行交易。
- **隔离工作区**：群聊子会话默认进入独立 workspace，避免污染用户主目录。

## 准备一个可并行开发的项目

使用“开发”场景前，可用独立维护的 [project-prep skill](https://github.com/TianLin0509/project-prep)
整理业务仓库，生成 Author/Merger 合同、项目配置、Git 钩子和本地合并入口。
支持 Claude Code 与 Codex，安装 skill 不会安装或启动 Hub。

安装方式、可直接发给 Agent 的 prompt 和群聊接入步骤见
[project-prep 接入说明](docs/project-prep.md)。推荐使用固定发布版本，源码由独立仓库维护。

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
