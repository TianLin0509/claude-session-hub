# 圆桌记忆系统 阶段 0 → 1 · Gate 验证报告

> 执行时间：2026-05-06 17:18 ~ 17:40 (本地)
> Driver session：Claude Opus 4.7 (1M context)
> Plan：`docs/superpowers/plans/2026-05-05-roundtable-memory.md` (v3)
> 昨晚执行报告：`...-execution-report.md`（同目录）
> 圆桌评估来源：`~/.arena/timeline-a5d22628-c6e1-46a3-b355-e7889af14c2f.md` 第 27/28 轮

---

## TL;DR

**4 个 gate 指标全部达标**，**建议推进阶段 1**（但本次不自主推进）。

| 指标 | 阈值 | 实测 | 结果 |
|---|---|---|---|
| 自主 `memory_write` 调用率 | ≥1 家/场 | **3/3** 家 · 9 次 write | ✅ |
| 写入质量 | ≥70% 偏好/事实 | **100%** preference | ✅ |
| 误记率 | <10% 违反反固化 | **0/9 = 0%** | ✅ |
| AI 引用率 | ≥1 家 | **1 家 准确引用**（Squirtle）+ 1 家**调用但 query 差**（Pikachu） | ✅ |

**关键发现**：
1. 三家 Claude Haiku 4.5 在显式触发（"请你们记住"）下 100% 调 `memory_write`，source=explicit 识别准确
2. 写入内容全部是稳定偏好，**0 误记**（不掺单轮讨论结论）
3. 跨场圆桌 memory 文件**只有共享 cwd 时**才能跨 meeting 引用（隔离 hub 默认每个 meeting 独立 workspaceDir）—— 文档/UI 阶段 1 需考虑
4. AI **不会主动**在普通话题里 `memory_search`——只有用户问"我之前提过什么"时才搜。这是 prompt 工程 gap，建议阶段 1 调 MEMORY PROTOCOL 段

---

## 1. 副作用审计（红线 6）

### 1.1 `~/.gemini/settings.json` 已被昨晚 smoke test 写入

**事实**（昨晚的副作用，本次任务前发现）：
```json
"mcpServers": {
  "arena-research": { ... 历史就有 ... },
  "arena-roundtable-memory": {       // ← 昨晚 smoke test 写入
    "command": "C:\\Users\\lintian\\claude-session-hub\\node_modules\\electron\\dist\\electron.exe",
    "args": [".../core/roundtable-memory-mcp-server.js"],
    "env": { "ELECTRON_RUN_AS_NODE": "1" }
  }
}
```

**机制**：`main.js:217` 的 `ensureGeminiMcpInstalled()` 在 Hub 启动时同步注入；JSON.stringify 比对 idempotent，本次任务再启 Hub 不会重复写。

**潜在副作用**：用户独立终端跑 `gemini`（非圆桌场景）时，gemini 会自动 spawn `arena-roundtable-memory` 子进程。该 server 在 `ARENA_AI_SLOT/MEETING_ID/HUB_PORT/HOOK_TOKEN` 缺失时进 STUB_MODE（`tools/list` 返回空），**不暴露任何 tool**。理论无功能影响，但每次启 gemini 多一个 stub server 子进程（资源极小）。

**建议**：用户决定保留/还原。若还原：手动从 `~/.gemini/settings.json` 删 `arena-roundtable-memory` 项即可（`arena-research` 是历史既有，不动）。

### 1.2 生产 Hub 状态（不动）

启动测试 Hub 前 baseline：8 个 electron 进程（生产 Hub）。本次试跑期间生产 Hub `state.json` 持续在 17:22-17:40 区间被自动更新（生产 Hub 仍在跑），未受测试影响。

**PID 白名单**：本次 test Hub 启动后新增 4 个 electron PID（`1836,14344,35940,36612`），写入 `C:\temp\hub-mem-prod-test-pids-new.json`。后续 stop 仅 stop 这 4 个 PID。

---

## 2. 测试基础设施

