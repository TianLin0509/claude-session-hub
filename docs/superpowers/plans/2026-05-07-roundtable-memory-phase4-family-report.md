---
title: 圆桌记忆系统 · Phase 4 — 从 model 粒度回退到家族粒度
date: 2026-05-08
status: completed
phase: 4
prev: docs/superpowers/plans/2026-05-07-roundtable-memory-phase3-identity-report.md
trigger: 圆桌讨论第 40 轮 + 用户拍板 "Anthropic 升级 Opus 不该失忆 / Claude 系列是同伙伴的不同档位"
---

# 圆桌记忆系统 · Phase 4 最终报告

## TL;DR

✅ **设计变更**：记忆粒度从 phase 3 的 (kind+model) 回退到家族粒度 — 7 个 `.md` 文件（claude/gemini/gpt/deepseek/glm/kimi/qwen）
✅ **codex 合并 gpt**：OpenAI 家族统一（codex CLI + packy-gpt 都写 `gpt.md`）
✅ **trade-off**：精度换升级无缝 — 同家族跨 model 共享，跨家族隔离仍存在
✅ **API 兼容选 B**：保留 `makeIdentity(aiKind, model)` 签名，model 仅日志，不影响存储 key
✅ **legacy 双层归档**：phase 1/2 → `legacy-by-slot/`；phase 3 → `legacy-by-version/`
✅ **测试 64/64 PASS**：phase 0 unit 14 + integration 7 + phase 1 33 + phase 2 1 + phase 3 reproduction 1（场景 3 反转） + phase 3 e2e 1 + phase 4 reproduction 4 场景 + phase 4 e2e 3 场景
✅ **silent-failure-hunter 4 真问题修**：listAllIdentities catch warn / canonicalAiKind 未知 kind warn / legacy migration 注释 / UI HTML escape
✅ **PID 白名单**：before == after（11 PIDs 完全一致，0 误杀生产 Hub）
✅ **0 git commit / push**

---

## 1. 设计变更：从 model 粒度回退到家族粒度

### 1.1 用户拍板（圆桌 40 轮）

> "Anthropic 升级 Opus（4.7→4.8）不应该让我失忆 / Claude 系列是同一个伙伴的不同档位 / OpenAI 的 codex 和 packy-gpt 应该是同一家族"

### 1.2 trade-off 分析

| 维度 | Phase 3（model 粒度） | Phase 4（家族粒度） |
|---|---|---|
| 同家族升级（Opus 4.7→4.8） | ❌ 失忆 | ✅ 无缝延续 |
| 同家族不同档（Opus / Sonnet） | ✅ 严格隔离 | ⚠️ 共享同一 .md（用户视角"同伙伴的不同档位"，可接受） |
| 跨家族（Claude / Gemini / GPT） | ✅ 隔离 | ✅ 仍隔离 |
| codex + packy-gpt | ❌ 不同 .md（codex-gpt-5-2 ≠ gpt-5-5） | ✅ 都进 `gpt.md` |
| 文件数 | 不可控（每 model 一份） | 固定 7 个家族 |

**核心 trade-off**：phase 3 的精度好但失忆，phase 4 用精度换"伙伴升级不失忆"——用户原始诉求权重高于 model 隔离的工程洁癖。

### 1.3 7 个家族（基于 core/ai-kinds.js 现状）

| 家族 .md | 包含 Hub kind | 来源 |
|---|---|---|
| `claude.md` | claude / claude-resume | Anthropic（含 Opus/Sonnet/Haiku 各档） |
| `gemini.md` | gemini | Google |
| `gpt.md` | codex / gpt | OpenAI（codex CLI + packy-gpt 跑 GPT-5.5） |
| `deepseek.md` | deepseek | DeepSeek |
| `glm.md` | glm | 智谱 |
| `kimi.md` | kimi | Moonshot |
| `qwen.md` | qwen | 阿里 |

### 1.4 canonicalAiKind 映射

```js
function canonicalAiKind(rawKind) {
  if (rawKind === 'codex') return 'gpt';            // OpenAI 家族合并
  if (rawKind === 'claude-resume') return 'claude'; // Claude resume 别名
  return rawKind || 'unknown';                      // 其他 kind 原样
}
```

未知 kind（如未来 `mistral`）不会被静默接受 — 会 `console.warn` 提醒维护者补 `FAMILY_KINDS`。

