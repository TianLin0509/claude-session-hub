# Hub Mobile PWA · Design Spec

**日期**：2026-06-06
**作者**：立花道雪
**状态**：已通过 brainstorm，进入实现

## 目标

让手机（华为 Mate X6 / 鸿蒙 NEXT）能：
- 跟家里 Hub 里的 Claude Code 会话发消息、看回复（卡片 UI + PTY 切换）
- 切出去 1 小时切回来时，**会话连续**——离线期间 Claude 跑的回复全在
- 看 Claude 生成的 HTML artifact（全屏 iframe 渲染）

## 非目标

- 不实现 Push 通知（V2 再加 HMS Push）
- 不实现 圆桌（多 AI 群聊）远程操作
- 不实现 桌面 session 多端共享（手机只看自己的"手机会话"）
- 不实现 设置面板/历史会话/全功能管理 UI（A 极简）

## 架构

```
┌─────────────┐         ┌──────────────────┐         ┌──────────────────┐
│ 手机 PWA    │  WSS    │ VPS Gateway      │  WSS    │ Hub mobile-bridge│
│ (Android    │ ──────► │ 138.128.192.245  │ ◄────── │ (家里 Windows)   │
│  Wrapper)   │         │ ${HUB_DOMAIN}    │ outbound│                  │
│             │ ◄────── │ :443 HTTPS       │ ──────► │ sessionManager   │
└─────────────┘         │ 哑转发 + Pairing │         │ spawn Claude CLI │
                        └──────────────────┘         └──────────────────┘
```

**核心约束**：
- VPS 是**哑转发**（无状态，纯应用层 WSS 桥），不存消息（B2 路径）
- Hub 是 truth source，所有消息持久化走现有 transcript jsonl
- VPS 出 → Hub 走 outbound WSS（Hub 主动连，绕 NAT）
- PWA → VPS 走 inbound WSS over HTTPS 443

## 组件分解

### 1. VPS Gateway (`mobile/vps-gateway/`)
- Node.js + `ws` 库
- 监听 HTTPS 443（Let's Encrypt 证书）
- 两个 WSS endpoint：
  - `/agent` — Hub 端主动连入（需 `BEARER_TOKEN` 鉴权）
  - `/pwa` — PWA 连入（需配对成功后的 `device_token` 鉴权）
- 一个 HTTP endpoint：
  - `POST /api/pair` — PWA 提交 PIN，VPS 转给 Hub 校验
- 路由：PWA 消息 → 对应 Hub agent（按 user namespace）
- 不存任何消息内容，只内存路由

### 2. PWA (`mobile/pwa/`)
- 静态资源：`index.html` + `app.js` + `styles.css` + `sw.js` + `manifest.json`
- 从 mock v1.5 提炼，保留所有视觉设计
- WSS client（应用层重连、心跳、离线队列）
- IndexedDB 存 device_token + 最后一条 turn cursor + 离线发送队列
- Service Worker 缓存静态资源（PWA 加桌面后可离线打开壳子）
- 配对屏 / 主屏 / artifact 全屏三态

### 3. Hub mobile-bridge (`mobile/hub-bridge/`)
- Node.js 模块，由 main.js 通过 env flag 加载：`CLAUDE_HUB_MOBILE_ENABLED=true`
- 默认关，老用户零感知
- 启动后：
  - 建立到 VPS `/agent` 的 outbound WSS（带 `BEARER_TOKEN`）
  - 创建/恢复一个 "mobile-session"（hubSessionId 固化为 `mobile-default`）
  - 监听 PWA 消息 → 转发到 sessionManager.sendInput()
  - 订阅 transcriptTap turn-complete → 推送给 VPS
- PIN 配对：
  - 通过 `/api/pair` 转发的 PIN 校验
  - 校验通过生成 device_token，存 `mobile-devices.json`，返回给 PWA