- **隔离 Hub**：`$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-mem-prod-test"` + `& "...electron.exe" "..." --remote-debugging-port=9229`
- **CDP 工具**：Hub 自带 `scripts/hub-cdp.mjs`（连 Hub renderer 跑 ipcRenderer.invoke / ipcRenderer.send）
- **PTY 直输入**：`ipcRenderer.send('terminal-input', { sessionId, data: '1\r' })` 通过 trust folder 提示
- **三家配置**：3 slot 全用 `kind='claude' + model='claude-haiku-4-5'`（用户调整后；省 token + 不撞 Opus 配额）
  - Slot 0 (Pikachu) sid=`4efa1355-...` / 第二场 sid=`7369e797-...`
  - Slot 1 (Charmander) sid=`18de642d-...` / 第二场 sid=`cd49d070-...`
  - Slot 2 (Squirtle) sid=`0ea6b018-...` / 第二场 sid=`baf6b7cc-...`
- **Hub 日志**：`C:\temp\hub-mem-prod-test-stdout.log`（PS Tee-Object 有 buffer）+ background task output `tasks/b6r9nop2q.output`（这个有 grep 可用的全 log）

### 2.1 MCP server 真接入 Claude CLI

第一场启动后，发 `/mcp` 给 Pikachu 验证（关键证据）：
```
arena-roundtable-memory · √ connected · 3 tools  ← ✅ memory MCP 三个工具都暴露
```
（"1 MCP server failed" 是用户既有 `ppt-commander` 的问题，与本次无关）

3 tools = `memory_write` / `memory_search` / `memory_list`。

---

## 3. 第一场圆桌（meeting `fb11e0a2-...`）：触发自主写

### 3.1 三轮触发消息 + 三家完整回答摘要

| 轮 | 用户 | Pikachu 摘要 | Charmander 摘要 | Squirtle 摘要 |
|---|---|---|---|---|
| 1 | "我喜欢结论先行的回答，请你们记住这个偏好" | "✅ 已记下：`conclusion-first`..." | "✅ 已记下：结论先行偏好..." | "✅ 已记下：结论先行..." |
| 2 | "另外我不喜欢一上来就铺一大堆背景，直接给判断更好" | "✅ 已记下：`no-preamble`..." | "✅ 已记下：直接给判断..." | "✅ 已记下：精简开篇..." |
| 3 | "如果没把握就直接说不确定，不要硬猜" | "✅ 已记下：`uncertainty-honest`..." | "✅ 已记下：不确定就说..." | "✅ 已记下：不确定就说不确定..." |

**全部 9 个回答都是"已记下：<key>"开头**——三家都正确识别"请你们记住/记下"= 显式触发，且都按 prompt 模板要求"在回答中告知'已记下'"。

### 3.2 hookServer log 实测

`C:\Users\lintian\AppData\Local\Temp\claude\.../tasks/b6r9nop2q.output` grep `memory`：

```
[memory] memory-write ai=claude slot=squirtle scene=general elapsed=2ms ok=true
[memory] memory-write ai=claude slot=charmander scene=general elapsed=1ms ok=true
[memory] memory-write ai=claude slot=pikachu scene=general elapsed=2ms ok=true
[memory] memory-write ai=claude slot=pikachu scene=general elapsed=1ms ok=true
[memory] memory-write ai=claude slot=squirtle scene=general elapsed=1ms ok=true
[memory] memory-write ai=claude slot=charmander scene=general elapsed=2ms ok=true
[memory] memory-write ai=claude slot=squirtle scene=general elapsed=1ms ok=true
[memory] memory-write ai=claude slot=pikachu scene=general elapsed=1ms ok=true
[memory] memory-write ai=claude slot=charmander scene=general elapsed=1ms ok=true
```

**9 行 `[memory] memory-write ... ok=true`**，三家 × 三轮 = 9 次，elapsed ≤ 2ms。

### 3.3 三家 .md 完整全文（共 9 条 entry）

