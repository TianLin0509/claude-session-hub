---
feature_ids:
  - feishu-notifier
topics:
  - feishu
  - notification
  - mobile-awareness
doc_kind: design
created: 2026-05-03
status: brainstorm-approved
---

# Hub 飞书未读消息通知设计

## 目标

让用户在离开电脑时也能感知 Hub 状态。当 Hub 中任一 session 完成一轮回复或进入"等你输入"状态时，主动推送一张通知卡片到飞书私聊。

**纯单向通知**：飞书侧不接受任何指令，用户看到提醒后自行用远程桌面工具回到电脑操作。

## 范围

In scope：
- Hub session "AI 完成一轮回复"（Stop hook 触发点）发飞书通知
- Hub session 进入 "等你输入"（`isWaiting` 由 false→true）发飞书通知
- 同一 session 60 秒内的多次普通触发合并去重
- "等你输入"高优先级触发**绕过去重立即发**
- 复用现有飞书应用凭据 (`HUB_FEISHU_APP_ID/SECRET/DOMAIN`) 与 `core/feishu-client.js`
- 配置缺失时静默禁用，不影响 Hub 其他功能
- 单元测试 + 集成测试 + 隔离 Hub 实例的 E2E 真实测试

Out of scope（用户明确拒绝）：
- 飞书侧任何反向控制（新建/继续/状态查询全不做）
- 配置面板 UI（先用 env / config.json，后续按需加）
- "窗口失焦才推送"或"非活跃 session 才推送"等过滤策略（用户选 D：全推 + 60s 去重）
- 60s 窗口结束后的"补发"队列（YAGNI）
- 富媒体附件（截图、文件）

## 架构

```
[Claude/Codex/Gemini CLI 完成一轮]
              ↓ Stop hook
[hook-server → renderer.onReplyCompleteFromHook(sessionId)]
              ↓
   ┌───────────────────────────┬─────────────────────────────────┐
   │ 已有：maybeNotify          │ 新增：ipcRenderer.send          │
   │  系统通知，仅窗口失焦时弹    │  ('feishu-notify', payload)     │
   └───────────────────────────┴────────────────┬────────────────┘
                                                 ↓
                              [main 进程：FeishuNotifier]
                              ① 60s 同 session 去重窗口
                              ② newlyWaiting 绕过去重
                              ③ 拼装飞书 markdown 卡片
                                                 ↓
                              [feishu-client.sendCard({chatId, card})]
                                                 ↓
                              POST /open-apis/im/v1/messages?receive_id_type=chat_id
                                                 ↓
                                          [飞书私聊]
```

### 关键不变量

- **renderer 端只发信号、不做过滤**：是否推送、何时推送，全部由 main 端 notifier 决策。renderer 端逻辑改动只有"在 `onReplyCompleteFromHook` 末尾追加 1 行 IPC"。
- **notifier 失败不影响 Hub**：所有飞书 API 错误只 `console.warn`，不抛、不阻塞 IPC。Hub 永远跑得动。
- **配置缺失 = 静默禁用**：未配 `HUB_FEISHU_NOTIFY_CHAT_ID` 时 notifier 不挂载 IPC handler，renderer 端 IPC 无人接收（Electron 默认安静）。
- **与 `feishu-codex-gateway` 完全独立**：双向交互那条线和单向通知互不依赖，可同时启用、可独立禁用。

## 组件设计

### 1. `core/feishu-notifier.js`（新增）

main 进程模块，单一职责：接 IPC payload → 去重判定 → 拼卡片 → 调 `FeishuClient.sendCard`。

**对外接口**：

```js
class FeishuNotifier {
  /**
   * @param {Object} opts
   * @param {FeishuClient} opts.client  必填，已注入 appId/appSecret 的客户端
   * @param {string}       opts.chatId  必填，接收通知的 chat_id；空字符串触发 dry-run
   * @param {number}       [opts.dedupeWindowMs=60000]
   * @param {string}       [opts.dryRunLogPath]  dry-run 模式写入的日志路径
   * @param {Object}       [opts.logger=console]
   * @param {() => number} [opts.now=Date.now]  注入用，便于单测
   */
  constructor(opts);

  /**
   * 接收 renderer 端 payload，按规则去重后推送。
   * 永不抛错（API 失败仅 logger.warn）。
   *
   * @param {Object} payload  见下方 IPC 协议
   * @returns {Promise<{sent: boolean, reason: 'sent'|'deduped'|'dryrun'|'error'}>}
   */
  async notify(payload);

  /** 最近一次错误（供诊断） */
  get lastError();
}
```

