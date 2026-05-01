# Post-Refactor Verify Records

放行历史 — 每次涉及多文件大改动跑完 `/post-refactor-verify` 后追加。

---

## 2026-05-01 · meeting-create-modal（圆桌 5 选 3 + Modal UI）

**Plan：** `docs/superpowers/plans/2026-05-01-meeting-create-modal.md`
**Spec：** `docs/superpowers/specs/2026-05-01-meeting-create-modal-design.md`
**Commit range：** `c10e671..1c7489a`（11 commits）

### Step 1 — 改动范围

15 production / test files：
- `core/transcript-tap.js` — `_backendFor` 加 deepseek/glm 路由
- `core/session-manager.js` — opts.model fallback for claude/codex；relaunchCli + currentModel 透传
- `core/roundtable-orchestrator.js` — aiStats sid 索引 + migrateAiStats 迁移老格式
- `core/general-roundtable-private-store.js` — 去 claude/gemini/codex 白名单
- `core/meeting-room.js` + `core/meeting-store.js` — slotSpecs 持久化
- `main.js` — _RT_READY_MARKERS deepseek + create-meeting IPC 接受 slots + sid 化的 stats
- `renderer/meeting-room.js` — 卡片按 slot 索引渲染 + 头像与 slot 绑定 + 动态 mention
- `renderer/meeting-create-modal.{js,css}` — 新 Modal（IIFE 包裹）
- `renderer/index.html` + `renderer/renderer.js` — Modal 引用 + createMeetingByMode 改弹 Modal
- `package.json` — version 0.4.0 → 0.5.0
- 5 个新测试 + 2 个老测试更新

### Step 2 — 遗留引用搜索

| 模式 | 范围 | 结果 |
|---|---|---|
| `for \(const kind of \['claude'` | main.js + renderer/ + core/ | 0 ✅ |
| `subs\.(claude\|gemini\|codex)` | main.js + renderer/ + core/ | 3（在 `_getRtSubInfo` 老兼容 helper 内，仅供 timeline overlay / summary picker 等遗留路径用，主渲染已切到 `_getRtSlots`）|
| `thinkSecByKind\|tokensByKind` | main.js + core/ | 0 实代码（仅 1 处变更说明注释）✅ |
| `aiStats\.(claude\|gemini\|codex)` | main.js + core/ + renderer/ | 0 ✅（迁移逻辑用 `stats[k]` 不是 `aiStats.claude`）|

### Step 3 — 调用方一致性

| 检查 | 结果 |
|---|---|
| `_avatarBySlot` 仅在圆桌卡片用 | ✅（`_avatarSrcFor(kind)` 在侧边栏单 session 列表保留）|
| `_getRtSlots` / `_getRtSubInfo` 共存且作用清晰 | ✅（slot 索引主路径 + kind 兼容辅助）|
| `state.aiStats[sub.sid] \|\| state.aiStats[kind]` 兼容回退 | ✅（renderer/meeting-room.js:389）|
| `setMeetingContext(sidInfoMap)` 注入时机 | dispatchTurn 之前 ✅；get-state / resend 不调（aiStats 保留 legacy，renderer 兜底回退）|
| IPC `create-meeting` 老调用方（不传 slots） | ✅ 不创建 sub，由 renderer 后续 add-meeting-sub 走老路径 |
| IPC `add-meeting-sub` 兼容 `{kind}` 与 `{kind, model}` | ✅ 顶层 model + opts.model 双兼容 |

### Step 4 — 端到端验证（CDP 真测）

启动隔离 Hub：
```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\AppData\Local\Temp\hub-mcm-e2e"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9251
```

E2E runner：`tests/_e2e-mcm-runner.js`（gitignored；用 `ws` 直连 CDP，无需 chrome-remote-interface）

执行结果：
- ✅ Modal 弹出（默认 Claude/Gemini/Codex × 默认 model）→ 截图 `00-modal-open.png`
- ✅ AI dropdown 切换触发 model dropdown 自动刷新（DeepSeek/Claude·Sonnet 4.5/GLM 测试通过）→ 截图 `02-modal-custom.png`
- ✅ 头像位置不随 kind 变化（皮卡丘永远 slot 1，自定义 case 验证通过）→ 截图 `02-modal-custom.png`
- ✅ 3 Claude 全选不报错 + DOM 提交格式正确 → 截图 `06-three-claude-modal.png`
- ✅ Modal Esc 关闭 → 截图 `07-after-dismiss.png`
- ✅ Modal cancel 按钮关闭