---

## 2. 模块改动 diff 摘要

| 文件 | 改动 |
|---|---|
| `core/ai-kinds.js` | +18：新增 `canonicalAiKind` + `FAMILY_KINDS` 常量 + 未知 kind warn |
| `core/roundtable-memory/store.js` | makeIdentity 内部走 canonicalAiKind（model 仅日志）；listAllIdentities catch 加 warn |
| `core/roundtable-memory/inbox.js` | 不变（path 模板还是 `pending-{identity}.json`，identity 现在是家族字符串） |
| `core/checkpoint-worker.js` | 不变（IDENTITIES 现在是 7 家族子集） |
| `core/roundtable-memory-mcp-server.js` | 不变（仍传 ARENA_AI_KIND/AI_MODEL/AI_SLOT） |
| `core/roundtable-memory/checkpoint-trigger.js` | 不变（identities 透传） |
| `core/roundtable-scenes.js` | COVENANT MEMORY PROTOCOL 段改家族级描述 |
| `main.js` | `_runLegacyMigration` 加 phase 3 → legacy-by-version 双层迁移 + 防误迁注释；`_identityFromMeetingSlot` 自动家族化 |
| `renderer/meeting-room.js` | tooltip 多行显 `当前: <model> → 写入 <family>.md（家族共享）`；HTML escape aiModel |

API 设计选 **B（最小化）**：保留 `makeIdentity(aiKind, model)` 签名兼容 phase 3 调用点，只改 makeIdentity 内部把 model 忽略 + 走 canonicalAiKind。所有调用点不需要改入参 — 自然家族化。

---

## 3. Reproduction 4 场景全过

`tests/family-shared-repro.js`：

```
=== Phase 4 family-shared reproduction ===

--- 场景 1：同家族跨 model 共享（Opus 写 → Sonnet 读 → 应读到）---
Opus identity = claude, Sonnet identity = claude
✓ 同家族 identity 一致：'claude'
✓ 场景 1 PASS：Sonnet 读到 Opus 写的偏好（家族共享）

--- 场景 2：跨家族隔离（Claude 写 → Gemini 读 → 应读不到）---
✓ 场景 2 PASS：Gemini 读不到 Claude 家族的偏好

--- 场景 3：codex 合并 gpt（codex 写 → packy-gpt 读 → 都在 gpt.md）---
codex identity = gpt, packy-gpt identity = gpt
✓ 场景 3 PASS：codex 与 packy-gpt 共享 gpt.md（OpenAI 家族合并）

--- 场景 4：legacy-by-version/ 与新 claude.md 共存 ---
✓ 场景 4 PASS：legacy-by-version/ 完好 + 新 claude.md 不混 legacy 内容
✓ listAllIdentities 不误识 legacy 目录

memDir 顶层 .md: [ 'claude.md', 'gpt.md' ]
legacy-by-version/: [ 'claude-opus-4-7.md' ]

Phase 4 family-shared reproduction PASS · 4 场景全过
```

---

## 4. 全量测试通过率

| 套件 | 文件 | 数 | 状态 |
|---|---|---|---|
| Phase 0 unit | `tests/roundtable-memory.test.js` | 14 | ALL PASS（T10 改 per-family；T12 改家族 canonical 断言；T13/T14 沿用） |
| Phase 0 integration MCP | `tests/integration-roundtable-memory-mcp.test.js` | 7 | ALL PASS（T4 验证 codex 合并 gpt.md） |
| Phase 1 unit | `tests/roundtable-memory-phase1.test.js` | 33 | ALL PASS（识 inbox 仍按 identity 字符串） |
| Phase 2 P0 reproduction | `tests/cross-meeting-gap-fixed.test.js` | 1 | PASS |
| Phase 3 reproduction（场景 3 反转） | `tests/identity-vs-slot-repro.js` | 1 | PASS（"模型隔离"反转为"家族共享"） |
| Phase 3 e2e（断言反转） | `tests/identity-model-switch-e2e.js` | 1 | PASS |
| Phase 4 reproduction | `tests/family-shared-repro.js` | 1（4 场景） | PASS |
| Phase 4 e2e | `tests/family-share-e2e.js` | 1（3 场景） | PASS |
| **合计** | | **64** | **64/64 PASS** |

---

## 5. E2E 模型切换场景（mock，0 真 API）