**内部状态**：
- `lastSentAt: Map<sessionId, timestamp>` — 每个 session 上次发送时间
- `lastError: { time, message } | null` — 最近一次错误

**去重判定**（`notify()` 入口）：

```
if payload.newlyWaiting === true:
    立即发，更新 lastSentAt
elif now - lastSentAt[sessionId] < dedupeWindowMs:
    return { sent: false, reason: 'deduped' }
else:
    立即发，更新 lastSentAt
```

**dry-run 模式**（`chatId === ''`）：
- 不调 `client.sendCard`
- 把 payload + 拼好的 markdown 文本 append 到 `dryRunLogPath`（通常是 `<dataDir>/feishu-notify.log`）
- 返回 `{ sent: true, reason: 'dryrun' }`，便于 E2E 断言

### 2. 卡片拼装

默认作为 `feishu-notifier.js` 内部的 `buildNotifyCard(payload)` 函数实现，不单独拆模块。如果实施过程中函数超过 50 行，再拆出 `core/feishu-notifier-card.js`。

**卡片格式**（飞书 schema 2.0 markdown 卡片，复用 `feishu-client.js:buildMarkdownCard`）：

```markdown
**Hub 提醒 · {session.title}**

状态：⏸ 等你回复    ← isWaiting=true 时
状态：✅ 一轮完成    ← isWaiting=false 时

{preview / waitingText, 截 200 字}

— Hub @ {HH:MM:SS}
```

颜色 header：
- `isWaiting=true` → `orange`（紧急感，跟 Codex gateway 的 approval 卡片一致）
- `isWaiting=false` → `wathet`（常规色）

### 3. `renderer/renderer.js` 改动

**唯一改动点**：`onReplyCompleteFromHook(sessionId)` 函数末尾追加 1 行 IPC（约在 `:2993` `renderSessionList()` 之后）：

```js
// 飞书通知（无条件发，main 端做去重 + 启用判定）
try {
  ipcRenderer.send('feishu-notify', {
    sessionId,
    title: session.title,
    kind: session.kind,
    isWaiting: !!session.isWaiting,
    newlyWaiting,            // 已是函数内现成变量
    waitingText: session.waitingText || null,
    preview: session.lastOutputPreview || '',
    timestamp: Date.now(),
  });
} catch {}
```

注意：**不动 `maybeNotify` 既有逻辑**（系统通知保持原行为），只追加飞书 IPC。

### 4. `main.js` 改动

**启动初始化**（在飞书相关配置加载附近）：

```js
const notifyConf = resolveNotifyConfig(); // 读 env + config.json
if (notifyConf && notifyConf.appId && notifyConf.appSecret && notifyConf.chatId !== undefined) {
  const client = new FeishuClient({
    appId: notifyConf.appId,
    appSecret: notifyConf.appSecret,
    domain: notifyConf.domain,
  });
  feishuNotifier = new FeishuNotifier({
    client,
    chatId: notifyConf.chatId,
    dedupeWindowMs: notifyConf.dedupeMs || 60000,
    dryRunLogPath: notifyConf.chatId === ''
      ? path.join(getHubDataDir(), 'feishu-notify.log')
      : null,
  });
  ipcMain.on('feishu-notify', (_event, payload) => {
    feishuNotifier.notify(payload).catch(err => {
      console.warn('[feishu-notify] notify rejected:', err.message);
    });
  });
  console.log(`[feishu-notify] enabled, chatId=${maskChatId(notifyConf.chatId)}`);
} else {
  console.log('[feishu-notify] disabled (missing app_id/app_secret/chat_id)');
}
```

**`resolveNotifyConfig()`**：env 优先于 config.json。复用现有 `core/hub-config.js` 的 channels 读取套路。

## 配置

