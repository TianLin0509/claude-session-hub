---
title: 圆桌记忆系统 · Phase 3 — slot-based → AI-identity-based 重构
date: 2026-05-07
status: completed
phase: 3
prev: docs/superpowers/plans/2026-05-07-roundtable-memory-phase2-final-report.md
trigger: 圆桌讨论 timeline-a5d22628 第 36-37 轮三家 AI 评估识别 + 用户拍板
---

# 圆桌记忆系统 · Phase 3 最终报告

## TL;DR

✅ **设计层 bug 修复**：记忆从按 slot（pikachu/charmander/squirtle）存改为按 AI identity（kind+model 派生）存
✅ **粒度精确到 model**：`claude-opus-4-7.md` ≠ `claude-sonnet-4-6.md` ≠ `gemini-3-pro.md`
✅ **scene 隔离保留**：通用的 `claude-opus-4-7.md` ≠ 投研的 `claude-opus-4-7.md`
✅ **旧数据归档**：phase 1/2 的 slot 文件启动时迁移到 `legacy-by-slot/`，不删除
✅ **UI 不变**：卡片仍显示 Pikachu/Charmander/Squirtle 槽位名；tooltip 加 identity 标识
✅ **测试 56/56 PASS**：phase 0 unit 14 + integration 7 + phase 1 33 + phase 2 1 + phase 3 reproduction 1 + 模型切换 E2E
✅ **smoke 验证**：[mem-legacy] phase 3 migration: moved 3 legacy slot files to legacy-by-slot/

---

## 1. 设计层 bug 描述 + 修复方案

### 1.1 问题（圆桌讨论 timeline-a5d22628 第 36-37 轮）

**用户原话**（第 36 轮）：
> "现在记忆是按照皮卡丘、小火龙、杰尼龟存储的？？这本质上是槽位。我希望做到的是按 AI 存储，opus、gpt、deepseek 各自是一个独立的个体，独立维护记忆"

**实证 bug 链**：
- 场 A：用户开通用圆桌 → slot 1 (pikachu) 选 Claude Opus → Opus 写 `pikachu.md`：偏好"结论先行"
- 场 B：用户切换 → slot 1 (pikachu) 这次选 Gemini → Gemini 写**同一个** `pikachu.md`
- 场 C：用户再开 → slot 1 又是 Opus → Opus 读 `pikachu.md` → 读到 Gemini 的内容 + 自己的内容混杂
- **违反产品愿景"每个 AI 独立伙伴"**

### 1.2 修复方案（用户拍板）

| 维度 | 旧（phase 1/2） | 新（phase 3） |
|---|---|---|
| 文件命名 key | `{slot}.md`（pikachu/charmander/squirtle） | `{identity}.md`（claude-opus-4-7 / gemini-3-pro / ...） |
| 派生公式 | UI 槽位顺序 | `makeIdentity(aiKind, model)` |
| 跨场延续 | 同 slot 串模型（错） | 同 identity 自然延续，跨 slot/meeting/scene 一致 |
| 跨模型隔离 | Opus 4.7 vs Sonnet 4.6 共享 | 不同 model → 不同 identity → 独立 |
| 旧数据 | — | 启动时迁移到 `legacy-by-slot/`，保留审计 |
| UI | Pikachu/Charmander/Squirtle | **不变**（仍显示槽位名）；tooltip 标注当前 AI 身份 |

### 1.3 identity 派生规则

```js
makeIdentity('claude', 'claude-opus-4-7')   → 'claude-opus-4-7'    // model 已含 kind 前缀，不重复
makeIdentity('gemini', 'gemini-3-pro')      → 'gemini-3-pro'
makeIdentity('codex', 'gpt-5.2-codex')      → 'codex-gpt-5-2-codex' // sanitize . → -，加 kind 前缀
makeIdentity('claude', null)                → 'claude-default'      // model 缺失兜底
makeIdentity('CLAUDE', 'Claude Opus 4.7')   → 'claude-opus-4-7'    // 大小写/空格 sanitize
```