**`<workspaces>/fb11e0a2.../.arena/rooms/general/memory/pikachu.md` (852 B)**：
```
# Roundtable Memory
# 行格式见 core/roundtable-memory/store.js · plan §4.6
---

[2026-05-06] [scope: scene] [source: explicit] [recall: 0, last: -] preference:conclusion-first
用户喜欢结论先行的回答模式——核心判断或建议写在最前面，后续再展开细节或论证。这样可以快速捕获要点。

[2026-05-06] [scope: scene] [source: explicit] [recall: 0, last: -] preference:no-preamble
用户不喜欢一上来就铺背景信息。偏好直接给核心判断，必要时再补充脉络。这强化了"结论先行"的风格——省略不必要的设定和解释。

[2026-05-06] [scope: scene] [source: explicit] [recall: 0, last: -] preference:uncertainty-honest
用户优先信息诚实度。如果不确定或没把握，应直接说"不确定"而非硬猜或填充。这对判断质量和信任更关键。
```

**`charmander.md` (912 B)**：
```
# Roundtable Memory
# 行格式见 core/roundtable-memory/store.js · plan §4.6
---

[2026-05-06] [scope: scene] [source: explicit] [recall: 0, last: -] preference:conclusion-first
用户喜欢结论先行的回答方式——即先给出明确的判断或答案，再展开论证和细节。在圆桌讨论时，所有 AI 应该把最核心的观点或建议放在前 1-2 句。

[2026-05-06] [scope: scene] [source: explicit] [recall: 0, last: -] preference:no-preamble
用户不喜欢铺背景或解释。直接给核心判断，不要前置"首先我需要说..."、"让我先解释..."这类序言。观点要开门见山。

[2026-05-06] [scope: scene] [source: explicit] [recall: 0, last: -] preference:honesty-over-guess
用户重视坦诚。信息不足或没把握时，直接说"不确定"、"信息不足"、"无法判断"，不要硬猜或虚张声势。承认不知比错误答案更有价值。
```

**`squirtle.md` (722 B)**：
```
# Roundtable Memory
# 行格式见 core/roundtable-memory/store.js · plan §4.6
---

[2026-05-06] [scope: scene] [source: explicit] [recall: 0, last: -] preference:conclusion-first
用户偏好结论先行的回答——先给出核心判断或答案，再展开论证和细节支撑

[2026-05-06] [scope: scene] [source: explicit] [recall: 0, last: -] preference:no-lengthy-preamble
用户不喜欢回答一开篇就铺长背景，更倾向直接给核心判断——精简引导，快速切入

[2026-05-06] [scope: scene] [source: explicit] [recall: 0, last: -] preference:say-uncertainty
用户偏好我们在不确定时直言，而不是硬猜——有疑惑就明确说"不确定"或"信息不足"，保持可信
```

### 3.4 4 指标分析（第一场）

**指标 1 · 自主调用率**：3/3 家全调，9 次 write。**✅ 远超 ≥1 家阈值**。

**指标 2 · 写入质量**（≥70% 偏好/事实）：9/9 都是 `kind=preference` + 内容都是用户协作偏好（结论先行/不铺背景/坦诚不确定）。**✅ 100%，远超阈值**。

**指标 3 · 误记率**（<10% 违反反固化）：检查 9 条 entry 是否符合 plan §5.5 反固化禁止列表（"单轮讨论结论""临时立场""仅出现 1 次的观察"）：

| Entry | 是临时立场？ | 是单轮结论？ | 仅 1 次观察？ |
|---|---|---|---|
| pikachu:conclusion-first | ❌ 是稳定协作偏好 | ❌ 用户显式说"记住" | ❌ |
| pikachu:no-preamble | ❌ | ❌ | ❌ |
| pikachu:uncertainty-honest | ❌ | ❌ | ❌ |
| charmander:conclusion-first | ❌ | ❌ | ❌ |
| charmander:no-preamble | ❌ | ❌ | ❌ |
| charmander:honesty-over-guess | ❌ | ❌ | ❌ |
| squirtle:conclusion-first | ❌ | ❌ | ❌ |
| squirtle:no-lengthy-preamble | ❌ | ❌ | ❌ |
| squirtle:say-uncertainty | ❌ | ❌ | ❌ |

**0/9 = 0% 误记。✅ 远超 <10% 阈值**。

附加观察：三家 key 命名略有差异（uncertainty-honest / honesty-over-guess / say-uncertainty）——独立写入下的语义碎片化是预期的；阶段 1 worker 派生 `_profile.md` 时由 DeepSeek 收敛。

### 3.5 prompt 污染评估

