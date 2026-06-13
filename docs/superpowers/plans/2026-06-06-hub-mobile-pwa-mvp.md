# Hub Mobile PWA · MVP Implementation Plan

**对应 spec**：`docs/superpowers/specs/2026-06-06-hub-mobile-pwa-design.md`
**目标**：M1 端到端跑通——手机能给家里 Claude 发消息看回复

## 文件清单

新增文件**全部**在 `mobile/` 子目录下，**绝不动**现有 Hub 代码（main.js 唯一改动：一处 env flag 加载）。

```
mobile/
├── README.md                          # 部署指引
├── shared/
│   └── protocol.js                    # 协议常量（消息类型枚举）
├── vps-gateway/
│   ├── package.json
│   ├── server.js                      # WSS gateway 主入口
│   ├── routes/
│   │   ├── agent.js                   # /agent endpoint (Hub 入站)
│   │   ├── pwa.js                     # /pwa endpoint (PWA 入站)
│   │   └── pair.js                    # /api/pair (HTTP POST)
│   ├── lib/
│   │   ├── auth.js                    # token 校验
│   │   └── relay.js                   # 哑转发路由表
│   ├── systemd/
│   │   └── hub-mobile-gateway.service
│   └── tests/
│       └── relay.test.js
├── pwa/
│   ├── index.html                     # 单页（从 mock v1.5 提炼）
│   ├── app.js                         # WSS client + 状态机
│   ├── styles.css                     # 从 mock 提炼
│   ├── sw.js                          # Service Worker
│   ├── manifest.json                  # PWA manifest（图标/启动屏/全屏）
│   └── icons/                         # PWA 桌面图标多尺寸
└── hub-bridge/
    ├── index.js                       # 模块入口（被 main.js require）
    ├── outbound-client.js             # WSS client 连 VPS
    ├── session-binder.js              # 绑定 mobile-default session
    ├── pair-handler.js                # PIN 配对逻辑 + 设备列表
    └── tests/
        └── session-binder.test.js
```

main.js 改动（**仅一处，安全增量**）：

```js
// 在 sessionManager 初始化后、hookServer.listen() 前后
if (process.env.CLAUDE_HUB_MOBILE_ENABLED === 'true') {
  const { startMobileBridge } = require('./mobile/hub-bridge');
  startMobileBridge({
    sessionManager,
    transcriptTap,
    hookToken: HOOK_TOKEN,
    getHubDataDir,
    config: getHubConfig(),
  });
}
```

## 实现顺序（依赖关系驱动）

### Phase 1 — 协议 & 共享代码
1. `mobile/shared/protocol.js` — 协议常量（MSG_TYPES、ERROR_CODES）

### Phase 2 — VPS Gateway（最独立，可单机测试）
2. `vps-gateway/package.json`
3. `vps-gateway/lib/auth.js`
4. `vps-gateway/lib/relay.js`
5. `vps-gateway/routes/agent.js`
6. `vps-gateway/routes/pwa.js`
7. `vps-gateway/routes/pair.js`
8. `vps-gateway/server.js`
9. `vps-gateway/tests/relay.test.js`
10. `vps-gateway/systemd/hub-mobile-gateway.service`

**验收**：本地 `node server.js`，mock 两端连入，PWA → Hub → PWA 消息环路通。

### Phase 3 — Hub Bridge
11. `hub-bridge/outbound-client.js` — WSS 重连 + 心跳
12. `hub-bridge/session-binder.js` — 绑定 mobile-default session
13. `hub-bridge/pair-handler.js` — PIN 生成 + 校验 + device_token 颁发
14. `hub-bridge/index.js` — 组装入口
15. main.js 加 env flag 加载（**唯一一处 Hub 代码改动**）
16. `hub-bridge/tests/session-binder.test.js`

**验收**：本地启隔离 Hub（CLAUDE_HUB_DATA_DIR + CLAUDE_HUB_MOBILE_ENABLED），bridge 连 mock VPS，能 spawn Claude 并双向流转 turn。

### Phase 4 — PWA
17. `pwa/manifest.json` + `pwa/icons/*`
18. `pwa/styles.css` — 从 mock 提炼
19. `pwa/index.html` — 主屏 + 配对屏
20. `pwa/app.js` — WSS client + 状态机 + IndexedDB
21. `pwa/sw.js` — Service Worker 缓存静态资源

**验收**：本地 `python -m http.server`，浏览器装到桌面，配对→发消息→看回复全流程。

### Phase 5 — 部署
22. `mobile/README.md` — 部署步骤
23. DuckDNS 注册 `lintian-hub.duckdns.org`
24. VPS 上 `certbot --standalone -d lintian-hub.duckdns.org`
25. VPS 上 `systemctl enable --now hub-mobile-gateway`
26. Hub 端写 `BEARER_TOKEN` 到 hub-config.json
27. Hub 端 env flag 启用 → 桌面快捷方式增加 `CLAUDE_HUB_MOBILE_ENABLED=true`

**验收**：手机 Chrome/Edge 访问 `https://lintian-hub.duckdns.org`，加桌面 → 配对 → 发消息 → 看 Claude 回复。

## 关键设计决策（已锁定，实施时遵守）

- **不 kill Hub**：所有测试用 worktree + CLAUDE_HUB_DATA_DIR 隔离实例
- **不改 state.json / Hub 配置**：mobile-bridge 只读 hub-config.json，自己的状态写 `mobile-devices.json`
- **路径白名单**：artifact 文件读限定 `Desktop/claude-artifacts/` 一个目录
- **PIN 安全**：6 位、5 分钟、3 次失败 5 分钟冷却（应用层）
- **device_token 安全**：128-bit random，永久有效，存 `mobile-devices.json`，可手动撤销
- **PWA 端 IndexedDB**：只存 device_token + last_seq + 待发送队列，不存历史消息

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| Hub 主进程稳定性受影响 | env flag 默认关；bridge 模块 try/catch 兜底；崩溃不影响主进程 |
| VPS gateway 被攻击 | rate limit + IP 白名单（Hub 出站固定家庭 IP）+ token 强校验 |
| PWA 加桌面失败 | 提供 Chrome/Edge 装载步骤；M3 上 Android Wrapper 后无依赖 |
| Let's Encrypt 续期失败 | certbot.timer + systemd OnFailure 告警 |
| 域名解析 | DuckDNS API 每 5min 上报家庭 IP（防解析飘了） |

## 已知非实现（V2+）

- HMS Push 后台推送
- 设备管理 UI（撤销设备走 hub-config.json 手工编辑）
- artifact 全屏渲染（先返回 raw HTML 链接，用户点了在浏览器打开）
- 离线返回分割线（重连时 cursor 续接，但不显示视觉标签）
- PTY 视图切换
- 折叠屏自适应

→ M2/M3 plan 单独写