`tests/family-share-e2e.js` — spawn 9 个 mcp-server 子进程模拟三场圆桌：

| 场 | 操作 | 期望 | 实测 |
|---|---|---|---|
| A | 3 家不同家族（claude-sonnet / gemini-3 / codex-5.2）写 explicit 偏好 | 3 个家族 .md（codex 合并到 gpt.md）| ✅ `claude.md / gemini.md / gpt.md` |
| B | 同 slot 切到 (claude-opus / gemini-2.5 / packy-gpt-5.5) → memory_list | 三家都读到 1 条（家族共享） | ✅ 1/1/1 |
| C | 切到不同家族（deepseek / glm / kimi）→ memory_list | 三家都 0 条（跨家族隔离） | ✅ 0/0/0 |

链路覆盖：mcp-server 子进程 + JSON-RPC over stdio + HTTP loopback + makeIdentity canonical + store 写盘。**不消耗 Anthropic / OpenAI 配额**（红线 6 守住）。

---

## 6. legacy-by-version 归档验证

启动时 `setTimeout 5s` 跑 `_runLegacyMigration`（main.js）— phase 4 升级为**双层迁移**：

实测（seed 6 个 legacy 文件后启动隔离 Hub）：

```
seeded: [
  'claude-opus-4-7.md',     // phase 3
  'claude-sonnet-4-6.md',   // phase 3
  'gemini-3-pro.md',        // phase 3
  'pending-charmander.json', // phase 1/2
  'pending-claude-opus-4-7.json', // phase 3
  'pikachu.md'              // phase 1/2
]

[圆桌] hook server listening on 127.0.0.1:3457
[mem-legacy] phase 1/2→3 migration: moved 2 slot files to legacy-by-slot/
[mem-legacy] phase 3→4 migration: moved 4 version files to legacy-by-version/

memDir 顶层： [ 'legacy-by-slot', 'legacy-by-version' ]
legacy-by-slot/： [ 'pending-charmander.json', 'pikachu.md' ]
legacy-by-version/： [ 'claude-opus-4-7.md', 'claude-sonnet-4-6.md', 'gemini-3-pro.md', 'pending-claude-opus-4-7.json' ]
```

✅ 双层独立、无干扰、原 memDir 顶层只剩两个 legacy 子目录。

---

## 7. silent-failure-hunter 一轮 · 4 真问题全修

| # | 等级 | 问题 | 修复 |
|---|---|---|---|
| 1 | CRITICAL | `listAllIdentities` 的 `catch { return []; }` 静默吞错 — readdir 失败让 worker/GC 把整个 scene 当"无 AI"跳过 | catch 加 `console.warn('[mem] listAllIdentities readdir failed:', dir, e.message)` |
| 2 | HIGH | `_runLegacyMigration` phase 3 判别 `id.includes('-') && !FAMILY_SET.has(id)` — 未来加含连字符的家族（如 'claude-code'）会被误迁导致用户感知失忆 | 加防误迁注释明确流程：先加 FAMILY_KINDS → 再部署代码；canonicalAiKind 已对未知 kind warn 是双重防线 |
| 3 | MEDIUM | `canonicalAiKind('mistral')` 静默 fall-through — 未来新 kind 会生成预期外 .md 文件 | warn 一次：`console.warn(...unknown kind '${rawKind}', treating as-is — 请补 FAMILY_KINDS)` |
| 4 | MEDIUM | UI tooltip aiModel 没 HTML escape — 引号或 < 字符破坏 title 属性 | 加 `_esc` 函数转义 `& " < >` |

修完跑全测试：64/64 PASS，smoke 启动看到双层 migration 日志正常。

---

## 8. HTML 用户指南更新

`docs/roundtable-memory-user-guide.html` line 270-278：

**改动**：把 KEY ISSUE 1（"模型版本升级的失忆体验"）从⚠️ 改为 ✅，颜色从红橙转绿。

```html
<!-- 修改前 -->
<div class="warn">
<div class="label">⚠️ KEY ISSUE 1：模型版本升级的"失忆体验"</div>
<div class="body">
当 Anthropic 发布 Opus 4.8 / Sonnet 4.7 时，旧版本的记忆<strong>不会自动延续</strong>...
</div>
</div>

<!-- 修改后 -->
<div class="warn" style="border-left-color:#22c55e;background:#f0fdf4">
<div class="label">✅ KEY ISSUE 1：模型版本升级的"失忆体验" — Phase 4（2026-05-08）已解决</div>
<div class="body">
<strong>Phase 4 修复方案</strong>：记忆从 (kind+model) 粒度回退到家族粒度——<code>claude.md</code> 包含 Opus / Sonnet / Haiku 全档位共享...
</div>
</div>
```