### env 变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `HUB_FEISHU_APP_ID` | ✅ | 复用现有飞书应用 ID |
| `HUB_FEISHU_APP_SECRET` | ✅ | 复用现有飞书应用 Secret |
| `HUB_FEISHU_DOMAIN` | 否 | `feishu`（默认）/ `lark` |
| `HUB_FEISHU_NOTIFY_CHAT_ID` | ✅ | **新增**：接收通知的 chat_id；空字符串 `""` 触发 dry-run |
| `HUB_FEISHU_NOTIFY_DEDUPE_MS` | 否 | 去重窗口毫秒数，默认 60000 |

### `~/.claude-session-hub/config.json`

```json
{
  "channels": {
    "feishuNotify": {
      "chatId": "oc_xxx",
      "dedupeMs": 60000
    }
  }
}
```

`appId` / `appSecret` / `domain` 共享 `channels.feishuCodex` 的现有配置（如已存在），或在 `feishuNotify` 节点显式指定覆盖。

### 配置不全时的行为

- **缺 appId 或 appSecret 或 chatId 任一项 → 静默禁用**（启动日志一行说明）
- **chatId 为空字符串 `""` → dry-run 模式**（不打真实 API，写日志，主要用于 E2E 测试）

## 错误处理 / 降级

| 场景 | 处理 |
|------|------|
| 飞书 API HTTP 错误 | `logger.warn`，记 `notifier.lastError`，不抛 |
| tenant token 过期 | `FeishuClient` 自动续期 (`feishu-client.js:174-191`)，notifier 无感 |
| 网络全断 | 每次 warn，不堆队列、不重试（YAGNI） |
| renderer IPC 发送失败 | renderer 端 try/catch 吞掉，Hub 不受影响 |
| notifier 初始化失败 | main.js 中 try/catch，console.error 后跳过；Hub 启动继续 |
| 60s 去重窗口期间被压制的 payload | 不补发；用户可回到 Hub 看 unread badge |

## 测试方案

### 第 1 层：单元测试 — `tests/unit-feishu-notifier.test.js`

注入 fake clock + fake `FeishuClient`，覆盖：

| 用例 | 期望 |
|------|------|
| 首次推送 | `client.sendCard` 调 1 次 |
| 60s 内同 session 重复 | sendCard 仅 1 次，第 2 次返回 `{sent:false, reason:'deduped'}` |
| 推进时钟 61s 后再推 | sendCard 共 2 次 |
| `newlyWaiting=true` 第二次推送 | sendCard 共 2 次（绕过去重） |
| 不同 session 不互扰 | sendCard 共 2 次 |
| 卡片内容拼装（isWaiting=true） | header 是 orange，markdown 含 "等你回复" + waitingText |
| 卡片内容拼装（isWaiting=false） | header 是 wathet，markdown 含 "一轮完成" + preview |
| API 失败不抛 | `client.sendCard` 抛错时 `notify()` resolve `{sent:false, reason:'error'}`，`notifier.lastError` 已记录 |
| dry-run 模式 | chatId='' → 不调 sendCard，写日志文件，返回 `{sent:true, reason:'dryrun'}` |

### 第 2 层：集成测试 — `tests/integration-feishu-notifier-ipc.test.js`

启动一个 Electron BrowserWindow（或用 `app.whenReady()` 的 mock），验证：
- renderer 端 `ipcRenderer.send('feishu-notify', payload)` 能到达 main 端 notifier
- 配置缺失时 IPC 无人接收，不报错

可选：用 Electron 测试框架（Spectron / playwright-electron）完整启动一个 Hub 实例做集成。

### 第 3 层：E2E 真实测试 — `tests/e2e-feishu-notifier.js`

按 Hub CLAUDE.md 的"启动模板 A"+"E2E 必须真实执行"铁律：

