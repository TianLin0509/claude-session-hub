# Silent Failure Audit — Claude Session Hub
**审查日期**: 2026-05-03  
**审查范围**: main.js · core/meeting-room.js · core/roundtable-orchestrator.js · core/transcript-tap.js · renderer/renderer.js · renderer/meeting-room.js · core/session-manager.js  
**方法**: 代码全文阅读 + 模式 grep + 错误传播路径人工追踪

---

## P0 级（用户可直接感知：卡死 / 数据丢失 / 状态错乱）

---

### P0-1 | Hook server `req.on('end')` 异步 handler 无顶层 try-catch，任何内部抛错都导致 HTTP 请求挂起且主进程 unhandled rejection

**文件**: `C:\Users\lintian\claude-session-hub\main.js:2517`

```js
req.on('end', async () => {
  if (tooBig) { res.writeHead(413); res.end('{}'); return; }
  let parsed;
  try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
  // ...大量逻辑，包括 await readLastUserMessage / await transcriptTap.notifyClaudeStop
  res.writeHead(200); res.end('{}');
});
```

**问题描述**: `req.on('end', async () => { ... })` 注册的是一个 EventEmitter 回调；在 Node.js 中，EventEmitter 回调内的 unhandled Promise rejection **不会**被 `process.on('unhandledRejection')` 捕获（它会被静默吞掉），并且 `res.end()` 永远不会被调用，导致这条 HTTP 请求连接挂起。后果：
- Stop hook POST 永远不返回 → CC CLI 的 Stop hook 超时（5s）→ transcript-tap `notifyClaudeStop` 不被调用 → 圆桌 idle-timer 兜底需等 5s。
- 更严重：触发抛错的代码路径（如 `sendToRenderer` 在 `mainWindow` 已销毁时）会让 Hook Server 整体失去响应。

**触发场景**: `readLastUserMessage` 内部文件 I/O 抛错（网络驱动/磁盘满）；`sendToRenderer` 在窗口销毁后被调；lindangBridge 调用抛错。

**建议修法**:
```js
req.on('end', () => {
  (async () => {
    // ...原有逻辑
  })().catch((e) => {
    console.error('[hook-server] req handler threw:', e);
    if (!res.headersSent) { res.writeHead(500); res.end('{}'); }
  });
});
```

---

### P0-2 | `registerSessionForTap` 空 catch 吞掉注册失败，transcript-tap 永不监听该 session，圆桌卡片永远不更新

**文件**: `C:\Users\lintian\claude-session-hub\main.js:489-490`

```js
function registerSessionForTap(session) {
  if (!session || !session.id) return;
  try { transcriptTap.registerSession(session.id, session.kind, { cwd: session.cwd }); }
  catch {}   // <--- 完全吞掉
}
```

**问题描述**: `transcriptTap.registerSession` 内部若抛错（如 `kind` 不在已知列表、内部状态机异常），catch 块完全静默。调用方（`_addMeetingSubInternal` / `create-session` IPC handler）不会知道注册失败。结果是该 session 的 ClaudeTap / CodexTap / GeminiTap 从未启动，`turn-complete` 事件永远不 emit，圆桌卡片永远停在 `thinking`，用户无法区分"AI 还没回答"和"tap 注册失败"。

**触发场景**: 在 session-manager 构造完但 transcriptTap 内部状态被破坏时（极罕见）；更常见：kind 为将来新增类型时（类型检查未覆盖）。

**建议修法**:
```js
function registerSessionForTap(session) {
  if (!session || !session.id) return;
  try {
    transcriptTap.registerSession(session.id, session.kind, { cwd: session.cwd });
  } catch (e) {
    console.warn(`[hub] registerSessionForTap failed for ${session.id.slice(0,8)} kind=${session.kind}:`, e.message);
    // 不阻断 session 创建，但必须留日志
  }
}
```

---

### P0-3 | `_rtWaitTurnComplete` 中 `onPartial` 回调内的 `sendToRenderer` 抛错被静默 catch，streamTimer 可能泄漏（永不 clearInterval）

**文件**: `C:\Users\lintian\claude-session-hub\main.js:1017-1033`

