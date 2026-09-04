# DEPLOY NOTE 20260903 — 长 prompt 卡在 CLI 输入框不提交

## 用户现象

在 Hub 下方输入框回车后，内容进了 CLI 输入框却折叠成 `[Pasted text +N lines]` /
`[[Pasted Content N chars]]`，**没有提交**，也没有任何提示。用户干等几十秒才发现 AI 根本没动。
输入越长越容易出现；群聊尤甚（prompt 带全上下文，最长）。普通/群聊、Claude/Codex 都中招。

## 根因

**不是「回车没发出去」，是「回车被 paste 缓冲吞掉」，而且长输入必然被吞。**

node-pty 1.1.0 在 Windows 上走 `this._agent.inSocket.write(data)`
（`node_modules/node-pty/lib/windowsTerminal.js:113`），这是 named pipe 上的 `net.Socket`，
**有内部队列、异步排空**。几十 KB 的 payload 写下去之后再 `write('\r')`，这个 `\r` 被追加进
同一条队列，很可能与 `BP_END` 一起落进 CLI 的**同一个 stdin chunk**。Ink 拿到
「正文 + BP_END + \r」这一整块时，`\r` 被当粘贴尾巴丢掉。

固定延时在短 prompt 下够用，长 prompt 下必然落在排空窗口内 —— 这就是「越长越容易卡」。

放大这个问题的是：**四条发送路径里有三条是开环的**，发完不验证、不重试、不提示。

| 路径 | 修复前 | 位置 |
|---|---|---|
| 普通会话浮动输入框 | BP 一次写完 + 700/900/1100ms 盲发 3 次 `\r` | `renderer/renderer.js` `sendInput` |
| 卡片「↺ 重发」 | `promptText + '\r'` 单次写完，**连延迟都没有** | `renderer/renderer.js` |
| 会议普通模式发送 | 裸写 + 400~900ms 后盲发 1 次 `\r`（sizeDelay 封顶 500ms） | `renderer/meeting-room.js` |
| 群聊派发 | 已有闭环，但 settle 写死 500ms | `core/group-chat-watcher.js` |

项目里其他调用方（study / agent-league / chatgpt-bridge / chuxin）早就不走裸
`terminal-input` 了 —— `main/ipc/study-handlers.js:668` 的注释白纸黑字写着「刻意不用」。
上面那三条是漏网的。

## 改动

### 新增 `core/pty-prompt-submit.js` — 三个原语

- `computeSettleMs(len)`：settle 时长 = `clamp(300 + len/20, 500, 3000)`ms，不再写死。
  下限 500ms 保证短 prompt 一点没变慢。
- `writeBracketedPaste()`：payload 按 2KB 分片、15ms 一停。分块的意义不是更快，而是让
  socket 队列在最后一片写完时接近空，`\r` 才可能独立成一个 stdin chunk。
  **切片不劈开代理对**（emoji 分两半写会各自编成无效 UTF-8）。
- `waitForPasteSettled()`：等屏幕上出现**与基线不同**的折叠标记 —— 这是「CLI 已经吃完这次
  粘贴」的正向信号，比干等准。比对基线是必须的：Ink 每帧全屏重绘会把上一次粘贴的旧标记
  反复刷进新字节，不比对就会立刻误判、提前把 `\r` 打进消化窗口里。

### 新增 `main/ipc/prompt-submit-handlers.js` — 普通会话闭环

`session:send-prompt` / `session:resend-prompt`。普通会话从此与群聊共用
`group-chat-watcher.sendToPty`：分块投喂 → 自适应 settle → 单发 `\r` →
等 Claude `UserPromptSubmit` / Codex `task_started` 语义确认 → 缺确认才补**一次**回车 →
仍无确认就如实返回 `stuck`。

- `sendToPty` 新增 `options.requireReady`。普通会话传 `false` 跳过 60s 冷启动 ready 轮询 ——
  输入框就摆在用户面前，CLI 显然在跑，再等一次会把「打完字立刻发」变成干等几十秒。
- **每会话串行化**：分块投喂引入的新风险是两条 payload 并发写同一 PTY 会交错成乱码，
  入口用 promise 链挡掉。不同会话之间仍并行。
