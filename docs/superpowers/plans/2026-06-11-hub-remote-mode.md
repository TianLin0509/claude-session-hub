# Hub 远程模式（公司电脑瘦客户端）实施计划

日期：2026-06-11
状态：**Phase 0 + Phase 1 已完成并 E2E 实测通过**（2026-06-11 16:37，全链路 13s：公司 UI 发 prompt → VPS 中继 → 家里 Hub spawn claude → 回复卡片渲染，截图 `Desktop\claude-artifacts\e2e-remote-mode-success.png`）。Phase 2（终端镜像）待开工。

**E2E 血泪（2026-06-11）**：从 Claude Code 会话里 spawn 测试 Hub 必须先剥离
`CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_*` / `CLAUDE_HUB_PORT|TOKEN|SESSION_ID` env，
否则测试 Hub spawn 的 claude 自认嵌套子会话 → **不落盘 transcript jsonl** → transcript-tap 拿不到
turn 文本 → 手机 PWA / 远程模式永远收不到回复（排查 1.5 小时）。生产 Hub 从桌面启动无此问题。
终极目标：**B 形态**——公司电脑装 Hub 选"远程模式"，操作体验 = 直接坐在家里电脑前用 Hub（完整终端镜像、按键直通、可打断）
交付路径：**C 路线**——先 A 骨架（消息卡片）跑通模式入口/认证/会话管理，再升级 B（终端镜像）

## 背景与已验证事实（2026-06-11 实测）

- 公司电脑性能受限无法跑 Claude Code；Claude Code 始终跑在家里 Hub，VPS 只做哑中继
- **公司网络原生 WSS 出站可用**：PowerShell ClientWebSocket 实测 `State: Open`，与网关日志 `[pwa] device test… connected` 两侧对账成功
- 公司侧 HTTPS（页面 + POST /api/pair 200）全通，经 Cloudflare 边缘
- 浏览器 PWA 的 WSS 被公司代理拦截（原生应用不受影响）——PWA 路线不修，绕开
- 家里 Hub ↔ 网关链路已在生产运行（3 个 Hub 实例在线），但存在 10~30s 一次的 1006 断连抖动（见 Phase 0）

## 架构总图

```
公司 Hub（瘦客户端）          VPS 网关（哑中继）              家里 Hub（执行端）
RemoteSessionManager  --WSS-->  lthub.xyz:8443  <--WSS出站--  hub-bridge + 真 PTY
(device.token 认证)            (nginx + gateway:8765)         (sessionManager)
```

**核心抽象**：公司 Hub 的 main process 实现 `RemoteSessionManager`，对 renderer 暴露与本地 `SessionManager` 同形的接口（`writeToSession` / `onData` 事件 / 会话列表）。renderer 的 xterm 渲染层**零改动**——它只认字节流，不关心来源是本地 PTY 还是 WSS 中继。

## Phase 0：地基修复（0.5~1 天）

远程模式的稳定性前提，必须先做。

1. **修 1006 断连抖动**。已锁定嫌疑：
   - `mobile/vps-gateway/routes/agent.js:88-110`：网关 30s isAlive 检查依赖 **ws 协议层 pong**（`ws.ping()` → `ws.on('pong')`），但家里 Hub 经 Cloudflare 接入，CF 边缘可能不透传协议层 ping/pong → 网关永远收不到 pong
   - `mobile/hub-bridge/outbound-client.js:113`：Hub 侧 30s 发 JSON PONG，与网关 30s 检查相位竞争，赶不上即被 `terminated stale hub ws (no pong)` 踢掉
   - 修复方向：网关 isAlive 改为"**任何入站 JSON message 即续命**"（agent.js L34-35 注释声称如此，需核实实际代码是否真的置位）+ 周期错开（Hub 心跳 15s / 网关宽限 45s）
   - 验收：网关日志连续 30 分钟无 `1006` / `stale terminate`
