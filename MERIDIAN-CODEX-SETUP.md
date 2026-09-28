# Hub 一键安装 SOP（给 AI Agent 用 · Windows）

> 文件名是历史遗留（早期只有 Meridian 网关一条路）。现在这就是**通用安装 SOP**：
> 团队网关是可选项，没有网关也照常装完。
>
> **你（Codex / Claude / 任意 AI 助手）的角色**：用户拉你来当配置助手。
> **整个安装只有一条命令**，不需要点任何 GUI，不需要 Computer Use 找按钮。

---

## 第 1 步 · 问清楚有没有 Token

对用户说：

```
管理员有没有发你一个 64 位的团队 Token？
有就发我，Claude 和 Codex 直接走团队网关；
没有也能装，装完你在 Hub 里登录自己的 Claude / Codex 账号就行。
我跑一条命令，约 5-15 分钟，期间可能弹 1-2 次 UAC 窗请你点"是"。
```

用户说不清楚就按**没有**处理 —— 没 Token 装出来的 Hub 一样完整，Token 随时可以后补
（重跑同一条命令并加上 `-Token` 即可，脚本是幂等的）。

## 第 2 步 · 跑一键脚本（唯一的实际操作）

打开 PowerShell（普通用户即可）：

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
iwr -useb https://raw.githubusercontent.com/TianLin0509/claude-session-hub/master/setup.ps1 -OutFile "$env:TEMP\hub-setup.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\hub-setup.ps1"
```

有 Token 就在最后一行补 `-Token <TOKEN>`。

脚本按顺序自动做完（每步有 `==>` 进度和绿色 `OK:` 确认）：

1. 选模式：有 Token = 团队网关模式；没有 = 自己账号模式
2. 装 Git + Node.js（已装则跳过；winget 装时弹 UAC，提醒用户点"是"）
3. clone（或更新）Hub 仓库到 `%USERPROFILE%\claude-session-hub`
   —— **GitHub 优先**，连不上才回退 Gitee 镜像（镜像可能滞后，回退时脚本会黄字提醒）
4. `npm install`（首次 2-15 分钟，耐心等）
5. 装 Claude Code CLI（已装则跳过）
6. 仅网关模式：把 Claude + Codex 的网关配置写进 `~/.claude-session-hub/config.json`
7. 仅网关模式：探测网关和 Token（**只提示不阻断**）
8. 创建桌面快捷方式 **AI Hub** 并启动 Hub

**成功标志**：绿色大字 `SETUP COMPLETE` + Hub 窗口弹出（深色界面 + 左侧功能栏）。
结尾会打印装到的版本号 `v1.6.x`。

**红黄之分（重要）**：

- 红色 `FAIL:` = 装不下去了，脚本已退出。停下，把那一行原样报给用户。
- 黄色 `WARN:` = 提醒，安装继续。**不要因为 WARN 重跑或改参数**。
  最常见的是网关不通。这时 Hub 已经装好了，但 `config.json` 里 Claude / Codex 仍然
  指着网关 —— 光让用户去登录自己的账号没有用，必须先扳回开关。

  **不要自己拼这条命令**：脚本已经打印了一行 `Switch -> ...`（网关失败时在 WARN 里也有），
  里面带着这台机器实际使用的数据目录，直接原样执行。标准安装下等价于：

  ```powershell
  powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\claude-session-hub\setup.ps1" -UseOwnAccount
  ```

  脚本结尾的 **Data** 和 **Accounts** 那几行是从实际使用的目录 / `config.json` 读回来的
  真实状态，以它们为准，不要按"用户有没有给 Token"来推断。若 Accounts 显示
  `UNKNOWN - ...`，说明配置文件读不了，按那条错误信息处理，别当成"走自己账号"。

**失败处理**：

| FAIL 内容 | 含义 | 处理 |
|---|---|---|
| `Token must be exactly 64 hex...` | token 复制少/多了字符 | 让用户重新完整复制；或者干脆去掉 `-Token` 先装上 |
| `git clone failed from all mirrors` | 到 GitHub 和 Gitee 都不通 | 见下方"网络受限备选" |
| `npm install failed` + EBUSY | 有残留 Hub 进程锁文件 | 让用户关掉所有 Hub 窗口后重跑脚本 |
| `electron.exe missing` | 依赖装坏了 | 重跑一次脚本即可 |

**网络受限备选**（连不上 raw.githubusercontent.com 时）：

```powershell
git clone https://github.com/TianLin0509/claude-session-hub.git "$env:USERPROFILE\claude-session-hub"
cd "$env:USERPROFILE\claude-session-hub"
powershell -ExecutionPolicy Bypass -File setup.ps1
```

git 也封了，就让用户用浏览器下载仓库 zip，解压后在解压目录里跑 `setup.ps1`（脚本会
自动识别源码在本地，跳过 clone）。

## 第 3 步 · 验证（30 秒）

Hub 窗口出现后，让用户（或你用 Computer Use）：

1. 首页点 **「新建普通会话」** 卡片
2. 选 **Claude Code**，工作目录选 **「临时目录」**（一次性目录，不污染任何项目）
3. 点 **创建会话**，等右侧终端出现 Claude Code 界面（3-5 秒）
4. 输入"你好"回车 → 看到中文流式回复 = **通了 ✓**

**自己账号模式**下，这一步 CLI 会要求登录：Claude Code 在会话里输入 `/login` 按提示走完即可。

群聊（核心功能）：首页点 **「新建 AI 群聊」** → 勾选 Claude 和 Codex → 选场景
（通用 / 开发 / 投研）→ 创建。两个 AI 会在同一个房间里协作发言。

## 完成后告诉用户

```
✓ 装好了，版本 v1.6.x（Hub 窗口顶部能看到）。日常启动：双击桌面"AI Hub"图标。
✓ 先读一遍 %USERPROFILE%\claude-session-hub\docs\team-onboarding.md，
  里面有 5 分钟上手（怎么开第一个群聊）和报问题的格式。
✓ 以后更新版本：重跑安装那条命令即可（幂等，不会弄坏现有配置）。
✓ 有 Token 的话：Token 是借用团队订阅的钥匙，不要截图/转发/提交进 git，
  怀疑泄露立刻找管理员吊销。
```

---

## 附录 · 关键路径

| 项 | 路径 |
|---|---|
| Hub 源码 | `%USERPROFILE%\claude-session-hub` |
| Hub 配置（网关模式下含 token） | `%USERPROFILE%\.claude-session-hub\config.json` |
| 组员上手文档 | `%USERPROFILE%\claude-session-hub\docs\team-onboarding.md` |
| 启动 | 桌面 `AI Hub.lnk`，或 `& "$env:USERPROFILE\claude-session-hub\node_modules\electron\dist\electron.exe" "$env:USERPROFILE\claude-session-hub"` |
| 更新 | 重跑 setup.ps1（推荐；仅对 git clone 装的有效，ZIP 装的会黄字提示无法更新） |
| 换回自己的账号 | `setup.ps1 -UseOwnAccount`（只改后端开关，保留网关 url/key） |

> **网关配置只由 setup.ps1 写入 config.json，UI 里没有对应入口。**
> 不要去 Hub 菜单里找"Meridian 代理"之类的选项 —— 那是早期版本的入口，已经没有了。
> 要改网关就编辑 `config.json` 的 `providers.claude` / `providers.codex`，或者重跑脚本。
