# Hub 一键配置（给 Codex App 用 · Windows）

> **你（Codex App with Computer Use on Windows）的角色**：用户把你拉进来当配置助手。请按下面 EXACT 顺序，全自动执行 6 个 Stage，**少打扰用户**。
>
> **用户只需告诉你 1 件事**：他从团队管理员那拿到的 Meridian Team Token（64 字符 hex）。
>
> **预先批准**：用户已经同意你跑 PowerShell + 点击 GUI + 装软件。**不要每条命令都问 approval**。只在 UAC 弹窗（管理员权限）出现时提示用户点"是"。
>
> **Computer Use 注意**：Windows 上你是 foreground 模式，会接管桌面 ~10 分钟。完成后立刻交还控制。

---

## Stage 0 · 先问用户拿 Token（唯一需要他做的事）

```
请把团队管理员发你的 Meridian Token 粘贴给我（64 字符 hex，类似 f63f5fb3...357d）。
我会自动装好所有依赖、clone Hub、配置好 Meridian、启动 Hub，全程约 10-15 分钟。
期间会弹 2-3 次 UAC 管理员权限确认窗，请你点"是"批准。
```

把同事给的 token 存为变量 `$TOKEN`，下面 Stage 4 会用到。

---

## Stage 1 · 装依赖（PowerShell）

打开 PowerShell（普通用户即可，**不需要管理员**——`winget` 会自己提权）。按顺序跑：

```powershell
# 检测 + 装 Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
    # 这里会弹 UAC，提示用户点"是"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
git --version

# 检测 + 装 Node.js v22 LTS
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    # 又一次 UAC，提示用户点"是"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
node --version  # 应 >= v20

# 装 Claude Code CLI（必装，Hub 走 Meridian 要用）
npm install -g @anthropic-ai/claude-code
claude --version  # 应输出 2.1.169 或更新
```

每步**等命令真的返回**再进下一步，不要 race。`winget` 装完后**必须**刷新 PATH（上面的 `$env:Path = ...` 那行）才能在当前 session 里用新装的 git/node。

