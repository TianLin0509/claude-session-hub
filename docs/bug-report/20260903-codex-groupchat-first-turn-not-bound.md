# 未修复：群聊 Codex 首轮 transcript 绑不上，导致整条 prompt 被重发

**状态：已定位到机制，未根因化，未修复。** 属既有问题（master 上同样复现），
与 2026-09-03 的「长 prompt 提交可靠性」修复无关。

## 现象

新建的 Codex 群聊成员，**第一轮**提问：

- Codex 实际收到了、也答了 —— 屏幕上打出了正确答案，rollout 文件里
  `task_complete` 与 `last_agent_message` 都在，内容正确
- 但群聊面板一直转，`groupchat:get-state` 里 `turns: 0`、`currentMode` 卡在 `group`、
  `aiStats: {}`，420 秒也等不到本轮结束
- 第 2、3 轮完全正常（`auto_recovered`/`ok`，10-18 秒答完）

## 已确证的机制

Hub 主进程日志直接点名：

```
[group-chat] codex transcript not bound for Codex 1(c368c5a9) after 90s (bindGrace=90s); retrying prompt submit #1
```

transcript 90 秒没绑上 → dispatcher 判定"没送到"→ **把整条 prompt 重发一遍**。
rollout 里因此留下两条一模一样的用户消息（本例 3192 字 ×2）和两个 `task_complete` ——
**多花了一整轮的 token，而且那一轮的答案仍然没被 Hub 收走。**

## 已排除的原因（都做了取证，不是猜测）

| 怀疑 | 结论 |
|---|---|
| prompt 没提交 | 排除。`sendStatus: ok`，屏幕有答案，rollout 有 `last_agent_message` |
| Codex 没写 rollout | 排除。文件在 `<CODEX_HOME>/sessions/2026/09/03/rollout-*.jsonl`，25 行 94KB |
| `codexSessionsRoot` 没传对 | 排除。隔离实例的 `state.json` 里该字段正确指向隔离 sessions 目录 |
| 扫描目录算错（本地/UTC 日期差） | 排除。`_candidateDirs()` 算出的目录存在且含该 rollout |
| `_tryBind` 的时间窗 [-10s,+300s] | 排除。rollout 时间戳与会话注册只差 2.3 秒 |
| prompt 指纹匹配失败 | 排除。离线用真实 rollout + 真实 prompt 复现，`requirePromptMatch=true` 也能 BOUND |
| `notePrompt` 参数错位 | 排除。外层 `TranscriptTap.notePrompt(sid, kind, prompt)` 签名正确、转发正确 |
| rollout 被永久标记 `_seen` 而不再回看 | 排除。`_tryBind` 有 `sawMatchingPendingCwd` 守卫，同 cwd 有 pending 时不标记 |

**所以：所有输入都对，离线重放能绑上，线上就是绑不上。** 剩下的嫌疑集中在
live 扫描时序上——`_readUserMessageEvents` 在某个中间状态读到的内容与最终不同，
或 `_pending` 条目在首轮期间被别处清掉/替换。

## 下一步（最省力的一条）

**`_tryBind` 目前在每条拒绝路径上都是静默 `return`，一条日志都没有。**
这正是它难查的原因。建议先加一层 debug 级拒因日志
（cwd 不匹配 / 时间窗外 / 无 expectedPrompt / 指纹不匹配 / 多候选未决），
再跑一次即可直接定位。改动很小，且对以后所有绑定类问题都有用。

复现命令：

```powershell
$env:HUB_STRESS_PROVIDERS='codex'; $env:HUB_STRESS_SURFACES='groupchat'; $env:HUB_STRESS_SIZES='60'
node tests\diag-real-prompt-submit-stress.js
```

失败时该脚本会把 Hub 主进程日志尾巴（`codex-tap` / `group-chat` / `paste-trapped`）
一并打出来。加 `HUB_STRESS_KEEP_TEMP=1` 保留隔离实例的 rollout 与 hub-data 供取证。

## 影响面提示

隔离测试用的是**全新 `CODEX_HOME`**（`sessions/` 目录一开始都不存在）。
生产环境的 `~/.codex/sessions` 早已存在且塞满历史 rollout，扫描路径与候选集都不同，
**未必同样表现**。定性为"生产也有"之前需要在真实 profile 上单独验证一次。
