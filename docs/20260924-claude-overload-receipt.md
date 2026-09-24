# Claude 过载期间的提交确认：从「等回显」改为「看原生历史」

## 生产证据（2026-09-24，会话 92add9e9，Claude Code 2.1.280）

只读核对原生 transcript 与 Hub 后台库，时间为 UTC：

- 18:08:41.035 第一条输入写进原生 transcript（enqueue→dequeue→user 行，距写入 27 ms）。
- 18:08:41.41 引擎发出 `system/init` 与 `system/status: requesting`。
- 18:09:41 Hub 60 秒确认期限到，`CLAUDE_SUBMISSION_TIMEOUT`，会话进入「待核对」。
- 18:09:43 起 `system/api_retry`（529 overloaded）陆续到达；Hub 只记进后台，不参与状态判断。
- 18:10:36 用户发第二条。`prepareForNewPrompt` 见待核对即 `reconnect()`，杀掉正在重试第一条的 writer；
  resume 后引擎自动插入 `Continue from where you left off.` / `No response requested.`，第一条永远不会被回答。
- 18:10:38 第二条写进 transcript；18:11:38 再次超时，IPC 返回 `ok:false`，渲染端记为「提交失败」。
- 18:13:04.989 API 恢复，stdout 回显才到，晚到确认把第二条纠正为 accepted。

结论：`--replay-user-messages` 的回显在模型开始流式输出时才发，量的是 API 首字节，不是引擎收到。
API 过载时它必然越过任何固定期限。

## 修复

1. **收到的证据改为原生 transcript**（`core/claude-receipt-probe.js`）。引擎在出队时就把 Hub 指定 UUID 的
   user 行写进 transcript。收到当前 writer 的 system 帧时（节流 2 秒）或期限到时，读 transcript 尾部
   8 MB，按字节找 UUID，只解析命中行；身份与正文（`echoMatches`）都一致才算收到。
   行被窗口截断、找不到、正文不符一律不算证据，退回原有行为（等回显或判 unknown），不猜。
2. **收到即 accepted**，与回显共用 `acceptSubmission`：同一 writer、同一 epoch 才可解除自身的超时待核对；
   之后到达的回显只静默再确认，不重复发 `submission-accepted`。
3. **重试可见**：`system/api_retry` 写入 `runtime.apiRetry`，输入框状态行显示
   「Claude 服务繁忙（529），引擎自动重试第 N/M 次 · 用时」；模型开始输出或本轮结束时清除。
4. **超时不再显示「提交失败」**：写入已发出但结局未知时 IPC 带 `unconfirmed:true`，渲染端记为「提交结果未确认」。
5. **发送前恢复不杀活的 writer**：超时待核对的那条若已在 transcript 里，先确认它，新消息排队在后，不重连。
   transcript 里没有才照旧重连（引擎确实没收到，重连不丢用户的东西）。

不变的边界：不自动重发；transcript 只证明收到，不证明完成；结果仍只认 `result` 帧。

## 验证

- `node --test tests/unit-claude-receipt-overload.test.js`：真实子进程 fixture（`--fixture=overloaded`）复现
  「transcript 立即写入、回显等 N 次 529 之后」。撤掉修复时三个事故用例失败，恢复后通过。
- 用生产那份 5 MB transcript 只读复核：两条输入按 Hub 日志里的原始指纹都判 `received`，耗时 3–6 ms。
- `node tests/e2e-claude-overload-cdp.js`：隔离 Hub + 真实输入框，529 持续约 75 秒（越过 60 秒期限）。
  0.2–0.3 秒显示「引擎已收到」，状态行显示重试次数与已等时长；30 秒时再发第二条会排队，不会重连。
  全程 79 个快照中没有 unknown，两条都由同一个 writer（同 epoch、同 pid）答完。
- 既有 `e2e-claude-native-cdp.js --mode=approval|hold|recovery` 与 `e2e-claude-serial-late-echo-cdp.js` 通过。
- `node scripts/run_unit_tests.js` 全量跑两次，各有 557/558 通过。两次失败分别是 Codex 的
  `unit-codex-lazy-start` 与 `unit-codex-migrator-backup`，单独重跑都通过，本次改动也没有碰到它们的代码路径。

UI 验证使用协议 fixture，不代表真实 Anthropic 服务的可用性。
