# 圆桌记忆系统 · Implementation Plan

> 日期：2026-05-05（v3 修正版）
> 决策来源：通用圆桌讨论 timeline-a5d22628（Pikachu/Charmander/Squirtle 共 26 轮辩论收敛）
> 修正历史：v1（第 22 轮）→ v2（第 23 轮 14 处修正）→ v3（第 24 轮用户提的 3 处要害修正）
> 状态：Plan v3 已用户授权执行；待 driver session 接手实施

---

## 实施进度跟踪（下次 session 接手时 resume 用）

### 阶段 0 任务清单（按顺序执行，每步 smoke test 通过才进下一步）

- [x] **Task 0.1**：Read 现状（实际架构已 P5 重构 / 2026-05-04）—— `core/driver-mcp-server.js`/`core/driver-mode.js`/`core/arena-memory/` 全部已删除；现实对应物 = `core/research-mcp-server.js` (per-scene MCP server 模板) + `core/roundtable-scenes.js` 中 `BASE_RULES`/`COVENANT_GENERAL`/`GENERAL_PRESET` (prompt 锚点) + `main.js:3021-3128` (hookServer) + `main.js:1416-1422` (projectCwd 取自主驾或第一活跃 sub 的 cwd, 与 timeline.md 同源)
- [x] **Task 0.2**：Write `core/roundtable-memory/store.js`（~190 行）—— `memoryDir`/`memoryFile`/`parseEntry`/`loadEntries`/`appendMemoryEntry`/`searchMemory`/`listMemory`，行格式按 plan §4.6
- [x] **Task 0.3**：Write `core/roundtable-memory-mcp-server.js`（~190 行，模板=research-mcp-server）—— TOOLS 含 3 个工具 + STUB_MODE + JSON-RPC over stdio + HTTP loopback to Hub
- [x] **Task 0.4**：Edit `main.js` 加 hookServer 3 个 memory routes + projectCwd 计算（同 timeline 公式）+ memory-event 广播 + ensureGeminiMcpInstalled 注册 arena-roundtable-memory（全局 gemini settings.json）+ _addMeetingSubInternal 给 Claude/Gemini/Codex 三家分别注入 memory MCP（research scene 占用 mcpConfig 名额时 skip）
- [x] **Task 0.5**：Edit `core/roundtable-scenes.js` —— COVENANT_GENERAL 加 MEMORY PROTOCOL 段（plan §7 三家共用，没有 driver-mode.js）+ 加 `writeRoundtableMemoryMcpConfig` / `buildRoundtableMemoryMcpEntryForCodex` helpers + module.exports 同步
- [x] **Task 0.6**：Smoke test 通过 —— 隔离 Hub (`CLAUDE_HUB_DATA_DIR=C:\temp\hub-mem-smoke`) 启动到 `[圆桌] hook server listening on 127.0.0.1:3458` (生产 Hub 占 3456/3457，fallback 到 3458)。无 require/load 报错。停 Hub 走 PID 白名单（仅 stop 自启 PID 69584）
- [x] **Task 0.7**：单测 11/11 通过 —— `tests/roundtable-memory.test.js` 覆盖 T1-T11 (append create/dedup/parse round-trip/search hit+bump/list filter/edge cases/scope=scene/per-slot 隔离/per-scene 隔离)。运行命令 `node tests/roundtable-memory.test.js`
- [x] **Task 0.8**：E2E 集成测试 7/7 通过（mock hookServer + 真 MCP server 子进程 × 3 + 真 stdio JSON-RPC）。证明链路：JSON-RPC stdio → HTTP loopback → token 校验 → store.appendMemoryEntry → .md 文件创建。三家 slot (pikachu/charmander/squirtle) 各调一次 memory_write，三个文件正确创建，行格式合 §4.6，per-slot 隔离。**真 AI 实跑 1 场端到端 + UI [已记 N] 角标**：阶段 0 未做（UI 改造在阶段 1 范围；红线 5 Opus 并发限制让 driver session 不便启 Anthropic Pikachu）→ 留给用户起床后开 1 场通用圆桌（Charmander/Squirtle 用 Gemini/Codex 即可触发）实测一次
- [x] **Task 0.9**：执行报告已写至 `2026-05-05-roundtable-memory-execution-report.md`