### 4. Android Wrapper (`android-app/`)（推后）
- 复用现有壳，加 Kotlin WebView MainActivity
- 沉浸式全屏（`WindowCompat.setDecorFitsSystemWindows(false)`）
- 单一 URL 加载 `https://${HUB_DOMAIN}`
- 自签 APK，自己边线安装

## 协议

### Hub ↔ VPS（出站 WSS）
**Hub → VPS**：
```json
{"type":"hello","agentId":"hub-tachibana","token":"BEARER_XXX"}
{"type":"turn","sessionId":"mobile-default","seq":42,"role":"assistant","content":"...","toolCalls":[...]}
{"type":"pair-result","pin":"836152","ok":true,"deviceToken":"DT_xxx","deviceName":"Mate X6"}
{"type":"pong","ts":...}
```
**VPS → Hub**：
```json
{"type":"pwa-input","deviceToken":"DT_xxx","content":"..."}
{"type":"pair-request","pin":"836152","deviceName":"Mate X6"}
{"type":"ping","ts":...}
```

### VPS ↔ PWA（出站 WSS）
**PWA → VPS**：
```json
{"type":"hello","deviceToken":"DT_xxx","sinceSeq":42}
{"type":"input","content":"..."}
{"type":"pong","ts":...}
```
**VPS → PWA**：
```json
{"type":"turn","seq":43,"role":"assistant","content":"...","toolCalls":[...]}
{"type":"conn-state","state":"ok|weak|hub-off|vps-off"}
{"type":"ping","ts":...}
```

### PWA → VPS HTTP（配对）
```
POST /api/pair
{"pin":"836152","deviceName":"Mate X6"}
→ 200 {"deviceToken":"DT_xxx"} | 403 {"error":"invalid_pin"}
```

## 安全

- **HTTPS 443 only**：Let's Encrypt 自动续期
- **PWA 鉴权**：长期 `device_token`（128-bit）+ Hub 端"已配对设备"列表（可撤销）
- **Hub 鉴权**：固定 `BEARER_TOKEN`（写 hub-config.json，每次 Hub 启动读，可手动 rotate）
- **PIN**：6 位数字，5 分钟有效，3 次失败 5 分钟冷却
- **VPS 信任边界**：VPS 看到的是 TLS 加密流量解密后的明文，但**不落盘**（内存路由后立即丢弃）

## 测试策略

- **VPS gateway 单测**：路由逻辑 / 鉴权 / PIN 校验 / 设备 token 管理
- **PWA 集成测**：mock WSS server，验证重连/队列/SW 缓存
- **Hub bridge 集成测**：复用 Hub 现有 e2e 模板（隔离 CLAUDE_HUB_DATA_DIR），mock VPS
- **端到端**：DuckDNS 域名走通 PWA → VPS → Hub → Claude 一发一答
- 严守 `feedback_e2e_real_user`：手机端真机操作，不靠后端 IPC 假装

## 里程碑

**M1（MVP，1-2 周）**：本地测通 + DuckDNS 部署
- VPS gateway（基础路由 + 配对）
- PWA（主屏 + 配对屏，无 artifact 全屏、无离线分隔线）
- Hub bridge（基础消息收发）
- DuckDNS + Let's Encrypt
- PWA 装到 Edge/Chrome → 桌面验证

**M2（V1，+1 周）**：体验完善
- artifact 全屏渲染
- 离线返回分割线
- 连接状态 4 态颗粒度
- 设备管理 UI

**M3（V2，+1-2 周）**：原生壳
- Android Wrapper（Kotlin WebView）
- 自签 APK
- 沉浸全屏

**M4（远期）**：
- HMS Push
- 折叠屏内屏自适应布局
- 圆桌远程

## 域名

部署时变量 `${HUB_DOMAIN}` 替换为：
- **MVP 临时**：`lintian-hub.duckdns.org`（免费三级域名）
- **生产**：NameSilo 注册的 `hub-lintian.com` 或类似（待用户购买）
- Let's Encrypt 自动签 SSL，两域名都适用