```js
streamTimer = setInterval(() => {
  if (watcher.isSettled()) { clearInterval(streamTimer); streamTimer = null; return; }
  // ...
  try {
    onPartial({ ... });
  } catch {}  // <--- 吞掉
  // ...
}, 1500);
```

同文件 `main.js:1062-1079`：
```js
return watcher.wait().then(result => {
  clearTimeout(hardTimeout);
  clearInterval(hostShellHeartbeat);
  if (streamTimer) clearInterval(streamTimer);  // 正常路径清 timer
  // ...
  if (typeof onPartial === 'function') {
    try { onPartial(result); } catch (e) { console.warn(...); }  // 这里有 warn，OK
  }
  return result;
});
```

**问题描述**: `setInterval` 内的 `onPartial` 被 `try{} catch{}` 完全吞掉。若 `sendToRenderer` 调用（位于 `onPartial` 里）在主窗口销毁后抛 `Error: Object has been destroyed`，异常被静默忽略，`streamTimer` 继续每 1500ms 触发（因为 `watcher.isSettled()` 此时返回 false，窗口已销毁所以 settle 信号永远不来）。`hardTimeout` 最终会 `watcher.skip()` 触发 settle，但在此之前 timer 持续燃烧 5 分钟。`timer` 中的错误完全不可见，运维无法追踪。

**触发场景**: 用户在圆桌轮次进行中关闭主窗口（`mainWindow = null`），`sendToRenderer` 调用 `mainWindow.webContents.send` 抛错。

**建议修法**:
```js
try {
  onPartial({ ... });
} catch (e) {
  console.warn('[roundtable] streamTimer onPartial threw:', e.message);
  // 可选：若是 destroyed 错误则清 timer 防泄漏
}
```

---

### P0-4 | `dispatchRoundtableTurn` 中 `Promise.all(targets.map(_rtSendToPty))` 无错误路由，_rtSendToPty 内部异常等于 PTY 死锁

**文件**: `C:\Users\lintian\claude-session-hub\main.js:1241-1249`

```js
await Promise.all(targets.map(async (t) => {
  const ok = await _rtSendToPty(t.sid, t.prompt, t.kind);
  if (ok) {
    sentTargets.push(t);
  } else {
    console.log(`[roundtable] ... skip ...`);
  }
}));
```

**问题描述**: `_rtSendToPty` 本身几乎不抛错（内部异常路径都有 catch），但 `_rtWaitCliReady` 内部的 `sessionManager.getSessionBuffer(sid)` 在 session 被并发关闭时会返回 undefined，循环内 `buf.length` 触发 TypeError。若整个 `Promise.all` 中任何一家抛错（promise rejection），该 async lambda 的错误会被 Promise.allSettled 的外层（`sentTargets` push 逻辑已过，实际是 `.map(async (t) => {...})` 产生 unhandled rejection）—— 但此处用的是 `Promise.all`，一家 reject 会让整个 `Promise.all` reject，直接抛到 `dispatchRoundtableTurn` 的 try 里，最终 `_roundtableInProgress` 被清（finally），但 `turnNum` 已经 `beginTurn` 了，`rollbackTurn` 不会被调用，**orchestrator 状态机留在非 idle 中间状态**，下次 dispatch 再次被 `_roundtableInProgress.has(meetingId)` 拦截返回 busy，圆桌永久锁死直到重启。

**触发场景**: 圆桌轮次发送时，某个 sub session 被用户从侧边栏强制关闭；或 session-manager 并发状态竞争。

**建议修法**: 把 `Promise.all` 改成类似 `Promise.allSettled` + 失败后 rollback 保护：
```js
const results = await Promise.allSettled(targets.map(async (t) => { ... }));
for (const [i, r] of results.entries()) {
  if (r.status === 'fulfilled' && r.value) sentTargets.push(targets[i]);
  else if (r.status === 'rejected') console.warn('[roundtable] _rtSendToPty rejected:', r.reason?.message);
}
if (sentTargets.length === 0) { orch.rollbackTurn(turnNum); return {...}; }
```

---

## P1 级（偶现 / 需特定时序，但发生时无日志难排查）

---

### P1-1 | `CodexTap._tryBind` 中 rollout 绑定后的 `onLine` 回调完全无错误处理，单行解析异常会导致 task_complete debounce timer 永不触发

