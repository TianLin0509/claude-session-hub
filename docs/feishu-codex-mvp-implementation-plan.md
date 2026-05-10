---
feature_ids:
  - feishu-codex-mvp
topics:
  - feishu
  - codex
  - mobile
doc_kind: implementation-plan
created: 2026-05-01
---

# 飞书接入普通 Codex Session MVP 实施计划

## 目标

先打通普通 Codex session 的飞书入口，不在第一阶段做圆桌。

闭环是：

1. 飞书 thread 发送 `新建 codex：<任务>`。
2. Hub 创建一个 Codex session。
3. 同一 thread 后续消息继续写入该 session。
4. Hub 把状态、最近输出、工具审批和输出摘要回推给 channel adapter。
5. 后续在这个基础上扩展 Claude/Gemini 和圆桌。

## 本轮已实现

- 新增 `core/feishu-codex-gateway.js`
  - 解析 `新建 codex：...`、`状态`、`最近输出`、`停止` 和普通继续输入。
  - 维护飞书 thread 到 Codex session 的绑定。
  - 调用 `sessionManager.createSession('codex')` 创建会话。
  - 调用 `sessionManager.writeToSession()` 转发输入。
  - 监听 `output` 事件，生成去 ANSI 的输出摘要。
  - 监听 `tool-use-preview` 事件，生成工具审批消息。
  - 输入采用 `prompt` 和 `Enter` 分段写入，避免 Codex TUI 把 Enter 吞进粘贴缓冲。

- 新增 `core/feishu-codex-routes.js`
  - 提供 `POST /api/feishu/codex/events`。
  - 支持飞书风格 `event.message.content` payload 和简化测试 payload。
  - 使用 `x-hub-feishu-token` 或 query token 做最小鉴权。

- 更新 `core/mobile-server.js`
  - 支持可选 `feishuCodex` 配置。
  - 只有提供 token 时才挂载飞书 Codex 路由，避免默认暴露远程创建 Codex session 的入口。

- 更新 `main.js`
  - 通过环境变量 `HUB_FEISHU_CODEX_TOKEN` 启用 MVP 路由。
  - 通过 `HUB_FEISHU_CODEX_CWD` 配置默认工作目录。
- 新增 `core/feishu-client.js`
  - 使用 Node 内置 `http/https` 获取 `tenant_access_token`。
  - 支持回复原飞书消息，或在没有 reply target 时发送到 chat。
  - 用飞书 interactive markdown card 承载 Hub 状态、摘要和审批消息。
  - 不引入官方 SDK 依赖，便于测试和控制打包风险。

- 新增 `core/feishu-ws-receiver.js`
  - 使用 `@larksuiteoapi/node-sdk` 的 `WSClient` 建立飞书长连接。
  - 监听 `im.message.receive_v1`。
  - 归一化 `chat_id`、`message_id`、thread key 和文本内容。
  - 过滤空消息、非文本消息、机器人自身消息。
  - 将消息转发给同一套 `FeishuCodexGateway`，不碰圆桌链路。

## 本地试用方式

启动 Hub 前设置：

```powershell
$env:HUB_FEISHU_CODEX_TOKEN = "dev-secret"
$env:HUB_FEISHU_CODEX_CWD = "C:\Users\lintian\claude-session-hub"
```

如果只设置上面两个变量，Hub 会接收飞书兼容事件，但 outbound 只写入日志。

要启用真实飞书发送，再设置：

```powershell
$env:HUB_FEISHU_APP_ID = "cli_xxx"
$env:HUB_FEISHU_APP_SECRET = "xxx"
$env:HUB_FEISHU_DOMAIN = "feishu"
```

可选：

```powershell
$env:HUB_FEISHU_REPLY_IN_THREAD = "1"
```

配置文件方式等价，路径：

`C:\Users\lintian\.claude-session-hub\config.json`

```json
{
  "channels": {
    "feishuCodex": {
      "token": "<local inbound token>",
      "app_id": "cli_xxx",
      "app_secret": "<secret>",
      "domain": "feishu",
      "cwd": "C:\\Users\\lintian\\claude-session-hub",
      "reply_in_thread": "1",
      "ws": "1"
    }
  }
}
```

Hub 启动后，向 mobile server 端口发送测试事件：

```powershell
$body = @{
  chatId = "chat-dev"
  threadId = "thread-dev"
  text = "新建 codex：检查当前项目移动端飞书接入方案"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:3470/api/feishu/codex/events" `
  -Headers @{ "x-hub-feishu-token" = "dev-secret" } `
  -ContentType "application/json" `
  -Body $body
```

继续输入：

```powershell
$body = @{
  chatId = "chat-dev"
  threadId = "thread-dev"
  text = "继续，把 P0 拆成文件级任务"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:3470/api/feishu/codex/events" `
  -Headers @{ "x-hub-feishu-token" = "dev-secret" } `
  -ContentType "application/json" `
  -Body $body
```

## 下一步

1. 接官方飞书应用凭据与事件订阅。
2. 在飞书里发送 `新建 codex：...` 做端到端实测。
3. 做工具审批按钮回调，而不是让用户手动回复 `1` / `2`。
4. 加 thread/session 绑定持久化，Hub 重启后仍能接续。
5. 单 session 稳定后，再扩展到 Claude/Gemini 和圆桌。

## 验证

已新增并通过：

- `node tests/unit-feishu-codex-gateway.test.js`
- `node tests/unit-feishu-codex-routes.test.js`
- `node tests/unit-feishu-client.test.js`
- `node tests/unit-feishu-ws-receiver.test.js`
- `node tests/mobile/test-rest.js`

已执行语法检查：

- `node --check core/feishu-client.js`
- `node --check core/feishu-ws-receiver.js`
- `node --check core/feishu-codex-gateway.js`
- `node --check core/feishu-codex-routes.js`
- `node --check core/mobile-server.js`
- `node --check main.js`

真实飞书验证：

- tenant token 获取成功。
- WebSocket 长连接启动成功，SDK 报告 `connected` / `ws client ready`。