- 宿主 shell（powershell 等）不走这套，保持 `text + '\r'` 直写。

### UI：卡住必须看得见

`sendStatus === 'stuck'` 时输入栏上方弹一条 `.fi-stuck` 提示条 +「补发」「忽略」按钮。
补发走 `resendCurrentPrompt`，它会先用 prompt 首行指纹判断原文还在不在输入框：
在 → 只补回车；不在 → 整条重写。**不盲发回车**，否则会在「原文其实没进去」时提交空输入框。

### 压力测试逼出来的两个补充修复

这两个都是**真机跑出来才发现**的，单测和静态检查都看不到：

1. **补发回车的预算被「屏幕在跑」的守卫吃光。** `retryMax=1` 时，
   `looksAlreadyRunning` 命中一次的 `continue` 就把 attempt 推到上限，循环结束 ——
   **补发回车一次都没发**却报了 stuck。实测现场：Codex 普通会话连发，第 2 条 220 行的
   prompt 以 `› [Pasted Content 10377 chars]` 卡在输入框，而屏幕因为上一轮还在收尾被读成
   running，`enterAttempts` 停在 1，用户干等 5 分钟。
   **修法不是加预算，是换证据**：区分两种情形的不是重试次数，而是
   **输入框里还有没有没提交的折叠粘贴**（`pasteStillInInputBox`）。
   有 → 这次粘贴没提交，必须补回车；没有 + 屏幕在跑 → 已提交，补回车反而会多起一轮
   （那是 `unit-groupchat-redundant-enter-guard` 锁住的实测教训，仍然成立）。
   只看可见屏幕末尾行，不整条扫 ring buffer —— 后者是只增历史，提交成功后标记仍在里面。

2. **「屏幕跑过 + 输入框空」被误报成 stuck。** 新建 Codex 会话的第一轮，rollout 还没绑定
   所以 `task_started` 迟到，答案又短到 running footer 撑不满确认帧 —— 于是没有任何
   lifecycle 确认。但屏幕上答案已经打出来、输入框空着。此时报 stuck 是自相矛盾的
   （stuck 的含义是"还躺在输入框里"），生产里会给一次完全正常的发送弹「⚠ 消息可能没提交」。
   现在这种情况按 `pty-running-input-clear` 记为已提交。

### 顺带修掉的两个既有缺陷

1. **`PASTE_MARKER_REGEX` 认不出现版 Claude 格式。** 正则要求 `Pasted text` 后直接跟数字，
   而 Claude Code 现在渲染的是 `[Pasted text #1 +120 lines]`（多了粘贴槽位号）。
   补 `(?:#\d+)?`。**修之前群聊的 paste 巡检对 Claude 会话一直是瞎的。**
   捕获组仍落在体积数字上（`tick()` 靠它判断「还是同一条 marker」，取成槽位号会让每次新粘贴
   都看起来体积没变）。
2. **`resendCurrentPrompt` 的 `rewrite_full` 对 Claude 走裸写 + 150ms + `\r`** ——
   正是被修掉的那套开环时序。补发是这个 bug 的恢复路径，自己再踩一次同一个坑毫无意义，
   改走同一套分块 + 自适应 settle。

## 验证

- 单测 969 项：964 通过。3 个失败在干净树上同样失败（kimi contract、presets 加载顺序、
  workspace tuning），与本次改动无关。原先第 4 个失败是版本号漂移
  （`package.json` 1.6.45 vs lock 1.6.43），本次升到 **1.6.46** 时三处对齐，已修好。
- 新增 `tests/unit-pty-prompt-submit.test.js`（8 项）、
  `tests/unit-prompt-submit-ipc-contract.test.js`（7 项）、
  `tests/unit-prompt-submit-ui-contract.test.js`（10 条源码契约）。
- `tests/unit-groupchat-redundant-enter-guard.test.js` 新增
  「running 屏幕不能替输入框里没提交的粘贴开脱」一例，并给原有那例补上
  「不得误报 stuck」的断言 —— 两条都是压测现场逼出来的。