**文件**: `C:\Users\lintian\claude-session-hub\core\transcript-tap.js:601-638`

```js
const onLine = (obj) => {
  if (obj?.type !== 'event_msg' || !obj.payload) return;
  const entry = this._bound.get(hubSessionId);
  if (!entry) return;
  const eventType = obj.payload.type;
  if (eventType === 'task_started' && entry._pendingEmitTimer) {
    clearTimeout(entry._pendingEmitTimer);
    // ...
  }
  if (eventType === 'task_complete' && typeof obj.payload.last_agent_message === 'string') {
    // ...debounce timer 设置
    entry._pendingEmitTimer = setTimeout(() => {
      // ...emit turn-complete
    }, TASK_COMPLETE_DEBOUNCE_MS);
  }
};
```

**问题描述**: `onLine` 中若 `this._bound.get(hubSessionId)` 在 `unregisterSession` 后被访问（session 已删但 timer 还活着），`entry` 为 undefined，后续代码不会执行；然而如果 `entry` 在 task_complete 之前被清 pending timer 逻辑破坏（如引用竞争），整个 turn-complete 链就断掉。更关键的是：`JsonlTail` 内 `this._onLine(obj)` 被 `try {} catch {}` 吞掉（transcript-tap.js:91）——任何 onLine 抛的异常完全消失，开发者看不到任何迹象。

**触发场景**: Codex 连续快速完成多个 task（任务叠加），`_bound` 中 timer 竞争更新。

**建议修法**: `JsonlTail._drain` 的 `try { this._onLine(obj); } catch {}` 改为：
```js
try { this._onLine(obj); } catch (e) {
  console.warn('[jsonl-tail] onLine threw:', this._filepath, e.message);
}
```

---

### P1-2 | `GeminiTap._bindSession` 中 `_scheduleGeminiIdleEmit` 的 timer 在 session unregister 后仍可能触发 emit

**文件**: `C:\Users\lintian\claude-session-hub\core\transcript-tap.js:894-913`

```js
const _scheduleGeminiIdleEmit = () => {
  if (boundEntry._idleTimer) clearTimeout(boundEntry._idleTimer);
  boundEntry._idleTimer = setTimeout(() => {
    boundEntry._idleTimer = null;
    // ...
    this.emit('turn-complete', { hubSessionId, text, ... });
  }, _GEMINI_IDLE_EMIT_MS);
  boundEntry._idleTimer.unref?.();
};
```

**问题描述**: `unregisterSession` 调用 `clearTimeout(bound._idleTimer)` 清理（transcript-tap.js:686），但 `_scheduleGeminiIdleEmit` 这个闭包是在 `_bindSession` 里创建的，引用的是 `boundEntry`（局部变量），而不是 `this._bound.get(hubSessionId)`。如果 `_scheduleGeminiIdleEmit` 被注册到 `onLine` 后，`unregisterSession` 清了 `_bound` Map 中的 `_idleTimer` 字段，但 `boundEntry` 局部引用的 `_idleTimer` 字段是同一个对象（引用相同），所以实际上 clearTimeout 是有效的——但如果在 `unregisterSession` 和 `_scheduleGeminiIdleEmit` 之间有极短的竞争窗口（比如 `clearTimeout` 之后立刻又 `_scheduleGeminiIdleEmit`），就会再次注册新 timer，此时 `this._bound` 中该 hubSessionId 已被删除，`emit('turn-complete')` 会被上层 `TranscriptTap` 转发，进而触发已销毁 session 的 timeline 追加。

**触发场景**: 用户快速关闭 Gemini 子 session（圆桌关闭）时，race condition。

**建议修法**: idle timer 触发时先检查 session 是否仍在 `_bound`：
```js
boundEntry._idleTimer = setTimeout(() => {
  boundEntry._idleTimer = null;
  if (!this._bound.has(hubSessionId)) return; // session already unregistered
  // ...emit
}, _GEMINI_IDLE_EMIT_MS);
```

---

### P1-3 | `roundtable-resend-participant` IPC handler 的 watcher.wait() 无顶层 try-catch，unhandled rejection 导致 _activeWatchers 泄漏

**文件**: `C:\Users\lintian\claude-session-hub\main.js:1779-1787`