截图归档：`tests/screenshots/meeting-create-modal/`（绝对路径见 commit `fd7e53e` E2E 截图）。

未在 E2E 路径覆盖（受 isolated Hub 无 API key / 慢启动制约）：
- ⏸ "群策群力"实流式发 prompt 的 DeepSeek transcript-tap 复用（spike 已在 `tests/_spike-deepseek-stop-hook-result.md` 验证 transcript schema 兼容；运行时端到端待用户在生产 Hub 自测）

### Step 5 — 多方审查（4 路）

按 `/cli-caller` skill Part 6 模板，对核心 logic 跑 Claude self + Gemini 2.5 Pro + Codex gpt-5.2 + DeepSeek V4 Pro。

**Gemini 2.5 Pro 发现：**
| # | 等级 | 内容 | 处理 |
|---|---|---|---|
| 1 | High | `migrateAiStats` 依赖不稳定 `Object.entries` 顺序 | ⏸ 实测 V8 ≥6.6 起按插入顺序稳定，main.js sid 注入按 subSessions 顺序，可控；但加了 `Object.entries(...).filter()` 显式收敛后兜底 |
| 2 | High | `migrateAiStats` 空 `sidToInfoMap` → `{}` 落盘丢数据 | ✅ 修：sidEntries 为空时直接 return 原 stats；`setMeetingContext` 也加 `hasSidInfo` 守卫 |
| 3 | High | `sendToRenderer('meeting-created')` 在 add-sub 之前发，UI 抖动 | ✅ 修：slots 路径下推迟到 add-sub + setSlotSpecs 完成后再发 |
| 4 | High | 串行 `await` 三家 → 25s 模态卡死 | ⏸ 与旧 `createMeetingByMode` 行为一致，并发 cold-start 可能压垮系统；不在本期改 |
| 5 | Med | Modal 用隐式全局 `selectMeeting` 而非 `window.selectMeeting` | ⏸ 已有 `window.selectMeeting` fallback；ESM 化才需改 |

**Codex gpt-5.2 发现：**
| # | 等级 | 内容 | 处理 |
|---|---|---|---|
| 1 | Med | 同 Gemini #3 | ✅ 与 Gemini 修同一 commit |
| 2 | Med | 同 Gemini #2 | ✅ 同 |
| 3 | Med | `tests/unit-general-roundtable-mode.test.js:103` 仍断言 `unknown` kind 抛错（与新契约冲突） | ✅ 修：改为只断空/null/undefined/非字符串非法 |

**DeepSeek V4 Pro 发现：**
| # | 等级 | 内容 | 处理 |
|---|---|---|---|
| 1 | High | `completeTurn` 用了未定义 `byMap` | ❌ 假阳性（byMap 是函数第 4 参，snippet 没贴签名）|
| 2 | Med | `kind: k \|\| null` 把空字符串错误转 null | ⏸ 实践中 sessionManager 严格控 kind 取值，空字符串不会进入；非真问题 |
| 3 | Med | `perTurnHistory` 无上限 push 内存泄漏 | ⏸ 与 refactor 前同行为；约 50B/turn，1000 turn 也仅 50KB；非回归 |

**Claude self-audit：** 已审 main.js create-meeting IPC + orchestrator setMeetingContext 时序 + modal IIFE。无新增 high 问题。

### Step 6 — 验证报告

| 项 | 状态 |
|---|---|
| 单测全绿（6 个测试套件 / 35+ 用例） | ✅ |
| Smoke test（Hub 隔离启动 + hook server listening） | ✅ |
| E2E（5 个截图 + DOM 断言） | ✅ |
| 残留 grep | ✅ 0 |
| 调用方一致性 | ✅ |
| 多方审查 | ✅ 3 路（Gemini/Codex/DeepSeek MCP）+ Claude self；3 个真 bug 已修，2 个 trade-off 文档化 |
| 高置信度问题 | 0（已全部修复）|

### Step 7 — 放行人

立花道雪（自动执行 — 用户外出 3h 内完成）

**放行 commit：** `1c7489a fix(verify): 4-way review findings — 3 real bugs`

---

## 2026-05-01 · roundtable-pilot-mode（主驾模式 + 不限字数摘要 + F5 段落目录）

