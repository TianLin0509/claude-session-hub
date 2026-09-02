# Agent League 高可用运行与接班手册

> 2026-09-02 / v1.6.36：新增全 Agent CLI 并行预热，并为 Codex 旧原生会话恢复增加超时后 fresh session 接管；详见“CLI 预热与失效恢复”。

## 结论

v1.6.29 将联赛从“单个 Hub 内存队列 + 两分钟文件锁”升级为：

- SQLite 事务运行库：`<league-root>/.runtime/agent-league.db`
- 每次接班递增 `epoch`，所有任务/副作用提交都校验 fencing token
- DRAFT、Hook、FINAL、Weekly 是持久阶段检查点
- 开盘与收盘采用 `prepare → 外部文件写入 → applied` 的 effect 协议
- 普通关窗默认隐藏到托盘，Hub/PTY/调度器继续运行
- 明确退出或进程崩溃后，其他 v1.6.29 Hub 可按检查点接班
- Codex resume 不再重放绑定前的历史完成事件；联赛 attempt_id 继续作为第二层防线
- 首页把最新运行尝试、最近有效 FINAL、技术弃权和执行覆盖率分账呈现

这里的“断点续传”是阶段级，不承诺从模型思考到第几个 token 继续：已提交阶段不重做；崩溃时尚未提交的阶段会先核对 attempt，再安全重放。

## CLI 预热与失效恢复

- 赛程创建后立即启动全部 Agent 的 CLI 会话并并行检查就绪；`maxConcurrency` 只限制正在执行的模型 turn，不再让排在后面的 Codex 等前两个 Agent 结束后才启动。
- 若 Codex 带历史 `codexSid` 恢复，但在前 60 秒就绪窗口内没有进入可发送状态，运行时会原子清除旧 native/Hub 绑定，关闭中毒 PTY，用新 Hub Session ID fresh 启动，再给完整就绪预算。
- 若正在 DRAFT→Hook 之间切换，pending task、watchdog 和 durable heartbeat 会一起迁移到新 Session；旧 PTY 随后上报的 exit/turn-complete 不能再把新任务误判为技术弃权。
- fresh 接管与 Prompt 发送前都会复核当前 SQLite leader/epoch；Hub 一旦进入 handoff 或租约已转移，后台预热即使刚好超时也不能再改写共享 SESSION 或发送新 turn。
- fresh 启动仍失败时，会进入原有 durable retry/technical-forfeit 语义，不会伪造成功；这能消除已知的“反复重用同一个卡死 Codex resume”路径，但不代替 CLI 登录、网络和模型容量健康检查。

真实双 Codex 验收会消耗模型调用，因此必须显式开启；脚本只使用隔离 Hub 数据目录、独立 CDP 端口和临时联赛 vault：

```powershell
$env:RUN_REAL_AGENT_LEAGUE_E2E='1'
node tests/e2e-agent-league-two-codex-real.js
```

## 成熟系统经验如何落地

本实现没有直接引入大型调度依赖，而是吸收其稳定机制：

- Temporal Event History：用持久事件恢复，而不是相信 worker 内存；Activity 写操作必须幂等，worker 在“业务已完成但尚未回报”时可能被重试。
  - https://docs.temporal.io/encyclopedia/event-history
  - https://docs.temporal.io/activity-definition
- Apache Airflow HA Scheduler：多个 scheduler 可以并存，但临界区依赖数据库锁；dead scheduler 的 orphan task 由其他 scheduler 接管。
  - https://airflow.apache.org/docs/apache-airflow/stable/concepts/scheduler.html
- BullMQ stalled jobs：worker 通过心跳续锁，失联任务回到 waiting；系统语义是 at-least-once，因此 job 必须原子化、幂等化。
  - https://docs.bullmq.io/guide/jobs/stalled
  - https://docs.bullmq.io/patterns/idempotent-jobs
- SQLite：多进程读取、单写者串行提交，事务只向其他连接暴露完整 committed state。
  - https://www.sqlite.org/isolation.html