2. **多 Hub 注册收敛**：当前 3 个本机 Hub 全挂在网关上（User 级 env 导致隔离测试实例也自动连）。改为：`CLAUDE_HUB_DATA_DIR` 隔离实例默认**不**启用 mobile bridge（需显式 opt-in），网关路由从"默认取第一个 Hub"改为显式 hubId 选择
3. **回归**：手机 PWA 现有功能不破坏（mobile-devices.json 兼容、TURN 流正常）

## Phase 1：远程模式骨架 = A 形态（1~2 天）

1. **模式入口**：Hub 设置页新增"远程模式"——开关 + VPS 地址 + PIN 配对流程，device token 存 dataDir（复用 PWA 的 `/api/pair` + `device.<token>` 子协议认证，零网关改动）
2. **main process**：新增 `RemoteHubClient`（协议参考 `mobile/pwa/app.js`，重连/退避骨架参考 `mobile/hub-bridge/outbound-client.js`）：hello/sinceSeq 补帧、list-hubs、list-sessions、new-session、pwa-input 发送、turn 接收
3. **renderer**：远程会话列表 + 消息卡片视图（TURN 结构化流）+ 连接状态四态指示（HUB_OFF/OK/WEAK/VPS_OFF，协议已有）
4. **E2E 验收（真人 UI 操作铁律）**：隔离实例模拟公司 Hub（`CLAUDE_HUB_DATA_DIR` + PID 白名单）→ UI 发 prompt → 家里 Hub spawn claude → 回复卡片渲染。验证断线重连 sinceSeq 不丢消息

## Phase 2：终端镜像 = B 形态（3~5 天）

1. **协议新增帧**（`mobile/shared/protocol.js`）：
   - `PTY_SUBSCRIBE {sessionId, sinceSeq}` / `PTY_UNSUBSCRIBE`
   - `PTY_DATA {sessionId, seq, dataB64}`（家→公司，批量聚合）
   - `PTY_INPUT {sessionId, dataB64}`（公司→家，原始按键直通）
   - `PTY_RESIZE {sessionId, cols, rows}`
2. **家里 hub-bridge 新增 `pty-binder.js`**：tap `sessionManager` 的 `output` 事件（已有全局 seq + ring buffer），订阅制转发；重连时用 ring buffer 按 sinceSeq 补帧；输入直通 `writeToSession` 原始字节（不走 PWA 的 \r 双写逻辑）
3. **公司 Hub `RemoteSessionManager`**：实现与本地 SessionManager 同形接口，xterm 直接渲染远端字节流，按键/Ctrl+C/方向键直通，resize 同步
4. **流控**：PTY_DATA 50~100ms 窗口聚合 + 单帧大小上限；弱网时降级提示（不静默丢帧）
5. **E2E 验收**：公司 Hub 终端里完整操作家里 claude TUI——菜单方向键选择、Ctrl+C 打断、全屏重绘，体感接近本地
6. **安全**：会话级远程可写白名单；device token 撤销入口

## Phase 3：打磨（按需排期）

设备管理 UI（生成 PIN / 撤销设备）、多 Hub 选择器、artifact 预览直通、Web Push 通知、圆桌（meeting）远程视图

## 风险与约束

| 项 | 说明 |
|---|---|
| VPS 资源 | 中继纯消息流量，网关 RSS 仅 19MB，1GB 内存无压力；**严禁在 VPS 上跑 AI 执行** |
| Cloudflare | WS 空闲超时约 100s → 心跳周期必须 < 60s；协议层 ping/pong 不可依赖（Phase 0 修复点） |
| 公司合规 | 链路走个人 VPS + 家里电脑，公司资料不进链路；TLS + device token + PIN 限速已有 |
| 生产安全 | 网关重启会瞬断手机 PWA 与 Hub 中继（**不影响** sing-box 代理链路，二者独立进程）；改动走 systemctl restart hub-mobile-gateway，提前告知 |
| 版本号铁律 | renderer UI 改动 → bump version + UI 显示同步刷新 |
