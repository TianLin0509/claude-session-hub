# 2026-05-03 · 三 Claude Sonnet 圆桌调试 — 测试 & 改进 Spec

> 作者：道雪 / Claude（Opus 4.7）
> 状态：待用户审阅
> 关联代码：`renderer/meeting-create-modal.js`、`main.js`（cli-ready / manual-extract）、`core/transcript-tap.js`、`core/turn-completion-watcher.js`、`renderer/meeting-room.js`

---

## 1. 背景与范围

### 1.1 起因

圆桌功能在混合 backend（claude / gemini-cli / codex-cli）下暴露不少 bug，三家 CLI 行为差异大，单条 bug 经常牵涉多家、根因难定位。**先把混合默认折叠成「3 个 Claude Sonnet 4.5」**，把状态机、文本提取、一键提取这条主线跑稳，再回过头来扩展到混合场景。

> 默认值改动（已 land 2026-05-03）：`renderer/meeting-create-modal.js:36-44` 的 `DEFAULT_SLOTS` 由
> `[claude opus / gemini flash / codex gpt-5.5]` 改为 3 × `{kind:'claude', model:'claude-sonnet-4-5'}`。
> 同步更新静态测试 `tests/meeting-create-modal-static.test.js`。

### 1.2 In Scope（本期必须跑通）

| 关注点 | 用户原话 | 对应主线代码 |
|---|---|---|
| **F1 创建 ready 状态机** | 从 shell 输入 `claude XXX` 起算"创建中"，到输入框可用算 ready；UI banner「XXX/XXX 启动中」与卡片状态保持一致 | `main.js:1865-1910` `cli-ready-status` IPC、`renderer/meeting-room.js:1622-1710` 轮询 + banner |
| **F2 长回复完整性** | 多轮交流尤其工具/skill 调用时，3 张卡片 tab 的文本不能在 AI 还没答完就被判为 settle | `core/turn-completion-watcher.js`、`core/transcript-tap.js:836-872` (idle_timer)、`core/transcript-tap.js:189` (extractLatestTurn) |
| **F3 一键提取兜底** | 自动提取失败时手动按钮必须能补救 | `renderer/meeting-room.js:563` 按钮 → `meeting-room.js:854` IPC → `main.js:1577` `transcriptTap.extractLatestTurn` |

### 1.3 Out of Scope（本期不碰，留待后续 spec）

- 混合 backend（gemini-cli / codex-cli / deepseek / glm）— 等 3 claude 通过后单独立项
- Resume / 切走切回会话状态保持
- 5 轮+ 长上下文累积、跨轮 prompt 互引深度测试
- 假死 / 90s+ 超时兜底 / 软提醒 banner 的完整覆盖
- 性能基线（启动时间、内存占用）

---

## 2. 测试计划

### 2.1 隔离 Hub 启动 SOP

**所有测试一律在隔离 Hub 实例跑，绝不动用户生产 Hub。** 启动模板（出自项目 `CLAUDE.md`）：

```powershell
# 终端 A — 启动隔离 Hub 实例
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-3claude-debug"
cd C:\Users\lintian\claude-session-hub
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9230
```

**验证启动成功**：日志看到 `[hub] hook server listening on 127.0.0.1:34xx`，且新窗口（不是用户日常的那个）出现。

**复位测试数据**：每轮重新调试前 `Remove-Item -Recurse C:\temp\hub-3claude-debug` 清状态（PS 5.1 别动主项目 `node_modules`）。

### 2.2 手测 SOP（主线，三个场景）

> **铁律**：每一步**完全模拟真实用户从 UI 操作**——通过 Playwright MCP 走 CDP 协议点 UI 元素，**严禁**绕过 UI 直接调 IPC handler 制造"假 E2E"。即使只是"创建一个圆桌"也走 modal → 选 slot → 点按钮，不走 `ipcRenderer.invoke('create-meeting', ...)`。

#### 场景 S1 · 创建 ready 状态机