```js
let result;
try {
  result = await watcher.wait();
} finally {
  clearInterval(streamTimer);
  clearInterval(heartbeat);
  clearTimeout(hardTimeout);
  _activeWatchers.delete(sid);
}
```

**问题描述**: `watcher.wait()` 的 promise 按设计永不 reject（turn-completion-watcher 总 resolve），但若实现变更或传入了错误的 `transcriptTap`，finally 里 `_activeWatchers.delete` 仍然会执行（这里处理得好）。问题在于 `result` 字段之后立即被 `orch.patchTurnResult` 使用，如果 result 为 undefined（wait() 被 reject 且被 finally 吞掉 rethrow），`result.text` 会 throw `TypeError: Cannot read properties of undefined`，被 `ipcMain.handle` 转化为一个不带 context 的 IPC error 返回到 renderer，renderer 的 catch 只有 `console.error` + alert，用户看到"暂未支持"的误导信息（meeting-room.js:915 的兜底 alert）。

**触发场景**: `watcher.wait()` 因内部 bug 意外 reject；或 `patchTurnResult` 在 orchestrator 状态被破坏后抛错。

**建议修法**: 在 `ipcMain.handle('roundtable-resend-participant')` 顶层加 try-catch：
```js
ipcMain.handle('roundtable-resend-participant', async (_e, args) => {
  try {
    return await _doResend(args);
  } catch (e) {
    console.error('[resend] unexpected top-level error:', e);
    return { ok: false, reason: 'internal_error', detail: e.message };
  }
});
```

---

### P1-4 | `ClaudeTap._scheduleIdleEmit` 的 idle timer 在 stop hook 取消后，若 `readLastAssistantMessageFromClaudeTranscript` 返回的 text 与上一 stop hook 的结果相同，`turn-complete` 静默不发

**文件**: `C:\Users\lintian\claude-session-hub\core\transcript-tap.js:280-302`

```js
entry._idleTimer = setTimeout(async () => {
  entry._idleTimer = null;
  if (!entry.transcriptPath) return;
  try {
    const text = await readLastAssistantMessageFromClaudeTranscript(entry.transcriptPath);
    if (!text || !text.trim()) return;
    if (text === entry.lastText) return; // 已 emit 过相同内容
    entry.lastText = text;
    this.emit('turn-complete', { ... });
  } catch (e) {
    console.warn('[claude-tap] idle-emit read failed:', e.message);
  }
}, _CLAUDE_IDLE_EMIT_MS);
```

**问题描述**: stop hook 取消 idle timer 后读 transcript 尾部，`entry.lastText` 已更新为本轮文本。如果 CLI 立即开始下一轮（用户快速连续提问）并在 5s 内完成，新 idle timer 触发时读到的仍是同一段 text，`text === entry.lastText` 判断为真，**emit 静默跳过**，导致第二轮圆桌卡片永远不更新。本质上是防重复去重逻辑在快速连续轮次时产生误判，因为 `entry.lastText` 没有在每轮开始时清零。

**触发场景**: 用户在第一轮回答完成后，在约 5s 内立即发送内容完全相同的第二轮提问（例如同一个股票问题重问），且两轮回答都命中同一 `readLastAssistantMessageFromClaudeTranscript` 结果。

**建议修法**: 在每轮 beginTurn 或 `_rtWaitTurnComplete` 开始时，调 `transcriptTap._claude.clearLastText(hubSessionId)`（需新增此方法），让防重复机制按轮复位：
```js
clearLastText(hubSessionId) {
  const e = this._bound.get(hubSessionId);
  if (e) e.lastText = null;
}
```

---

### P1-5 | `cacheAccountUsage` / `cacheAgentUsage` 空 catch 吞掉写盘失败，用量数据静默丢失

**文件**: `C:\Users\lintian\claude-session-hub\main.js:2634-2647` 和 `main.js:2650-2657`

```js
function cacheAccountUsage(data) {
  try {
    // ...fs.writeFileSync
  } catch {}  // <--- 完全静默
}

function cacheAgentUsage(provider, tokenData) {
  try {
    // ...fs.writeFileSync
  } catch {}  // <--- 完全静默
}
```