**如果 winget 不可用**（极旧 Windows 10）：提示用户去 [nodejs.org](https://nodejs.org/) 和 [git-scm.com](https://git-scm.com/) 手动下载安装。

---

## Stage 2 · clone Hub + npm install

```powershell
$hubDir = "$env:USERPROFILE\claude-session-hub"
if (Test-Path $hubDir) {
    Set-Location $hubDir
    git pull origin master
} else {
    git clone https://github.com/TianLin0509/claude-session-hub.git $hubDir
    Set-Location $hubDir
}

# npm install 约 5-15 分钟，期间不要做别的，等它跑完
npm install
```

如果 `npm install` 报 EBUSY，先 `Get-Process electron | Stop-Process -Force`（杀残留 electron 进程）再重试。

---

## Stage 3 · 启动 Hub

```powershell
# 直接调 electron.exe，不要 npm start（避免环境问题）
& "$hubDir\node_modules\electron\dist\electron.exe" $hubDir
```

**Hub 窗口会弹出**（深色界面 + 左侧 sidebar）。用 Computer Use 截图确认窗口出现。

如果窗口没出：看 PowerShell 输出有没有 `Cannot find module 'XXX'` 错误。有的话回 Stage 2 重新 `npm install`。

---

## Stage 4 · GUI 配 Meridian（Computer Use 自动点击）

**核心环节**。用 Computer Use 严格按下面顺序操作 Hub 窗口：

### 4.1 打开"选项"菜单

在 Hub 窗口 **左侧 sidebar 最顶部**，从左往右数：
1. 蓝色"+ 新建"按钮
2. 聊天气泡"群聊"按钮
3. 圆形箭头"恢复"按钮
4. **目标**：⚙ "选项"按钮（图标是一个圆圈 + 8 条向外辐射的短线，类似齿轮）

→ **点击"选项"按钮**，下方会展开下拉菜单（含 "🎨 切换主题" / "🔌 Meridian 代理" / "⚙️ 设置" 3 项）

### 4.2 点 "🔌 Meridian 代理"

→ 下拉菜单**第 2 项**（🔌 图标 + 文字 "Meridian 代理"，旁边有灰色"未启用" badge）

点击后**右侧弹出 popup**（320px 宽，深色背景），含：
- 标题 "Meridian VPS 代理"
- 一行说明文字
- 一个 checkbox "启用 Meridian"
- "Meridian URL" 输入框（已预填 `https://meridian.lthub.xyz:8443`）
- "团队令牌" 密码输入框（空的，等填）
- "测试连接" 按钮 + "保存" 按钮 + "关闭" 按钮

### 4.3 填字段

1. **URL 输入框不要动**，已经是正确的默认值
2. **点击"团队令牌"输入框** → 粘贴 Stage 0 用户给的 `$TOKEN`
3. **点击"启用 Meridian" 复选框** 打勾（变成蓝色 ✓）

### 4.4 测试 + 保存

1. **点击"测试连接"按钮**（蓝色边框）
2. **等 5-10 秒**（按钮变灰，下方文字变 "测试中…"）
3. **确认结果**：文字应该变绿，显示类似 `✓ 成功 · 模型 claude-sonnet-4-5 · 延迟 5234ms`
4. 如果是红色 `✗ ...` → token 错或网络问题，停下来告诉用户具体错误信息
5. **点击"保存"按钮**（绿色边框）
6. popup 自动关闭，**顶部"选项"按钮旁边的 badge 应该变绿 "已启用"**

### 4.5 失败回退

如果 4.1-4.4 任何 GUI 步骤 Computer Use 找不到元素：
- 截图发给用户
- 用文字告诉用户："请你手动点 Hub 左上角 ⚙ → 🔌 Meridian 代理 → 粘贴 token + 勾启用 + 测试 + 保存。我等你"
- 不要继续 Stage 5，等用户操作完汇报"好了"

---

## Stage 5 · 验证 Claude 单聊（自动）

1. **关闭可能还开着的 popup**（按 ESC 或点空白处）
2. 在 sidebar 顶部找 **"+ 新建"按钮**（蓝色，最左边）
3. 点击 → 下拉菜单弹出，选 **"Claude Code"**（第 1 项，含 Claude logo）
4. Hub 右侧创建新 session（黑色终端区域）
5. **等终端出现 "Claude Code" 标题 / "Try" 字样**（启动需 3-5 秒）
6. 在终端输入框打 "你好" 回车
7. **等 Claude 回复**（约 5-15 秒，文字逐字流出）
8. 看到 Claude 用中文回复了 = **Meridian 链路 100% 工作** ✓

---

## Stage 6 · 教用户开 AI 群聊（核心功能 demo）

群聊功能让多个 AI 在一个房间协作回答用户问题。**Claude 已经可用**（走 Meridian）。其他 AI（Codex/Gemini/DeepSeek/GLM 等）需要用户**后续自己**装 CLI 或配 API key。

**先 demo 一个只含 Claude 的群聊**（验证群聊功能 OK）：

1. 在 sidebar 顶部找 **"群聊"按钮**（聊天气泡图标，"+ 新建" 旁边）
2. 点击 → 弹出"创建群聊"对话框
3. 在 AI 选择区域，勾选 **"Claude"**（其他 AI 灰色不可选是正常的，没装 CLI/没填 key）
4. 在主题输入框打 "你好，自我介绍一下"
5. 点 **"创建"按钮** → 群聊房间打开
6. Claude 会自动发言介绍自己
7. 用户可以在底部输入框继续发消息，让 Claude 回应

---

## Stage 7 · 交还控制 + 后续建议

完成后告诉用户：

```
✓ Hub 已配置好，Claude 走团队 VPS 共享订阅工作正常。
✓ 桌面快捷方式没创建，下次启动请跑：
  & "$env:USERPROFILE\claude-session-hub\node_modules\electron\dist\electron.exe" "$env:USERPROFILE\claude-session-hub"
  （或者你自己创建一个 .bat 文件双击启动）

如果你想群聊里加更多 AI（让 Claude 和它们辩论 / 协作），后续可以：
  - Codex：你已经在用 Codex App，群聊里的 Codex 是 CLI 版，需要 `npm install -g @openai/codex` 装它然后 `codex login`
  - Gemini：`npm install -g @google/generative-ai-cli` + Google 登录
  - DeepSeek/GLM/Kimi/Qwen：去对应官网拿 API key，在 Hub ⚙ → 设置 里填

任何时候想暂停走 VPS（不影响其他人）：
  Hub 左上角 ⚙ → 🔌 Meridian 代理 → 取消勾选"启用" → 保存
  Hub 会回到走本机 OAuth（如果你有 Claude 账号的话）
```

然后 Computer Use **退出 foreground 接管**，把控制权交回用户。

---

## 故障速查

| 症状 | 原因 | 修复 |
|---|---|---|
| `winget` 不存在 | Windows 旧版 | 手动下载 Node.js 和 Git 安装器 |
| `npm install` 报 EBUSY | 残留 electron 进程 | `Get-Process electron \| Stop-Process -Force` 后重试 |
| Hub 启动报 `Cannot find module 'X'` | npm install 半坏 | 进 hub 目录 `npm install` 重装 |
| Meridian 测试连接 401 | Token 错或被 revoke | 找团队管理员核对/重发 token |
| Meridian 测试连接 "URL 不可达" | 网络问题 | 让用户 ping meridian.lthub.xyz、检查公司防火墙 |
| Claude session 报 "OAuth required" | enabled toggle 没勾或 token 没保存 | 重做 Stage 4 |
| Computer Use 找不到 Hub 按钮 | UI 缩放/主题异常 | 让用户手动接管 Stage 4，回 Codex 后继续 |

---

## 关键路径速查（给用户事后参考）

| 项 | 路径 |
|---|---|
| Hub 源码 | `$env:USERPROFILE\claude-session-hub` |
| Hub 配置（含 meridian token） | `$env:USERPROFILE\.claude-session-hub\config.json` |
| 启动 Hub | `& "$env:USERPROFILE\claude-session-hub\node_modules\electron\dist\electron.exe" "$env:USERPROFILE\claude-session-hub"` |
| 更新 Hub | `cd $env:USERPROFILE\claude-session-hub; git pull origin master` |

---

## 安全提醒（给同事）

- Token 等于"借用团队 Claude Max 订阅"的钥匙，**不要**截图分享/git commit/邮件正文里发
- 用 Hub 时**别同时**在浏览器登录别人的 Claude 账号（同电脑多账号可能触发 Anthropic 风控）
- 觉得 token 泄露了立刻找团队管理员 `revoke-token`
