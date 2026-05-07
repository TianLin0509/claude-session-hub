# 圆桌记忆系统 阶段 0 · 执行报告

> 执行 session：2026-05-06 凌晨（driver = Claude Opus 4.7 1M context）
> Plan：`docs/superpowers/plans/2026-05-05-roundtable-memory.md`（v3）
> 报告完成时间：2026-05-06 02:18 (本地)

## TL;DR

- ✅ 阶段 0 代码完整落地：store.js + memory MCP server + main.js hookServer 路由 + scenes.js MEMORY PROTOCOL prompt + Gemini 全局 settings 注册
- ✅ Smoke test × 2 通过（隔离 Hub 都到 `[圆桌] hook server listening`，无 require/load 错误）
- ✅ Unit test 11/11 通过（store.js append/dedup/parse/search/list/edge cases/per-slot/per-scene 隔离）
- ✅ Integration test 7/7 通过（mock hookServer + 真 MCP server 子进程 × 3 + 真 stdio JSON-RPC，链路：JSON-RPC → HTTP → store → .md）
- ⚠ **真 AI 实跑 1+ 场圆桌端到端验证未做**——单 driver session + 红线 5（避 Opus ≤1 并发）+ UI 改造在阶段 1 范围
- ⚠ **Plan §11 的 4 个指标（AI 自主调用率/写入质量/误记率/引用率）未实测**——这些本质需要"真实跑 5-10 场圆桌 + 人工评估"，不是一晚单 driver 能客观完成
- ❌ **未自主推进阶段 1**（按用户授权边界保守处理；推进前置条件未全部满足）
- 0 git commit / 0 git push（按用户授权"不要 push"，且代码留给用户起床后审核 + 实测一场再决定 commit）

---

## 1. Task 完成清单

Plan 顶部的 9 个 checkbox 已全部 Edit 为 `[x]`。

| Task | 状态 | 关键产物 / 路径 |
|---|---|---|
| 0.1 Read 现状 | ✅ | 发现 plan 路径已过时（P5 重构 2026-05-04 删了 driver-mcp/driver-mode/arena-memory）；新映射用 research-mcp 模板 + roundtable-scenes.js prompt 锚点 |
| 0.2 Write `core/roundtable-memory/store.js` | ✅ | `C:\Users\lintian\claude-session-hub\core\roundtable-memory\store.js`（~190 行） |
| 0.3 Write `core/roundtable-memory-mcp-server.js` | ✅ | `C:\Users\lintian\claude-session-hub\core\roundtable-memory-mcp-server.js`（~190 行，模板=research-mcp-server） |
| 0.4 main.js hookServer + sub session MCP 注入 | ✅ | `C:\Users\lintian\claude-session-hub\main.js` +131 -8（diff 见 git） |
| 0.5 scenes.js MEMORY PROTOCOL + helper | ✅ | `C:\Users\lintian\claude-session-hub\core\roundtable-scenes.js` +89 -0 |
| 0.6 Smoke test | ✅ | 见 §2 实际输出 |
| 0.7 Unit test | ✅ | `tests/roundtable-memory.test.js` 11/11 PASS |
| 0.8 E2E（集成） | ✅ | `tests/integration-roundtable-memory-mcp.test.js` 7/7 PASS（**真 AI 实跑场次未做**，见 §4） |
| 0.9 报告 | ✅ | 即本文 |

**0 git commit，0 git push**。理由：用户红线"不要 git push"且阶段 0 待你起床实测一场再决定。仅 modified `core/roundtable-scenes.js` + `main.js`，新文件 untracked：`core/roundtable-memory/store.js`、`core/roundtable-memory-mcp-server.js`、`tests/roundtable-memory.test.js`、`tests/integration-roundtable-memory-mcp.test.js`、`docs/superpowers/plans/2026-05-05-roundtable-memory-execution-report.md`。

---

## 2. Smoke test 实际输出

### Smoke 1（aiKind 改名前）

启动命令（PS 同句 `& exe` + `run_in_background`，遵守用户红线 3 + Hub CLAUDE.md）：

```powershell
$env:CLAUDE_HUB_DATA_DIR="C:\temp\hub-mem-smoke"
& "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe" `
  "C:\Users\lintian\claude-session-hub" --remote-debugging-port=9230