### 阶段 0 验证指标（4 个全达标进阶段 1）

跑 5-10 场圆桌后评估：
- [ ] AI 自主 memory_write 调用率 ≥1次/场
- [ ] 写入质量 ≥70% 偏好/事实
- [ ] 误记率 < 10%
- [ ] AI 引用率至少 1 次

### 关键安全前提（每步 smoke 之前必查）
- 用 `CLAUDE_HUB_DATA_DIR=C:\temp\hub-mem-test` 隔离测试 Hub（不动生产 Hub）
- 启动新 Hub 用 PowerShell `& exe` 同句 + `run_in_background`（不是 Start-Process）
- E2E 必须 PID 白名单（before/after diff，禁止时间窗推断）
- 测试用 Gemini/Codex 替代 Claude（避免 Opus ≤1 的并发限制）

---

---

## 0. 目标

让通用圆桌的三家 AI（Pikachu/Charmander/Squirtle）跨会话**越用越懂用户**，同时：
- 保留 AI 个性（不复读机）
- 不污染回答正文
- 用户半透明可见——**直接打开 .md 文件用自己的工具看**
- 场景隔离（通用 vs 投研互不污染）

## 1. 背景

22 轮圆桌讨论的核心收敛：
- **方向**：AI 自主写为主 + Hub checkpoint 兜底
- **存储形态**：纯 Markdown + 一个小状态 JSON，0 RAG、0 向量库
- **作用域**：per-scene 隔离 + per-agent 个体 + 薄共识层
- **派生方式**：Hub 后台 child_process worker 调 DeepSeek v4-pro
- **写入边界**：worker 不越权写个体记忆，只写 _profile + pending inbox

**代码层可复用**：Hub 已有 `core/arena-memory/` 模块（store/marker-parser/injector，~3 个文件）——它们是通用文件操作工具，本 plan 的 store 实现可参考其风格，但**文件路径与场景独立设计**。

## 2. 五项核心原则

1. **AI 自主写为主**，Hub checkpoint 每 3 轮兜底
2. **后台 worker 不越权写个体记忆**——只写 `_profile.md` + `pending-{slot}.json`
3. **不打断前台对话**——所有重活走 child_process worker 异步
4. **场景隔离**（通用 vs 投研互不污染），跨 scene 偏好阶段 2+ 才开放
5. **半透明可见**——卡片按钮直接 `shell.openPath` 打开 .md 文件，用户用自己的工具看

## 3. 文件结构（v3 简化）

```
<projectCwd>/.arena/rooms/{scene}/
  timeline.md                    # 已有，AI 全量 Read（人可读叙事）
  checkpoint-state.json          # v3 新：单文件 Hub checkpoint runtime 状态（<1KB）
  memory/
    pikachu.md                   # AI 自主写，worker 只读
    charmander.md
    squirtle.md
    _profile.md                  # worker 派生（含 frontmatter），AI 只读，开场全量注入
    pending-pikachu.json         # inbox 候选，AI 自决采纳
    pending-charmander.json
    pending-squirtle.json
    inbox-archived/              # 拒绝 + 过期的 pending 归档（按月）
      pikachu-202605.json
    .memory-disabled             # 用户 disable 开关（可选）

~/.arena/agents/{slot}/cross.md  # 跨 scene 协作偏好（阶段 2+ 才启用，阶段 0/1 关闭）
```

**v3 修正**：
- ❌ 删除 `episodes.jsonl`（过度工程）
- ❌ 删除 `.checkpoint-cursor`（合并进 `checkpoint-state.json`）
- ✅ 新增 `checkpoint-state.json`（单一状态文件，<1KB）

## 4. 数据 Schema

### 4.1 checkpoint-state.json（v3 新，替代 episodes.jsonl + cursor）