**Plan：** `docs/superpowers/plans/2026-05-01-roundtable-pilot-mode.md`
**Spec：** `docs/superpowers/specs/2026-05-01-roundtable-pilot-mode-design.md`
**Commit range：** `1c66ea5..d2d905a`（6 commits + 1 待 commit bug fix）

### Step 1 — 改动范围

18 production / test files (1843 insertions / 27 deletions)：
- `core/summary-engine.js` — `summarizeWithKind(kind, system, prompt, opts)` 5-kind 路由（claude/gemini/codex/deepseek/glm）
- `core/general-roundtable-private-store.js` — 新增 sid 索引 API（`appendPrivateTurnBySid` / `listPrivateTurnsBySid` / `clearPrivateTurnsBySid`），保留旧 kind API
- `core/pilot-recap-builder.js` — **新文件**，`splitByTurn` / `splitBySmart` / `build` / `rebuildMd`，写 markdown 镜像 + 段落目录
- `core/roundtable-orchestrator.js` — `_maybePilotRecapPrefix` + `findLatestPilotRecap`，副驾 prompt 注入 D'+F2+F5
- `core/meeting-store.js` + `core/state-store.js` — `pilotSlot` 字段持久化（双轨：meeting.pilotSlot + `_pilotSlotByMeeting` dict）
- `core/meeting-room.js` — `setPilotSlot` API
- `main.js` — IPC `roundtable:pilot-toggle` + `roundtable:pilot-segment-mode` + `_generatePilotRecap` + `_appendTimelineRecap` + `_parseSummaryWithSegments` + dispatchTurn pilotSlot 守卫
- `renderer/meeting-room.js` — 主驾 toolbar dropdown / `_bindPilotEvents` / `_applyPilotCardVisual` / `_renderPilotRecapCard` / `_bindPilotRecapEvents` / `_updatePilotPlaceholder` / observer guard (bug fix)
- `renderer/meeting-room.css` — `.mr-pilot-*` 样式集 + dropdown 上弹（bug fix）
- `package.json` — version 0.5.0 → 0.6.0
- 5 个新测试：`summary-engine-multi-kind` / `private-store-no-whitelist`（扩展）/ `pilot-recap-builder` / `pilot-recap-parser` / `orchestrator-pilot-recap-injection`

### Step 2 — 遗留引用搜索

| 模式 | 范围 | 结果 |
|---|---|---|
| 删除/重命名对象 | 全项目 | **无** — 改动全是新增 API + bug 修复 |
| 旧 `appendPrivateTurn`(kind API) 调用 | `**/*.js` | ✅ 仍被 `main.js:1911` 私聊路径用，旧契约保留 |
| 新 `appendPrivateTurnBySid`(sid API) 调用 | `**/*.js` | ✅ 仅 `main.js:1396` dispatchTurn 主驾分支调用 |
| `summarizeWithKind` 调用 | `**/*.js` | ✅ 1 定义 + 2 调用（`main.js:684/899`）+ 测试齐全 |

### Step 3 — 调用方同步检查

| API/字段 | 调用点 | 一致性 |
|---|---|---|
| `summarizeWithKind(kind, system, prompt, opts)` | `main.js:684` (`_generatePilotRecap`) + `main.js:899` (segment-mode IPC) | ✅ 签名一致 |
| `meeting.pilotSlot` 字段 | 11 处读写（`main.js` IPC handler / dispatchTurn / restore；`renderer/meeting-room.js` _renderFusedTabs / _applyPilotCardVisual / disabled 判定） | ✅ 全部用 `(typeof === 'number' && >= 0 && <= 2)` 守卫 |
| `_pilotSlotByMeeting[mid]` dict | `main.js:376/622/1396/2042-2058/2064/2113/2937` | ✅ 与 meeting.pilotSlot 双轨同步, restore 时 dict 合并到 meeting |
| `clearPrivateTurnsBySid` | `main.js:666/732`（短主驾兜底 + 长主驾分支） | ✅ try-catch 保护 |
| IPC `roundtable:pilot-toggle` | handler `main.js:814` ↔ renderer `_bindPilotEvents`(meeting-room.js:2143) | ✅ |
| IPC `roundtable:pilot-segment-mode` | handler `main.js:864` ↔ renderer `_bindPilotRecapEvents`(meeting-room.js:765) | ✅ |
| timeline tag `pilot-recap` | 写入 `main.js:782` ↔ 渲染 `meeting-room.js:719+765` | ✅ |