**问题描述**: 用量缓存写入失败（磁盘满、目录权限、Hub Data Dir 隔离路径不存在）完全被吞掉。下次 Hub 重启时 `loadUsageCache()` 拿到空对象，UI 上"Usage 5h / 7d"计量数据重置为零，用户误以为用量刷新了。长期静默会导致用户反复遭遇"配额超了但 UI 没提示"的困境。

**触发场景**: Hub Data Dir 磁盘空间不足；测试隔离实例 `CLAUDE_HUB_DATA_DIR` 指向的目录被清理后目录不存在。

**建议修法**:
```js
} catch (e) {
  console.warn('[usage-cache] write failed:', e.message);
}
```

---

### P1-6 | `roundtable-orchestrator.js` 中 `_saveState()` / `_saveTurnFile()` 在 `completeTurn` 中无 try-catch，持久化失败直接向上 throw，导致 `dispatchRoundtableTurn` 的 finally 执行但 turnRecord 未落盘，下次重启轮次历史丢失

**文件**: `C:\Users\lintian\claude-session-hub\core\roundtable-orchestrator.js:410-411`

```js
completeTurn(turnNum, mode, ...) {
  // ...
  this._saveState();       // fs.writeFileSync，无 try-catch
  this._saveTurnFile(record);  // fs.writeFileSync，无 try-catch
  return record;
}
```

**问题描述**: `_saveState` 和 `_saveTurnFile` 直接调用 `fs.writeFileSync`，无任何异常处理。若 `arena-prompts` 目录满盘或权限问题，writeFileSync 抛错，异常向上 propagate 到 `dispatchRoundtableTurn`，被 `try {...} finally { _roundtableInProgress.delete(meetingId); }` 的 `finally` 捕获后清锁，但**不会被记录**（`roundtable:turn` IPC handler 只在 Promise 层面抛，renderer 收到 rejection 且只打 `console.error`）。用户看到圆桌 IPC 失败，但日志里完全没有"磁盘写入失败"的提示，只有一行 `turn IPC failed: undefined` 之类的内容。

**触发场景**: Hub Data Dir 磁盘满；arena-prompts 目录权限被其他进程锁（Windows 文件系统 bug）。

**建议修法**:
```js
try { this._saveState(); } catch (e) {
  console.error('[orchestrator] _saveState failed:', e.message);
  // 可接受降级：内存 state 仍然正确，仅持久化失败
}
try { this._saveTurnFile(record); } catch (e) {
  console.error('[orchestrator] _saveTurnFile failed:', e.message);
}
```

---

## P2 级（防御性建议，无明显现象但应该加）

---

### P2-1 | `renderer/meeting-room.js` 中 `triggerRoundtable` 的 `ipcRenderer.invoke('roundtable:turn')` 在 `.then()` 回调内的 `alert()` 阻塞事件循环，`clearOptimistic` 可能在 alert dismiss 后过晚执行

