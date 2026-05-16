# Hub 防卡死改造 · Design

**日期**：2026-05-16
**起因**：2026-05-16 用户 Hub PID 81164 被 https URL 预览（`<webview>`）完全 takeover，10+ 种逃生手段全部失效，session 被人质 ~半小时
**复盘 artifact**：`.arena/artifacts/hub-escape-stuck-prevention.html`、`hub-cardblock-root-prevention.html`

## 摘要

为 Hub 加上**三层防御**：

1. **视觉层 · 方向 A** — 预览面板顶部 32px "安全条" 永远可见，✕ 按钮永远在 webview 之外
2. **外部救援层 · P0-①** — hookServer 加 `POST /api/escape-home` HTTP endpoint（token 鉴权，复用现有 hookServer 模式）
3. **永久后门层 · P0-②** — Hub 启动默认开 Chromium CDP 端口（`--remote-debugging-port=0`，端口由 OS 分配）

外加 **per-PID 控制文件** `<dataDir>/control/<pid>.json`（含 hookPort/cdpPort/HOOK_TOKEN/dataDir/pid/startedAt）让外部脚本能发现 token。

辅助 **一键 PowerShell 救援脚本** `tools/hub-escape.ps1` 封装查 control file → curl endpoint → 输出结果。

## 不在范围（明确排除）

- **方向 B**：sidebar 永远保留 40px rail — 用户决定本期不做，单独 PR
- **方向 C**：URL 预览改用 iframe — 副作用大（X-Frame-Options 拒嵌）
- **方向 D**：session 与 UI 解耦 daemon — P2 单独立项，1-2 周工作量
- **方向 ④**：globalShortcut 注册失败可见提示 — P1 之后做
- **session 持久化** — 不做（D 立项时一起考虑）

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│ Hub 进程 (main.js)                                              │
│                                                                 │
│  ① 文件顶层（require 后立刻）：                                │
│     app.commandLine.appendSwitch('remote-debugging-port', '0') │
│     （可通过 env CLAUDE_HUB_NO_CDP=1 跳过）                    │
│                                                                 │
│  ② whenReady() 内、hookServer listen 后：                      │
│     hub-control.writeControlFile({                              │
│       pid, hookPort, cdpPort: readDevToolsActivePort(),         │
│       token: HOOK_TOKEN, dataDir, startedAt                     │
│     })                                                          │
│     hub-control.cleanStale()  // 测活其他 PID                  │
│                                                                 │
│  ③ hookServer 新路由：                                          │
│     POST /api/escape-home                                       │
│       → 检查 parsed.token === HOOK_TOKEN                       │
│       → sendToRenderer('escape-home')                           │
│       → 返回 { ok: true }                                       │
│                                                                 │
│  ④ before-quit：                                                │
│     hub-control.unlinkSelf()                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Renderer (renderer/index.html + styles.css + renderer.js)      │
│                                                                 │
│  方向 A 改动：                                                  │
│  - preview-panel 改 CSS grid layout                            │
│  - preview-header 永远 display: flex（不再被全屏模式 hide）    │
│  - togglePreviewLayout() 只动 body，不动 header                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ 救援链 (外部)                                                   │
│                                                                 │
│  tools/hub-escape.ps1 [pid]                                     │
│    → 默认查 ~/.claude-session-hub/control/                     │
│    → 不带 pid 取最新启动的；带 pid 精确匹配                    │
│    → curl POST http://127.0.0.1:<hookPort>/api/escape-home     │
│    → echo 结果                                                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 组件细节

### 1. `core/hub-control.js`（新增）

**职责**：管理 per-PID 控制文件 + CDP 端口探测。

**导出**：
- `writeControlFile({ pid, hookPort, cdpPort, token, dataDir, startedAt })` — 写到 `<controlDir>/<pid>.json`，原子写（temp 文件 + rename）
- `readDevToolsActivePort(userDataDir, timeoutMs = 3000)` — 轮询 `<userData>/DevToolsActivePort` 第一行（Chromium 写入），超时返回 null
- `cleanStale(controlDir)` — 遍历目录，对每条 `process.kill(pid, 0)` 测活，失败的 `unlinkSync`
- `unlinkSelf(controlDir, pid)` — 删自己的 control 文件

**关键设计**：
- **controlDir = `<dataDir>/control`**（B 方案，跟随 dataDir）。默认 dataDir = `getHubDataDir()` = `~/.claude-session-hub/`
- 启动时 mkdirSync recursive: true
- writeControlFile 失败要 warn 但不阻塞 Hub 启动（控制文件丢失 = 救援不便，但 Hub 还能用）
- cleanStale 失败要 warn 不阻塞
- readDevToolsActivePort 在 Chromium 还没写出文件时轮询 100ms × 30 次

