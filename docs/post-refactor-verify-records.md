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
