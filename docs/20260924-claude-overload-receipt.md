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

## 追加：不再为「待核对」弹提示（同日，用户决定）

用户反馈：输入框上方经常出现「上次任务状态待核对 / 核对上次任务」，很蠢、很碍眼，要求不再提示。

生产日志（2026-09-17~24，native-agent-submissions）统计：待核对的 Claude 记录共 86 条，
其中 83 条是后台活动（`task-notification`，也就是 Monitor 事件、后台命令完成通知），提交只有 3 条。
83 条里 77 条出自 09-23 已修的「通知并入主回合」问题；今天那 4 条是修复前残留的，
Hub 重启后恢复成待核对，而连上时的自动核对故意跳过后台活动，只能等人点按钮。

那个按钮能做的只有一件事：登记 do-not-replay。它不重发，也不追认成功。让人去点它毫无增益，所以：

1. **后台活动自动登记**（`ClaudeNativeActivities.settleUnknown`）：放弃、恢复、重连时，结果未知的注入回合
   当场记为 `unknown` + `reconciliation.history='engine-internal'`。正文保留，不编造成功，不亮待核对，也不挡发送。
2. **普通会话连上即完整核对**：`_start` 的自动核对改用与按钮相同的语义，找不到历史时记为 `history-missing`。
   此刻旧 writer 已确认退出，旧提交不可能还在跑。原先更严的 `automatic` 分支没有调用者了，已删除。
   **群聊 / 无人值守席位不变**：它们根本不自动核对，停下来防止重复派工的关卡保留。
3. **writer 仍活着、但拿不到收到证据**（极少见，需要 60 秒内 transcript 里都没有那一行）：输入框只平静地说
   「Claude 未确认收到上一条，可直接继续发送」，不写待核对、不带按钮、不亮警示色，侧栏也不标记。
   这种情况不能显示「已就绪」，因为引擎可能还在跑。
4. 超时不再作为 `action-error` 挂成红字（晚到的确认纠正状态后，它原本要到重连才会清掉），改记到后台。

仍然保留按钮的情况：停止操作没有得到确认（此时发送被闸住，按钮是唯一出口），以及群聊 / 无人值守席位。

改了哪些测试：守旧规则（「必须等人核对」）的测试改为新规则。测「过期 UI 身份被拒、旧消息绝不重发」
这类不变量的测试改用群聊席位来跑，因为那里的人工关卡没变，防线原样保留。

验证：全量单测 558/558 通过。E2E approval / recovery（单独跑连续两次）、serial-late-echo、overload 通过。
`e2e-claude-native-cdp.js --mode=background` 失败，但在主干 `56aeb43` 上同样失败，是原本就有的问题，与本改动无关，未处理。