```json
{
  "last_user_msg_count": 2,
  "last_token_count": 4500,
  "last_checkpoint_at": "2026-05-05T10:00:00Z",
  "last_checkpoint_turn": "t6",
  "consecutive_failures": 0,
  "last_failure_reason": null
}
```

- 每次用户发言、worker 完成时**覆写**（不是 append）
- Hub 重启时读此文件恢复计数器状态
- 文件大小恒定 < 1KB
- 原子写入（write tmp + rename）

### 4.2 pending-{slot}.json

```json
{
  "items": [
    {
      "id": "pending-2026-05-05-001",
      "created_at": "2026-05-05T10:30:00Z",
      "source_checkpoint": "t6",
      "reason": "用户在 t4-t6 反复提到下行风险偏好",
      "content": "[2026-05-05] [scope: scene] preference:downside-first 用户重视下行风险",
      "status": "pending",
      "priority": false,
      "remind_count": 0
    }
  ]
}
```

`status` 取值：`pending` | `accepted` | `rejected` | `expired`
`priority`：用户手动编辑文件设为 `true` 后，下次 inbox 注入时该条置顶（v3 简化：不要 IPC handler，用户编辑文件即可）

### 4.3 pending 生命周期规则

| 触发条件 | 状态变化 | 行为 |
|---|---|---|
| AI 采纳 | `pending` → `accepted` | 调 `memory_write({source:'inbox'})` 后从 pending 删除 |
| AI 拒绝 | `pending` → `rejected` | 移到 `inbox-archived/`，不再提示 |
| 提醒 ≥ 3 次仍 pending | `pending` → `expired` | 移到 `inbox-archived/`，不再提示 |
| 创建后 7 天未处理 | `pending` → `expired` | 同上 |
| 同 key 重复入 inbox | 自动合并 | 更新已有 pending 的 reason，不新建 |

每次 hook 注入 inbox 时 `remind_count += 1`。

### 4.4 _profile.md frontmatter

```markdown
---
updated_at: 2026-05-05T10:30:00Z
source_checkpoint: t6
scene: general
entry_count: 12
---
[2026-05-05] preference:conclusion-first 用户喜欢结论先行 (recall:5)
[2026-05-05] preference:downside-first 用户决策时重视下行风险 (recall:3)
[2026-05-05] [persisted] rule:no-fundamental-pollution 通用 vs 投研记忆隔离 (recall:8)
```

上限 ≤ 20 条 entry。

### 4.5 _profile.md 淘汰规则

满 20 条时新条目入选规则：

1. `[persisted]` 永远保留
2. 新增 vs 现有按 `recall_count` 排序
3. 同分时 `updated_at` 较新优先
4. 长期未引用（30 天 recall_count 增量为 0）且非 persisted → 候选淘汰
5. DeepSeek prompt 输出 keep/evict/new 三清单，由 worker 应用

### 4.6 个体 .md 行格式

```
[2026-05-05] [scope: scene] [source: self|inbox|explicit] [recall: 0, last: -] preference:conclusion-first
用户喜欢结论先行，反复观察到。
```

`source` 取值：
- `self`：AI 在发言中自主写
- `inbox`：AI 采纳了 pending 后写
- `explicit`：用户显式说"记住"触发

`recall_count` 由 `memory_search` 命中时自动 bump。

## 5. 四条核心链路

### 5.1 链路 1：AI 自主写（前台）

```
AI 发言中觉得"该记" → 调 MCP memory_write({scope, kind, content, key, source:'self'})
  → Hub MCP server 写 .arena/.../memory/{slot}.md
  → UI 显示 [已记 N → 偏好] 角标
```

### 5.2 链路 2：Checkpoint Worker（后台，每 3 轮触发）

触发条件（轮次必满足，token 只能延后不能提前）：
- **必要条件**：`checkpoint-state.json` 中 `last_user_msg_count` ≥ 3 since `last_checkpoint_turn`
- **充分条件**：token 累计阈值（如 6K）
- **显式触发**：用户说"记一下/总结一下"
- **防抖**：1 分钟 cooldown（可配置）
- **互斥**：`.checkpoint.lock` 文件锁

