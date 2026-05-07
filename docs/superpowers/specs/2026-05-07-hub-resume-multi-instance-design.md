# Hub Resume 机制加固：多 Hub 并发安全 + 圆桌/Session 双备份

> 2026-05-07 立花道雪
> 用户故事：开两个 Hub 共享同一份数据目录，分别在里面操作 session/圆桌，关闭后重启 Hub，发现部分会话彻底丢失。

## 1. 设计目标

1. **多 Hub 并发不丢**：Hub A 和 Hub B 共享 `~/.claude-session-hub/` 时，任意一边的 session/圆桌不会因另一边写盘而消失。
2. **磁盘双备份**：圆桌和 session 在 per-id JSON 里都有完整字段，即使 `state.json` 损坏或被外部清空，下次 boot 仍能扫目录恢复全部内容。
3. **Codex/Gemini 强化**：`codexSid` / `geminiChatId` / `geminiProjectHash` / `geminiProjectRoot` 即时双写，不会被 `state.json` race 覆盖为 null。
4. **完全向后兼容**：旧 `state.json`（v1）+ 旧 `meetings/<id>.json`（v1）能 100% 加载，且首次 boot 自动迁移成新结构。
5. **不退化任何现有功能**：sidebar、resume、unread、persist 等所有现有路径行为不变。

## 2. 非目标

- 不做 vector clock / CRDT / 多 Hub 协作编辑：用户场景是加性使用（各 Hub 各开自己的 session）。
- 不强制单实例：保留多开能力。
- 不动 Claude/Codex/Gemini 自身的 transcript 文件（CLI 拥有，Hub 只读）。

## 3. 数据流总览

### 3.1 写盘三类资产

| 资产 | 路径 | 写盘策略 | 备注 |
|---|---|---|---|
| 全局索引 | `<DATA_DIR>/state.json` | **lock + read-merge-write**（500ms debounce） | 索引 + 完整字段冗余（双层保险） |
| Per-session 备份 | `<DATA_DIR>/sessions/<hubId>.json` | per-id 直写 + 200ms debounce | **新增**；codex/gemini meta 即时写 |
| Per-meeting 备份 | `<DATA_DIR>/meetings/<id>.json` | per-id 直写 + 5s debounce（保留） | **字段补全 v1→v2** |

### 3.2 Boot 加载顺序（自我修复）

```
1. lock state.json
2. read state.json
3. 扫 sessions/ 目录，找出 state.json 中缺失的 hubId → 用 per-session JSON 重建
4. 扫 meetings/ 目录，找出 state.json 中缺失的 meetingId → 用 per-meeting JSON 重建
5. 写回 cleanShutdown=false 的合并结果
6. unlock
```

### 3.3 Resume 流程（不变）

resume-session IPC 路径完全不变。读取的字段从 state.json 还是 per-session JSON 取决于哪个 updatedAt 更新（merge 后端透明）。

## 4. Schema 变更

### 4.1 state.json — 加 `updatedAt` 字段

```js
{
  version: 1,           // 不变
  cleanShutdown: bool,
  sessions: [{
    hubId, kind, title, cwd, pinned,
    ccSessionId, codexSid, geminiChatId,
    geminiProjectHash, geminiProjectRoot,
    currentModel, meetingId,
    lastMessageTime, lastOutputPreview, unreadCount,
    updatedAt: number,   // ★ 新增（毫秒时间戳，每次任意字段变更同步刷）
  }],
  meetings: [{
    ...现有字段,
    updatedAt: number,   // ★ 新增
  }],
  // immersiveByMeeting 字段保留（旧版兼容），但同时迁移进 per-meeting JSON
  immersiveByMeeting, pilotSlotByMeeting, dispatchModeByMeeting,
}
```

旧 state.json 缺 `updatedAt` → 视为 0，merge 时被任何带 updatedAt 的版本覆盖。

### 4.2 sessions/&lt;hubId&gt;.json — 新增

```js
{
  schemaVersion: 1,
  hubId, kind, title, cwd, pinned,
  ccSessionId, codexSid, geminiChatId,
  geminiProjectHash, geminiProjectRoot,
  currentModel, meetingId,
  lastMessageTime, lastOutputPreview, unreadCount,
  updatedAt, savedAt,
}
```

写时机：`persist-sessions` IPC 的 list 中每个 entry 同步写一份；transcript-tap 检测到 codex/gemini sid 时**立刻** sync 写（200ms debounce 也跳过，防 race）。

### 4.3 meetings/&lt;id&gt;.json — schemaVersion 1→2，字段补全