**步骤**：
1. 在隔离 Hub 侧边栏点 + → 「新建圆桌」（不要带任何参数，验证默认就是 3 claude sonnet 4.5）
2. 截图 modal 默认状态
3. 点「创建圆桌」按钮，**同时启动秒表**（记录 t0）
4. 持续观察并记录：
   - **t1**：3 个子 session 卡片首次出现的时间
   - **t2**：输入框上方 banner「N/3 启动中」首次出现的时间
   - **t3**：banner 消失的时间（即 3 家全部 ready）
   - **t4**：3 张卡片状态文字从「创建中」切到「待命」的时间（按家分别记 t4a/t4b/t4c）
5. 同时观察并记录：
   - banner 显示的家数变化轨迹（3/3 → 2/3 → 1/3 → 消）
   - 卡片状态切换是否与 banner 计数同步
   - shell tab 里 `claude` 命令是否完整入 PTY（截图 shell tab 的可见输出）

**期望**：
- t1 ≤ 1s（卡片立即创建）
- t2 ≤ 2s（banner 不能晚出现，否则用户首屏看不见提醒会盲发）
- max(t4a/b/c) - min(t4a/b/c) ≤ 2s（同质 Sonnet 应当近乎同步 ready）
- |t3 - max(t4)| ≤ 500ms（banner 消失与最后一张卡片切「待命」必须同步，不能出现"banner 已消但卡片仍显创建中"或反之）

**记录模板**（每跑一次填一行）：
```
[S1 round N · YYYY-MM-DD HH:MM]
t0(create click) | t1(cards show) | t2(banner show) | t3(banner gone) | t4a/b/c(card ready)
shell-input ok? Y/N | banner-vs-card consistent? Y/N | screenshot: <path>
异常：<现象>
```

#### 场景 S2 · 长回复完整性

> **指令选用**（用户确认按你最初提的来，可临场调整）：
> - 第 1 轮：普通问答 baseline，问"用一句话介绍你自己"
> - 第 2 轮：工具调用，问"用 Bash 列出 `C:\Windows\System32` 下前 50 个文件，按字母序输出"
> - 第 3 轮：skill 调用，问"用你的 `/yuque` 或类似的长输出 skill，输出一段示例内容"（按你常用的来）