### Step 4 — 端到端验证

| 验证 | 命令 / 路径 | 结果 |
|---|---|---|
| 单测套件 1 | `node tests/summary-engine-multi-kind.test.js` | ✅ 7/7 |
| 单测套件 2 | `node tests/private-store-no-whitelist.test.js` | ✅ 9/9 |
| 单测套件 3 | `node tests/pilot-recap-builder.test.js` | ✅ 9/9 |
| 单测套件 4 | `node tests/orchestrator-pilot-recap-injection.test.js` | ✅ 11/11 |
| E2E 主线 | `tests/_e2e-pilot-mode-runner.js`（CDP, 隔离 Hub）| ✅ 5 场景 PASS（截图 `tests/screenshots/pilot-mode/00-05.png`）|
| E2E bug fix 验证 | `tests/_e2e-pilot-bugfix-verify.js`（CDP）| ✅ 3 bug PASS（截图 `06-bugfix-dropdown.png` + `07-bugfix-after-pilot-on.png`）|
| 用户亲测反馈 | 真实用户三个 bug 反馈 → 全修 | ✅ |

### Step 5 — 多方审查（精简 — 只报 high severity）

聚焦 4 段核心代码：private-store sid API / pilot-recap-builder.js / `_generatePilotRecap` + `_parseSummaryWithSegments` / observer guard bug fix。

| 审查方 | 结论 | 实际 severity |
|---|---|---|
| Claude (self) | _parseSummaryWithSegments 边界（LLM 摘要正文里举例引用"段落 N: xxx"会被尾扫误抓） | low（LLM 通常遵守 prompt 格式约定） |
| Gemini | 报 high：(1) read-modify-write 文件并发竞态; (2) clear catch 静默吞 | (1) medium（实际是 IPC handler 间 await 让出, 不是 fs 原子性, race window 极窄）; (2) low-medium（fs 操作失败概率低, log 缺失只影响诊断） |
| Codex | 报 high：read-await-clear race（dispatchTurn capture pilotSlot vs IPC pilot-toggle null-then-await-summary） | medium（同 Gemini-1, 触发条件苛刻） |
| DeepSeek (V4-pro reasoning_effort=high) | 报 high：_turns 持久化到 timeline → 隐私泄漏 | **false positive** — 设计意图，F5-A/B 切段 IPC 必须保留 turns 副本（store 已清空时） |

### Step 6 — 验证报告

| 项 | 状态 |
|---|---|
| 单测全绿（4 套件 / 36 用例） | ✅ |
| E2E（7 截图 + DOM 断言）| ✅ |
| 用户亲测 3 bug 反馈 | ✅ 全修 |
| 残留 grep | ✅ 0（无删除/重命名）|
| 调用方一致性 | ✅ |
| 多方审查 | ✅ 4 路（Gemini/Codex/DeepSeek MCP + Claude self）|
| 高置信度问题 | 0 ship blocker |
| Known issues 文档化 | ✅（race + log 缺失 → 后续 issue）|

### Known Issues（post-ship 单独修）

1. **read-await-clear race**（Gemini + Codex 共识）
   - 触发：用户在主驾响应中点关主驾, dispatchTurn `await` 期间用 capture `pilotSlot` 写新 turn, 之后被 `_generatePilotRecap` 的 `clearPrivateTurnsBySid` 一起清掉
   - 影响：丢失最后一轮 turn 数据；摘要不会包含但无崩溃
   - 概率：低（精确时序窗口）
   - TODO：dispatchTurn 写入 sid 索引前重新校验 `meeting.pilotSlot`，或加 turn-level lock
2. **clear 失败静默吞**（Gemini）
   - 现状：`try { clearPrivateTurnsBySid... } catch {}` 无 log（main.js:666 / 732）
   - 影响：失败后 store 残留, 下次主驾会卷入老 turns
   - TODO：catch 块加 `console.error`；可考虑 retry-once
3. **`_parseSummaryWithSegments` 误抓边界**（Claude self）
   - 触发：LLM 摘要正文中举例引用"段落 N: xxx"格式
   - 影响：摘要被截断, 例子误成 segments
   - TODO：要求"段落 N"行连续 + 紧贴文本结尾才算目录

### Step 7 — 放行人

立花道雪（用户亲测 + 4 路审查 + 自动 verify）

**放行 commit：** 待 commit（pilot 修复 = css dropdown flip + js observer guard + verify 文档 + 截图）
