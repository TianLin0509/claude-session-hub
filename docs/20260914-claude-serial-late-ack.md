# Claude 串行群聊提交确认晚到

## 生产证据与根因

2026-09-14，群聊“决赛材料八页展示”的第 3 轮串行步骤在 Claude 席位失败。
只读核对 per-meeting、groupchat、native-agent-submissions 和该 Claude UUID 的原生 transcript：

- 17:06:27.455 UTC 记录 submitting；17:06:43.191 UTC 才记录 submission-accepted，间隔 15.736 秒，越过默认 15 秒确认期限。
- 超时走 `disconnect(CLAUDE_SUBMISSION_TIMEOUT)`，把 `unreconciled` 置为 true。原来的晚到 echo 只将 UI 改为 starting/accepted，没有清除此标志，后续 assistant/result 被过滤。
- 引擎实际上继续调用工具，并于 17:12:05.225 UTC 写入 1673 字符的 end_turn 正文。Hub journal 仍停在 accepted，群聊没有收录。
- 串行流程对待核对提交又尝试派发；driver 拒绝 `CLAUDE_SUBMISSION_UNKNOWN`，群聊把它泛化为 provider_error，覆盖了最初的派发身份。
- 手动同步只找 transcript tap / PTY，未按 Claude 原生提交身份取结果，因此报出不适用的 Stop hook / idle-timer 提示。

这不是本次尚未合并的后台 UI 改动触发的故障。未写生产 state、未操作生产 writer、未重发该任务。已存在的原生最终回答可只读取回；本次修复不会自动重启旧实例或消除旧实例里已有的待核对状态。

## 修复

1. 仅同一个仍连接的 writer、同一 epoch、同一原始 UUID 与内容的晚到确认，可以解除该提交自身的确认超时。其他断线、内容不符、重连和历史不确定性不会被解除；不自动重发。
2. Claude 提交待核对归类为 reconciliation；串行步骤立即暂停，不消耗第二次派发来重试。
3. Claude 手动同步只读取本轮 attemptId 对应的原生成功终态，包含尚未汇总成 turn 的 pendingPrompts 身份。缺身份、未完成、空结果均明确拒绝，不用最新回答顶替旧轮。
   原生成功回执与失败气泡的 attemptId 一致时显示“原生已完成 · 待同步”。用户同步后再点继续，只有同一 workflow run/step 的证据可以跳过已完成步骤，随后派给下一位。
4. 实际 transcript 同时证实 SDK 会将同一 API message ID 拆成多个 assistant block 帧。后台以累计 block index 保持每块身份，直到 message_stop 才结束流，历史反向分页前先计算正向索引，避免思考和正文互相覆盖。

## 验证

- `node --test tests/unit-claude-native-recovery.test.js tests/unit-claude-backstage.test.js tests/unit-native-backstage-status.test.js`
- `node tests/unit-groupchat-attempt-protocol.test.js`
- `node tests/unit-groupchat-recovery-ipc-contract.test.js`
- `node tests/unit-loop-engine.test.js`
- `node tests/e2e-claude-serial-late-echo-cdp.js`：真实隔离 Hub、两位 Claude、真实串行派发、15.7 秒晚到 echo、完成回执、真实同步按钮。检查只发送一次、流程暂停、回答准确收录。
- 最终完整候选须重新跑隔离 `merge_task.py --dry-run` 和正式合并闸门。

UI / GUI 采用原生协议 fixture，不代表真实模型服务可用性全面验收。

## 合并审查发现的独占数据库初始化竞争

正式全量检查触发 `unit-session-open-ownership.test.js` 的 `database is locked`，合并脚本按规则回滚。通过 8 个进程在 WAL 切换前同步放行，原主干实现可复现失败，定位到并发首次初始化的 `PRAGMA journal_mode=WAL`，不是仅凭负载猜测。

初始化改为只对 SQLITE_BUSY 有界重试：先关闭失败连接以释放锁，再重新打开；建表与旧表加列在同一事务中完成；初始化成功后保留原来的 1000 ms 业务事务等待策略。永久错误、超出重试预算和关闭失败仍上抛，不伪造会话归属成功。

新增回归覆盖同步首次初始化、同步旧表迁移、永久错误传播、持续锁冲突的超时及连接关闭。已有单 writer/占用者拒绝规则保持不变。