执行流：

```
Hub 主进程检测到触发 → 创建 .checkpoint.lock
  → child_process.fork('checkpoint-worker.js', { sceneDir })
  → Hub 主进程立即返回 ← 不阻塞圆桌

Worker 独立进程（~3-5s）：
  1. 读 timeline.md 末 200 行（圆桌上下文，~3 轮全部发言）
  2. 读三家 memory/*.md
  3. 读当前 _profile.md
  4. 调 DeepSeek v4-pro（prompt 见 § 5.5）
  5. 增量更新 _profile.md（应用淘汰规则）
  6. 检测漏记 → 写 pending-{slot}.json（同 key 合并）
  7. 更新 checkpoint-state.json（last_checkpoint_turn / last_checkpoint_at）
  8. 删除 .checkpoint.lock
  9. process.exit(0)
```

### 5.3 链路 3：AI 处理 inbox（前台，下次发言前）

```
UserPromptSubmit hook 检测 pending-{slot}.json 非空 →
  竞态防护：
    - 检查 created_at > 上次本 slot 发言时间（防重复注入）
    - 检查 pending-{slot}.processing.json 不存在（如有且 mtime > 10 分钟 → 视为僵尸，rename 回 .json 重新注入）
    - rename 为 pending-{slot}.processing.json
  
  增 remind_count + 应用过期规则
  按 priority 排序（true 置顶）
  
  prompt 头部追加：
    "[INBOX] 你有 N 条记忆建议（路径 ...）。Read 后决定：
     - 采纳 → memory_write({source:'inbox'}) 然后从 pending 删除该条
     - 拒绝 → 移到 inbox-archived，不再提示
     处理后清空 .processing.json 文件（rename 回原名+清空 items）。"

AI 自决采纳/拒绝 → 个性保留 + 不漏记
```

### 5.4 链路 4：每日衰减（后台 cron）

```
Hub setInterval(86400000, decayScan) → 纯规则扫描：
  for each .arena/**/rooms/*/memory/*.md:
    if mtime < lastScanTime → skip
    parse 每条 entry:
      if [persisted] → skip
      if last_recalled_at < now - 90d → 加 ~~删除线~~（保留可见）
```

完全不用 LLM。

### 5.5 DeepSeek 派生 prompt（含反固化负面约束）

```
你是圆桌共识层提炼器。下面是三家 AI 对同一用户的最新观察。

任务：
1. 找出至少 2 家共现的稳定偏好/规则
2. 输出 ≤ 20 行的更新后 _profile.md
3. 对比当前 _profile，重复的不要输出
4. 检测漏记 → 输出每家的 pending 候选

【严格禁止纳入 _profile 的内容】
- 单轮讨论结论（如"今天倾向方案 A"、"看好茅台估值"）
- 临时投资立场或市场判断
- 具体话题的具体决策
- 仅出现 1 次的观察

【允许纳入 _profile 的内容】
- 协作偏好（"喜欢结论先行"、"不喜欢复读"）
- 稳定表达偏好（"用户喜欢被反对"）
- 多次重复的长期画像（"用户偏务实"）
- 场景规则（"通用 vs 投研记忆隔离"）

输出 JSON：
{
  "profile_keep": [...],     // 建议保留
  "profile_evict": [...],    // 建议淘汰（30 天未引用）
  "profile_new": [...],      // 新增条目
  "pending": {
    "pikachu": [...],
    "charmander": [...],
    "squirtle": [...]
  }
}
```

## 6. MCP 工具定义（3 个，复用 driver-mcp-server.js）

```typescript
memory_write({
  scope: 'scene',                // 阶段 0/1 固定 'scene'，cross-scene 阶段 2+ 才开
  kind: 'preference' | 'fact' | 'observation' | 'persisted',
  content: string,
  key?: string,
  source?: 'self' | 'inbox' | 'explicit'
})

memory_search({
  scope?: 'current',
  query: string,
  limit?: number = 5
})

memory_list({ scope?, kind? })
```