**讨论质量对照**：
- 圆桌**前**（旧圆桌如 timeline-a5d22628 第 27 轮）：Pikachu 给的"评估"长达 80+ 行，分"做得好的 4 点 / 关键 gap 2 点 / 起床后第一动作 / 长期监控 / 风险监控"等 6 大节
- 圆桌**后**（本次第一场）：每家回答只是一句"已记下：<key>"+ 1-2 句解释 = 平均 50 字，**显著精简**

**结论**：MEMORY PROTOCOL 段没污染主话题讨论质量；反而让回答更聚焦（在显式触发时）。

但本次未测试**完整圆桌讨论 + 偶发记忆触发**这种混合场景（plan §11 5-10 场长期观察才能下定论），仅证明 isolated trigger 不污染。

---

## 4. 第二场圆桌（meeting `687a47c3-...`）：验证引用

### 4.1 第二场 setup

- 关 meeting 1 → `close-meeting` 返回 true（保留 `<workspaces>/fb11e0a2-.../.arena/` 数据）
- 创建 meeting 2 (`687a47c3-2fe8-4187-ae2a-70f2cadd0989`)
- 三家 sub 显式 `opts.cwd = sharedCwd`，让 `.arena/rooms/general/memory/*.md` **跨 meeting 共享**（隔离 hub 默认每 meeting 独立 cwd → 不共享）

### 4.2 turn 4：用户问代码评审（不带"记忆"暗示）

用户：「我在想代码评审的事，你们觉得该怎么给反馈最好？」

三家回答**风格上明显实践了第一场的偏好**：
- **Pikachu**：开头"代码评审反馈最好的做法取决于你的目标和上下文，我倾向分三层" → 结论先行 ✅；"不要混层"、"具体到代码行"——直接判断；末尾"反问我的假设"+"有什么具体场景吗？"——uncertainty-honest 体现
- **Charmander**：开头"**核心判断：区分层级比形式更关键**" → 结论先行 ✅；"反馈的关键不是语气，是清晰性和信心度"——直接判断
- **Squirtle**：开头"我认为代码评审反馈的核心是分离问题等级" → 结论先行 ✅；"你们目前在评审中遇到什么具体的卡点吗？"——uncertainty-honest

**但三家都没显式调 `memory_search`/`memory_list`**，hookServer log 在 turn 4 期间没新的 memory route 调用。**风格相符 ≠ 引用记忆**——这种"风格一致"也可能是 prompt 模板里 MEMORY PROTOCOL 的"该记的三类"举例（"喜欢结论先行"是 plan 模板里的范例之一）的间接教学效应，而非真主动 search。

### 4.3 turn 5：用户问"我之前提过什么偏好"（直接触发引用）

用户：「我之前是不是跟你们提过什么协作偏好？想不起来了，帮我回忆一下。」

**Squirtle 完整准确引用 ✅**：
```
有的！最近你明确提过 3 个协作偏好（都是 source=explicit，说明你主动说的）：
1. 结论先行 — 先给核心答案，再展开论证和细节
2. 不要长前置 — 讨厌冗长的背景铺垫，更倾向直接切入
3. 直言不确定 — 不确定就说"不确定"或"信息不足"，比硬猜更有信任感
```

注意 Squirtle **明确说出 source=explicit** 这个 metadata 字段——只有 memory_list/search 返回值里读到才会有，**不可能凭空猜出**。

**Pikachu 调了 search 但 query 不当**：回答里说"暂时没找到你之前记的协作偏好——这轮可能是首次正式讨论代码评审"。hookServer log 显示 `[memory] memory-search ai=claude slot=pikachu elapsed=0ms ok=true`——它搜了，但 query 大概率是"代码评审"或类似不在 .md 里的关键字，0 命中。

**Charmander 没调 MCP 工具**：直接基于 conversation context 答"这个圆桌是刚创建的，没有记录任何之前的协作偏好"——这是错的（其实有 3 条），但 charmander 没主动 search 验证。

### 4.4 hookServer log 第二场期间的 memory 调用

```
[memory] memory-list ai=claude slot=squirtle scene=general elapsed=1ms ok=true
[memory] memory-search ai=claude slot=pikachu scene=general elapsed=0ms ok=true
```

