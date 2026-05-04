# Codex 一键提取失败 TDD 修复计划

**日期**：2026-05-04
**触发**：用户在生产 Hub 实测圆桌"明天周几"场景，codex 角色（Squirtle gpt-5.5）已正常回答但 Hub 卡片状态停在"输出中 1m10s"，"一键提取"弹窗显示笼统"提取失败：no_content"，**v2.1 引入的 `extractMode` 4 态字段未在 UI 任何位置生效**。
**对应 Spec**：`docs/superpowers/specs/2026-05-04-codex-roundtable-equiv-design.md` S2

---

## 一、根因分析

### 已确认（从代码 + 截图）

1. **renderer/meeting-room.js:920** `alert(\`提取失败：${r?.reason}\n\n${r?.detail}\`)` 直接展示 `r.detail` 字段，**未消费 `r.extractMode`**
2. **main.js:1786** `no_content` 分支的 detail 是写死的笼统文本：
   > `transcript 中没有可读的 last assistant 内容（kind=...）。可能原因：CLI 还没真正回答 / transcript 路径未绑定 / Stop hook 没触发且 idle-timer 还没到期...`
3. v2.1 Phase 1 B1.3 把 `extractMode` 透传到 IPC 返回值，但 detail 文本未按 extractMode 分级
4. 用户截图重现：codex 内部已生成答案"明天是星期二"，但被 ai-team MCP `team_respond` 工具的 `Allow ...?` confirm 弹窗阻塞，rollout 文件 **未写 task_complete**（codex 在等待用户授权）

### 待验证（需取证）

- A. CodexTap `_bound` 是否包含该 hubSessionId（绑定成功？）
- B. 若已绑定，rollout 文件中是否有 agent_message（partial_commentary 应该可拉）
- C. 若未绑定，原因是什么（cwd 不匹配 / timestamp 超窗口 / 文件未生成）

---

## 二、TDD 阶段计划

### Phase E0: 调研入口（30min）

**E0.1**：新增调试 IPC `roundtable-codex-debug-state(hubSessionId?)`：
- 返回 `{ sessionsRoot, candidateDirs, pending, bound, seen, todayFiles }`
- `pending`: `[{ hubSessionId, cwd, spawnTime, ageMs }]`
- `bound`: `[{ hubSessionId, rolloutPath, hasLastText }]`
- `todayFiles`: 当天目录所有 rollout 文件名（不读内容）
- 用于运行时排查"为什么没 bind"

### Phase E1: RED 测试（45min）

**E1.1 RED**：`tests/unit-codex-extract-detail-by-mode.test.js`
- 喂 4 种 extractMode 给 main.js IPC handler 模拟（直接调 helper / 字符串 grep）
- 断言每种 extractMode 对应的 detail 文本含**针对性 hint**：
  - `no_rollout_bound`: 含"rollout 文件未绑定" + "检查 ~/.codex/sessions" 或 "cwd / timestamp 窗口"
  - `no_task_complete_yet`: 含"仍在思考" + "task_complete"
  - `partial_commentary`: 不会进 no_content 分支（text 非空），但 ok=true 路径也应附带 extractMode 让 UI 知道
  - `final_answer`: 同 partial，正常返回

**E1.2 RED**：`tests/unit-codex-debug-ipc-contract.test.js`
- 直接 require core/transcript-tap，构造 CodexTap，验证暴露的状态接口（`getDebugSnapshot()`）契约
- 断言返回结构稳定：`{ sessionsRoot, pending: Array, bound: Array, seen: Array }`

### Phase E2: GREEN 修补（1h）

**E2.1 GREEN**：`core/transcript-tap.js`
- CodexTap 增加 `getDebugSnapshot()` 方法，导出当前 `_pending / _bound / _seen` 的快照（不暴露内部 timer）
- TranscriptTap 转发：`getCodexDebugSnapshot()`

**E2.2 GREEN**：`main.js`
- 新增 `ipcMain.handle('roundtable-codex-debug-state', ...)` 暴露快照
- 改 `roundtable-manual-extract` 的 `no_content` 分支，按 `extracted.extractMode` 路由 detail 文本
- 4 态对应文案表见下文