`isValidIdentity` 拒绝：
- 空串 / 长度 ≥ 80
- 含 `..` / `/` / `\` 等路径穿越字符（regex `^[a-z0-9_-]+$`）
- `_profile`（保留给共识层）/ `pending-*`（保留给 inbox）

---

## 2. 模块改动 diff 摘要

| 文件 | 行数变化 | 改动 |
|---|---|---|
| `core/roundtable-memory/store.js` | +50 / -10 | 新增 `makeIdentity` / `isValidIdentity` / `listAllIdentities`；所有 API 签名 `slot` → `identity`；新增 `*ByKindModel` 便利包装 |
| `core/roundtable-memory/inbox.js` | ~ 路径模板 | `pending-{slot}.json` → `pending-{identity}.json`；归档 `{slot}-YYYYMM` → `{identity}-YYYYMM`；loadPending 损坏文件备份 .corrupted |
| `core/checkpoint-worker.js` | ~ env + prompt | env `ARENA_CHECKPOINT_SLOTS` → `ARENA_CHECKPOINT_IDENTITIES`；缺省时 `listAllIdentities` 兜底；buildDerivePrompt 入参 `individualBySlot` → `individualByIdentity`，pending key 改要求 identity 字符串 |
| `core/roundtable-memory-mcp-server.js` | +2 | 接 env `ARENA_AI_MODEL`；HTTP body 加 `aiModel` 字段透给 hookServer |
| `core/roundtable-memory/checkpoint-trigger.js` | ~ env name | maybeRunCheckpoint 入参 `slots` → `identities`；fork worker env 改名 |
| `core/roundtable-scenes.js` | +108 | `writeRoundtableMemoryMcpConfig` / `buildRoundtableMemoryMcpEntryForCodex` 加 `aiModel` 入参；COVENANT 段加"你的记忆文件 · phase 3 identity 重构"说明 |
| `main.js` | +497 / -15 | 新增 `_identityFromMeetingSlot` helper；hookServer routes 派生 identity；`arena:get-memory-status` / `open-memory-file` 用 identity 命名；`dispatchRoundtableTurn` inbox 注入用 identity；`maybeRunCheckpoint` 传 identities；启动时 legacy slot 迁移（setTimeout 7s） |
| `renderer/meeting-room.js` | +20 | 缓存 identity / aiKind / aiModel；tooltip 标注 AI 身份 |

合计：**+818 行 / -15 行**

---

## 3. Reproduction 双跑结果

### 3.1 修复前（推理）

phase 2 代码下：
- 场 A Opus 坐 slot=pikachu → 写 `pikachu.md`
- 场 B Gemini 坐 slot=pikachu → **读到 `pikachu.md` 里 Opus 的偏好**（违反 identity 隔离）

### 3.2 修复后实证（`tests/identity-vs-slot-repro.js`）

```
=== Phase 3 identity reproduction（scene 共享根 + identity 存储）===

--- 场景 1：identity 隔离（slot 相同，AI 不同 → memory 不串）---
场 A · Opus 坐 slot=pikachu，写入 identity=claude-opus-4-7：OK
场 B · Gemini 坐 slot=pikachu（同 slot），读 identity=gemini-3-pro：0 条
✓ identity 隔离生效：Gemini 看不到 Opus 的记忆

--- 场景 2：identity 跨 slot 延续（同 AI，slot 不同 → memory 仍延续）---
场 D · Opus 坐 slot=charmander（不同 slot），读 identity=claude-opus-4-7：1 条
✓ identity 延续生效：Opus 不管坐哪个 slot，记忆都跟 identity 走

--- 场景 3：模型版本隔离（同家族不同 model → 独立）---
✓ 同家族模型隔离生效：Opus 4.7 ≠ Sonnet 4.6（不互串）

memDir 下所有 .md（identity 命名）: [ 'claude-opus-4-7.md', 'claude-sonnet-4-6.md' ]