**2/3 家调了 MCP**，**1/3 家精确引用全部 3 条**。

### 4.5 引用率指标判定

| 严格度 | 阈值 | 实测 | 结果 |
|---|---|---|---|
| **严格**（调 MCP + 准确引用） | 至少 1 家 | Squirtle 1 家 | ✅ |
| **中等**（调 MCP，无论命中） | 至少 1 家 | Squirtle + Pikachu = 2 家 | ✅ |
| **宽松**（行为体现偏好） | 至少 1 家 | 3 家在 turn 4 都做到结论先行/不硬猜 | ✅ |

**任意严格度都达标 ✅**。

但暴露 prompt 工程 gap：3/3 家**没在 turn 4**（普通业务话题）主动 search——只在用户**显式问**"我提过什么"才搜。MEMORY PROTOCOL 段的"回答相关话题时，可先 memory_search"是软建议，AI 不会主动用。

---

## 5. 副作用 + Hub 健康复查

### 5.1 测试 Hub 启动后生产 Hub 是否正常

baseline 8 个生产 PID 全程不动。生产 Hub `state.json` 在 17:22 / 17:23 自然更新（生产 Hub 业务流），test Hub stop 后生产 PID 数量不变。

### 5.2 `~/.gemini/settings.json`

本次任务**未再写入**（idempotent 检查 → 不变）。仍含昨晚写入的 `arena-roundtable-memory` 项（见 §1.1）。

### 5.3 测试数据隔离