```
1. 启动隔离 Hub 实例
   $env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-feishu-e2e"
   $env:HUB_FEISHU_APP_ID    = "<真实 app id>"
   $env:HUB_FEISHU_APP_SECRET = "<真实 secret>"
   $env:HUB_FEISHU_NOTIFY_CHAT_ID = "<真实 chat_id 或专用 E2E chat>"
   .\node_modules\electron\dist\electron.exe . --remote-debugging-port=9221

2. Playwright 通过 CDP (port 9221) 连接 Electron 主窗口

3. 真实 UI 操作：
   - 点击 "新建 Codex session"（用 Codex 不用 Claude，避免占用你 Opus 配额）
   - 输入简短 prompt 如 "回我一个 Hi"
   - 等 Stop hook 触发

4. 自动化断言（在 Hub 端）：
   - 轮询 main 进程 stdout，期望出现 [feishu-notify] sent 日志（或 lastError 为 null）

5. 人工验证：
   - 用户在飞书私聊里看到通知卡片 ← 必须人工 ✓

6. 60s 内再触发一次 turn：
   - 期望日志显示 [feishu-notify] deduped
   - 飞书侧无第 2 条

7. 等 60s 后再触发：
   - 期望飞书第 2 条到达 ← 人工 ✓

8. 清理：
   - Stop 隔离 Hub 实例（不动用户生产 Hub）
   - 不清理 C:\temp\hub-feishu-e2e（保留给后续诊断）
```

**`newlyWaiting=true` 触发的 E2E**：

如果能找到稳定触发 Codex/Claude `isWaiting=true` 的 prompt（如让 Codex 走到工具审批），E2E 中加这一段：
- 触发 isWaiting → 期望 60s 内**也**收到飞书通知（绕过去重）

如果不好稳定复现，**降级为单元测试 + 手工 spot-check**，并在 E2E 报告中标注"`newlyWaiting` 为人工验证"，不假装自动化通过。

### 真实推送 vs dry-run 选择

- 第 1/2 层一律 dry-run
- 第 3 层 E2E 必须真实推送，因为这是验证"飞书真的收到了"的唯一办法
- 为避免污染日常飞书私聊，建议用户在飞书里建一个**专门的 "Hub-E2E-Test" 单聊机器人**，E2E chat_id 单独配

## 实施顺序提示（供 writing-plans 参考）

1. `core/feishu-notifier.js` + 单元测试（自包含，不依赖其他改动）
2. `main.js` 启动初始化 + IPC handler
3. `renderer/renderer.js` 追加 1 行 IPC
4. 集成测试
5. E2E 真实测试 + 人工验证（用户自己跑）

## 与现有飞书集成的关系

| 模块 | 方向 | 触发 | 本次是否动 |
|------|------|------|------------|
| `core/feishu-client.js` | API SDK | 被调 | 仅复用，不改 |
| `core/feishu-codex-gateway.js` | inbound | 飞书消息 → Codex session | 不动 |
| `core/feishu-codex-routes.js` | inbound HTTP | 接收飞书事件 | 不动 |
| `core/feishu-ws-receiver.js` | inbound WS | 飞书长连 | 不动 |
| **`core/feishu-notifier.js`** | **outbound** | **Hub session 状态变化** | **新增** |

## 验收标准

- [ ] 配置全：每次 Hub session 完成一轮，60s 内首条触发飞书通知到达
- [ ] 配置全：60s 内重复触发被合并，仅首条到达
- [ ] 配置全：60s 后再触发，第 2 条到达
- [ ] 配置全：session 进入 `isWaiting=true`，立即收到通知（即使 60s 窗口期内）
- [ ] 配置缺：Hub 启动正常，无报错；renderer 端 IPC 静默吞掉
- [ ] 飞书 API 失败：Hub 主流程无任何阻塞，`notifier.lastError` 可见
- [ ] dry-run 模式：日志文件出现 payload 记录，飞书无任何推送
- [ ] 现有 `feishu-codex-gateway`（如启用）功能不受影响
- [ ] E2E 真实测试通过 + 用户飞书侧人工确认收到卡片

## 风险与已知限制

- **不去重的 newlyWaiting 可能引发短期内多条**：理论上若 Claude 反复 waiting/recover 会刷屏。实际观察 `isWaitingForUser()` 判定逻辑较稳，不期望抖动。如果实测有抖动，再加"`newlyWaiting` 自身也走一个独立的 30s 短去重窗口"。
- **chat_id 获取门槛**：用户首次配置需要在飞书后台拿到 chat_id（机器人和你的私聊 chat_id）。文档需提供获取步骤。
- **凭据共享带来的风险**：notifier 和 codex-gateway 共享 appId/secret，notifier 出问题理论上不影响 gateway，但若 token 续期机制有 bug 可能互相污染。两者用独立 `FeishuClient` 实例规避。