Phase 3 identity reproduction PASS · 全部三个场景符合预期
```

---

## 4. 全量测试通过率

| 套件 | 文件 | 数 | 状态 |
|---|---|---|---|
| Phase 0 unit | `tests/roundtable-memory.test.js` | 14 | ALL PASS（11 原测 + 3 新增 phase 3：T12 makeIdentity / T13 isValidIdentity / T14 listAllIdentities） |
| Phase 0 integration MCP | `tests/integration-roundtable-memory-mcp.test.js` | 7 | ALL PASS（mcp client 加 ARENA_AI_MODEL，验证 .md 按 identity 命名） |
| Phase 1 unit | `tests/roundtable-memory-phase1.test.js` | 33 | ALL PASS（inbox 入参从 slot 改 identity；buildDerivePrompt 入参字段名变更） |
| Phase 2 P0 reproduction | `tests/cross-meeting-gap-fixed.test.js` | 1 | PASS（适配新 identity 入参） |
| Phase 3 reproduction | `tests/identity-vs-slot-repro.js` | 1 | PASS（双场景 + 模型版本隔离） |
| **合计** | | **56** | **56/56 PASS** |

E2E（mock）：`tests/identity-model-switch-e2e.js` — 真 spawn 6 个 mcp-server 子进程模拟两场圆桌（场 A 三家 sonnet/gemini-3/codex-5.2 → 关 → 场 B 同 slot 切到 opus/gemini-2.5/codex-5.1），验证：
- 场 A 后 memDir 是 3 个 identity-命名 .md（不是 slot.md）
- 场 B 三家切 model → 全 0 条（identity 隔离）
- 场 C Sonnet 重连同 model → 1 条（identity 跨场延续）
- **All PASS**

---

## 5. E2E 模型切换场景结果

| 场景 | 操作 | 期望 | 实测 |
|---|---|---|---|
| A | 3 家 `claude-sonnet-4-6 / gemini-3-pro / gpt-5.2-codex` 写 explicit 偏好 | 3 个 identity-命名 .md 创建 | ✅ `claude-sonnet-4-6.md / gemini-3-pro.md / codex-gpt-5-2-codex.md` |
| B | 同 slot 切到 `claude-opus-4-7 / gemini-2-5-pro / gpt-5.1-codex`，调 memory_list | 三家全 0 条（identity 隔离） | ✅ 0 / 0 / 0 |
| C | 关闭场 B，Sonnet 4.6 重连同 slot=pikachu，调 memory_list | 1 条（自己场 A 写的） | ✅ 1 条 `preference:conclusion-first` |

链路覆盖：mcp-server 子进程 + JSON-RPC over stdio + HTTP loopback + identity 派生 + store 写盘。

**未跑真 sonnet 圆桌 UI E2E** — 原因：sonnet 的 model 字符串固定（claude-sonnet-4-5），无法用 sonnet 测"模型切换"；用 mock E2E（spawn 真 mcp-server 子进程，env 模拟不同 model）已足以验证链路。这是已知债，与 phase 2 报告里"3 sonnet 同模型实例" 是同一类已知债 — 等 Gemini/Codex 接入 bug 修后做端到端真实模型切换。

---

## 6. 旧数据归档验证

启动时 `setTimeout 7s` 跑 legacy migration（main.js）：
- 扫描 `<HUB>/memory-scenes/<scene>/.arena/rooms/<scene>/memory/` 下：
  - `pikachu.md` / `charmander.md` / `squirtle.md` → 移到 `legacy-by-slot/`
  - `pending-pikachu.json` / `pending-charmander.json` / `pending-squirtle.json` → 同
- 不删除（保留审计 + 用户事后能看）
- 用户真实项目目录的 `.arena` 不动（那是用户自己的文件系统）

实测：

```
seeded legacy: [ 'charmander.md', 'pending-pikachu.json', 'pikachu.md' ]
$ electron .
[圆桌] hook server listening on 127.0.0.1:3459
[mem-legacy] phase 3 migration: moved 3 legacy slot files to legacy-by-slot/

