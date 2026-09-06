# 开发群聊工作台交付说明

> 本文件保留上一轮 v1.6.81 任务行工作台的交付记录。当前 A 风格与 v1.6.82 整合后的 v1.6.83 验证，见 `20260905-dev-workbench-a-codex1.md`。

开发看板对应所有开发群聊：一个群聊就是一个任务，以整行显示最新进展、流程位置、来源与时间。任务 / 项目 Tab 共用群聊推送的事实，工作台不调用模型、扫描仓库或逐个拉取聊天记录。保留现有左侧“开发”入口，使用 Hub 的深浅主题。

## 使用

1. 打开“开发”，新建开发群聊，绑定项目并布置任务。
2. 工作席和审核席在有意义的阶段输出 `UPDATE: 中文进展`。这不会完成当前轮，也不会通过审核门禁。
3. 最终交接沿用 `PROGRESS / VERIFIED / RISK / REPORT`；审核沿用 `RESULT / BLOCKERS / VERIFIED / NEXT`。看板显示来源席位、群聊轮次与时间。
4. 每条任务横向占满一行，详情默认收起。默认最近更新优先，也可按创建时间排序；行末操作可置顶、置底、停止、恢复中断流程、手动接管、恢复自动设置。置顶置底沿用群聊持久化字段。
5. 恢复自动设置只恢复配置，不派发任务；恢复中断流程保留原目标、执行记录与返工额度。超期或缺席位的任务明确提示，仍可手动处理。
6. 切换到项目 Tab，按真实工作目录归组；同名不同目录保持独立。先看当前任务，按需展开已通过 / 已停止的历史，暂停和失败仍留在当前任务中。每项目初始最多 3 条当前任务，支持继续展开。

## 数据与恢复边界

- 原始群聊消息和展示摘要在同一原子 JSON 写入中保存，成功后才推送；看板不是第二套任务台账。
- 基于 `0ef54e58bec28c28388d4768e2a9e97e158fb361` 的新群聊底座：进展校验 runId / attemptId / providerTurnId，保留稳定 memberId；摘要附带 revision 拒绝迟到版本。恢复席位按 slotSpecs 的稳定身份匹配，不以数组位置推定成员。包含最新 Claude stop_reason 终态门禁，UPDATE 不会提前完成自动提取。
- 最近审核结果参与最新进展展示。冷启动的残留 running 标为待恢复，新失败不会继承旧 PASS，手动群聊运行时不会误报自动循环已经完成。
- Claude / Codex 的过程 UPDATE 复用现有 JSONL tail 事件，匹配当前群聊待完成提示，过滤旧轮、引用和代码示例。其他提供商仍可通过既有群聊完成路径显示最终汇报；本轮没有新增其轮内 UPDATE 监听。
- 冷启动只读取旧记录一次，并在 worker 解析；实时推送不会被迟到的磁盘读取覆盖。手动“重新载入”只请求紧凑摘要，并可重试失败记录。
- 元信息接口不复制整段聊天时间线，一条历史字段损坏不会让所有任务消失。
- 每条任务有独立操作锁，确认绑定当前任务配置；未知结果不自动重试派发。停止未获执行端确认时，不显示成已接管。
- 显示字段有长度上限，原文保留并提示节选。超过 64 MB 的旧记录会明确提示未自动载入；后续新汇报仍能恢复显示。
- Agent 的自测、审核汇报是带来源的声明；看板不把它们升级为系统独立验证。已通过不代表已发布或用户验收完成。

## 验证

Windows 执行前仅在本次 shell 中将 `C:\Program Files\Git\bin` 放到 PATH 前面，避开 WindowsApps 的 WSL bash 占位程序；未改全局环境。