**步骤**：
1. 接 S1 完成的圆桌，主输入框输入第 1 轮 prompt → 发送
2. 等 3 张卡片都 settle（状态 = 「已答 ✓」）
3. **立即**做交叉对照：
   - **找 transcript JSONL 路径**（注意：Claude Code CLI 把 transcript 放在 `~/.claude/projects/<cwd-encoded>/<sid>.jsonl`，**不在** Hub 数据目录里。隔离 Hub 启动后，cwd 仍是 hub 项目目录，所以路径是 `C:\Users\lintian\.claude\projects\C--Users-lintian-claude-session-hub\<sid>.jsonl`）。最稳找法：
     ```powershell
     Get-ChildItem "$HOME\.claude\projects\C--Users-lintian-claude-session-hub" `
       -Filter *.jsonl | Sort LastWriteTime -Descending | Select -First 3
     ```
     拿最近修改的 3 个文件就是本次圆桌的 3 个子 session
   - 取末尾最后一条 `assistant` 消息的 `text` 字段总长（字符数）
   - 对比卡片 tab 显示文本的字符数（DevTools 里 `document.querySelector('[data-rt-sid="<SID>"] .mr-ft-tab-content').textContent.length`）
   - 记录差值百分比
4. 重复第 2 轮、第 3 轮（每轮都做交叉对照）

**期望**（硬指标）：
- 每轮每个 sid 的「卡片字符数 / transcript 末尾 assistant 字符数」≥ 95%
- 不能出现"transcript JSONL 还在追加新 chunk 但 watcher 已 settle"的情况
- 第 2 / 3 轮结束后，下一轮 prompt 中引用的 by[sid] 上下文必须基于完整文本（看 turn 对象的 by[sid] 与 transcript 对照）

**记录模板**：
```
[S2 round N · turn T · sid <S>]
card chars | transcript chars | ratio
settle source: stop_hook / idle_timer_5s / manual
异常：<现象>（如 ratio < 95% → 预判 bug #3 命中）
```

**调试辅助**：建议手测时在 DevTools console 开着 `localStorage.debug = 'roundtable:*'`（如果代码里已有调试开关；没有的话要新加）。

#### 场景 S3 · 一键提取幂等 + 进行中提取

**步骤**：
1. 在 S2 第 2 轮 settle 之后，**逐个**点 3 张卡片右下角「一键提取」按钮
2. 验返回的 text 与卡片当前显示文本字符级一致（diff 为空 / 仅尾部空白差异）
3. 在 S2 第 3 轮**仍在进行中**（任一家状态 = 「思考中」）时，点该家「一键提取」
4. 验：返回非空、不报错、不 crash，UI 上卡片右上角出现「手动」角标，状态变 `manual_extracted`
5. 第 3 轮自然 settle 后，再次点同家「一键提取」，验幂等（仍能返回当前 transcript 末尾文本）

**期望**：
- settle 后点：text 完全一致，状态保持 `completed`（不变 `manual_extracted`）— 这一条要确认现在代码是否如此，否则 settle 后点会"降级"状态
- 进行中点：返回部分文本 + 状态置 `manual_extracted` + 角标显示

**记录模板**：
```
[S3 round N · sid <S> · phase <settled/inprogress>]
button clicked Y/N | resp non-empty Y/N | resp == card-text Y/N | status after
异常：<现象>
```

### 2.3 自动化 E2E 骨架

**本期分两阶段**：

- **阶段 1（手测主导，进行中）**：S1 / S2 / S3 全部走 §2.2 手测 SOP，目的是先暴露现象、确认时序稳定、判定预判 bug 是否命中。S2 的长回复完整性**永远不自动化**——内容随机，断言只能验"长度 > 阈值"价值有限，必须人眼对照 transcript 才能判完整性。

- **阶段 2（本期收尾任务，手测稳定后）**：手测中 S1 / S3 现象稳定（连续 3 次同样的时序）后，固化为 `tests/e2e-roundtable-3claude.js`，覆盖：
  - S1 的 banner ↔ 卡片状态一致性断言（H1）
  - S3 的一键提取按钮可用性 + 返回非空 + settle 后幂等（H3）

  **要求**：脚本必须**完全模拟真实用户从 UI 操作**——通过 CDP 真实点击 modal 按钮、点卡片角落「一键提取」按钮，**严禁**像旧 `e2e-roundtable-M1.js` 那样大量 `ipcRenderer.invoke('cli-ready-status', ...)` 直接探测后端。后者会掩盖"按钮点不到 / 元素不存在 / 状态没渲染上 UI"这类前端 bug。

  本期产出的 e2e 脚本是"3 claude 同质场景"专用，未来扩混合 backend 时应能直接复用骨架（CDP 启动、CDP 点击辅助函数、断言模板）。

> **注意**：未来这个 E2E 脚本必须走 CDP 真实点击 UI，而**不是**像旧 `e2e-roundtable-M1.js` 那样大量直接 `ipcRenderer.invoke('cli-ready-status', ...)` 探测后端。后者会掩盖"按钮点不到 / 元素不存在 / 状态没渲染上 UI"这类前端 bug。

### 2.4 三条硬指标（通过门槛）

| # | 指标 | 衡量方法 |
|---|---|---|
| H1 | banner ↔ 卡片状态切换偏差 ≤ 500ms | S1 的 \|t3 - max(t4)\| |
| H2 | 卡片字符数 / transcript 末尾 ≥ 95% | S2 每轮逐 sid 对照 |
| H3 | 一键提取在 settle 后幂等 + 进行中可用 | S3 第 2 / 4 / 5 步全部满足 |

**通过条件**：
1. S1 / S2 / S3 各跑 ≥3 *次完整跑*（不是 3 轮，是 3 次完整 SOP），三条硬指标无一连续失败。
2. §2.3 阶段 2 的自动化脚本（S1 + S3 时序断言）落地并能稳定通过。
3. 期间发现的 bug 走第 6 节决策路径。

---

## 3. 预判 Bug 与修复方向

> 来源：基于 2026-05-03 `Grep` 对 `cli-ready` / `extractLatestTurn` / `idle_timer_5s` / `manual_extract` 等关键路径的代码审查。
> 排序：命中概率从高到低。
> 命中后处置：每条都标了「修复方向」+「改哪些文件」+「风险」，作为转 implementation plan 的种子。

### Bug #1【高 · F1 域】并发 spawn 3 个 claude，shell 命令字符乱序

**现象预判**：S1 中观察到某一张卡片永远卡在「创建中」、shell tab 看到 `clude` / `aclaude` 等错位字符串、3 家 ready 时间差远大于 2s。

**根因怀疑**：`session-manager.js`（933 行）spawn shell 后 `pty.write('claude\r')` 没有串行化保护，3 个并发时各 PTY 的 ready 事件竞争，写入字符可能交错或丢字节。

**修复方向**：spawn 三个子 session 改串行 + 每个 spawn 完先 `await readyForInput`（基于 PTY 第一次 prompt 输出而非 fixed timeout）再 write。

**改文件**：`core/session-manager.js`（spawn 流程）；可能涉及 `main.js` 的 `add-meeting-sub` IPC handler。

**风险**：串行化会让创建总耗时从 max(3) 变 sum(3)，约多 ~400ms，可接受。

### Bug #2【高 · F1 域】Sonnet 4.5 慢启动时 `cli-ready` 过早判 true

**现象预判**：S1 中卡片切「待命」过快，但用户立刻发消息时输入丢失（前几个字符没进 PTY），之后卡片状态正常。

**根因怀疑**：`main.js:1865-1910` 的判定逻辑只看 buffer 长度 + STABLE_MS（500ms）静默。Sonnet 4.5 OAuth 完成后可能有 ANSI 重绘静默期 → 命中 STABLE → 误判 ready，但实际输入框还没渲好。

**修复方向**：buffer 检测改为「marker 字符串正则匹配 Claude Code 的输入框 prompt」(典型如 `> ` 或带颜色的 `╭`)，再加 STABLE_MS 双重门。

**改文件**：`main.js:1865-1910` `_cliReadyStableState` 和 `cli-ready-status` handler；可能新增 `core/cli-ready-markers.js` 收口三家 backend 的 marker 模式（为将来扩混合 backend 留扩展点）。

**风险**：marker 字符串硬编码风险——Claude Code CLI 升级若改 prompt 字符会断。建议 marker 留成可配 + 启动时打 log 让人看出现失配。

### Bug #3【高 · F2 域】`idle_timer_5s` 在工具调用静默期误 settle

**现象预判**：S2 第 2 轮（Bash 列文件）卡片字符数远小于 transcript JSONL 末尾，比例可能 < 50%。

**根因怀疑**：`core/transcript-tap.js:836-872` 的 `_scheduleGeminiIdleEmit` 类逻辑（claude 也有同款 idle_timer 兜底，5s 静默就 emit complete）。Bash 命令在 Claude Code 里跑 ≥5s（`dir /s` 之类）期间，PTY 不出新字符 → idle timer 触发 → watcher.wait() resolve → orchestrator 抓 transcript → 但 tool_result 还没回来。

**修复方向**：transcript JSONL 监听里识别 `tool_use` / `tool_result` 事件，工具调用进行中**重置 / 暂停** idle timer；只有"非工具状态下的真静默"才能 emit。

**改文件**：`core/transcript-tap.js:189`（ClaudeTap.notifyStop / extractLatestTurn / idle 相关），可能涉及 `core/turn-completion-watcher.js`。

**风险**：tool 调用嵌套 / 长时间 hung tool 可能让 turn 永远不 settle。需要保留绝对超时（建议 5 min）兜底，超时后走 manual_extract 路径。

### Bug #4【中 · F2 域】卡片 tab 文本（流式 buffer）vs settle 时 patch 进 turn 的文本（transcript JSONL 抽取）不同源，导致跨轮 prompt 引用残缺

**现象预判**：S2 第 3 轮的 prompt 里看到引用上一轮 by[claude_sid_1] 的内容是截断的（如最后一句话不全），但当时卡片 tab 显示是完整的。

**根因怀疑**：UI 卡片走 PTY stdout 流式累积；`extractLatestTurn` 走 transcript JSONL 末尾 last-assistant 节点。两者写入时点不一致——transcript JSONL 是 Claude Code CLI 主动写、可能 buffer 几百字节才 flush；PTY stdout 是字符级实时。Settle 时刻读 transcript 可能读到的是上一个 flush 边界。

**修复方向**：
- 短期：settle 时主动等 transcript JSONL 静默 ≥1s 再读（让 flush 完成）
- 中期：卡片显示文本与 patch 文本统一走 transcript JSONL 这一个数据源（Upstream Data Source 原则——别同时维护两个流）

**改文件**：`renderer/meeting-room.js`（卡片显示数据源）、`core/transcript-tap.js`（extract 时机）。

**风险**：统一数据源是较大重构，本期建议只做"短期 wait flush"补丁，重构留单独 spec。

### Bug #5【低 · F3 域】`sincePromptTs` 跨轮过滤精度

**现象预判**：S3 第 5 步幂等检查时，多次点「一键提取」返回的不是当前轮内容，而是上一轮 last-assistant。

**根因怀疑**：`main.js:1577` 调 `extractLatestTurn(sid, sincePromptTs || 0)`。如果 prompt 入 PTY 的时间戳记录与 transcript JSONL 第一条 user 消息的时间戳偏差 > 1s（不同时钟源 / 异步写），过滤会漏掉本轮。

**修复方向**：`sincePromptTs` 改用 transcript JSONL 自身的"本轮 user 消息出现时间"作为下界，而不是用 PTY write 时刻。

**改文件**：`renderer/meeting-room.js:82` 附近的时间戳记录、`core/transcript-tap.js` 的过滤逻辑。

**风险**：低，改动范围小。

### Bug #6【可能 · F3 域】settle 后再点「一键提取」会"降级"状态？

**现象预判**：S3 第 2 步，`completed` 卡片点一键提取后状态变 `manual_extracted`，角标多出来"手动"。

**根因怀疑**：看 `meeting-room.js:357,397` 的 partial.status === 'manual_extracted' 分支，似乎只要 IPC 返回就置 manual_extracted，没区分"为兜底"vs"为已 settle 后再点"。

**判定**：手测 S3 时**先验证现象**，如果确认会降级，则简单：前端 IPC 调用前判 currentStatus === 'completed'，是的话只走"返回 text 给用户对照"路径，不 patch 状态。

**改文件**：`renderer/meeting-room.js:854` 附近 manual-extract handler。

**风险**：低。

---

## 4. 成功标准与退出条件

**退出本期调试 → 进入"扩展到混合 backend"阶段** 的判定：

1. S1 / S2 / S3 各完整跑 ≥3 次
2. H1 / H2 / H3 三条硬指标在最近 3 次连续无失败
3. 预判 Bug 中已命中的全部 fix（或显式延后立单独 spec）
4. 调试期间发现的新 bug 全部记录在本 spec 末尾的「执行追加」段（见 §6），简单的就地修，复杂的转决策

---

## 5. 不在本期 Scope（明确延后）

- 混合 backend（gemini-cli / codex-cli / deepseek / glm 任意组合）
- Resume / 切走切回的状态保持
- 5+ 轮长上下文累积测试、`byStatus` 的所有边界
- 假死 / 90s+ 超时 / 软提醒 banner 的覆盖率提升
- 自动化 E2E 脚本（待第二期）
- 性能 / 内存基线

---

## 6. 执行追加（调试中发现的新事项 — 留空待填）

> 调试过程中如发现 §3 未列出的新 bug：
> - **简单**（单文件 ≤30 行、无架构影响）→ 直接修，在此节追加一行「YYYY-MM-DD bug X 简述 + commit hash」
> - **复杂**（跨文件 / 跨阶段 / 涉及数据迁移）→ 在此节追加一段「现象 + 怀疑根因 + 候选方向」，找用户决策

（待填）
