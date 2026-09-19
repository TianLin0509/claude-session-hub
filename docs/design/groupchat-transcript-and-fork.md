# 群聊记录存档与分支（2026-09-17）

用户提的三件事：群聊能不能整体分支、加成员之后到底怎么运作、能不能把已有会话拉进群聊。
实现分成两层：先修「成员拿到的上下文」，再在它之上做三个分支入口。

## 一、成员拿到什么上下文

权威事实仍然是 orchestrator 的 `state.messages`（`<hubData>/arena-prompts/<meetingId>-groupchat.json`）。
每轮给成员的 prompt 仍然是**增量**：`buildDelta` 只带它上次发言之后的新内容。三条新规则：

1. **没看过的用户提问要补上。** 原来 `buildDelta` 一刀切掉所有 `role==='user'`，于是
   刚加入 / 上一轮没被勾选的成员只看到队友答复，不知道在答什么问题。现在按
   `core/group-chat-transcript.js` 的 `isUserSpeech` 分辨：维护者的提问和中途补充算数，
   Hub 的派工卡片（`origin==='hub'` 或带 `dispatch`）和自愈提示（`systemNote`）仍然不进任何成员的上下文。
2. **本轮那条提问不重复。** 它由 `## 用户` 段承载。`_currentUserMessageSeq` 按内容认出它并排掉，
   串行工作流复用同一条用户消息发给下一位成员时也不会出现两遍。
3. **历史有预算。** `HISTORY_INLINE_BUDGET = 40000` 字符、单条 `SINGLE_MESSAGE_INLINE_LIMIT = 16000`。
   超出的部分不是丢掉，而是换成「群聊记录 md 的路径 + `#序号`」，让 AI 自己去读。
   投委会幕间的全量注入（`includeCommitteeMid`）有自己的契约，不受预算约束。

每条内联发言的格式是 `#<seq> <说话人>：<正文>`，序号就是 md 里的锚点。

## 二、群聊记录 md

`<hubData>/arena-prompts/<meetingId>-transcript.md`，由 `core/group-chat-transcript.js` 渲染。

- **它是投影，不是事实。** 删掉不丢任何东西，下一次状态保存会重新生成。所以写失败只告警，
  绝不拖垮一次正常的状态保存。
- 内容按轮分段，每条一个 `### #<seq> <说话人> · 时间 · 标签`。**正文永不截断**——
  截断是 prompt 那一侧的事，这里正是那一侧的兜底去处。
- 过程汇报（`status === 'progress_update'`）不收录。
- 写盘有指纹去重（`transcriptSignature`）：一轮要保存十几次状态，内容没变就不重写。
- 群聊删除时一起清理（`cleanup`）。

## 三、三个分支入口

分支参数由 `core/session-fork-plan.js` 统一计算（单会话分支、加入群聊、整群分支共用），
成员创建一律走 `addMeetingSubInternal`——群聊成员要的 MCP 注入、DeepSeek 记忆注入、
槽位登记、参与者勾选都长在那里，绕过去就会得到一个「看着在群里、其实没有群聊工具」的成员。

| IPC | 入口 | 行为 |
| --- | --- | --- |
| `groupchat:add-existing-session` | 会话右键「加入群聊…」、群聊「+ 成员 → 从已有会话分支…」 | 从原会话分支出一个新会话进群，**原会话不动** |
| `groupchat:create-from-sessions` | 会话右键「加入群聊… → 新建群聊」 | 一次分支多个会话开一个新群 |
| `groupchat:fork-meeting` | 群聊右键「分支群聊」 | 每位成员各分支一份 + 复制群聊记录 |

**为什么是分支而不是把原会话搬进来**：MCP 是启动时注入的，跑起来的会话改不了；
而且原会话可能正被另一个 Hub 打开。分支既继承了原会话的上下文，又是一个由本群聊配置出来的新进程。

### 整群分支的硬性约束

- 轮次进行中、有未结算的发送 → 拒绝。
- 开发群聊 / 启用了串行工作流 → 拒绝：两个分支会共用同一个工作目录和交付文件。
- 成员发过言却没有原生会话 ID → 整体拒绝（少一个人的群聊不是这个群聊的分支）；
  一次都没发过言的席位没有上下文要继承，按同配置新建即可。
- 任一成员失败 → 整体回滚，不留半个群聊。
- 记录搬运在**成员全部就位之后**才做（`importForkedState` → `core/group-chat-fork.js`）：
  每一张按 sid 记的账本（已读游标、成员身份、逐轮结果、统计、补充送达）都改名到新会话；
  在途投递账本（`attempts`/`pendingPrompts`/`activeRun`）和消息上的 `attemptId`/`providerTurnId`
  一律不继承，它们指向源侧的原生 turn。分支时已退群成员的历史发言保留正文，
  但 sid 打上 `fork-orphan:` 前缀——不能让新群聊的卡片指向别人房间里活着的会话。

## 三点五、分支的真实代价：Claude 要重放历史（2026-09-18 事故）

两家的分支根本不同：Codex 的 `thread/fork` 在 App Server 服务端完成（实测 0.6 秒），
Claude 只能 `claude --resume <父会话> --fork-session`，CLI 必须把父会话整段读进来再写成
新会话文件。实测 17.1 MB / 884 条记录的父会话要 **124.6 秒**才回握手。

而 Hub 的 initialize 等待原本写死 60 秒，于是必然出现「先报错、一分钟后自己好了」：
60 秒判连接失败 → 群聊那条提交被标成 `submission_unknown` → 侧栏亮异常 →
引擎其实连上并把这一轮跑完了。历史越大越必然踩到。

修法（`core/claude-handshake-timeout.js`）：
- 全新会话仍是 60 秒，行为不变；resume / fork 按父会话 transcript 字节数放宽
  （基准 60 秒 + 25 秒/MB，封顶 10 分钟）。25 秒/MB 是按实测 7.3 秒/MB 留 3 倍余量。
- 量不到父会话文件（迁过目录、provider 放在别处）就回落到基准，绝不因为量不准而启动失败。
- 载入期界面说人话：「正在载入历史（17.1 MB），大会话可能要一两分钟」，
  而不是和真故障共用一句「等待连接响应」。放宽后的预算同时写进 backstage 和主进程日志，
  出问题时第一个要回答的就是「当时到底等了多久」。

**所以从大历史群聊分支，Claude 成员天然要等一两分钟才开口**，这是 CLI 的代价，不是故障。

## 四、验证入口

- `node tests/unit-groupchat-transcript-fork.test.js`：md 投影、预算与截断、状态迁移
- `node tests/unit-groupchat-fork-ipc.test.js`：三个 IPC 的拒绝理由、参数透传、失败回滚
- `node tests/e2e-groupchat-transcript-fork-cdp.js`：真实隔离 Hub 的端到端（15 项）
- `node tests/e2e-groupchat-fork-ui-cdp.js`：三个界面入口用真实鼠标点一遍（15 项）
- `node tests/e2e-groupchat-fork-stress-cdp.js`：多轮 + 反复分支 + 并发 + 增删成员 + 重启（16 项，
  `GC_STRESS_ROUNDS` 可加压）
- `node --test tests/unit-claude-handshake-timeout.test.js`：握手预算的取值、降级与文案
- `node tests/e2e-claude-fork-handshake-cdp.js`：真实隔离 Hub 里用 12 MB 伪造历史验证预算真的放宽

E2E 全部用 Codex App Server fixture 扮演成员：不花钱、不碰生产数据。