### scope 实施分阶段
- **阶段 0/1**：`scope` 只接受 `'scene'`
- **阶段 2+**：开放 cross-scene

### 显式触发路径
用户说"记住这个"/"记下" → **当前 AI 在自己发言流里识别**（Claude/Gemini/Codex 都能听懂）→ 调 `memory_write({source:'explicit'})`。

Hub **不做关键词匹配**——避免误判。MEMORY PROTOCOL 段必须明确：
> "用户说'记住'/'记下'等显式指令，必须立即调 memory_write，source='explicit'，并在回答中告知'已记下'。"

## 7. Prompt 模板修改

| AI | 文件 | 改动 |
|---|---|---|
| Pikachu (Claude) | `core/driver-mode.js` 加 MEMORY PROTOCOL 段（圆桌专用） | 复用 auto-memory 风格 |
| Charmander (Gemini) | `COPILOT_PROMPT_GEMINI` 加场景判断分支（mode==='roundtable' 时启用） | A 类→`save_memory`；B 类→MCP `memory_write` |
| Squirtle (Codex) | `COPILOT_PROMPT_CODEX` 加场景判断分支 | A 类→Codex auto；B 类→MCP `memory_write` |

### MEMORY PROTOCOL 段统一精神

```
## MEMORY PROTOCOL（圆桌专用）

观察到值得长期记的偏好/事实/对用户理解，调 memory_write。

【该记的三类】
- 偏好：用户协作风格
- 事实：项目稳定信息
- 观察：你对用户的理解

【不要记】
- 临时讨论结论 —— 防思维固化
- 一次性观察 —— 等多次确认再记

【显式触发】
用户说"记住这个" → 必记，source='explicit'，回答中告知"已记下 X"

【inbox 处理】
发言前看到 [INBOX] 提示，先 Read pending 文件后决定采纳/拒绝

【引用记忆】
"5 月 5 号你说过 X，所以..."
```

## 8. UI 改造（v3 简化：直接跳转文件，不弹 modal）

### 8.1 卡片按钮（v3 修正：直接跳转 .md，不是 modal）

每家 AI 卡片右上角加一组按钮（紧邻 `CtxXX%`）：

```
📒 N    📥(红点)   📊
个体    inbox      profile
```

- **`📒 N`**：N = 个体 .md 条目数。点击 → `shell.openPath(<slot>.md)` 用系统默认工具打开
- **`📥`**：仅 `pending-{slot}.json` 非空时显示（红点）。点击 → `shell.openPath(pending-{slot}.json)`
- **`📊`**：点击 → `shell.openPath(_profile.md)`

**v3 修正说明**：v2 设计的 Memory Viewer modal（3 tab + 交互按钮 + IPC handler）整体取消。理由：
1. 用户明确"按钮跳转 .md 文件"——不是要造新 viewer
2. 用户用自己的 markdown 编辑器更熟（VS Code / Typora / 系统默认）
3. 节省 ~200 行 UI + ~30 行 IPC handler

### 8.2 用户编辑文件 = 半透明的真正含义

用户想"标记某条 pending 优先" → **直接编辑 `pending-{slot}.json`** 加 `priority: true`，Hub 下次 hook 注入时识别置顶。**不需要"⭐ 标为优先"按钮**。

用户想删除某条记忆 → **直接编辑 `{slot}.md`** 删除该行。

**这才是真正的半透明**：用户用文本编辑器，记忆系统用同一份文件。零中间层。

### 8.3 IPC handler（v3 简化）

```javascript
// main.js 只需 1 个 IPC
ipcMain.handle('arena:open-memory-file', async (_, { scene, slot, type }) => {
  // type: 'own' | 'pending' | 'profile'
  const memDir = path.join(projectCwd, '.arena', 'rooms', scene, 'memory');
  const fileMap = {
    own: path.join(memDir, `${slot}.md`),
    pending: path.join(memDir, `pending-${slot}.json`),
    profile: path.join(memDir, '_profile.md'),
  };
  await shell.openPath(fileMap[type]);
});
```