**E2.3 GREEN**：`renderer/meeting-room.js`（最小改动）
- alert 文案保留沿用 `r.detail`（main.js 已生成分级 hint），无需大改 renderer

### Phase E3: 真实重现取证（30min）

**E3.1**：启隔离 Hub（`CLAUDE_HUB_DATA_DIR=...hub-codex-extract-bug`，CDP 9262）

**E3.2**：跑真实 codex 单家圆桌，发"明天周几"
- 等 30s-2min 让 codex 完成（不触发 ai-team MCP 路径，避免阻塞）
- 调用 manual-extract → 期望命中 final_answer（rollout 应有 task_complete）

**E3.3**：调用 debug IPC 验证 _bound 已记录该 sid

**E3.4**：尝试触发 ai-team MCP 阻塞场景重现 user 截图（如可触发）

### Phase E4: 真 bug 修复（视取证结果）

**情形 X**：若 codex 正常完成 → bug 在 partial_commentary 路径下用户没拿到 hint。**此情形修补 detail 文案即可（E2.2 已覆盖）**

**情形 Y**：若 codex 完成但 _bound 缺失（绑定 bug）→ 调查 cwd/timestamp/路径 normalize → 修 transcript-tap.js 的 _tryBind 逻辑

**情形 Z**：若 ai-team MCP 阻塞导致 task_complete 永不写 → 需要给用户 UI hint："codex 卡在 MCP confirm 弹窗，请进 shell 确认"

---

## 三、4 态 detail 文案表（E2.2 实施依据）

| extractMode | 用户看到的弹窗 detail |
|---|---|
| `no_rollout_bound` | `Codex rollout 文件尚未绑定（kind=codex）。可能原因：（a）当天目录 ~/.codex/sessions/<今日>/ 还没新文件；（b）codex spawn 时的 cwd 与 rollout session_meta.cwd 不一致；（c）timestamp 超出绑定窗口 [-10s, +5min]。建议：点"🔧 进 shell"看真实 PTY 输出，或等 5-10s（codex 通常 spawn 后 5s 才写 rollout 首行）` |
| `no_task_complete_yet` | `Codex 已绑定 rollout 但 task_complete 事件尚未写入（kind=codex）。可能原因：（a）codex 仍在思考；（b）codex 在等 MCP 工具确认弹窗（如 ai-team team_respond），需要进 shell 点"Allow"；（c）codex 多 task 场景含 3s debounce，最后一个 task 完成后才 emit。建议：点"🔧 进 shell"看 codex 当前状态` |
| `partial_commentary` | （ok=true 路径 ✓ 已同步 N 字 partial）—— 不进入失败弹窗 |
| `final_answer` | （ok=true 路径 ✓ 已同步 N 字 final）—— 不进入失败弹窗 |

---

## 四、回归保护

跑全部现有 codex equiv 单测（44 cases）确认零回归：
- unit-codex-extract-tristate (5)
- unit-codex-extract-ipc-contract (4)
- unit-codex-extract-idempotent (4)
- unit-codex-extract-concurrent-race (3)
- unit-codex-extract-partial-then-final (5)
- unit-codex-send-contract (5)
- unit-codex-fresh-context (12)
- unit-codex-multi-turn-consistency (6)

---

## 五、工作量估算

| Phase | 时间 |
|---|---|
| E0 调研 | 30min |
| E1 RED 测试 | 45min |
| E2 GREEN 修补 | 1h |
| E3 真实重现 | 30min |
| E4 真 bug 修（视情形） | 0-1h |
| **总计** | **2.75-3.75h** |

---

## 六、产出清单

- 新文件：
  - `tests/unit-codex-extract-detail-by-mode.test.js`
  - `tests/unit-codex-debug-ipc-contract.test.js`
  - 本 plan 文档
- 修改文件：
  - `core/transcript-tap.js`（CodexTap 加 getDebugSnapshot，TranscriptTap 转发）
  - `main.js`（manual-extract detail 分级 + 新增 debug-state IPC）
- E3 取证：（视情形可能修 transcript-tap.js 的 _tryBind 逻辑）