- `tests/unit-group-chat-watcher-codex-ack.test.js` 里「整条 payload 必须是单次 write」
  的断言改成重组校验 —— 那正是本次有意改掉的行为，新断言更强（验分块无损 + BP 帧完整）。
- 启动 smoke（隔离数据目录）：`[群聊] hook server listening on 127.0.0.1:3464`。
- 真机压力测试见下。

### 压力测试

```powershell
node tests/diag-real-prompt-submit-stress.js
# 单格：$env:HUB_STRESS_PROVIDERS='codex'; $env:HUB_STRESS_SURFACES='normal'; $env:HUB_STRESS_SIZES='600'
# 修复前基线（复现旧的 700/900/1100ms 开环时序做对照）：$env:HUB_STRESS_LEGACY='1'
```

矩阵：`{普通会话, 群聊} × {claude, codex} × {60, 220, 600 行}`。用真凭证跑真 CLI，
只起隔离实例、只关自己起的 PID。每格三条判据全过才算通过：

1. `sendStatus ∈ {ok, auto_recovered}`，不能是 `stuck`
2. 拿到语义确认，且 `enterAttempts ≤ 2`（不能靠狂发回车蒙对）
3. AI 真回了带 marker 的那一行（端到端确认 prompt 完整进去了）

`HUB_STRESS_LEGACY=1` 会用 IPC 逐字节复现修复前的开环时序，用来证明这个修复确实改变了
结果，而不是测试本身太宽松。

### 实测结果（2026-09-03）

**修复前 vs 修复后（普通会话，同样三档体积）**

| 格 | 修复前（700/900/1100ms 盲发） | 修复后（闭环） |
|---|---|---|
| codex 60 行 / 2,892 字 | 通过 | `ok · enter=1` |
| codex 220 行 / 10,376 字 | **失败：`prompt 卡在输入框：[Pasted Content 10379 chars]`** | `auto_recovered · enter=2 · 12.9s` |
| codex 600 行 / 28,236 字 | **失败：卡在输入框** | `auto_recovered · enter=2 · 16.3s` |
| claude 60/220/600 行 | 三格均通过 | `ok · enter=1`（3.7-5.0s） |

**诚实标注**：可复现的开环失败是 **Codex 特有**的，本轮**没有**复现出 Claude 的失败。
Claude 那侧的问题不是"实测会卡"，而是**旧代码一旦卡了就永久静默、无检测无补救**
（没有任何确认、重试或提示）。所以对 Claude 的收益是"失败可见、可自愈"，不是"修好了实测失败"。

**修复后完整矩阵：11/12 通过**

| | 60 行 | 220 行 | 600 行 |
|---|---|---|---|
| claude / 普通 | ✅ ok/1 | ✅ ok/1 | ✅ ok/1 |
| codex / 普通 | ✅ ok/1 | ✅ auto_recovered/2 | ✅ auto_recovered/2 |
| claude / 群聊 | ✅ ok/1 | ✅ ok/1 | ✅ ok/1 |
| codex / 群聊 | ❌ 见下 | ✅ auto_recovered/2 | ✅ auto_recovered/2 |

唯一失败格 **codex/群聊/60 行** 在 **master 上同样失败**（stash 掉本次全部改动做的基线对照：
master 1/3 通过，改动后 2/3 —— 600 行那格正是被本次修复救回来的）。
现象是 Codex 屏幕上答案已打出，但群聊编排没拿到，`answered:false`：这是**新建 Codex 会话
第一轮 rollout 尚未绑定**导致的答案抽取问题，与 prompt 提交无关，属既有问题。
另注：隔离测试用的是全新 `CODEX_HOME`（`sessions/` 目录都不存在），生产环境未必同样表现，
定性前需要单独查证。

## 注意

- Claude 侧的隔离测试必须给 `CLAUDE_CONFIG_DIR` 播一份 `.claude.json`
  （`hasCompletedOnboarding: true`），否则 CLI 停在 onboarding 向导，
  表现为 `timeout claude startup frame`。
- `bracketedPasteSettleMs` 显式配置时仍按固定值走，保留测试与应急旁路。