- Electron：后台运行需要独立生命周期；当前版本先以 Tray 保留完整 Hub 主进程和 node-pty 能力。
  - https://www.electronjs.org/docs/latest/api/tray

## 状态机

单 Agent 盘前任务：

```text
pending/draft
  → running/draft (attempt N)
  → pending/hook  (DRAFT checkpoint committed)
  → running/hook  (attempt N+1)
  → completed     (FINAL committed)
  ↘ technical-forfeit（同阶段自动重试预算耗尽）
```

开盘/收盘为每 Agent 独立 task，并使用稳定 effect key：

```text
<environment>:<phase>:<date>:agent:<agent-id>
```

同一个 effect key 若输入 hash 不同会直接报冲突；输入相同的重复调用返回已提交结果。

## 接班协议

1. 运行 Hub 同时持有短期兼容文件租约和 SQLite leader lease。
2. leader 每 5 秒续约，SQLite lease 默认 20 秒；旧文件租约 TTL 为 25 秒。
3. leader 正常退出时先停止派发，再 drain PTY，最后释放租约。
4. leader 崩溃时，其他 Hub 在租约过期后取得更大的 `epoch`。
5. 新 leader 将旧 epoch 的 `running` task 标回 `pending`，保留 DRAFT/Weekly 等 durable checkpoint。
6. 旧 leader 若恢复并提交，其 epoch 已失效，写入被拒绝；迟到 attempt 输出只记观察事件。

## 交易完整性

- 盘前 cohort 在开盘前必须全员进入 `completed` 或 `technical-forfeit`，否则拒绝部分成交。
- effect 在修改 Markdown 前先持久化结算前组合和快照 ID。
- 若在 `PORTFOLIO.md` 已写、`TRADES.md`/当日记录未写时崩溃，接班者从 prepared effect 重算，并按 trade ID 去重补齐。
- FINAL/Weekly 重放通过稳定 run ID 去重，避免 `decisionCount`、MEMORY 和 EVOLUTION 重复增加。

## 用户入口

- `联赛健康`：检查 vault、SQLite quick_check、scheduler、CLI、初心 API、T-1 数据、owner/epoch。
- 顶部运行状态：显示实际 owner PID、epoch、共享任务终态进度。
- Agent 行状态：显示 DRAFT、Hook、重试、技术弃权等 durable stage。
- `只跑这个 Agent`：用于新增 Agent 当日补跑或技术弃权后的人工重试；已完成同伴不会重跑。
- `关窗后台守护`：开启自动赛程时，关闭窗口只隐藏到托盘；托盘可重新打开或明确退出。

## 一次性升级要求

旧版本的开盘/收盘没有完整 fencing。第一次切换 v1.6.29 时必须：

1. 等当前联赛阶段终态，或确认 `.run.lock` 不存在。
2. 关闭所有 v1.6.27 及更早 Hub 一次。
3. 启动一个 v1.6.29 Hub，打开“联赛健康”，确认 SQLite、scheduler、CLI、T-1 数据均通过。
4. 此后可以多开 v1.6.29 Hub；不兼容 runtime protocol 会拒绝接班，而不是冒险重放。

不要让旧 Hub 与新 Hub 长期同时指向生产 vault。

## 回滚

1. 在 UI 关闭自动赛程。
2. 从托盘明确退出所有 v1.6.29 Hub。
3. 备份 `<league-root>/.runtime/`，不要直接删除。
4. Markdown 账本仍然可读；回滚旧代码前确认没有 pending decision 或未完成开盘 effect。
5. 若必须恢复旧版，只开一个旧 Hub，避免其无 fencing 的 open/close 与其他实例竞争。

## 已验证边界

- 同一 Windows 用户、同一机器、本机 NTFS。
- 普通关窗由 Tray 保活；机器关机或所有 Hub“明确退出”后，必须有一个 Hub 再次启动才会继续调度。
- 跨机器共享目录不在本版本支持范围；若未来需要，应改用服务端数据库/独立 Runner，而不是把 SQLite 放进同步盘。
- 模拟联赛，不连接真实券商。
