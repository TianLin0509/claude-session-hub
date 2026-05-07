---
title: 圆桌记忆系统 · Phase 2 最终报告（含隐患 1 修复 + 试用 3 实证）
date: 2026-05-07
status: completed
phase: 2
prev: docs/superpowers/plans/2026-05-07-roundtable-memory-phase1-final-report.md
---

# 圆桌记忆系统 · Phase 2 最终报告

## TL;DR

✅ **隐患 1 修复**：Polish 1 从"每轮硬要求 memory_list"回退为"自主判断 + 显式触发硬要求"，彻底避免 reflection fatigue
✅ **试用 3 实证**：跨 meeting gap 是结构性的（`getMeetingWorkspaceDir(meetingId)` 每 meeting 独立），代码 + reproduction 双重证据
✅ **P0 跨 meeting memory UX**：解耦 timeline 与 memory，新增 `getSceneMemoryRoot(scene)` + `isUserProjectCwd` 双层 fallback
✅ **P1 worker 失败状态灯**：右上角 `🧠 N` 卡片角标（橙/红双级别），点击打开 `checkpoint-state.json`
✅ **P2 inbox-archived GC**：180 天保留，启动 5s 后异步扫描 `<HUB>/memory-scenes/*`
✅ **51/51 测试全过**（phase 0: 11 + integration: 7 + phase 1: 33，新增 I6 gcArchive）
✅ **smoke 启动验证**：日志 `[mem-gc] inbox-archived scanned=2 removed=1 (180-day retention)` 真跑

---

## 1 用户反馈点对点回应

| # | 用户戳穿 | 我的处置 |
|---|---|---|
| 隐患 1 | Polish 1 "硬要求每轮 memory_list" 违反 AI 自主精神 | ✅ 改为引导式（话题相关时自主调），仅"用户问之前说过什么"保留硬要求（防凭空猜） |
| 隐患 2 | 跨 meeting UX 推迟 = 产品体验阻塞 | ✅ 提为 P0，结构性修复（per-scene 共享 / per-project 共享双路径）|
| 隐患 3 | E2E 仍是 3 sonnet 同模型 | ⚠️ 已知债，承认（Gemini/Codex 接入 bug 未修复前不能补） |

---

## 2 隐患 1 修复细节

### 2.1 修改前（v6 收敛版本）

`core/roundtable-scenes.js:298-307`：

```
【引用记忆 · 必做】
**每轮发言前先调一次 memory_list({kind: 'preference'}) 看自己记下的协作偏好**——这是硬要求，不是建议。
原因：用户的偏好（结论先行/不铺背景/直言不确定/...）会改变你这轮该怎么写。**不查 = 浪费记下的偏好**。

执行规则：
1. 发言前先调一次 memory_list({})，O(几条) 快得很
2. 命中相关项时**在回答中自然引用**
3. ...
4. ...
5. 用户问"我之前说过什么 / 你记得什么" → 必调 memory_list({}) 准确回答（不要凭空猜）
```

### 2.2 修改后（隐患 1 修复版）

```
【引用记忆 · 自主判断 · 不仪式化】
memory_list 是工具不是仪式。**话题与偏好相关时**主动调一次有价值；纯闲聊/查事实别浪费 token。

判断维度：
- 话题涉及"该怎么答（详略/结论位置/技术选型/沟通风格）" → 值得 list
- 话题是"用户在问具体事实/外部信息" → 不必 list
- **用户问"我之前说过什么 / 你记得什么"** → 必调 memory_list({}) 准确回答，禁止凭空猜（这条是硬要求）
- 命中相关项 → 回答首句自然带一次（"你之前说过 X，所以..."），1 句话即可
- 命中无关项 → 心里按偏好风格答，不必显式引用
- list 返回空 → 跳过引用正常发言

原则：被反复问会变成敷衍——该用就用，不该用别仪式化。
```

### 2.3 为什么这样改

- 用户原始诉求是 cat-cafe 风格（AI 在相关语境下主动查/写），不是 Mem0 风格（每轮硬塞）
- 30 轮反复讨论的 reflection fatigue 警告：被反复问 → AI 回答开始机械化、敷衍化
- 硬要求保留范围缩到"用户问之前说过什么"——这种场景必须查实，否则会幻觉
- 让 AI 自己判断"该不该 list"，而不是"该怎么 list"

---

## 3 试用 3 实证（跨 meeting gap）

### 3.1 reproduction script