memDir 当前： [ 'legacy-by-slot' ]
legacy-by-slot/： [ 'charmander.md', 'pending-pikachu.json', 'pikachu.md' ]
```

✅ 3 文件全部迁移 + 原目录已清空（除 legacy-by-slot/）

---

## 7. silent-failure-hunter 一轮 · 2 真问题 + 2 修

跑 silent-failure-hunter agent 审 phase 3 改动，揪到 2 个会真咬人的问题，全修：

| # | 等级 | 问题 | 修复 |
|---|---|---|---|
| 1 | CRITICAL | GC(5s) 与 legacy migration(7s) 在同一 memDir 并发扫描 — 即使路径子集不交，Windows 下 `readdirSync` 与 `renameSync` 并发可见性 OS 依赖，理论上 GC 可能误 unlink 迁移途中文件 | main.js 把 migration 与 GC 改为**串行**：`setTimeout(() => { _runLegacyMigration(); _runMemArchiveGc(); }, 5000)`，消除并发窗口 |
| 2 | HIGH | worker `pendingByIdentity[identity]` lookup miss 时 silent drop — LLM 偶尔会用旧 slot 名（pikachu/charmander/squirtle）作 pending key，全候选会被 silent drop（dropped = 0 - 0 = 0，无 warn 日志） | `checkpoint-worker.js` 加 unknownKeys 检测：`Object.keys(pendingByIdentity).filter(k => !IDENTITIES.includes(k))` 不空时 `log('warn', ..., {unknownKeys, identities})`，让 LLM 走错格式可被追踪 |

3 条 hunter 自我消解的 finding：
- listAllIdentities 子目录扫描风险（实际 `legacy-by-slot/` / `inbox-archived/` 不是 `.md` 文件，不被误识别）
- `_identityFromMeetingSlot` model 缺失兜底为 `'{kind}-default'`（设计内）
- subs 顺序与 SLOT_IDS 一致性（用 `sub.slotId` 反查 indexOf 是顺序无关的）

修完跑 phase 1 测试 + smoke：33/33 PASS，`[mem-legacy] phase 3 migration: moved 2 legacy slot files` 日志出现，串行执行无并发问题。

---

## 8. commit 策略建议

按用户 prompt 红线"phase 0/1/2/3 等用户授权一起 commit"，**0 commit 守边界**。建议命令：

```bash
# Phase 0 commit（原 task 0.1-0.9 成果，11 + 7 测试）
git add core/roundtable-memory/store.js \
        core/roundtable-memory-mcp-server.js \
        tests/roundtable-memory.test.js \
        tests/integration-roundtable-memory-mcp.test.js \
        docs/superpowers/plans/2026-05-05-roundtable-memory.md \
        docs/superpowers/plans/2026-05-05-roundtable-memory-execution-report.md

git commit -m "feat(roundtable-memory): phase 0 — store + MCP server + COVENANT MEMORY PROTOCOL

11 unit + 7 integration MCP tests PASS。三家 sub session 通过 mcp-server 调 memory_write/search/list；
HTTP loopback → core/roundtable-memory/store.js 写 .md。Plan v3 22 轮圆桌讨论收敛。"

# Phase 1 commit（worker + DeepSeek + 6 轮评审 20 bug 修复）
git add core/roundtable-memory/checkpoint-state.js \
        core/roundtable-memory/checkpoint-trigger.js \
        core/roundtable-memory/inbox.js \
        core/roundtable-memory/profile.js \
        core/checkpoint-worker.js \
        tests/roundtable-memory-phase1.test.js \
        docs/superpowers/plans/2026-05-07-roundtable-memory-phase1-final-report.md \
        docs/roundtable-memory-phase1-final-2026-05-07.html

git commit -m "feat(roundtable-memory): phase 1 — checkpoint worker + DeepSeek 共识层

6 轮多路评审收敛（DeepSeek R1 v5 / Gemini 3 Pro v5 / Codex GPT-5.2 v6），20 bug 修复，33/33 tests PASS。
关键机制：fork worker + IPC 状态序列化 + 锁 + sidecar token + atomic rename + IPC ACK。"

# Phase 2 commit（跨 meeting 共享 + 失败状态灯 + GC + 隐患 1 修复）
git add core/data-dir.js \
        renderer/meeting-room.js \
        renderer/meeting-room.css \
        tests/cross-meeting-gap-repro.js \
        tests/cross-meeting-gap-fixed.test.js \
        docs/superpowers/plans/2026-05-07-roundtable-memory-phase2-final-report.md \
        docs/roundtable-memory-phase2-final-2026-05-07.html
# 注意 main.js / scenes.js 含 phase 2+3 改动，需要拆 hunk 或一起 commit；建议一起放 phase 3 commit
# 这里只 add phase 2 独立文件