```js
{
  schemaVersion: 2,    // ★ 升级（v1 自动迁移）
  id,
  // 原有：timeline + slot 信息
  _timeline, _cursors, _nextIdx,
  slotSpecs, pilotSlot, dispatchMode, mode, participants,
  // ★ 新增（迁移 v1 时从 state.json 反查填入）
  title, scene, createdAt, subSessions,
  layout, focusedSub, syncContext, sendTarget, pinned,
  lastScene, lastMessageTime, covenantText,
  immersive,           // 从 state.json 的 immersiveByMeeting 迁过来
  updatedAt, savedAt,
}
```

`loadMeetingFile` 处理两种 schemaVersion：v1 时所有缺失字段返回 null，由 main.js 的 boot 路径用 state.json 兜底；v2 时是完整数据。

## 5. 写盘协议

### 5.1 文件锁（自研最小化）

`core/file-lock.js`：

```js
function acquireLock(lockPath, { retries = 20, retryDelayMs = 50, staleMs = 10000 }) {
  for (let i = 0; i < retries; i++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');  // 原子 O_CREAT|O_EXCL
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, mtime: Date.now() }));
      return fd;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 检查是否 stale
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;  // 立即重试
        }
      } catch {}
      // 短退避
      const start = Date.now();
      while (Date.now() - start < retryDelayMs) {}  // sync busy-wait（写盘场景毫秒级）
    }
  }
  return null;  // 拿不到锁，调用方走无锁路径兜底
}

function releaseLock(fd, lockPath) {
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(lockPath); } catch {}
}
```

为什么不上 npm 包：CLAUDE.md 严禁主工作目录 `npm install`；同时 fs.openSync('wx') 在 Windows / POSIX 都是原子的，自研版能做到所有需要的语义（mtime stale 检测 + 重试 + fallback）。

### 5.2 stateStore.save 新流程

```js
function save(state, { sync = false } = {}) {
  // 防抖逻辑保留（500ms），但实际写盘函数变 _saveWithMerge
}

function _saveWithMerge(myMemoryState) {
  const fd = acquireLock(LOCK_FILE);
  try {
    let diskState;
    try {
      diskState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch {
      diskState = defaultState();
    }

    const merged = mergeState(diskState, myMemoryState, {
      removedSessionIds: drainRemovedSessions(),
      removedMeetingIds: drainRemovedMeetings(),
    });

    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } finally {
    if (fd != null) releaseLock(fd, LOCK_FILE);
  }
}
```

### 5.3 mergeState 算法

```js
function mergeState(diskState, memState, { removedSessionIds, removedMeetingIds }) {
  // sessions: 按 hubId 索引取 LWW
  const sessByHubId = new Map();
  for (const s of diskState.sessions || []) sessByHubId.set(s.hubId, s);
  for (const s of memState.sessions || []) {
    const existing = sessByHubId.get(s.hubId);
    if (!existing || (s.updatedAt || 0) >= (existing.updatedAt || 0)) {
      sessByHubId.set(s.hubId, s);
    }
  }
  for (const id of removedSessionIds) sessByHubId.delete(id);

  // meetings 同理
  const meetByMtgId = new Map();
  for (const m of diskState.meetings || []) meetByMtgId.set(m.id, m);
  for (const m of memState.meetings || []) {
    const existing = meetByMtgId.get(m.id);
    if (!existing || (m.updatedAt || 0) >= (existing.updatedAt || 0)) {
      meetByMtgId.set(m.id, m);
    }
  }
  for (const id of removedMeetingIds) meetByMtgId.delete(id);

  return {
    version: 1,
    cleanShutdown: memState.cleanShutdown,  // 各 Hub 自己写自己的 flag（多 Hub 时谁退出谁刷新）
    sessions: [...sessByHubId.values()],
    meetings: [...meetByMtgId.values()],
    // immersive/pilot/dispatch dict：盘上 + 内存 union
    immersiveByMeeting: { ...diskState.immersiveByMeeting, ...memState.immersiveByMeeting },
    pilotSlotByMeeting: { ...diskState.pilotSlotByMeeting, ...memState.pilotSlotByMeeting },
    dispatchModeByMeeting: { ...diskState.dispatchModeByMeeting, ...memState.dispatchModeByMeeting },
  };
}
```

### 5.4 removedIds 跟踪

main.js 维护两个 Set：

```js
const _removedSessionIds = new Set();
const _removedMeetingIds = new Set();

ipcMain.on('persist-sessions', (e, list, meetingList) => {
  // 与上一次 persist 的 list 比较，diff 出消失的 id 加入 _removedSessionIds
  // 同理 meeting
  ...stateStore.save(...)
});
```

drain 时（save 内部）取出全部并清空，已生效的删除不会被重复推 disk。

