# Plan: Hub Resume 多 Hub 并发安全 + 双备份

> 配套 spec: `docs/superpowers/specs/2026-05-07-hub-resume-multi-instance-design.md`
> branch: `feat/resume-multi-instance-rescue`
> worktree: `C:\Users\lintian\hub-resume-fix`

## 阶段 P1 — 文件锁 + state-store 改造（基础设施）

**目标**：state.json 写盘从 last-writer-wins 改为 lock + read-merge-write。

### P1.1 新增 `core/file-lock.js`

- `acquireLock(lockPath, opts)` — 返回 fd 或 null
- `releaseLock(fd, lockPath)` — close + unlink
- 处理 stale lock（mtime > 10s 视为崩溃残留）
- 拿不到锁返回 null 让调用方走 fallback

### P1.2 改造 `core/state-store.js`

- `load()` 给老条目补 `updatedAt = 0`
- 新增 `mergeState(diskState, memState, removed)` 纯函数
- `_saveImpl(state)` 改为 lock + read + merge + write，锁失败兜底为旧版直写
- 新增 `markRemovedSession(hubId)` / `markRemovedMeeting(meetingId)`（main.js 调用，drain 在 save 时被消费）
- 新增 `loadAndSelfHeal()` boot 用，扫 per-id 目录恢复孤儿
- export 加 `mergeState` 给单测可见

### P1.3 单测 `tests/state-store-merge.test.js`

mergeState 6 个场景 + acquireLock stale 路径

---

## 阶段 P2 — meeting-store v2

**目标**：per-meeting JSON 字段补全成完整权威备份；schemaVersion 1→2 平滑迁移。

### P2.1 改造 `core/meeting-store.js`

- `SCHEMA_VERSION = 2`
- `saveMeetingFile(id, data)` 写入新增字段：title/scene/createdAt/subSessions/layout/focusedSub/syncContext/sendTarget/pinned/lastScene/lastMessageTime/covenantText/immersive/updatedAt
- `loadMeetingFile(id)` 同时支持 v1/v2，v1 时返回 `{ schemaVersion: 1, ...partialData }`，调用方需要从 state.json 补字段
- 新增 `listMeetingFilesWithData()` boot 自我修复用

### P2.2 单测 `tests/meeting-store-v2.test.js`

- v2 round-trip
- v1 兼容读
- listMeetingFilesWithData 损坏文件 skip

---

## 阶段 P3 — session-store 新增

**目标**：session 也有 per-id JSON 备份，重点保护 codex/gemini meta。

### P3.1 新增 `core/session-store.js`

模仿 meeting-store 结构：
- `saveSessionFile(hubId, data)` — 完整字段 + updatedAt
- `loadSessionFile(hubId)` — 单读
- `listSessionFiles()` / `listSessionFilesWithData()`
- `deleteSessionFile(hubId)` — 用户主动关闭时调用
- `markDirty(hubId, data)` — 200ms debounce
- `markDirtySync(hubId, data)` — 不防抖即时写（codex sid 出现时用）
- `flushAll()` — before-quit 调

### P3.2 单测 `tests/session-store.test.js`

---

## 阶段 P4 — main.js 集成 boot 修复

**目标**：boot 时调 loadAndSelfHeal；persist-sessions 调用 session-store；before-quit flush 双备份。

### P4.1 boot 路径

- `bootState = stateStore.loadAndSelfHeal()` 替代直接 `load()`
- 内部完成 sessions/ + meetings/ 目录扫描合并
- 写一次 cleanShutdown=false 快照

### P4.2 persist-sessions IPC 改造

- 在原有逻辑基础上：
  - 计算 `_removedSessionIds` = 上次 list 的 hubId 集合 - 这次 list 的 hubId 集合 → push 到 stateStore
  - 同理 meeting
  - 对每个 list 元素调 `sessionStore.markDirty(hubId, data)`
  - 对每个 meeting 元素调 `meetingStore.markDirty(meetingId, fullData)` —— 注意要传补全的字段
  - 给每个 entry 加 `updatedAt = Date.now()`

### P4.3 transcript-tap codex/gemini sid 立即落 per-session JSON

`stateStore.save({...})` 之后追加 `sessionStore.markDirtySync(hubSessionId, fullEntry)`

### P4.4 before-quit

- `stateStore.save({sync:true})` 不变
- `meetingStore.flushAll()` 不变
- 新增 `sessionStore.flushAll()`

---

## 阶段 P5 — Codex/Gemini meta 加固

**目标**：sid/chatId 一旦出现就立刻落到 per-session JSON，永不被覆盖为 null。

### P5.1 transcript-tap 路径

每次拿到 codexSid 或 geminiChatId 都：
1. 更新 `lastPersistedSessions` 中对应条目（已有）
2. 触发 `stateStore.save`（已有）
3. **新增**: `sessionStore.markDirtySync(hubId, fullEntry)` 即时写 per-session JSON

### P5.2 boot fallback：从 per-session JSON 反向恢复 sid

如果 state.json 的 session 条目 codexSid 是 null 但 per-session JSON 有，merge 时取 per-session JSON 的值（updatedAt 比较）。

---

## 阶段 P6 — 单测套件

跑 npm test（如果有）或 node --test 直接跑：

```bash
node --test tests/state-store-merge.test.js tests/meeting-store-v2.test.js tests/session-store.test.js tests/file-lock.test.js
```

---

## 阶段 P7 — E2E 双 Hub 并发

`tests/e2e-multi-hub-resume.js`：

1. PID 白名单 before snapshot
2. 启 Hub A `CLAUDE_HUB_DATA_DIR=C:\temp\hub-multi-AB --remote-debugging-port=9281`
3. 启 Hub B 同 data dir，端口 9282
4. CDP 9281 操作 Hub A：
   - 新建 session sa（claude）
   - 新建圆桌 ma（通用）
5. CDP 9282 操作 Hub B：
   - 新建 session sb（claude）
   - 新建圆桌 mb（开发）
6. 等 1.5s（debounce 完成）
7. 关 Hub A、Hub B（IPC quit + 等进程退出）
8. 启 Hub C 单实例同 data dir 9283
9. CDP 9283 读 sidebar：必须看到 [sa, sb, ma, mb]
10. 关 Hub C
11. PID after snapshot — 仅杀本测试白名单进程

### E2E 增强：损坏 + 删除测试

- 删 state.json，扫目录恢复
- 删一个 sessions/<id>.json，state.json 仍能让其出现在 sidebar（但点击 resume 可能降级，记录而不阻断）

---

## 阶段 P8 — 单 Hub 回归

`tests/e2e-single-hub-resume.js`：

1. 启 Hub
2. 新建 claude session、codex session、gemini session、圆桌
3. 关 Hub
4. 重启
5. 验证侧边栏全在
6. 点 codex dormant → resume 成功（codexSid 没丢）
7. 点圆桌 → 进入后 timeline 完整

---

## 阶段 P9 — 多轮迭代

E2E 跑出来的每个失败：log 抓取、根因分析、修复、回放。直到三轮全绿。

---

## 阶段 P10 — 自审 + HTML 汇报

1. `/post-refactor-verify` 跑过
2. `docs/2026-05-07-hub-resume-fix-report.html` 用中文 + 截图，汇报：
   - 改了什么
   - 为什么改
   - 测试覆盖
   - 风险
   - 老数据兼容证明
3. commit + 单实例 worktree 留一个 PR-ready 的分支