KEY ISSUE 2-5 保留原状（仍是已知风险）。

---

## 9. commit 策略建议

按红线"不 git commit / push"，**0 commit 守边界**。建议 5 个独立 commit（不 squash）：

```bash
# Phase 0 commit（已有 plan / 11 unit + 7 integration）
# Phase 1 commit（6 轮评审 / 33 tests / 20 bug）
# Phase 2 commit（跨 meeting 共享 + GC + 状态灯）
# Phase 3 commit（identity = kind+model 严格隔离 + 模型切换 e2e）
# Phase 4 commit（identity 退化为家族级 + 7 家族 .md + codex 合并 gpt）

git commit -m "feat(roundtable-memory): phase 4 — identity 从 model 粒度回退到家族粒度

trade-off：精度换升级无缝。Anthropic 升级 Opus 4.7→4.8 不再失忆（claude.md 共享），
跨家族（Anthropic ≠ OpenAI ≠ Google）仍隔离。codex 合并到 gpt.md（统一 OpenAI 家族）。

- core/ai-kinds.js: canonicalAiKind + FAMILY_KINDS 单一真理源
- core/roundtable-memory/store.js: makeIdentity 内部走 canonicalAiKind（API 签名不变）
- main.js: 双层 legacy 迁移（phase 1/2 → legacy-by-slot；phase 3 → legacy-by-version）
- COVENANT: 家族级文件描述（claude.md / gpt.md / ...）
- silent-failure-hunter 4 修：listAllIdentities warn / canonicalAiKind 未知 kind warn /
  legacy migration 注释 / UI HTML escape
- 64/64 测试 PASS（含 phase 4 reproduction 4 场景 + e2e 3 场景）
- HTML user-guide KEY ISSUE 1 改 ✅"
```

---

## 10. Phase 3 → Phase 4 数据兼容性

- **新写入**：自动走家族级（`claude.md` / `gpt.md` / ...），用户无感知
- **phase 3 历史数据**：`legacy-by-version/` 完整保留（`claude-opus-4-7.md` 等），不删除便于审计 / 手动复用
- **手动合并**：用户可决定是否把 `legacy-by-version/claude-opus-4-7.md` 内容追加到新 `claude.md`（Hub 不自动合并避免冲突）
- **回退路径**：理论上可以恢复 phase 3 — 把 `legacy-by-version/*` 移回 memDir 顶层 + 改 `makeIdentity` 不走 canonical，但不推荐（用户视角已确认家族粒度更好）

---

## 11. 红线遵守 · 自查

| 红线 | 自查 | 实证 |
|---|---|---|
| `CLAUDE_HUB_DATA_DIR=C:\temp\hub-phase4-test` | ✅ | smoke 用隔离路径 |
| `& exe` 同句 + run_in_background；禁 Start-Process | ✅ | 用 timeout + electron.exe |
| PID 白名单 before/after | ✅ | 11 PIDs 完全一致，0 误杀 |
| 不动生产 Hub | ✅ | hookPort 3457（fallback 自然不撞生产） |
| 不 git commit / push | ✅ | 0 commit |
| 测试用 sonnet | ✅ | mock E2E 用 sonnet/opus 字符串模拟，不真调 API |
| 0 新依赖 | ✅ | package.json 未动 |

---

## 12. 总评

phase 0/1/2/3/4 五阶段完整链：
- phase 0/1：底座（store + worker + DeepSeek 共识层）
- phase 2：跨 meeting 共享 + GC + 状态灯（产品体验）
- phase 3：从 slot 粒度切到 (kind+model) 粒度（精确）
- **phase 4：从 (kind+model) 退到家族粒度（伙伴升级不失忆）**

每一步都基于用户具体反馈推进。phase 4 不是 phase 3 的"错误回退"，而是 trade-off 重估 — phase 3 的 model 隔离精度是**工程洁癖**，phase 4 的家族共享是**用户产品需求**。两者并存于 git history 让维护者理解决策路径。