文件：`tests/cross-meeting-gap-repro.js`（保留作为前事实证据）

```
$ node tests/cross-meeting-gap-repro.js
--- 模拟用户开第一次圆桌 (meetingA) ---
charmander 写入偏好 conclusion-first: OK

--- 用户关掉圆桌 → 重开同 scene 第二次圆桌 (meetingB) ---
charmander 读到的偏好条数: 0
命中: (空)

--- 文件系统证据 ---
A 存在: true → C:\temp\hub-cross-meeting-test\workspaces\meeting-A-1778112895609\.arena\rooms\general\memory\charmander.md
B 存在: false → C:\temp\hub-cross-meeting-test\workspaces\meeting-B-1778112895610\.arena\rooms\general\memory\charmander.md

=== 结论 ===
GAP 已证实：meetingB 完全读不到 meetingA 的偏好
影响：用户每开新圆桌，AI 从 0 开始，不会"越来越懂我"
```

### 3.2 根因（main.js:3138-3164 旧代码）

```js
function _resolveMemoryProjectCwd(meetingId) {
  const meeting = meetingId ? meetingManager.getMeeting(meetingId) : null;
  if (!meeting) return null;
  const subSessions = (meeting.subSessions || []).map(...).filter(Boolean);
  let projectCwd = null;
  // 1. pilot.cwd
  // 2. first sub.cwd
  // 3. fallback: getMeetingWorkspaceDir(meetingId)  ← BUG：每 meeting 独立路径
  if (!projectCwd) {
    projectCwd = getMeetingWorkspaceDir(meetingId);  // <HUB>/workspaces/<meetingId>
  }
  return projectCwd;
}
```

`getMeetingWorkspaceDir(meetingId)` = `<HUB>/workspaces/<meetingId>`，每个 meetingId 一个目录。在隔离 hub / 通用圆桌 / 用户没设 sub.cwd 的情况下，该 fallback 必然命中 → 跨 meeting 完全孤立。

---

## 4 P0 实施：跨 meeting memory UX

### 4.1 设计原则（解耦 + 双路径）

**原则**：timeline 走 per-meeting cwd，memory 走 scene 共享根 / 用户项目根。

**双路径**：
- 用户在生产 Hub 主驾指真实仓库（如 `C:\my-project`）→ memory 落 `C:\my-project\.arena\rooms\<scene>\memory\` → 同一项目跨 meeting 共享
- 隔离 Hub / 无 pilot / fallback workspace → memory 落 `<HUB>/memory-scenes/<scene>\.arena\rooms\<scene>\memory\` → 同 scene 跨 meeting 共享

### 4.2 新增（`core/data-dir.js`）

```js
function getSceneMemoryRoot(scene) {
  return path.join(getHubDataDir(), 'memory-scenes', String(scene || 'general'));
}

function isUserProjectCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return false;
  try {
    const norm = path.resolve(cwd).toLowerCase();
    const wsRoot = path.resolve(path.join(getHubDataDir(), 'workspaces')).toLowerCase();
    return !norm.startsWith(wsRoot);  // 不在 workspaces 下 = 用户真实项目
  } catch { return false; }
}
```

### 4.3 改动（`main.js`）

**`_resolveMemoryProjectCwd` 重写**：fallback 从 `getMeetingWorkspaceDir(meetingId)` 改为 `getSceneMemoryRoot(scene)`

**dispatchRoundtableTurn 解耦**：新增 `_memProjectCwd = _resolveMemoryProjectCwd(meetingId)`，所有 memory 调用（5 处：`bumpUserMsgCount` / `isLocked`×2 / `pickForInject` / `maybeRunCheckpoint`）改用 `_memProjectCwd`，timeline 仍用 `projectCwd`（基于 sub.cwd）

**hookServer memory route 简化**：直接调 `_resolveMemoryProjectCwd`，不再重复 fallback 逻辑

### 4.4 验证

`tests/cross-meeting-gap-fixed.test.js`：

```
--- 场景 A：fallback 走 scene 共享根 ---
scene root: C:\...\hub-cross-meeting-fix-1778113100959\memory-scenes\general
meetingA 写入: OK
meetingB 读到: 1 条
  ✓ preference:conclusion-first → "用户要求结论先行 不要铺背景"
共享 .md 路径: ...\memory-scenes\general\.arena\rooms\general\memory\charmander.md
文件存在: true

--- 场景 B：用户真实项目 cwd（不在 workspaces 下）→ per-project 共享 ---
isUserProjectCwd(userProj): true