**文件**: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js:1099-1117`

```js
ipcRenderer.invoke('roundtable:turn', { ... }).then((result) => {
  clearOptimistic();
  if (result && result.status === 'busy') {
    // ...
    alert('上一轮圆桌还在等...');  // 阻塞直到用户点 OK
  }
}).catch((e) => {
  console.error('[roundtable] turn IPC failed:', e.message);
  clearOptimistic();
});
```

**问题描述**: 如果 `result.status === 'busy'`，`clearOptimistic()` 在 `alert()` 之前调用（这里顺序是对的），但 `alert()` 阻塞同步事件循环，期间 `ipcRenderer.on('roundtable-partial-update')` / `roundtable-turn-complete` 等 IPC 事件会积压在队列。alert dismiss 后，所有积压事件会立即批量处理，可能导致 UI 状态短暂错乱（多次 refresh 连发）。这不是"静默失败"而是"延迟爆发"模式。

**建议修法**: 用 `console.warn` + 在 `mr-rt-soft-alert-banner` 显示提示代替 `alert()`，或者把 `clearOptimistic()` 移到 alert 之后。

---

### P2-2 | `JsonlTail._drain` 中 `this._reading` 互斥锁在 `finally` 里重置，若 `fh.close()` 抛错，`_reading` 永远为 true，该 tail 后续所有 drain 都被跳过

**文件**: `C:\Users\lintian\claude-session-hub\core\transcript-tap.js:71-100`

```js
async _drain() {
  if (this._closed || this._reading) return;
  this._reading = true;
  try {
    // ...读文件
    const fh = await fs.promises.open(this._filepath, 'r');
    try {
      // ...
    } finally {
      await fh.close();  // 若此处抛错，进入外层 catch，_reading 仍然 true
    }
  } catch {
    // Transient IO errors — next tick will retry.
  } finally {
    this._reading = false;  // 这里正确
  }
}
```

实际上此处 `_reading = false` 在 `finally` 里，所以正常情况是对的。但注意：`fh.close()` 抛错时：
1. 内层 try-finally 完成（close 抛了但 finally 还是执行？不，`await fh.close()` 抛错后跳到外层 catch）。
2. 外层 catch `{}` 吞掉了 close 的错误。
3. 外层 finally `this._reading = false` 正常执行。

所以此条路径实际上是安全的，标记为 P2 注意事项：`fh.close()` 失败被完全静默，会导致文件句柄泄漏（`fh` 未关闭）。Windows 上文件句柄不释放会阻止后续 `fs.watch` 事件。

**建议修法**:
```js
} finally {
  try { await fh.close(); } catch (e) {
    console.warn('[jsonl-tail] fh.close failed:', this._filepath, e.message);
  }
}
```

---

### P2-3 | `renderer/renderer.js` 启动时 `get-hub-config-raw` / `get-usage-cache` invoke 的 `.catch(() => {})` 吞掉失败，首屏用量数据静默不渲染

**文件**: `C:\Users\lintian\claude-session-hub\renderer\renderer.js:3828` 和 `3843`

```js
ipcRenderer.invoke('get-hub-config-raw').then(...).catch(() => {});
ipcRenderer.invoke('get-usage-cache').then(...).catch(() => {});
```

**问题描述**: 两个启动 IPC 的 `.catch(() => {})` 完全静默吞掉失败。若 IPC handler 未注册（main.js 崩溃后 handler 不可用）或抛错，UI 上 Usage Badge 和 Codex 模式徽章静默保持默认值，用户无法感知主进程端有异常。虽然这对功能影响有限（降级显示默认值），但对调试主进程启动失败毫无帮助。

**建议修法**:
```js
.catch((e) => { console.warn('[renderer] startup IPC failed:', e.message); });
```

---

## 统计

| 严重度 | 数量 |
|--------|------|
| P0     | 4    |
| P1     | 6    |
| P2     | 3    |
| **合计** | **13** |

**已豁免的合理 suppression（未列入）**:
- `main.js:161` — `.claude.json` 首次启动不存在，跳过是合理的
- `main.js:296` — `fh.close()` 在 `readLastUserMessage` 的 finally 里，close 失败不影响主路径
- `transcript-tap.js:53` — `JsonlTail.start()` 中首次 drain 失败（文件尚未创建）跳过是合理的
- `transcript-tap.js:59-60` — `fs.watch` 在网络驱动失败 + 降级轮询，有明确 fallback

---

## 新发现：是否解释了"用户报过但根因未找到"的问题

**可能解释：圆桌"第二轮提问后卡片不更新"（相同内容连问）**

P1-4 描述的场景（ClaudeTap idle-timer 去重误判）可能正是用户反馈"同一个问题连问两次，第二轮卡片没刷新"的根因。当前防重复逻辑 `if (text === entry.lastText) return` 使用的是**文本内容相等**作为判断条件，但未按轮次区分。若 AI 对相同问题产生完全相同的回答（常见于简单确认类问题），idle-timer 会误判为"重复，已 emit"而跳过。

**可能解释：圆桌 IPC `roundtable:turn` 偶尔 renderer 端收到"上一轮还在跑"但实际圆桌已空闲**

P0-4 描述的 `Promise.all` + orchestrator 状态机未 rollback 场景，可能正是用户报告"再发一轮说'上一轮还在等'但明明没人在答"的根因。`_roundtableInProgress` 在 `Promise.all` 抛错后虽然由 finally 清除，但若 `beginTurn` 已执行而 `rollbackTurn` 未被调用，orchestrator 内的 `currentMode` 仍是非 idle 状态（持久化到 roundtable-state.json），重启后恢复时读到错误 currentMode，让所有后续 `getOrchestrator().getState()` 返回"还在轮次中"。