```

stdout 关键片段：

```
[圆桌] hook server bind failed on :3456 (EADDRINUSE): listen EADDRINUSE: address already in use 127.0.0.1:3456
[圆桌] hook server bind failed on :3457 (EADDRINUSE): listen EADDRINUSE: address already in use 127.0.0.1:3457
[圆桌] hook server listening on 127.0.0.1:3458
[mobile] listening on :3472
```

3456/3457 是生产 Hub 占用 → fallback 3458（设计预期）。无 `App threw an error during load: Cannot find module` 类错误。

PID 白名单：仅 stop 自启 PID 69584 + 3 个 child（41424/47948/79404，按 startTime 窗口识别）。0 误杀生产。

### Smoke 2（aiKind 改名修复后再验）

为防 main.js 改名 (`parsed.kind`→`parsed.aiKind`) 引入回归，重启 Hub：

```
DevTools listening on ws://127.0.0.1:9231/devtools/browser/...
[圆桌] hook server bind failed on :3456 (EADDRINUSE)
[圆桌] hook server bind failed on :3457 (EADDRINUSE)
[圆桌] hook server listening on 127.0.0.1:3458
[mobile] listening on :3472
```

PID 白名单（before/after diff）：before=8 / after=12 / 4 个新 PID 全 stop / **0 误杀**。

---

## 3. Unit test（Task 0.7）输出

```
PASS T1 append create
PASS T2 append second key
PASS T3 dedup same key
PASS T4 render/parse round-trip
PASS T5 search hit + bump recall
PASS T6 search miss
PASS T7 list filter by kind
PASS T8 edge cases
PASS T9 scope=scene explicit
PASS T10 per-slot isolation
PASS T11 per-scene isolation

ALL PASS · roundtable-memory.test.js
temp dir: C:\Users\lintian\AppData\Local\Temp\rt-mem-A0k20Y
```

覆盖：append create/append second key/dedup（同 key recall+1 + content 更新 + action='update'）/header 渲染与解析 round-trip/search 命中 + recall bump/search miss/list 按 kind 过滤/边界（缺 projectCwd / invalid kind / invalid source / 空 key/空 content / 非法 scope）/scope='scene' explicit 接受/per-slot 文件隔离（pikachu vs charmander）/per-scene 文件隔离（general vs research）。

运行：`node tests/roundtable-memory.test.js`。

---

## 4. Integration test transcript（Task 0.8 主证）

### 4.1 测试结构

`tests/integration-roundtable-memory-mcp.test.js` 启动：

1. **Mock hookServer**：监听 127.0.0.1:动态端口，复用 main.js memory route 同款逻辑（token 校验 → store.appendMemoryEntry/searchMemory/listMemory）
2. **三个 MCP server 子进程**：spawn `core/roundtable-memory-mcp-server.js`，通过 stdio 通信
   - `pikachu` 进程 env `ARENA_AI_KIND=claude / ARENA_AI_SLOT=pikachu`
   - `charmander` 进程 env `ARENA_AI_KIND=gemini / ARENA_AI_SLOT=charmander`
   - `squirtle` 进程 env `ARENA_AI_KIND=codex / ARENA_AI_SLOT=squirtle`
3. **JSON-RPC client**：通过 stdin 写 line-delimited JSON-RPC 请求，stdout 收响应

### 4.2 输出

```
mock hookServer listening on 127.0.0.1:55868
temp project cwd: C:\Users\lintian\AppData\Local\Temp\rt-mem-int-TDdOKe
PASS T1 initialize × 3
PASS T2 tools/list × 3 (each returns 3 tools)
PASS T3 memory_write × 3 (one per slot)
PASS T4 three .md files created with correct content
PASS T5 memory_search hit
PASS T6 memory_list × 3 (per-slot isolation)
PASS T7 dedup over MCP

