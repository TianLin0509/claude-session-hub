# Hub 一键配置指南（给 AI Agent 用 · Windows）

> **你（Codex App / Claude / 任意 AI 助手）的角色**：用户拉你来当配置助手。
> **整个安装只有一条命令**，不需要点任何 GUI，不需要 Computer Use 找按钮。
> 用户唯一要给你的东西：团队管理员发的 **Meridian Token**（64 位 hex 字符串）。

---

## 第 1 步 · 向用户要 Token

对用户说：

```
请把团队管理员发你的 Meridian Token 粘贴给我（64 位 hex，类似 f63f5fb3...357d）。
我跑一条命令就能装好全部，约 5-15 分钟，期间可能弹 1-2 次 UAC 窗请你点"是"。
```

## 第 2 步 · 跑一键脚本（唯一的实际操作）

打开 PowerShell（普通用户即可），把 `<TOKEN>` 换成用户给的 token，跑：

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
iwr -useb https://raw.githubusercontent.com/TianLin0509/claude-session-hub/master/setup.ps1 -OutFile "$env:TEMP\hub-setup.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\hub-setup.ps1" -Token <TOKEN>
```

脚本按顺序自动做完（每步有 `==>` 进度和绿色 `OK:` 确认）：

1. 装 Git + Node.js（已装则跳过；winget 装时弹 UAC，提醒用户点"是"）
2. clone（或更新）Hub 仓库到 `%USERPROFILE%\claude-session-hub`
3. `npm install`（首次 2-15 分钟，耐心等）
4. 装 Claude Code CLI（已装则跳过）
5. 写入 Meridian 配置 —— **Claude 走团队 Max 订阅 + Codex 自动联动走团队 ChatGPT Pro（gpt-5.5），两个都零手工配置**
6. **在线验证**：真实调一次 Meridian 端点确认 token 有效
7. 创建桌面快捷方式 **AI Hub** 并启动 Hub

**成功标志**：绿色大字 `SETUP COMPLETE` + Hub 窗口弹出（深色界面 + 左侧 sidebar）。

**失败处理**：脚本会在出错处停下并打红色 `FAIL: <原因>`。常见情况：

| FAIL 内容 | 含义 | 处理 |
|---|---|---|
| `Token must be exactly 64 hex...` | token 复制少/多了字符 | 让用户重新完整复制 |
| `git clone/pull failed` | 到 github.com 的网络不通 | 见下方"网络受限备选" |
| `cannot reach https://meridian...` | 到 VPS 的网络/防火墙问题 | 把这行发给团队管理员 |
| `token REJECTED (HTTP 401)` | token 错误或已被吊销 | 找团队管理员核对/重发 |
| `npm install failed` + EBUSY | 有残留 Hub 进程锁文件 | `Get-Process electron \| Stop-Process -Force` 后重跑脚本 |

**网络受限备选**（raw.githubusercontent.com 被挡时）：

```powershell
git clone https://github.com/TianLin0509/claude-session-hub.git "$env:USERPROFILE\claude-session-hub"
cd "$env:USERPROFILE\claude-session-hub"
powershell -ExecutionPolicy Bypass -File setup.ps1 -Token <TOKEN>
```

## 第 3 步 · 验证对话（30 秒）

Hub 窗口出现后，让用户（或你用 Computer Use）：

1. 点 sidebar 顶部蓝色 **"+ 新建"** → 选 **"Claude Code"**
2. 等右侧终端出现 Claude Code 标题（3-5 秒）
3. 输入"你好"回车 → 看到中文流式回复 = **全部成功 ✓**

群聊（核心功能）：点 sidebar 顶部 **"群聊"** 按钮 → 勾选 **Claude** 和 **Codex**（都已走团队订阅）→ 输入主题 → 创建。两个 AI 会自动协作发言。

## 完成后告诉用户

```
✓ 全部装好。日常启动：双击桌面"AI Hub"图标。
✓ Claude 和 Codex 都走团队共享订阅，不需要注册任何账号。
✓ 以后更新版本：重跑安装时那条命令即可（幂等，不会弄坏现有配置）。
✓ Token 是借用团队订阅的钥匙：不要截图/转发/提交进 git。怀疑泄露立刻找管理员吊销。
```

---

## 附录 · GUI 手动配置（仅当脚本路线完全走不通时）

Hub 内有两个等价入口，填的是同一份配置：

**入口 A**：Hub 左上角齿轮 **⚙ 选项** → 下拉菜单 **🔌 Meridian 代理** → 弹窗里填
Meridian URL（默认 `https://meridian.lthub.xyz:8443` 不用动）+ 团队令牌 → 勾"启用 Meridian" → 测试连接（应变绿 `✓ 成功`）→ 保存。

**入口 B**：⚙ 选项 → **⚙️ 设置** → AI 模型列表点 **Claude** 行进详情 → "VPS 代理（可选 · 团队共享）"区域 → 填 URL + 令牌 → 测试 → 保存。

> 注意：菜单里如果没有"🔌 Meridian 代理"这一项，说明代码是旧版——先
> `cd $env:USERPROFILE\claude-session-hub; git pull origin master`，**完全关闭 Hub 再重启**。

## 附录 · 关键路径

| 项 | 路径 |
|---|---|
| Hub 源码 | `%USERPROFILE%\claude-session-hub` |
| Hub 配置（含 token） | `%USERPROFILE%\.claude-session-hub\config.json` |
| 启动 | 桌面 `AI Hub.lnk`，或 `& "$env:USERPROFILE\claude-session-hub\node_modules\electron\dist\electron.exe" "$env:USERPROFILE\claude-session-hub"` |
| 更新 | 重跑 setup.ps1（推荐），或 `git pull origin master` 后重启 Hub |