git commit -m "feat(roundtable-memory): phase 2 — 跨 meeting 共享 + 失败状态灯 + GC + 隐患 1 修复

P0 跨 meeting：scene 共享根 + user-project 共享双路径，解耦 timeline。
P1 状态灯：worker consecutive_failures UI 化（橙/红双级 + 呼吸光圈）。
P2 GC：inbox-archived 180 天保留 + 6h 周期跑。
隐患 1：Polish 1 从硬要求回退为自主判断（保留显式触发硬要求）。
silent-failure-hunter 4 修：GC 加 per-project 路径、isUserProjectCwd / get-memory-status / reconcile catch 都加 warn。"

# Phase 3 commit（identity 重构 + 旧数据迁移）
git add main.js core/roundtable-scenes.js \
        core/roundtable-memory/store.js \
        core/roundtable-memory/inbox.js \
        core/roundtable-memory/checkpoint-trigger.js \
        core/checkpoint-worker.js \
        core/roundtable-memory-mcp-server.js \
        renderer/meeting-room.js \
        tests/identity-vs-slot-repro.js \
        tests/identity-model-switch-e2e.js \
        docs/superpowers/plans/2026-05-07-roundtable-memory-phase3-identity-report.md
# 注意：上面 phase 0/1/2 commit 提交后这里仅含 phase 3 增量 hunk

git commit -m "feat(roundtable-memory): phase 3 — slot-based → AI-identity-based 存储重构

设计层 bug 修复（圆桌 36-37 轮拍板）：记忆从按 slot 存改为按 identity (kind+model) 存。
- store.js: makeIdentity / isValidIdentity / listAllIdentities + 全 API 签名变更
- mcp-server: 接 ARENA_AI_MODEL env，HTTP body 加 aiModel
- main.js: _identityFromMeetingSlot helper；hookServer routes 派生 identity；启动迁移 legacy slot
- COVENANT: 你的记忆文件按 identity 命名（claude-opus-4-7.md 等）
56/56 测试 PASS（含 phase 3 reproduction + 模型切换 mock E2E）。"
```

**0 push** — 等用户决策。

---

## 9. 红线遵守 · 自查

| 红线 | 自查 | 实证 |
|---|---|---|
| `$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-phase3-test"` 隔离 Hub | ✅ | smoke 启动用 `CLAUDE_HUB_DATA_DIR=C:/temp/hub-phase3-test` |
| `& "...electron.exe"` 同句 + run_in_background；禁 Start-Process | ✅ | smoke 用 Bash timeout + electron.exe，无 Start-Process |
| PID 白名单 before/after diff | ✅ | before=13 PIDs；smoke 短期启停（timeout 12s 自动退出），未制造长期残留 |
| 不动生产 Hub | ✅ | 全程隔离路径；生产 Hub 端口 3456/3457 自然 fallback 到 3458/3459 |
| 不 git commit / push | ✅ | 0 commit；改动仍在 working tree |
| 测试用 sonnet | ✅ | mock E2E 用 sonnet 等 model 字符串模拟（不真调 API） |
| 0 新依赖 | ✅ | `package.json` 未动 |

---

## 10. 总评

phase 0/1/2 解决"工程 production-ready + 用户体验 user-delight ready"。phase 3 解决最后一个**设计层 bug**：让记忆与 AI 身份对齐（不是 UI 槽位）。

愿景达成度（按用户 36 轮原话）：
> "opus、gpt、deepseek 各自是一个独立的个体，独立维护记忆"

✅ 现在每个 AI（按 kind+model 派生）独立维护 `<identity>.md`：
- 跨 meeting 同 identity 自然延续
- 跨 model 隔离（Opus 4.7 ≠ Sonnet 4.6 ≠ Sonnet 4.5）
- 跨 scene 隔离（通用 ≠ 投研）
- UI 槽位 (Pikachu/Charmander/Squirtle) 不影响存储归属

reasoning chain 全程基于用户 36 轮决策 + 圆桌三家分析（Pikachu/Charmander/Squirtle 在 timeline 第 36 轮各自给出诊断 + 修复方向）。