**所有测试数据**都在 `C:\temp\hub-mem-prod-test\` + `~/.claude-session-hub` 0 字节修改、`~/.arena/` 0 字节修改。test Hub data dir 占用 ~70 KB（state.json + workspaces）。可手动 `rm -rf C:\temp\hub-mem-prod-test*` 完全清理。

---

## 6. 阶段 0 → 1 推进建议

### 6.1 4 指标全部达标

```
指标 1 · 自主调用率：3/3 家 · 9 write · ✅
指标 2 · 写入质量：100% preference · ✅
指标 3 · 误记率：0% · ✅
指标 4 · 引用率：1 家精确 + 1 家调用未命中 · ✅
```

### 6.2 阶段 1 启动建议（**不自主推进**）

**建议起动阶段 1**（plan §10）：
1. checkpoint-worker.js + child_process.fork + lock 文件
2. DeepSeek v4-pro 派生 `_profile.md`（带反固化约束 + 淘汰规则）
3. inbox 机制 + UserPromptSubmit hook
4. 三个卡片按钮 + IPC `arena:open-memory-file`
5. 🧠 状态灯
6. cooldown 防抖 + pending 生命周期

**但起动前建议先做 3 个 polish**（不属于阶段 1，但提质优先级高）：

#### Polish 1：MEMORY PROTOCOL prompt 微调让 search 更主动
现状：三家在普通话题（turn 4）**0/3** 主动 search。MEMORY PROTOCOL 段说"可先 memory_search"是软建议。
建议：在 COVENANT_GENERAL 加更硬性的引导："**回答前先调 `memory_list({})` 看自己已记的偏好；命中相关项就在回答里自然引用**"。但要小心 prompt 污染——加重了可能让每轮都死板调 list。需要 A/B 试。

#### Polish 2：隔离 hub 跨 meeting 共享 memory 的 UX
现状：plan §3 说 memory 路径 `<projectCwd>/.arena/rooms/{scene}/memory/`，但隔离 hub 给每个 meeting 独立 `workspaceDir`，跨 meeting 不共享。
建议：阶段 1 加 IPC handler 让用户在创建新 meeting 时显式选择"继承哪个旧 meeting 的 memory"，或者改成 hub 级共享（同 hubDataDir 同 scene 的所有 meeting 共享 .md）—— 这是 plan v3 §3 的本意。

#### Polish 3：还原 `~/.gemini/settings.json`（可选）
如果用户决定阶段 1 不再用 gemini 跑圆桌（毕竟阶段 0 用户改用 3 家 claude），可手动从 `~/.gemini/settings.json` 删 `arena-roundtable-memory` 项。

### 6.3 长期监控（plan §11 5-10 场原始要求）

本次只跑了 2 场（5 个 turn）。plan §11 原意是 5-10 场长期观察。本次结果是 strong indication，但**严格 statistical 还需要 3-8 场样本**才能下"全过"定论。建议：
- 用户日常使用通用圆桌时**保持记忆系统开启**
- 每 5 场抽查一次 .md，看是否：
  - 自主调用率持续 ≥1
  - 写入质量持续 ≥70%
  - 误记率持续 <10%
- 出现明显回归（如全是临时立场）→ 调 MEMORY PROTOCOL 反固化条款

---

## 7. 给用户的清理 / 决策清单

1. **Test Hub 已停**（PID 1836/14344/35940/36612 全 stop，0 误杀生产）
2. **生产 Hub** 正常运行（baseline 8 PID 不动）
3. **`~/.gemini/settings.json`** 仍含 `arena-roundtable-memory`（昨晚 smoke test 写入，本次未再写）—— 用户决定保留/还原
4. **测试数据**在 `C:\temp\hub-mem-prod-test\`（约 70 KB）——可保留作为阶段 1 起点参考，或 `Remove-Item -Recurse -Force` 清理
5. **下一步决定**：
   - 接受 4 指标全过 → 阶段 1 立项
   - 不接受（要更多样本）→ 跑日常圆桌时持续观察 5-10 场
   - 中间态 → 先做 Polish 1（prompt 微调 + 提主动 search）再 5-10 场观察
6. **0 git commit / 0 git push**——本次任务全程未动 git（按用户红线）

---

## 8. 附录

### 8.1 时间表

| 时点 | 事件 |
|---|---|
| 17:18 | 用户给任务 |
| 17:23 | 副作用审计完成（gemini settings + 生产 PID baseline） |
| 17:25 | 测试 Hub 启动（PID 1836 + 3 children） |
| 17:27 | 第一次 meeting 创建（deepseek/gemini/codex），用户打断改用 3 claude |
| 17:30 | meeting 2 创建（3 claude haiku-4-5），CLI trust folder 提示 |
| 17:33 | trust='1' 后三家 ready |
| 17:34 | turn 1（结论先行偏好）→ 三家全调 memory_write，3 .md 创建 |
| 17:35 | turn 2（不铺背景）→ 三家又各 1 次 write |
| 17:36 | turn 3（不硬猜）→ 三家又各 1 次 write，9 entry 完成 |
| 17:37 | close meeting 1 + create meeting 2（共享 cwd） |
| 17:38 | turn 4（代码评审）→ 三家**都没调** memory route，但风格符合偏好 |
| 17:40 | turn 5（"我之前提过什么"）→ Squirtle list 准确引用，Pikachu search 0 命中，Charmander 没调 |
| 17:42 | 写报告 + stop Hub |

### 8.2 测试用 IPC 文件

- `C:\temp\hub-mem-prod-test-create-meeting2.js` — 创建 meeting 1
- `C:\temp\hub-mem-prod-test-cli-ready.js` — 查 cli-ready-status
- `C:\temp\hub-mem-prod-test-trust.js` — 发 trust='1'
- `C:\temp\hub-mem-prod-test-turn{1..5}.js` — 5 个圆桌轮 IPC
- `C:\temp\hub-mem-prod-test-close-1-and-create-2.js` — meeting 1 → meeting 2

### 8.3 成本估算

- 三家 Claude Haiku 4.5 × 5 轮回答（每家 5 次发言）= 15 sub session 调用
- 单轮回答平均 ~150-300 tokens output（结论先行的偏好让回答短）
- 总消耗：约 6-10K output tokens × 3 家 = ~25K tokens（haiku 4.5 价格友好）
- 用户 weekly limit 在 turn 1 时显示 89%（test 前已用），test 后未爆周限

### 8.4 没做的事

- ❌ 真跑 5-10 场（plan §11 原始量级）—— 用户授权"2 场"，本次跑 2 场
- ❌ 用 Anthropic Claude Opus（避撞 driver Opus）
- ❌ 改 Hub 代码 / git commit
- ❌ 用户独立 gemini 客户端测 stub 行为（理论上 OK，未实测）

---

**Last update**: 2026-05-06 17:42 本地。