### 2. `main.js` 改动

**位置 a：文件顶层（line 1-50 区间）** — 必须在 `app.whenReady()` 之前 appendSwitch
```
if (process.env.CLAUDE_HUB_NO_CDP !== '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '0');
}
```

**位置 b：hookServer listen 成功后（line ~4675 附近）**
```
hookPort = await listenWithFallback();
if (hookPort) {
  const cdpPort = process.env.CLAUDE_HUB_NO_CDP === '1'
    ? null
    : await hubControl.readDevToolsActivePort(app.getPath('userData'));
  hubControl.cleanStale(controlDir);
  hubControl.writeControlFile({ pid: process.pid, hookPort, cdpPort, token: HOOK_TOKEN, dataDir: getHubDataDir(), startedAt: Date.now() });
}
```

**位置 c：hookServer 路由判断（line ~3878-3900）** — 加 `isEscapeHome` 分支
```
const isEscapeHome = req.method === 'POST' && req.url === '/api/escape-home';
// 加入主 if 判断
if (isEscapeHome) {
  if (parsed.token !== HOOK_TOKEN) { res.writeHead(403); res.end('{}'); return; }
  sendToRenderer('escape-home');
  res.writeHead(200); res.end('{"ok":true}');
  return;
}
```

**位置 d：before-quit handler 末尾（line ~4919）**
```
try { hubControl.unlinkSelf(controlDir, process.pid); } catch {}
```

### 3. `renderer/index.html` + `styles.css` + `renderer.js`（方向 A）

**核心变更**：preview-header 永远可见，即使全屏预览。

`styles.css` 改 `.preview-panel`：
```
.preview-panel {
  flex: 1;
  display: flex;
  flex-direction: column;  /* 不变 */
  background: var(--bg-primary);
  min-width: 0;
}
.preview-header {
  flex: 0 0 32px;  /* 永远 32px 高，不被压扁 */
  /* ... 现有样式保持 ... */
}
.preview-body {
  flex: 1;
  min-height: 0;  /* 关键：允许 webview/iframe 占满剩余空间 */
}
```

`togglePreviewLayout()`（renderer.js line 4420）改动：**不要 hide header**，全屏模式只切换 split / source panel display，header 永远 in。

**调试用 fallback**（万一全屏模式真希望 header 隐起来）：通过 `preview-panel.fullscreen` class 切换 header 透明度而非 display，但**默认全屏模式 header 仍可见**。

### 4. `tools/hub-escape.ps1`（新增）

**职责**：一键救援，封装 control 文件查询 + curl。

**核心逻辑**：
1. 解析参数：`[int]$Pid` 可选、`[string]$DataDir`（默认 `~/.claude-session-hub`）
2. 列 `<DataDir>/control/*.json`；测活 + 选目标 PID（不传则取 `startedAt` 最大）
3. 读 hookPort + token
4. 发送 `Invoke-RestMethod -Uri "http://127.0.0.1:$hookPort/api/escape-home" -Method POST -Body (@{token=$token} | ConvertTo-Json) -ContentType "application/json"`
5. 打印结果

**失败处理**：
- control 文件目录不存在 → 提示用户当前没 Hub 在跑 / 或 dataDir 错
- PID 测活失败 → 提示该 Hub 已退出，跳过
- HTTP 失败 → 打印 status code + body

### 5. `tests/e2e-escape-endpoint.js`（新增）

**职责**：真实 Hub 启动 + control file + HTTP endpoint + CDP 端到端验证。

**步骤**：
1. `launchIsolatedHub({ dataDir, port: <test CDP port> })` 启隔离 Hub
2. 等 control 文件出现在 `<dataDir>/control/<pid>.json`，校验内容（hookPort/cdpPort 非空、token 非空、pid 匹配）
3. 连 CDP → openPreviewPanel("http://example.com") → 校验 preview-header 仍可见（DOM eval `getComputedStyle(headerEl).display === 'flex'`）+ 方向 A 验证
4. curl `POST /api/escape-home` 带 token → 校验返回 200 + preview-panel display:none + sidebar-collapsed:false（escape 完成）
5. 错误 token → 校验 403
6. `gracefulQuit(hub)` → 校验 control 文件被删

## 数据流

### 启动期
```
process.start
  → require / loadModules
  → if !CLAUDE_HUB_NO_CDP: appendSwitch('remote-debugging-port', '0')
  → app.whenReady()
    → createWindow / hookServer listen → hookPort assigned
    → readDevToolsActivePort(userData)  # 等 Chromium 写文件
    → writeControlFile(...)
    → cleanStale(...)
    → showMainWindow()
```