| 实际执行 | 结果 |
|---|---|
| `node scripts/run_unit_tests.js --jobs 8` | 367 个文件全部通过，81.4 秒 |
| `node tests/unit-dev-workbench-service.test.js` | 51 项检查通过；1,000 任务 / 20,000 次写入通知，125 ms；每批最多 100 条；摘要约 960 KiB |
| `node tests/unit-dev-workbench-transcript.test.js` | Claude 与 Codex 的真实 JSONL tail 测试通过；过程更新不冒充完成，历史更新不混入当前轮 |
| `node tests/dev-workbench-cdp-e2e.js` | 43 项真实隔离 Hub UI / IPC 检查通过；无未捕获 renderer 异常；正常退出码 0 |
| `node --check`（改动入口）及 `git diff --check` | 通过 |

最终 UI 测试：PID 5624，CDP 51250，数据目录为独立临时目录。1,000 任务下连续 30 次摘要请求平均 32.7 ms、最大 46.5 ms；群聊落盘到看板可见 203 ms。任务每页最多 40 条；项目每页最多 12 个，当前任务和历史渐进展开。以上是本机合成负载，不是线上性能承诺。

故障覆盖：坏 JSON、坏时间线字段、超大旧记录、缺席位、过期任务、旧确认令牌、重复操作、停止不确认、立即拒绝的恢复请求、摘要拒绝/不返回/迟到、坏消息字段、无效报告、renderer 刷新。UI 的 Agent 消息为确定性夹具，未调用真实模型或执行真实仓库合并；不能称为全链路多 Agent 开发验收。

新增验证：整行布局、完整流程位置、创建时间排序、置顶置底真实落盘、项目归组 / 同名隔离、历史展开、千任务项目视图连续推送、详情与 Tab / 排序偏好保留。

版本：1.6.81。分支：`feat/dev-workbench-rows-20260905-codex1`。生产目录与进程未修改，未合入 master。上轮卡片工作树保留；本轮从新底座建立工作树并迁入前一版工作台能力。

## Mission Hub 对照

以下是前一版调研留下的固定版本对照，本轮未重新核验该外部仓库。

查阅官方仓库版本 `f3dba7a1abb9474a88764f21283297cbe9935e2b`。产品方向相近，但 Clowder 以 Feature / Backlog 为中心、覆盖更广的治理；当前 AI Hub 实现紧贴开发群聊。

- [F073 设计与验收记录](https://github.com/zts212653/clowder-ai/blob/f3dba7a1abb9474a88764f21283297cbe9935e2b/docs/features/F073-sop-auto-guardian.md)：共享 SOP 阶段、接手者、恢复摘要；区分 attested / verified / unknown。文档明确将 handoff + ack + timeout 的 P2 从该功能剥离，不能把这段规划当成完整交付。
- [WorkflowSopPanel 源码](https://github.com/zts212653/clowder-ai/blob/f3dba7a1abb9474a88764f21283297cbe9935e2b/packages/web/src/components/mission-control/WorkflowSopPanel.tsx)：展示阶段、接手者、建议技能、Goal / Done / Focus、证据状态及更新来源；读取所选任务，并用请求序号避免一部分旧响应覆盖。
- [SOP API](https://github.com/zts212653/clowder-ai/blob/f3dba7a1abb9474a88764f21283297cbe9935e2b/packages/api/src/routes/workflow-sop.ts)：任务绑定校验、expectedVersion 与 409 冲突反馈。
- [F076](https://github.com/zts212653/clowder-ai/blob/f3dba7a1abb9474a88764f21283297cbe9935e2b/docs/features/F076-mission-hub-cross-project.md)：需求审计与渐进交付的更大范围；文档已标注被 F152 接替。借鉴方法，不直接扩成本轮范围。

下一版建议优先增加简短交接摘要与“现在轮到谁 / 需要我决定什么”，仍由群聊合同产出并带来源；以后再做结构化接手确认与超时升级。保持人工可介入，以及合并、发布等关键动作的人类决策边界。相似产品证明这不是无人尝试的空白，是否好用应看维护者少读多少记录、异常后能否自己恢复。