~15 行。

### 8.4 Failure 状态灯（🧠）

Hub 状态栏右侧加一个 🧠 灯：
- 🟢 绿：正常
- 🟡 黄：单次派生失败
- 🔴 红：连续 5 次失败
- 鼠标悬停显示最近一次失败原因

### 8.5 disable 开关行为

`.memory-disabled` 文件存在时：
- ❌ 不写新 memory（MCP `memory_write` noop）
- ❌ 不触发 checkpoint worker
- ❌ 不显示 pending 提醒
- ✅ 仍读取 `_profile.md` 开场注入
- ✅ 仍显示 `📒/📥/📊` 按钮（用户可查看历史）
- ✅ 保留衰减扫描

即"停止新增但保留读取"。

## 9. 模块清单与行数估算（v3 大幅减少 UI）

| 模块 | 文件 | 行数 |
|---|---|---|
| MCP 工具扩展 | `core/driver-mcp-server.js` | +50 |
| 存储层 | `core/roundtable-memory/store.js` | ~80 |
| Inbox 模块 | `core/roundtable-memory/inbox.js` | ~80 |
| Checkpoint 协调器 | `core/roundtable-checkpoint.js` | ~80 |
| Worker 进程 | `core/checkpoint-worker.js` | ~200 |
| 衰减扫描 | `core/roundtable-decay.js` | ~30 |
| Prompt 模板 | `core/driver-mode.js` 修改 | +60 |
| Hub 后端集成 | `main.js` | +50 |
| **UI - 三个卡片按钮** | renderer | **~40**（v3：从 80 砍到 40） |
| **UI - Failure 🧠 状态灯** | renderer | ~25 |
| **IPC handler** | `main.js` | **~15**（v3：从 35 砍到 15） |
| 测试 | `tests/roundtable-memory.test.js` | ~150 |
| **合计** | | **~860 行** |
| **新增依赖** | | **0** |

v3 砍掉 ~320 行（Memory Viewer modal 不要了 + episodes.jsonl 不要了）。

## 10. 三阶段实施

### 阶段 0：MCP 工具 + Prompt 验证（1-2 天）

> ⚠ 不走 marker 协议污染回答 —— 直接上 MCP `memory_write`
> ⚠ scope 固定 'scene'，cross-scene 阶段 2+ 才开

任务：
1. 在 `driver-mcp-server.js` 注册 3 个 MCP 工具
2. 改 `driver-mode.js` 三家 prompt 加 MEMORY PROTOCOL 段
3. 实现 `roundtable-memory/store.js` 基础写盘
4. 实现 `checkpoint-state.json` 读写
5. 验证（见 § 11）

### 阶段 0 失败回滚路径

| 根因 | 回滚动作 |
|---|---|
| AI 不爱写（自主调用率 < 1次/场） | 加强 prompt 引导 + 加示例；如仍不达标，提前进入阶段 1 上 checkpoint 兜底 |
| 写入质量低（误记率 > 30%） | 加强 MEMORY PROTOCOL 反固化条款 |
| 引用率为 0 | 改 prompt 引导段加引用示例 |
| 全面失败 | 暂停，重新评估 |

### 阶段 1：核心 + UI（1-2 周）

任务：
1. checkpoint-worker.js + child_process.fork + lock 文件
2. DeepSeek v4-pro 派生 `_profile.md`（带反固化约束 + 淘汰规则）
3. inbox 机制 + UserPromptSubmit hook（带竞态防护 + 僵尸恢复）
4. **三个卡片按钮 + IPC `arena:open-memory-file`**
5. 🧠 状态灯
6. cooldown 防抖（1 分钟，可配置）
7. pending 生命周期（过期 / 合并 / 提醒次数 / priority 字段识别）

### 阶段 2：运营级（2-3 周）