ALL PASS · integration-roundtable-memory-mcp.test.js
```

### 4.3 写盘文件路径 + 内容样本

三家 AI 各调一次 memory_write 后落盘到 `<projectCwd>/.arena/rooms/general/memory/{slot}.md`：

| Slot | 文件 | 大小 | 关键内容 |
|---|---|---|---|
| pikachu | `<TEMP>\.arena\rooms\general\memory\pikachu.md` | 230 B | `[2026-05-05] [scope: scene] [source: self] [recall: 2, last: 2026-05-05] preference:conclusion-first` |
| charmander | `<TEMP>\.arena\rooms\general\memory\charmander.md` | 209 B | `[2026-05-05] [scope: scene] [source: self] [recall: 0, last: -] observation:risk-averse` |
| squirtle | `<TEMP>\.arena\rooms\general\memory\squirtle.md` | 200 B | `[2026-05-05] [scope: scene] [source: explicit] [recall: 0, last: -] fact:main-language` |

样本（pikachu.md 完整内容）：

```
# Roundtable Memory
# 行格式见 core/roundtable-memory/store.js · plan §4.6
---

[2026-05-05] [scope: scene] [source: self] [recall: 2, last: 2026-05-05] preference:conclusion-first
用户喜欢结论先行（多次确认）
```

`recall: 2` 是因为 T5 search 命中 +1，T7 dedup update 又 +1。两次 bump 都正确反映在文件里。

### 4.4 这一步证明的链路 + 没证明的部分

**证明链路（端到端）**：
- ✅ MCP JSON-RPC over stdio（initialize/tools/list/tools/call）
- ✅ MCP server STUB_MODE 判定（无 ARENA_AI_SLOT 进 stub；三家都填了 → 都活）
- ✅ HTTP loopback（MCP server → hookServer 127.0.0.1）
- ✅ token 校验（无效 token → 403；与 main.js 同源逻辑）
- ✅ store 写盘（appendMemoryEntry/searchMemory/listMemory 三链路）
- ✅ 行格式合 §4.6
- ✅ Per-slot 文件隔离（三家各自 .md，独立 server 进程互不污染）
- ✅ Per-scene 文件路径（`rooms/{scene}/memory/{slot}.md`）

**没证明的部分**：
- ❌ Anthropic Claude/Gemini/Codex 自主 LLM 真主动调 memory_write —— 这取决于 prompt 工程质量（COVENANT_GENERAL 加的 MEMORY PROTOCOL 段是否够诱发，但本身不能在测试里验证）
- ❌ Hub 真创建 meeting + 三个 sub session + 真 LLM 互动的 1 场端到端 —— 受限于 (a) 单 driver 撞 Opus ≤1 并发，(b) UI 改造在阶段 1 范围（用户起床后开 1 场即可观察）
- ❌ UI `[已记 N]` 角标 —— 阶段 0 没做 UI（plan §10 列入阶段 1）；hookServer 已发 `memory-event` IPC，等待阶段 1 renderer 接

---

## 5. 4 个验证指标的实测情况

Plan §11 阶段 0 验证 4 指标（跑 5-10 场圆桌后评估）：

| 指标 | 通过标准 | 实测 | 说明 |
|---|---|---|---|
| AI 自主 memory_write 调用率 | 每场 ≥1 次 | **N/A** | 单晚单 driver 跑不动 5-10 场（每场 5-10min 纯 AI 时间）+ 红线 5 限制 |
| 写入质量 | ≥70% 偏好/事实 | **N/A** | 同上 + 需要人工评估 |
| 误记率 | < 10% | **N/A** | 同上 |
| AI 引用率 | 至少 1 次 | **N/A** | 同上 |

**坦诚**：这 4 指标本质是"AI prompt 工程效果"的定量观察，需要：
1. 真实 5-10 场圆桌（每场 5-10 分钟纯 AI 异步时间）
2. 人工评估每条 entry 是否符合"长期偏好/事实"vs"临时观点"
3. 看 AI 是否在第 N 场对话里**主动**搜索/引用过去的记忆

**单晚 driver session 客观跑不完且不能自评**。建议起床后跑 1-2 场亲自观察首批数据，再决定阶段 1 怎么走。

---

## 6. 阶段 0 失败回滚记录（按 plan §10 根因 4 类）

实施过程中遇到的问题与解决：

### 6.1 Bug 1：MCP server baseBody.kind 字段名冲突（root cause = 写入质量类，工程错而非 prompt 错）

**症状**：integration-test T6 失败 — `pikachu list returns 1 entry, 0 !== 1`。
**根因**：roundtable-memory-mcp-server.js 转发 tools/call 时 `baseBody.kind = AI_KIND`（'claude'），与 entry kind 字段（preference/observation/fact）同名。当 args 不含 kind（如 memory_list({}) 调用），spread `{ ...baseBody, ...args }` 让 baseBody.kind='claude' 漏到 store.listMemory.kind 触发 kind filter `key.startsWith('claude:')` → 0 命中。
**修复**：mcp server `baseBody.kind` → `baseBody.aiKind`；main.js memory route 也同步 `parsed.kind`→`parsed.aiKind`（log 用）。
**影响范围**：write/search 路径不受影响（args 永远显式传 kind）；只 list 路径受影响。
**验证**：修复后 integration-test 7/7 PASS；smoke test 2 重启 Hub 无回归。

### 6.2 Plan v3 路径过时（Task 0.1 现状核查）

**症状**：plan 顶部 Task 0.1 写"Read `core/driver-mcp-server.js` / `core/driver-mode.js` / `core/arena-memory/`"——这三个全不存在。
**根因**：plan v3 写于 2026-05-05，但 P5 重构（2026-05-04）已删除 driver-mode 架构 + arena-memory；现实对应物是 `core/research-mcp-server.js` per-scene 模板 + `core/roundtable-scenes.js` 中的 `BASE_RULES`/`COVENANT_GENERAL`/`GENERAL_PRESET` 锚点。
**Adapt 决策**（自主推进，未停下问）：
  - "driver-mcp-server.js" → 新建 `core/roundtable-memory-mcp-server.js`，模板复用 research-mcp-server.js（HTTP loopback + STUB_MODE + JSON-RPC over stdio）
  - "driver-mode.js" → 改 `core/roundtable-scenes.js` 的 `COVENANT_GENERAL` 末尾追加 MEMORY PROTOCOL 段（三家共用同一份 covenant，没有 plan 里设想的"三家 prompt 各自定制"那一层架构了）
  - 阶段 0 只让 general scene 启 memory MCP（research scene 单 mcpConfigFile 名额仍归 research，跨 scene 合并推迟到阶段 1）
**理由**：plan 的目标和接口契约都正确（路径仅是过时词），结构化 adapt 不偏离 plan 精神；用户授权"无需中途确认"。

---

## 7. 工程问题与解决方式总结

| # | 问题 | 解决 |
|---|---|---|
| 1 | Plan 路径过时（driver-* 已删） | 见 §6.2，自主 adapt 到现实 P5 架构 |
| 2 | hub-isolation-guard hook 拦截非隔离 electron 启动 | 改用 `$env:CLAUDE_HUB_DATA_DIR` + `& exe` 同句 + `run_in_background`（Hub CLAUDE.md 红线 + user feedback_hub_isolation_env_pitfall） |
| 3 | Start-Job / Start-Process 不继承 env | 改 `& exe` 同句直接调用 |
| 4 | Smoke test 端口 3456/3457 被占（生产 Hub） | Hub 自动 fallback 3458（设计预期） |
| 5 | PowerShell `2>&1` 把 stderr 包成 NativeCommandError | 用 `*>&1`（合并 stream 7）忽略；不影响 stdout 捕获 |
| 6 | baseBody.kind 与 args.kind 字段冲突 | 见 §6.1，rename `baseBody.kind`→`aiKind` |
| 7 | PowerShell Get-Content 显示 GBK 解码 UTF-8 内容时乱码 | 文件本身 UTF-8 正常（行格式断言已通过单测/集成测试），仅 PowerShell 终端显示问题，不写入污染 |
| 8 | meetingManager 通过 ipcRenderer 访问，外部直接 HTTP 难以创建 meeting | 改用 mock hookServer + spawn 真实 MCP server 子进程的集成测试方案（绕开 Hub UI）；真 AI 跑场留给用户起床后操作 |

---

## 8. 阶段 0 → 阶段 1 推进决策

### 8.1 阶段 1 启动前置条件检查

阶段 1 内容（plan §10）：checkpoint-worker.js + DeepSeek 派生 _profile.md + inbox 机制 + UserPromptSubmit hook + 三卡片按钮 + 🧠 状态灯 + cooldown + pending 生命周期。

| 前置条件 | 状态 | 备注 |
|---|---|---|
| 阶段 0 代码就绪 | ✅ | store/MCP server/route/prompt 都齐 |
| 阶段 0 测试覆盖 | ✅ | unit + integration 18 项 |
| 4 指标实测达标 | ❌ | **未实测**（见 §5） |
| AI 真主动调 memory_write 概率验证 | ❌ | 没跑场 |
| MEMORY PROTOCOL prompt 是否够诱发 | ❌ | 没观察过 |

**阶段 1 worker 派生 `_profile.md` + pending inbox 的设计前提是**：阶段 0 个体 .md 已有可观察数据。如果阶段 0 AI 不爱写（未达标），worker 派生没有共识可提炼，等于空跑 DeepSeek。

### 8.2 推进建议

**不建议立即推进阶段 1**。原因：
1. 阶段 0 的 4 个验证指标未实测——直接进阶段 1 是无证据推进
2. 阶段 1 的 checkpoint worker 依赖阶段 0 的 .md 真有 AI 自主写入数据
3. 用户原始意图（plan §10 阶段 0 末"4 全达标 → 进阶段 1"）是带 gate 推进

**建议路径**：
1. **用户起床后**：开 1-2 场通用圆桌（slot 配置 Charmander=Gemini, Squirtle=Codex；Pikachu 用 deepseek/glm 等非 Anthropic Claude family，避 Opus 配额冲突）
2. 跑完后看 `<projectCwd>/.arena/rooms/general/memory/*.md` 是否有 AI 自主写入的 entry
3. 如有 → 评估写入质量（看 kind 是否为 preference/fact/observation 而非临时观点）→ 决定阶段 1
4. 如无 → 调 MEMORY PROTOCOL 段（plan §10 阶段 0 失败回滚路径"AI 不爱写"对应：加强 prompt 引导 + 加示例）

**已自主推进到阶段 1 的步数：0**（按用户授权"绝对不要推进阶段 2/3"+ 阶段 1 前置条件未达标，保守不推进阶段 1）。

---

## 9. 给用户起床后的 1 分钟检查清单

1. `git status` 看到 modified `core/roundtable-scenes.js` + `main.js`，新文件 untracked（`core/roundtable-memory/`、`core/roundtable-memory-mcp-server.js`、`tests/roundtable-memory.test.js`、`tests/integration-roundtable-memory-mcp.test.js`、本报告）
2. 跑 `node tests/roundtable-memory.test.js` 看到 11 PASS
3. 跑 `node tests/integration-roundtable-memory-mcp.test.js` 看到 7 PASS
4. 桌面快捷方式启动生产 Hub → 创建通用圆桌（建议三 slot：deepseek + gemini + codex；不要 anthropic claude 避配额冲突）→ 发一句"我喜欢结论先行，记一下"→ 等三家回答 → 看 `~/.arena/rooms/general/memory/*.md`（如果走默认 cwd）
5. 没看到 .md 文件 → 看 Hub 控制台是否有 `[memory] memory-write ai=... slot=... scene=general` 日志
6. 决定：有 AI 主动写 → 阶段 1 上 checkpoint worker；没写 → 调 prompt

---

## 10. 设计纪律 / 记录的小决策

- **MCP 跨场景 vs 仅 general**：阶段 0 选"仅 non-research scene 启 memory MCP"（变量名 `memoryMcpEnabled` 在 main.js _addMeetingSubInternal）。理由：Claude CLI 单 `--mcp-config` 名额；research scene 已占用。research 场景下 memory MCP 不启（Pikachu/Charmander/Squirtle 在 research scene 看不到 memory_* 工具）。阶段 1+ 再设计两 MCP server 合并方案。
- **prompt 段位置**：MEMORY PROTOCOL 加到 `COVENANT_GENERAL` 末尾，不加 BASE_RULES（避免污染 research/dev 场景）。三家共用同一份 covenant；plan §7 的"三家 prompt 各自定制"在 P5 后已无对应代码层（GENERAL_PRESET 是场景级，不分家）。
- **新依赖 = 0**：plan 已确认；本次实施未引入 npm 包。
- **报告路径**：按用户要求 `2026-05-05-roundtable-memory-execution-report.md`（同 plan 同目录）。

---

**Last update**: 2026-05-06 02:18 本地。
**Driver session ID**: 当前 Claude Opus 4.7（1M context），单一 session，无嵌套 subagent。