### 救援期
```
PowerShell: hub-escape.ps1 81164
  → Get-Content control/81164.json | ConvertFrom-Json
  → Invoke-RestMethod POST http://127.0.0.1:$hookPort/api/escape-home
                              body { token: ... }
  → main.js hookServer 路由命中
    → sendToRenderer('escape-home')
  → renderer ipcRenderer.on('escape-home') → escapeToHome()
    → closePreviewPanel / clear sessions / expand sidebar
  → 200 { ok: true } 返回
```

### 退出期
```
window-all-closed
  → before-quit
    → 持久化 flush（已有）
    → hubControl.unlinkSelf(...)
  → hookServer.close
  → sessionManager.dispose() → pty.kill
```

## 错误处理

| 失败点 | 处理 |
|---|---|
| `appendSwitch` 失败 | 不可能（同步 API），不处理 |
| `readDevToolsActivePort` 超时（Chromium 没写文件） | 写 control file 时 cdpPort = null。Hub 仍可用，只是没 CDP 后门。warn 日志 |
| `writeControlFile` 失败（磁盘满 / 权限） | warn，不阻塞 Hub 启动 |
| `cleanStale` 失败 | warn，跳过该条 |
| 救援 endpoint 鉴权失败 | 403（与现有 endpoint 一致） |
| 救援 endpoint 时 mainWindow 已销毁 | sendToRenderer 检查 isDestroyed（已有），返回 200 但实际无 effect。**ok 注：endpoint 不知道结果，但救援场景 mainWindow 一定还在** |
| `unlinkSelf` 失败 | warn，下次 cleanStale 兜底 |
| 方向 A：togglePreviewLayout 改动破坏现有布局 | E2E 覆盖（fullscreen / split 两种状态 header 都得可见） |

## 兼容性

- **现有用户**：Hub 启动多约 500ms（等 Chromium 写 DevToolsActivePort），多写一个 ~100B 文件
- **现有热键**：Ctrl+Alt+Home / ESC / 点 `#hub-escape-home` 按钮 全部保留
- **现有 e2e 测试**：`e2e-escape-home.js` 等不受影响（验证的是 renderer 内 escapeToHome 函数，新路径只是再加一个 IPC 触发入口）
- **隔离 Hub**：control 文件跟随 dataDir，与生产隔离不冲突

## 测试策略

### 单元层
- `hub-control.js` 的 `writeControlFile` / `cleanStale` / `readDevToolsActivePort` 用 tmpdir 测

### E2E（必须真实 Hub + CDP，符合 Hub 项目 CLAUDE.md 铁律）
- `tests/e2e-escape-endpoint.js`：新增，覆盖完整救援链路
- `tests/e2e-escape-home.js`（已有）：跑一遍确认方向 A 不破坏现有按钮路径
- 手动 sanity：tools/hub-escape.ps1 在隔离 Hub 上跑一次

## 风险

1. **Chromium DevToolsActivePort 文件路径**：Electron 把 userData 作为 Chromium 的 user-data-dir，文件就在 `<userData>/DevToolsActivePort`。已查 hub-launcher.js 用 `--remote-debugging-port=<port>` 启动 Hub 也是从这里读 `/json/version`，路径假设可靠
2. **多 Hub 启动顺序**：同一秒启动两个 Hub，cleanStale 测活时另一个可能还在 spawn 中（pid kill 0 返回 true 但 control 文件还没写）。**缓解**：cleanStale 跳过 control 文件 mtime < 5 秒的（年轻 Hub 不动）
3. **token 泄漏面**：control 文件包含 token。**缓解**：文件权限锁本机用户（Windows NTFS 默认 = 创建者读写），同机其他用户/容器无权限。token 仍局限于 hookServer 路由——和现有路由风险面一致
4. **方向 A 全屏预览体验**：用户全屏预览时 header 仍占 32px。**预期**：可接受（按"安全条"设计），未来若有 UX 不满可加 hover-only 模式

## 出口标准

- [ ] design spec commit（本文件）
- [ ] implementation plan commit
- [ ] 所有代码改动 commit
- [ ] E2E 测试在隔离 Hub 上通过：control 文件出现/内容正确/CDP 可连/endpoint 200/方向 A header 永远可见/退出后 control 文件被删
- [ ] silent-failure-hunter 审查通过（重点查 hub-control 错误吞掉 + main.js 启动期降级链）
- [ ] post-refactor-verify（≥3 文件改动）
- [ ] hub-escape.ps1 在生产 Hub 实测一次（白手套）
- [ ] CLAUDE.md 加一条铁律："Hub 卡死 → `tools/hub-escape.ps1`"