仅记录"渲染端在两次 persist 之间显式消失的 id"作为删除信号，不依赖"内存里没有 = 已删除"。

### 5.5 锁失败兜底

`acquireLock` 1s 内拿不到锁 → log 警告 + 走旧版无锁直接覆盖。锁失败不能让 Hub 卡死。

## 6. Boot 自我修复

`main.js` 启动序列改造：

```js
const bootState = stateStore.loadAndSelfHeal();
//   内部：
//   1. read state.json（无文件 → defaultState）
//   2. listSessionFiles() 扫 sessions/ 目录
//   3. listMeetingFiles() 扫 meetings/ 目录
//   4. state.json 缺失但磁盘有 → 用 per-id JSON 重建条目（updatedAt 取文件 savedAt）
//   5. 合并后 sync 写一次（cleanShutdown=false 的快照）
//   6. 返回 mergedState
```

健壮性：单个 per-id JSON 损坏 → log 警告 + skip，不影响整体加载。

## 7. 迁移与兼容

### 7.1 旧 state.json (v1, 无 updatedAt)

`load()` 自动给老条目补 `updatedAt = 0`。下次任意 Hub 操作时，新写入会带正确的 updatedAt 并直接覆盖。

### 7.2 旧 meetings/&lt;id&gt;.json (v1)

`loadMeetingFile` 检测到 schemaVersion=1 时返回特殊标记，main.js boot 用 state.json 的 meetings[] 反查补全 title/scene 等字段，下次 markDirty 自动写成 v2。

### 7.3 老用户首次启动

无感升级：boot 时若发现 sessions/ 目录不存在，创建之；不会扫到孤儿（合理）；后续每次 persist 自动写 per-session JSON 备份。

## 8. 测试方案

### 8.1 单元测试 (`tests/`)

- `state-store-merge.test.js`：mergeState 各分支（disk-only / mem-only / 双方有 + LWW / removedIds 删除）
- `meeting-store-v2.test.js`：v1 → v2 迁移、字段补全、loadMeetingFile 双 schema 兼容
- `session-store.test.js`：list / save / delete / 损坏 JSON skip
- `file-lock.test.js`：拿锁 / 释放 / stale 超时 / 拿不到 fallback

### 8.2 E2E 多 Hub 并发（核心验证）

`tests/e2e-multi-hub-resume.js`：

1. 起两个隔离 Hub 实例 A/B 都用 `CLAUDE_HUB_DATA_DIR=<同一隔离目录>`（PID 白名单 before/after diff，禁止时间窗口推断）
2. CDP 9281/9282 连两边
3. Hub A 创建 session sa；Hub B 创建 session sb；Hub A 创建圆桌 ma；Hub B 创建圆桌 mb
4. 双方 persist debounce 完成后，关闭两个 Hub
5. 启第三个 Hub 实例 C（同一目录），验证侧边栏看到 [sa, sb, ma, mb] 全集
6. 进一步：Hub C 删 sa，启 Hub D 验证只剩 [sb, ma, mb]，确认 removedIds 跟踪生效

### 8.3 E2E 单 Hub 回归

`tests/e2e-single-hub-resume.js`：

1. 创建 N 个 session（claude/codex/gemini 各一个）+ 1 个圆桌
2. 关闭 Hub
3. 重启 Hub
4. 验证全部 dormant 出现在侧边栏，model/cwd/codexSid/geminiChatId 字段无 null
5. 点击 dormant session → resume 成功（不会因 sid 丢失而走 fallback）

### 8.4 模拟 state.json 损坏

`tests/e2e-state-json-corruption.js`：

1. 跑测试场景生成 sessions/ + meetings/ + state.json
2. 直接 rm state.json
3. 重启 Hub
4. 验证侧边栏从 sessions/ + meetings/ 完整恢复

## 9. 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 锁失败导致写阻塞 | 低 | Hub 卡顿 | 1s 超时 + fallback 无锁路径 |
| stale lock 误判删 | 极低 | 短暂双写 | 10s 阈值（远超 100ms 写时长） |
| per-session JSON 写入风暴 | 中 | 磁盘 IO 增 | 200ms debounce + per-id 文件不互相覆盖 |
| 向后不兼容 | 低 | 老用户启动失败 | v1 兜底逻辑 + 大量单测覆盖迁移路径 |

## 10. 不做（YAGNI）

- 不做 lockfile npm 依赖（自研够用）
- 不做 WAL（per-id 文件已经是 append-friendly 了）
- 不做 vector clock（用户场景是加性的）
- 不做"removed_at 软删除"（直接 unlink per-id 文件即可）
- 不强制单实例锁（保留多开自由度）
