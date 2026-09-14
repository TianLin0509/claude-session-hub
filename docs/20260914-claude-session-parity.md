# Claude session 对齐当前 Codex

对照基线：`39c7608f4412ac49755297db2f56edae83e7d794`，2026-09-14 的 master。
本次在独立工作树实现；不合入 master，不提前升版本，不重启生产 Hub。

## 结论

Claude 已使用原生 stream-json，并已有统一输入栏、卡片、审批和恢复等主要功能。
本次补齐最近 Codex 后台升级遗漏的三视图和导出，修复卡片指标在恢复/续接时丢失、消耗量与上下文混算，以及速度在两处显示不一致。
普通会话和群聊成员沿用同一套原生 UI；各引擎的协议与模型能力保持真实语义。

## 当前差异与处理

| 用户看到的能力 | 当前比较与本次处理 |
| --- | --- |
| 默认卡片、问题导航、历史分页 | 已有共用实现；本次保持。不会重新恢复旧 TUI 输入路径。 |
| 中间进展、工具、最终回答 | 已有共用卡片；Claude task-notification 续接已合并到原人类轮。本次让续接累计消耗、最新上下文和耗时跟随同一结果卡。 |
| 工作记录 / 原始记录 / 原终端 | 原来仅 Codex 有新后台，Claude 只显示终端；本次 Claude 复用同一组件、分页存储和详情读取。 |
| 大结果、完整导出 | 原来 Claude 卡片可以查全文，后台没有 Codex 的原始导出；本次补齐，页面只传有界预览，完整内容留在 SQLite 分块记录中。 |
| 卡片 token、context、耗时 | 原生结果已保存，但恢复投影没有读回 result.usage 和消息 model；展示拆分还清除了结果卡指标。本次统一投影，并只在最后一张结果卡显示。 |
| 上下文口径 | Claude result.usage 是多次调用的总消耗，不能当作上下文占用。本次用最后一次顶层 assistant 的输入及缓存 token 作观测；未知不显示百分比。窗口优先采用同一模型的原生 modelUsage.contextWindow。 |
| 速度状态 | 原来输入栏读 nativeRuntime.fastMode，状态栏/成员摘要读启动偏好 fastMode，会同时出现“标准”和“Fast”。本次让两处复用同一判断。 |
| 模型、推理、速度、计划模式 | 现有原生控制保留；设置由引擎确认后生效，不复制另一家模型档位或费用语义。 |
| 审批、多问题、停止 | 已有原生请求表单和确认闭环；本次回归普通会话和两位 Claude 群聊成员。停止意图不冒充已停止。 |
| 草稿、关闭与恢复 | 两家均遵循独占契约，关闭后另一 Hub 恢复原生身份、历史、草稿。本次后台记录随自己的 driver 关闭，重连后仍可读取。 |
| 开发文件工作流 | 沿用现有按阶段回执的派工；本次回归 Claude 原生文件交付与接续。 |
| 执行期间的新输入 | 协议差异：Codex 支持原生 turn/steer，Claude 当前 Hub driver 排队至前一查询完成。保留真实排队回执，不伪造即时 steer。 |
| 原生命令、goal/loop、模型目录 | 两家各走自己的原生命令与能力目录；本次没有新增、改写或对外承诺等价的原生命令集合。 |
| 后台诊断覆盖 | Codex 已有 App Server stderr 采集；本次 Claude 后台保存消息、思考、工具结果、原生 result 与操作失败，未新增 stderr 采集。旧版本未保存的逐字过程不补造。 |
| 引擎进程 | Codex 本 Hub 进程池与 Claude 每个会话的 stream-json 子进程不同；不为外观一致重写传输层。 |

## 实现边界

- `core/claude-backstage.js` 将 Claude 的消息/block/tool ID 映射到现有后台存储；保留原始字符串（含多字节字符和 NUL），不用终端过滤后的文本反推原文。
- 后台历史导入以已保存的 Hub 原生提交/活动为来源，逐页处理；没有 journal 的外部旧 Claude 历史仍由卡片历史入口查看，不宣称后台可以补全从未采集的过程。
- `core/claude-turn-metrics.js` 区分累计消耗与最后一次调用的上下文观测；后台子调用不覆盖顶层上下文。恢复从持久化 result 和 transcriptMessages 推导，兼容旧 journal，无需迁移真实数据。
- 消费者只接收当前 driver 的更新，保留独占 session 和 native writer 防护。原来的 `codex:backstage-*` 内部通道兼容保留，按实际会话后端路由。
- 本次未做真实模型服务验收；所有 GUI 使用真实隔离 Electron + 原生协议子进程 fixture。导出测试只固定系统保存对话框的路径，实际导出逻辑不替换。

## 验证入口

```powershell
node --test tests/unit-claude-backstage.test.js tests/unit-claude-parity-metrics.test.js tests/unit-session-status-summary.test.js
node tests/e2e-claude-codex-parity-cdp.js
node tests/e2e-claude-native-controls-cdp.js
node tests/e2e-native-consumer-matrix-cdp.js --provider=claude --scenario=approval --view=group
node tests/e2e-session-exclusive-cdp.js
node tests/e2e-claude-native-fileflow.js
node tests/e2e-codex-backstage-cdp.js
$env:PATH = 'C:\Program Files\Git\bin;' + $env:PATH
$env:HUB_UNIT_JOBS = '2'
node scripts/run_unit_tests.js
```

后台测试同时检查视图切换、大结果分页、导出、草稿和滚轮；卡片 fixture 明确给出累计输入 100k、独立上下文观测 12.5k / 1M、耗时 7.8s，断言显示 100k、1%、7.8s。
最终命令结果、候选 SHA 和截图在工作树 `artifacts/claude-parity-report.html` 中汇总。

## 测试维护

现有 `e2e-codex-backstage-cdp.js` 仍含“两个 Hub 同时共享查看”断言，与当前独占契约冲突，已改为先关闭原会话再由另一 Hub 恢复原生身份和后台记录。
同时让测试等待实际侧边栏/最终 Markdown DOM，避免把内部状态完成等同于 UI 更新完成。
保留 teardown 错误和原始测试错误，避免退出阶段的异常遮蔽实际断言。

此前 `docs/20260913-claude-codex-runtime-parity.md` 的共享订阅/控制权移交描述属于历史实现，以 `docs/design/session-exclusive-ownership.md` 为准。
