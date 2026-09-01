# AI Hub 回答完成飞书通知（Feishu CLI）

AI Hub 可以在普通 session 回答完成、或群聊整轮全部收敛后，通过官方飞书 CLI 向指定飞书会话/群聊或用户发送通知。

## 一次性准备

推荐把 CLI 固定安装在稳定工具目录（当前验证版本：`1.0.92`）：

```powershell
npm install --prefix C:\DevTools\LarkCLI @larksuite/cli@1.0.92
& 'C:\DevTools\LarkCLI\node_modules\@larksuite\cli\bin\lark-cli.exe' config init
```

使用应用机器人身份发送时，不需要授予 Hub 读取个人日历、私信或云盘的权限。飞书应用需要：

- 机器人能力已启用；
- `im:message:send_as_bot` 权限；
- 机器人已加入目标群聊/会话，或已与目标用户建立私聊关系。

## 在 Hub 中启用

1. 打开一个需要关注的 session。
2. 点击顶栏“通知未配”，进入原有“回答完成通知”设置。
3. 填写飞书接收对象 ID：
   - `oc_...`：会话/群聊 `chat_id`；
   - `ou_...`：用户 `open_id`。
4. 点击“发送测试”，在飞书手机端确认收到。
5. 勾选当前会话通知并保存。顶栏应显示“通知开”。

设置界面、顶栏开关和会话级持久化语义与旧微信版一致；只是通知 provider 已替换为飞书 CLI。

## 完成判定与准确性

- 普通 session 只接受 Hub 的 transcript/native lifecycle `turn-complete`，不从 PTY 文本猜完成。
- 同一轮优先使用 provider 原生 `turnId`；没有 `turnId` 的 provider 使用当前 prompt 代次。
- 同一轮即使 transcript 后续补全、文本变化，也只投递一次。
- 新一轮开始后到达的旧轮完成事件会被拒绝。
- 已中断或失败的轮次不会被后到的完成事件误报。
- 群聊成员不单独推送；仅当整轮所有结果均为终态后发送一条汇总。
- 被抢占、中断或仍含 `running` 等非终态成员的群聊不推送。
- 成功事件 ID 会写入投递审计；Hub 重启后从审计恢复，防止同一轮再次推送。
- 飞书 CLI 额外使用同一 event ID 派生的 idempotency key，网络重试不会制造重复消息。

这里的“零虚警/零漏警”是验收矩阵内的目标，不代表外部网络、飞书开放平台或本机断电永远不会失败。外部投递失败会显式出现在工作台健康提醒和审计日志中，不会伪装成已发送。

## 会话级开关语义

- 每个 session 独立保存通知状态；新建和历史 session 默认关闭。
- 顶栏“通知开”：仅当前 session 回答完成后推送。
- 顶栏“通知关”：仅当前 session 不推送，其他 session 不受影响。
- 顶栏“通知未配”：尚无有效 `oc_...` / `ou_...` 接收对象。
- 普通 session 每轮最多推送一条。
- 群聊按房间独立设置，整轮收敛后最多推送一条。
- 默认不包含回复正文；“附带回复预览”必须由用户显式开启。
- 网络/CLI 瞬时失败按 2 秒、10 秒、60 秒退避重试。

## 配置与环境变量

配置保存在 Hub 数据目录的 `config.json`：

```json
{
  "notifications": {
    "provider": "feishu-cli",
    "include_preview": false,
    "notify_group_chats": true,
    "feishu": {
      "target": "oc_xxx"
    }
  }
}
```

可选环境变量：

- `HUB_NOTIFY_FEISHU_TARGET`：覆盖接收对象；
- `HUB_NOTIFY_FEISHU_CLI_PATH`：覆盖 CLI 可执行文件路径；
- `HUB_NOTIFY_ENABLED`：仅保留旧配置兼容，不会替代每个 session 自己的开关。

Windows 默认先查找：

`C:\DevTools\LarkCLI\node_modules\@larksuite\cli\bin\lark-cli.exe`

若不存在，则尝试 PATH 中的 `lark-cli.exe`。

## 投递审计

审计位于 Hub 数据目录的 `notification-delivery.jsonl`。

审计只记录：

- event ID；
- provider；
- 发送/失败/抑制状态；
- 尝试次数；
- CLI exit code；
- 安全错误码和飞书 message ID。

审计不记录飞书接收对象、通知标题、回答正文或回复预览。

## 常见错误

- `invalid_target`：接收对象不是有效的 `oc_...` / `ou_...`。
- `cli_not_found`：飞书 CLI 未安装，或 `HUB_NOTIFY_FEISHU_CLI_PATH` 错误。
- `authorization_error` / `cli_configuration_error`：CLI 尚未完成应用配置。
- `missing_scope`：应用缺少 `im:message:send_as_bot`。
- `confirmation_required`：CLI 风险门禁要求人工确认；Hub 不会静默绕过。
- `timeout` / `network_error`：检查本机网络、代理及飞书开放平台连通性。
- `cli_failed`：检查机器人是否已经加入目标会话，以及目标 ID 是否属于当前租户。
