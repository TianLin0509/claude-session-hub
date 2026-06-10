# Meridian VPS 代理快速配置（给 Codex 看的执行指南）

> **你（Codex）的任务**：帮当前用户在本机 Windows 11 上装 Claude Session Hub，并配置好 Meridian VPS 代理走团队共享 Claude Max 订阅。
> **不要询问用户每一步细节**，按下面 EXACT 顺序执行，遇到错误时再问。
> **用户只需要给你一件事**：他从团队管理员那拿到的 64 字符 hex Token（管理员可能用 `issue-token.sh <name>` 生成发给他）。

## 前置（如已满足跳过）

- Windows 11, PowerShell 5.1+
- Node.js v20 或 v22 (检查 `node -v`，没装就 `winget install OpenJS.NodeJS.LTS`)
- Git for Windows (检查 `git --version`)

## 1 步装 Hub

```powershell
# 安装路径建议（用户没指定就用这个）
$target = "$env:USERPROFILE\claude-session-hub"

# clone（如已存在就 pull）
if (Test-Path $target) {
  Push-Location $target
  git pull origin master
  Pop-Location
} else {
  git clone https://github.com/TianLin0509/claude-session-hub.git $target
}

# install
cd $target
npm install
```

npm install 约 5-15 分钟。**如遇 EBUSY 错误**，确保没有 electron.exe 进程在跑（`Get-Process electron`），杀掉后重试。

## 2 步启动 Hub（smoke test）

```powershell
# 直接启动 Hub（不要用 npm start，可能报错）
& "$target\node_modules\electron\dist\electron.exe" $target
```

应看到 Hub 窗口打开。看到 `[hub-control] control file written` 在日志里 = 启动成功。

## 3 步配置 Meridian（关键）

**首选方式：左上角快捷入口**

1. Hub 窗口顶部左侧，找 ⚙️ "选项" 图标按钮（圆圈+辐射图标）
2. 点开 → 弹出菜单选 "🔌 Meridian 代理"
3. popup 弹出，做以下事：
   - **Meridian URL**：默认已填 `https://meridian.lthub.xyz:8443`，**不要改**
   - **团队令牌**：粘贴用户给你的 64 字符 hex Token
   - **勾选** "✅ 启用 Meridian"
   - 点 "测试连接" 按钮，**等 5-10 秒**
   - 应该看到绿色 `✓ 成功 · 模型 claude-sonnet-4-5 · 延迟 XXXms`
4. 点 "保存" 按钮，popup 自动关闭
5. 看左上角顶栏 badge 应该显示 "已启用"（绿色）

## 4 步验证

```powershell
# 检查 config.json 写入正确
$cfg = Get-Content "$env:USERPROFILE\.claude-session-hub\config.json" | ConvertFrom-Json
$cfg.providers.meridian
# 应该输出含 url / token / enabled: true
```

在 Hub UI 里：
1. 点 "+ 新建" → 选 "Claude Code"
2. 启动 Claude session
3. 输入 "hi" 回车
4. **预期**：正常返回 Claude 的问候
5. **如果报 OAuth 错** → meridian 配置没生效，检查上面步骤

## 故障排查

| 症状 | 原因 | 修复 |
|---|---|---|
| Hub 启动报 `Cannot find module 'X'` | npm install 半坏 | `cd $target; npm install` 重新装 |
| 测试连接 "URL 不可达" | 用户网络访问不了 VPS | 让用户 ping meridian.lthub.xyz、telnet :8443 |
| 测试连接 "Token 鉴权失败 401" | Token 错或已被管理员 revoke | 找管理员确认/重发 Token |
| Claude session 报 "OAuth required" | enabled toggle 没勾 / token 没保存 | 重新打开 popup 确认勾选 + 保存 |
| 启动 Hub 报防火墙警告 | Windows Defender SmartScreen | 允许通过 |

## 关键文件位置

| 文件 | 路径 | 用途 |
|---|---|---|
| Hub 源码 | `$env:USERPROFILE\claude-session-hub` | clone 目录 |
| Hub 配置 | `$env:USERPROFILE\.claude-session-hub\config.json` | meridian url/token/enabled 持久化在这 |
| 启动入口 | `$target\node_modules\electron\dist\electron.exe $target` | 直接调 electron 不要用 npx |

## 用户偏好提醒

- **不要把 Token 写进 git/聊天/截图分享** —— Token 等同于团队 Max 订阅访问凭据
- 想暂停 Meridian → 打开 popup 取消勾选 "启用 Meridian" 保存即可（Token 留着，下次直接勾启用）
- 想完全清掉 → popup 里 Token 输入框 → 全选删 → 保存

## 同事/管理员侧（不是 Codex 任务）

如果你（管理员）需要给新同事开 token：
```bash
ssh root@138.128.192.245 "/root/bin/issue-token.sh alice"
# 输出 token，把 token 通过安全渠道发给 alice
```

revoke：
```bash
ssh root@138.128.192.245 "/root/bin/revoke-token.sh alice"
```