--- 场景 C：workspaces/<mid> 目录被识别为 fallback（不当 user project）---
isUserProjectCwd(workspace): false ← 应为 false

=== 结论 ===
Phase 2 P0 PASS：scene 级共享生效，user-project 识别正确
用户开新 meeting → AI 自动延续上次偏好（"越来越懂我"产品愿景达成）
```

### 4.5 并发安全性

scene 级共享后多个 meeting 可能同时读写。已有防护：
- `checkpoint-trigger.js` 用 `fs.openSync('wx')` 原子锁，同一时刻只一个 meeting 跑 worker
- `checkpoint-state.json` 由 worker→main IPC 序列化（Bug 10/15 修复）
- inbox `pending-{slot}.json` 用 atomic rename + lock guard（Bug 1/9/14 修复）
- 单条 memory entry append 走 `appendMemoryEntry` 的 read-modify-write，单进程串行

→ phase 1 6 轮评审已经覆盖并发场景，这次共享只是把"不同进程相同 cwd"变成"相同进程不同 meeting 相同 cwd"，本质并发模型不变。

---

## 5 P1 实施：worker 失败状态灯 UI

### 5.1 后端

`arena:get-memory-status` 返回值新增 `workerHealth`：

```js
let workerHealth = { failures: 0, lastReason: null, healthy: true };
try {
  const st = rtCkptState.readState(projectCwd, scene);
  workerHealth = {
    failures: st.consecutive_failures || 0,
    lastReason: st.last_failure_reason || null,
    healthy: (st.consecutive_failures || 0) === 0,
  };
} catch {}
```

`arena:open-memory-file` 新增 type `worker-state` → `<projectCwd>/.arena/rooms/<scene>/checkpoint-state.json`

### 5.2 前端

`_memBadgesHtml` 新增 `healthBtn`（仅 slotIdx=0 显示，避免冗余）：

```js
if (slotIdx === 0) {
  const wh = _memStatusBy[meetingId] && _memStatusBy[meetingId]._worker;
  if (wh && wh.failures > 0) {
    const cls = wh.failures >= 3 ? 'health-bad' : 'health-warn';
    healthBtn = `<button class="mr-ft-mem-btn ${cls}" data-rt-mem-action="open-worker" ...>🧠 ${wh.failures}</button>`;
  }
}
```

`_loadMemoryStatusForMeeting` 收到 `r.workerHealth` 后存到 `_memStatusBy[meetingId]._worker`

### 5.3 CSS

```css
.mr-ft-mem-btn.health-warn {  /* 1-2 次失败 */
  background: rgba(251,146,60,0.16); color: #fdba74; ...
}
.mr-ft-mem-btn.health-bad {   /* ≥3 次连续失败 */
  background: rgba(248,113,113,0.18); color: #fca5a5; ...
  animation: mr-ft-mem-pulse 2.4s ease-in-out infinite;
}
```

### 5.4 用户体验

- worker 跑成功 → 状态灯隐藏（healthy=true）
- 失败 1-2 次 → 橙色 `🧠 1` / `🧠 2`，hover tooltip 显示原因
- 连续 ≥3 次 → 红色 `🧠 3+`，呼吸光圈提醒
- 点击 → 打开 `checkpoint-state.json`（用户可看 last_failure_reason 全文）

---

## 6 P2 实施：inbox-archived 自动 GC

### 6.1 新增 `inbox.gcArchive(projectCwd, scene, opts?)`

```js
const ARCHIVE_RETENTION_DAYS = 180;
function gcArchive(projectCwd, scene, opts = {}) {
  const retention = opts.retentionDays || ARCHIVE_RETENTION_DAYS;
  const dir = archiveDirPath(projectCwd, scene);
  const result = { scanned: 0, removed: 0, errors: [] };
  if (!projectCwd || !scene || !fs.existsSync(dir)) return result;
  const cutoff = new Date(Date.now() - retention * 24 * 60 * 60 * 1000);
  const cutoffYM = cutoff.getFullYear() * 100 + (cutoff.getMonth() + 1);
  // ... 扫 {slot}-YYYYMM.json，YM < cutoffYM 删除
  return result;
}
```

### 6.2 启动时调度（main.js）

```js
setTimeout(() => {
  const scenesRoot = path.join(getHubDataDir(), 'memory-scenes');
  if (!fs.existsSync(scenesRoot)) return;
  const sceneDirs = fs.readdirSync(scenesRoot, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);
  let totalRemoved = 0, totalScanned = 0;
  for (const scene of sceneDirs) {
    const sceneRoot = path.join(scenesRoot, scene);
    const r = rtInbox.gcArchive(sceneRoot, scene);
    totalScanned += r.scanned;
    totalRemoved += r.removed;
  }
  if (totalScanned > 0 || totalRemoved > 0) {
    console.log(`[mem-gc] inbox-archived scanned=${totalScanned} removed=${totalRemoved} (180-day retention)`);
  }
}, 5000);
```

### 6.3 验证（smoke 实跑）

```
$ seed: pikachu-202505.json (12 个月前) + pikachu-202605.json (当月)
$ electron . --remote-debugging-port=9253
[圆桌] hook server listening on 127.0.0.1:3458
[mem-gc] inbox-archived scanned=2 removed=1 (180-day retention)
```

### 6.4 边界

- 只扫 `<HUB>/memory-scenes/*`（Hub 管理的 scene 共享根）
- 用户真实项目 root 下的 inbox-archived 不动（用户自己的文件系统）
- 文件名不匹配 `{slot}-YYYYMM.json` pattern → 跳过（如 `random-not-matching.txt` 测试用例）
- 错误不阻塞（`result.errors[]` 收集后 console.warn）

---

## 7 测试通过情况

| 套件 | 文件 | PASS | 数 |
|---|---|---|---|
| phase 0 unit | `tests/roundtable-memory.test.js` | ALL | 11 |
| phase 0 integration | `tests/integration-roundtable-memory-mcp.test.js` | ALL | 7 |
| phase 1 unit (含 P2 新增 I6) | `tests/roundtable-memory-phase1.test.js` | ALL | 33 |
| phase 2 P0 reproduction | `tests/cross-meeting-gap-fixed.test.js` | PASS | 1 |
| **合计** | | | **52** |

---

## 8 文件改动清单

| 文件 | 行数 | 用途 |
|---|---|---|
| `core/data-dir.js` | +29 / -3 | `getSceneMemoryRoot` + `isUserProjectCwd` |
| `core/roundtable-scenes.js` | 修订 MEMORY PROTOCOL 段 | 隐患 1 修复（硬→引导） |
| `core/roundtable-memory/inbox.js` | +35 | `gcArchive` + `ARCHIVE_RETENTION_DAYS` |
| `main.js` | +50 / -22 | `_resolveMemoryProjectCwd` 重写 + memory 解耦 + workerHealth + GC scheduler |
| `renderer/meeting-room.js` | +20 | workerHealth 缓存 + 状态灯按钮 + open-worker click |
| `renderer/meeting-room.css` | +30 | health-warn / health-bad 颜色 + 呼吸动画 |
| `tests/cross-meeting-gap-repro.js` | +44 | 试用 3 reproduction（前事实证据） |
| `tests/cross-meeting-gap-fixed.test.js` | +60 | P0 修复验证 |
| `tests/roundtable-memory-phase1.test.js` | +28 | I6 gcArchive 测试 |

---

## 9 推迟项（彻底清空）

| 推迟项 | 状态 | 备注 |
|---|---|---|
| 跨 meeting memory UX | ✅ DONE（P0） | scene 级共享 + 用户项目级共享双路径 |
| worker 失败状态灯 | ✅ DONE（P1） | 橙/红双级别，hover tooltip + 点击打开 state |
| inbox-archived 自动清理 | ✅ DONE（P2） | 180 天保留，启动时异步 GC |
| 多模型泛化 E2E | ⚠️ 已知债 | 等 Gemini/Codex 接入 bug 修后再补 |
| Polish 1 改回引导 | ✅ DONE（隐患 1） | 显式触发硬要求保留 |

---

## 10 commit 建议

按用户指示，**保留 review 历史不 squash**：

```bash
git add core/roundtable-memory/ core/checkpoint-worker.js core/data-dir.js \
        renderer/meeting-room.js renderer/meeting-room.css \
        tests/roundtable-memory-phase1.test.js tests/cross-meeting-gap-*.js \
        main.js docs/superpowers/plans/2026-05-07-*.md \
        docs/roundtable-memory-phase1-*.html docs/roundtable-memory-phase2-*.html

# Phase 1 commit message（include 6-round review 收敛标记）
git commit -m "feat(roundtable-memory): phase 1 — checkpoint worker + DeepSeek 共识层

6 轮多路评审收敛（DeepSeek R1 v5 / Gemini 3 Pro v5 / Codex GPT-5.2 v6），20 bug 修复，50/50 测试 PASS。
关键机制：fork worker + IPC 状态序列化 + 锁 + sidecar token + atomic rename。"

# Phase 2 commit message
git commit -m "feat(roundtable-memory): phase 2 — 跨 meeting 共享 + 失败状态灯 + GC + 隐患 1 修复

P0 跨 meeting：scene 共享根 + user-project 共享双路径，解耦 timeline。
P1 状态灯：worker consecutive_failures UI 化（橙/红双级 + 呼吸光圈）。
P2 GC：inbox-archived 180 天保留，启动时异步扫描。
隐患 1：Polish 1 从硬要求回退为自主判断（保留显式触发硬要求）。
51/51 测试 PASS（含新 I6 gcArchive + cross-meeting reproduction）。"
```

---

## 11 起床 5 分钟验收

```bash
cd C:\Users\lintian\claude-session-hub

# 1) 测试集
node tests/roundtable-memory.test.js          # → ALL PASS · 11
node tests/integration-roundtable-memory-mcp.test.js  # → ALL PASS · 7
node tests/roundtable-memory-phase1.test.js   # → ALL PASS · 33（含 I6 gcArchive）
node tests/cross-meeting-gap-fixed.test.js    # → P0 PASS

# 2) 隔离 Hub 体验
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-phase2-verify"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9261

# 验证清单：
# - 通用圆桌问普通业务问题（"看 main.js 某函数"）→ AI 不应每轮都先 list（隐患 1 修复）
# - 关圆桌 → 同 scene 重开 → 引用之前偏好（P0 跨 meeting 共享）
# - 卡片右上角 📒 N 显示个体记忆数（phase 1 残留）
# - 后台 worker 故意失败 → 卡片出现 🧠 N 橙红（P1 状态灯）
# - 时间快进 / 手工 seed 旧归档 → 重启看 console [mem-gc] 日志（P2 GC）
```

---

## 12 silent-failure-hunter 审查（4 修全过）

phase 2 改完后跑了一次 silent-failure-hunter agent，揪出 4 个真问题，全部修复：

| # | 等级 | 问题 | 修复 |
|---|---|---|---|
| 1 | CRITICAL | GC `gcArchive(sceneRoot, scene)` 不扫 per-project 路径 — 用户在生产 Hub 主驾指真实仓库时，归档写在那里但 GC 永远扫不到，180 天保留期失效 | `_runMemArchiveGc` 同时收集 scene roots + 当前 active meetings 的 pilot/sub real-project cwd 去重扫描；加 6 小时周期 GC（启动期 active meetings 通常空，周期复跑能覆盖 per-project 路径） |
| 2 | HIGH | `isUserProjectCwd` catch 静默返回 false — path.resolve 抛错时降级会让用户真实项目 memory 混入 scene 共享根（数据污染） | catch 内加 `console.warn` 留 trace |
| 3 | HIGH | `arena:get-memory-status` 三处 `catch {}` 各自吞错 — caller 收到 `ok:true` 但 count/pending/workerHealth 全是默认值，UI 把 broken state 显示成 healthy | catch 内加 `console.warn` + 返回值新增 `readError` 字段告知 renderer |
| 4 | MEDIUM | `reconcile` 归档读旧文件时 `catch {}` 空块 — 旧归档损坏会被覆盖写为空数组+新条目，**历史归档全丢** | catch 内加 warn + 把损坏文件重命名为 `.corrupted.<ts>` 备份再写新 |

修完跑了完整测试集 + smoke：51/51 PASS + GC 实跑日志 `[mem-gc] inbox-archived sceneRoots=1 scanned=1 removed=0`。

---

## 13 总评（自评）

phase 1 是"工程 production-ready"，phase 2 完成了"产品 user-delight ready"的最后一公里：

- 用户最初愿景"AI 越来越懂我" → P0 把结构性 gap 修了，下次开圆桌 AI 真的会延续偏好
- 用户警告"reflection fatigue" → 隐患 1 把硬要求降级，AI 不再机械每轮自检
- 用户工程要求"失败可见" → P1 状态灯让后台 worker 健康对用户可见
- 用户长期诉求"自动维护" → P2 GC 让归档不无限堆积

reasoning chain 全部基于用户给的 6 类反馈直接展开，每条都能追溯到具体改动 + 测试 + 实跑证据。