任务：
1. 衰减扫描 cron
2. 失败兜底（连续 5 次告警）
3. `.memory-disabled` disable 开关
4. timeline.md 自动按月归档
5. inbox-archived/ 自动清理（>180 天）
6. cross-scene scope 开放 + 跨 scene 晋升

### 阶段 3：可选优化（按需）

- memory_search 升级 FTS5
- 跨 scene 偏好晋升到 `~/.claude/CLAUDE.md` 候选区
- AI 写入风格 dashboard

## 11. 阶段 0 验证指标（4 个硬指标）

| 指标 | 通过标准 |
|---|---|
| AI 自主 memory_write 调用率 | 每场圆桌 ≥1 次 |
| 写入质量 | ≥70% 是偏好/事实，非临时观点 |
| 误记率 | 抽查 10 条记忆，违反反固化规则比例 < 10% |
| AI 引用率 | 至少 1 次 AI 主动引用历史记忆 |

4 个全达标 → 进阶段 1。否则按 § 10 阶段 0 失败回滚路径处理。
跑 5-10 场圆桌后评估。

## 12. Failure Observability

- worker 失败 → exit code 非 0 → `consecutive_failures += 1`（写到 checkpoint-state.json）
- 单次失败 → 🟡 + 跳过本次
- 连续 5 次 → 🔴 + 用户提示
- DeepSeek API 不通 → 跳过本次，下次 cron 重试
- 状态灯悬停显示最近一次失败原因

## 13. 关键边界（红线）

| 红线 | 原因 |
|---|---|
| Worker 不能写 `{slot}.md` | 个性保留 |
| AI 不能改 `_profile.md` | 共识层由 worker 单一维护 |
| AI 不能写 `~/.claude/CLAUDE.md` | 用户级保护 |
| pending 处理后必须删除/归档 | 防重复注入 |
| inbox hook 必须时间戳校验 | 防同一条反复提示 |
| 阶段 0/1 scope 固定 'scene' | 避免 cross.md 误污染 |

## 14. 风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| AI 拒不采纳 inbox | 中 | 阶段 1 末观察采纳率 <30% 调引导 |
| DeepSeek API 不稳 | 低 | 单次跳过 + 5 次告警 |
| timeline.md 膨胀 | 中 | 阶段 2+ 自动按月归档 |
| 跨 AI 写入风格不一 | 高 | 阶段 0 验证期发现可调 prompt |
| worker fork 失败 | 低 | 主进程不受影响，下次重试 |
| pending 永久积压 | 中 | 7 天/3 次提醒后 expire |
| _profile 抖动 | 中 | DeepSeek 输出 keep/evict/new 三清单 |
| AI 误记短期观点 | 高 | DeepSeek 反固化约束 + 误记率指标 |
| inbox processing 僵尸 | 低 | 10 分钟超时自动恢复 |
| Hub 退出最后一轮丢状态 | 低 | `app.on('before-quit')` flush checkpoint-state.json |

## 15. v3 修正清单（吸收用户第 24 轮 3 处要害修正）

| # | 修正项 | 原因 |
|---|---|---|
| 1 | **删除 `episodes.jsonl`**，改用 `checkpoint-state.json`（单文件 <1KB 覆写） | 用户问"是干什么用的"——它是过度工程，Hub 内存就有相关数据 |
| 2 | **删除"主驾会议室"全部引用** | 用户：现在只有圆桌 + 普通 session，无主驾 |
| 3 | **UI 改为 `shell.openPath` 直接打开 .md 文件**，删除 Memory Viewer modal | 用户：按钮是跳转 .md 文件 |

附带影响：
- 模块行数从 ~1180 → **~860 行**（砍 ~320 行 modal + episodes 相关）
- IPC handler 从 ~35 → ~15 行
- "⭐ 标为优先"按钮取消 → 用户直接编辑 pending json 加 `priority: true` 字段

## 16. 决策记录

关键决策见 v2，本 v3 在 v2 基础上做 3 处用户拍板修正。

---

**总信心度**：99%。

**下一步**：用户审核本 plan v3 → 通过后切独立 session 启动阶段 0（按 § 10 顺序）。
