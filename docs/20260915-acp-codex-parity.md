# 千问、DeepSeek 原生 Harness、智谱与 Codex 对齐

基线：`c767275558ecb6d7566ffd8900f40553de0324c8`（v1.6.172）。实现于独立 worktree，版本由合并入口抬升。

## 本次补齐

- 三家 ACP 复用 Codex/Claude 的后台组件，提供工作记录、原始记录、原终端和完整导出。消息、思考、工具输入/输出、计划、原生 stopReason 和 stderr 按实际来源保存。普通 IPC 只传分页预览，完整记录按需读取；不从终端过滤结果反推原文。
- `AcpBackstage` 使用每个 Hub 会话独立的 SQLite 文件，随原 driver 关闭。旧 ACP 历史按需补入；原有消息、工具数据保留不变。未采集的历史逐字过程和诊断无法补录。
- 执行中可点击发送或按 Enter 追加消息。ACP 将其保存到待发送队列并显示队列回执；当前轮正常完成后按顺序发送，收到真实原生更新后才发布接收确认。没有复制 Codex 的 `turn/steer` 语义。
- 停止、未知提交、断线、失败或关闭时，未发送内容转为保留状态。恢复会话后可查看全文、确认发送或移除，不自动重放。单会话最多保留 20 条、正文合计 2 Mi 字符，超限明确拒绝。
- 上下文观测随轮次保存并在恢复时还原，卡片沿用共用 context 展示。它不冒充累计输入/输出 token、费用或套餐剩余额度。
- 状态栏显示三家的真实名称；群聊沿用相同的原生驱动、后台入口、交互控件和投递管线。
- 修复原生会话关闭/休眠时草稿重复写入已经关闭的 driver、导致重开后误报未保存的问题。关闭前等待最后一次草稿保存完成；失败保留会话并明确报错。休眠后移除旧控制器，恢复时重读持久化版本。
- 修复 DeepSeek 原生群聊头像引用不存在的 `deepseek-acp.svg`，统一到既有 DeepSeek 图标。

## 保留的真实能力差异

即时 steer 需要上游协议支持；本次为明确可见的顺序队列。模型/思考/权限、图片、分支及原生命令仍以当前 Harness 握手和原生配置为准。不新增虚构的模型档位、完整思考正文、账单余额或自主循环。DeepSeek 官方 API 路线保持独立。

## 验证入口

```powershell
node --test tests/unit-acp-parity.test.js tests/unit-acp-session.test.js tests/unit-acp-cancellation.test.js tests/unit-acp-history-store.test.js
node tests/e2e-acp-parity-cdp.js
node tests/e2e-acp-runtime-parity-cdp.js
node tests/e2e-acp-alignment-cdp.js
node scripts/run_unit_tests.js
```

GUI 使用真实隔离 Electron、独立数据/HOME/CDP 与 ACP 协议 fixture；不调用真实模型服务。导出仅固定操作系统保存路径，实际点击、IPC、分页、UTF-8 写入及原子完成逻辑不替换。

旧 `acp-agent.js` fixture 总返回同一原生 ID，与会话独占合同冲突。GUI 模式现使用独立 ID，恢复时返回请求的原 ID；普通单元测试保持原稳定 ID。原始失败证据与后续通过证据分别保留在 `artifacts/acp-parity` 和相关测试产物目录。
