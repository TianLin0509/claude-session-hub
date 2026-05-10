# 圆桌 Resend & Auto-Recovery 设计

**日期**：2026-05-03
**作者**：道雪 + Claude Opus
**状态**：spec 已审批 — 转 plan

## 背景

圆桌运转中两个偶现 bug 反复影响体验，目前都靠手动兜底（一键提取）救回，但能自动救的应该自动救。

### Bug 1：卡片只取首句

**症状**：子 session 实际给出完整答案（PTY/JSONL 里有），但圆桌卡片只显示第一句。

**根因**：Claude 答案分两条 assistant message——M1（短）含 `stop_reason=end_turn`、M2（长）才是真答案。M1 在 JsonlTail 触发 200ms 防抖 emit `turn-complete` → watcher settle → M2 到达时 listener 已被释放。

**现状兜底**：用户手动按 `[一键提取]`，调 `extractLatestTurn` 直读 transcript 末尾 → patchTurnResult。能救，但需要用户主动出手。

### Bug 2：发送失败

**症状**：圆桌发起一轮后某家 sub 没动静，进 shell 看 PTY 发现 prompt 卡在输入框（`\r` 没生效），或 PTY 完全空（prompt 根本没写进去）。

**根因**：`writeToSession(sid, prompt)` 完成后的 `\r` 偶发被吞——CLI 在 paste-state-machine、tool 调用占着 stdin、PTY 退化成宿主 shell 等。`roundtable-watcher.dispatchPromptToSub` 现有 verify 失败分支只 `console.warn`，等 5min hard timeout。

**现状兜底**：无。用户只能进 shell 手动按 Enter / 重发。

## 目标

1. **Bug 1 自动恢复**：watcher settle 后保留 tap listener 300s（5 分钟），新 emit 到达时自动调 `patchTurnResult` 升级卡片，零交互。
2. **Bug 2 自动恢复**：dispatch verify 失败时根据 `echoSeen` 标志位自动重试一次。
3. **Bug 2 手动兜底**：卡片逃生栏新增 `[📤 发送]` 按钮，复用与自动恢复同一底层函数。
4. **send_stuck 视觉提示**：自动恢复失败的 sub 立即出红边 + 按钮闪烁，让用户感知系统救不回来了。

## 非目标

- 不重做 dispatch 的 fast-path/echo settle 逻辑（已锁单测，沿用）。
- 不重写"重新拉起"按钮（仍是 stub，跟本设计无关）。
- 不引入新的"全 meeting 一键发送"按钮——单家粒度足够，省去 prompt+prompt 污染风险。

## 设计

### 模块 A — Bug 1 自动恢复（patch-after-settle）

**改动点**：`core/turn-completion-watcher.js`

现状：`settle()` 一旦调用就 `_cleanup()`——移除 `transcriptTap.on('turn-complete')` 监听。

新增：settle 后**不立即 cleanup**，而是把 listener 改挂到"patch 模式"再保留 **300s（5 分钟）**。期间收到新 `turn-complete` 事件且满足以下条件 → 触发 onTurnPatched 回调：

1. 新 text 与 settle 时的 text 不同
2. 新 text 长度 > settle 时 text 长度（避免短答案覆盖长答案的回退场景）
3. signalSource 是 `stop_reason_terminal` 或 `stop_hook`（idle 兜底信号不参与，避免误触）
4. 当前轮的 byStatus[sid] **不是** `manual_extracted`（防护 #2：用户已手动救过，不要覆盖状态）—— text 仍可补全，但 status 保持 manual_extracted 不动

伪代码：

```js
const PATCH_WINDOW_MS = 300_000;  // 5 分钟（原 60s 太短，AI 慢思考可达数分钟）

const settle = (result) => {
  if (settled) return;
  settled = true;
  settledText = result.text;
  // 不再 _cleanup()，改启动 300s patch window
  patchWindowTimer = setTimeout(() => {
    if (onTurnComplete) transcriptTap.removeListener('turn-complete', onTurnComplete);
    onTurnComplete = null;
  }, PATCH_WINDOW_MS);
  if (onTurnComplete) {
    // 替换为 patch handler
    transcriptTap.removeListener('turn-complete', onTurnComplete);
    onTurnComplete = (evt) => {
      if (evt.hubSessionId !== hubSessionId) return;
      if (evt.signalSource !== 'stop_reason_terminal' && evt.signalSource !== 'stop_hook') return;
      if (evt.text === settledText) return;
      if (evt.text.length <= settledText.length) return;
      onTurnPatched({ sid: hubSessionId, label, text: evt.text, status: 'completed' });
      settledText = evt.text; // 更新基线，可能还有 M3
    };
    transcriptTap.on('turn-complete', onTurnComplete);
  }
  // 调用方拿到 settle 结果
  resolveSettle(result);
};
```

**防护 #1：跨轮污染（核心）**

300s 窗口内同一 sub 可能开了下一轮。下一轮的 emit 也会带相同 hubSessionId，老 listener 会误捕获并把新轮答案 patch 到老轮卡片上。

修复：**新一轮 dispatch 该 sub 时，强制清掉它身上的所有老 patch listener**。

实现入口：`roundtable-watcher.dispatchPromptToSub` 调用前，main.js 注册一个 `cancelPatchListenersForSid(sid)` helper，由 watcher 模块通过依赖注入调用。

```js
// main.js 全局 patch-listener 注册表（per-sid）
const _patchListeners = new Map(); // sid → Set<{cleanup}>

function registerPatchListener(sid, watcher) {
  if (!_patchListeners.has(sid)) _patchListeners.set(sid, new Set());
  _patchListeners.get(sid).add(watcher);
}
function cancelPatchListenersForSid(sid) {
  const set = _patchListeners.get(sid);
  if (!set) return;
  for (const w of set) w.cancelPatch?.();  // watcher 暴露 cancelPatch 方法
  set.clear();
}
```

dispatchPromptToSub 入口处先 `cancelPatchListenersForSid(sid)`——保证一个 sub 永远只有最新一轮的 listener 在监听。

**防护 #2：不覆盖 manual_extracted 状态**

main.js 注入 onTurnPatched 回调里：

```js
const onTurnPatched = ({ sid, text, status }) => {
  const turn = orchestrator.getTurn(turnNum);
  if (!turn) return;
  const currentStatus = turn.byStatus?.[sid];
  // 用户已手动提取过 → 只补 text 不改 status
  const finalStatus = (currentStatus === 'manual_extracted') ? 'manual_extracted' : status;
  orchestrator.patchTurnResult(turnNum, sid, { text, status: finalStatus });
  sendToRenderer('roundtable-turn-patched', { meetingId, turnNum, sid, charCount: text.length });
};
```

**EventEmitter maxListeners**：`transcriptTap.setMaxListeners(100)` 防止 300s 窗口下并发 listener 触发 Node warning。

**main.js 接通**：`startTurnCompletionWatcher` 注入 `onTurnPatched` 回调 → 调 `orchestrator.patchTurnResult` → `sendToRenderer('roundtable-turn-patched', ...)`。

**renderer**：`ipcRenderer.on('roundtable-turn-patched', ...)` 内查到对应卡片，重渲染 + 右上角短暂显示 `自动补全 +N 字` 角标，3 秒后消失。

### 模块 B — Bug 2 自动恢复 + 手动按钮

#### B-1：dispatchPromptToSub 扩展（自动恢复）

**改动点**：`core/roundtable-watcher.js`

现状（line 141-146）：

```js
await new Promise(r => setTimeout(r, POST_ENTER_VERIFY_MS));
const afterEnter = sessionManager.getRoundtableLastActivity(sid);
if (afterEnter === lastSeen) {
  console.warn(`[roundtable] post-Enter still zero-echo for ${kind}(${sid.slice(0, 8)}) ...`);
}
return true;
```

改为：verify 失败时根据 `echoSeen` 分支自动重试**一次**：

```js
if (afterEnter === lastSeen) {
  // 自动恢复：依赖 echoSeen 物理信号（无需任何字符串匹配/魔数）
  const recovered = await _autoRecoverSend({
    sessionManager, sid, kind, prompt,
    echoSeen,
    timing: { ENTER_RETRY_GAP_MS, POST_ENTER_VERIFY_MS },
  });
  if (!recovered) {
    // 升级 send_stuck — 通知 UI（main.js 监听后 sendToRenderer）
    onSendStuck?.({ sid, kind, mode: echoSeen ? 'enter_only' : 'rewrite_full' });
  }
}
return true;
```

`_autoRecoverSend` 内部：

```js
async function _autoRecoverSend({ sessionManager, sid, kind, prompt, echoSeen, timing }) {
  const before = sessionManager.getRoundtableLastActivity(sid);
  if (echoSeen) {
    sessionManager.writeToSession(sid, '\r');
  } else {
    sessionManager.writeToSession(sid, prompt);
    await new Promise(r => setTimeout(r, timing.ENTER_RETRY_GAP_MS));
    sessionManager.writeToSession(sid, '\r');
  }
  await new Promise(r => setTimeout(r, timing.POST_ENTER_VERIFY_MS));
  const after = sessionManager.getRoundtableLastActivity(sid);
  return after !== before;
}
```

**关键**：`echoSeen` 是 dispatchPromptToSub 已有的物理标志位（`lastSeen !== beforeWrite`），不引入新检测路径。

#### B-2：手动 `[📤 发送]` 按钮

**触发链**：

```
卡片 [📤 发送] click
  → IPC roundtable-resend-prompt { meetingId, sid }
  → main: resendCurrentPrompt(meetingId, sid)
      ├ 取 turn.promptBy[sid] / turn.promptHeaderBy[sid]
      ├ inspect ring buffer tail 是否含 promptHeaderBy[sid]
      │   含 → writeToSession('\r')                    mode=enter_only
      │   不含 → writeToSession(prompt) + 等 echo + writeToSession('\r')   mode=rewrite_full
      ├ 等 500ms verify
      └ 返回 { ok, mode, reason? }
  → renderer 反馈：按钮短暂变绿 ✓ 已重发
```

**指纹设计（解耦关键）**：

`turn.promptHeaderBy[sid]` 在 dispatchRoundtableTurn 入口处由 `prompt.split('\n')[0]` 切出，**不硬编码任何 pattern**。无论将来 prompt 头格式怎么改（`[scene · 第 N 轮 · mode]` → `## 第 N 轮 (mode)` → 别的），指纹自动跟着 prompt 实际内容走。

**前提锁单测**：`build*Prompt` 三函数输出第一行必须非空且包含轮次唯一信息（轮号 N）。如果将来违反这个前提，CI 立即报警提示同步更新文档。

#### B-3：数据持久化（state.turns 新字段）

```js
turn.promptBy        = { sid: '完整 prompt 文本' }  // resend rewrite 模式用
turn.promptHeaderBy  = { sid: 'prompt 第一行' }      // ring buffer 指纹检测
turn.sendStatus      = { sid: 'ok' | 'auto_recovered' | 'stuck' }  // 调试 + UI
```

**节流策略（B 选项）**：`promptBy` 仅保留**当前未 settle**的 turn。turn settle 进入 history 时（completed/skipped/errored 全部到位）→ `delete turn.promptBy`，但 `promptHeaderBy` 与 `sendStatus` 长存（小，调试有用）。

**底层入口**：在 `orchestrator.completeTurn` / `skipTurn` 内联清理。

### 模块 C — UI 反馈

#### `[📤 发送]` 按钮位置

`renderer/meeting-room.js` 卡片逃生栏（line 670-675）：

```html
<div class="mr-ft-escape-bar">
  <button data-rt-escape="extract" ...>一键提取</button>
  <button data-rt-escape="skip" ...>跳过</button>
  <button data-rt-escape="resend-prompt" ...>📤 发送</button>   <!-- 新增 -->
  ${relaunchBtn}
</div>
```

click handler 加 `action === 'resend-prompt'` 分支，与 extract 同样的 disabled+spinner+绿色反馈样式。

#### send_stuck 视觉（A 选项 — 强提示）

- 卡片左侧加红色 4px 实线边
- `[📤 发送]` 按钮黄底（`#ffc107`）+ 1Hz CSS keyframes 闪烁
- 状态条文案："⚠ 发送卡住，请按发送"

CSS：

```css
.mr-ft.send-stuck {
  border-left: 4px solid #f85149;
}
.mr-ft.send-stuck button[data-rt-escape="resend-prompt"] {
  background: #ffc107;
  color: #000;
  animation: send-stuck-blink 1s ease-in-out infinite;
}
@keyframes send-stuck-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

#### auto_patched 反馈

卡片右上角短暂浮 `自动补全 +N 字` 角标，3 秒后 fade-out 消失。不留长期角标（避免污染最终视图）。

### IPC 协议

```ts
// renderer → main
'roundtable-resend-prompt' { meetingId: string, sid: string }
  → { ok: boolean, mode?: 'enter_only' | 'rewrite_full', reason?: string }

// main → renderer (push)
'roundtable-send-stuck'   { meetingId: string, sid: string, mode: 'enter_only' | 'rewrite_full' }
'roundtable-turn-patched' { meetingId: string, turnNum: number, sid: string, charCount: number }
```

## 关键不变量

| # | 不变量 | 保护机制 |
|---|---|---|
| 1 | 绝不重复发 prompt 导致 `prompt+prompt` 污染 | 自动路径走 echoSeen 物理信号；手动路径走 promptHeaderBy 指纹检测 |
| 2 | patch-after-settle 不破坏 turn meta 的其他字段 | `patchTurnResult` 单测已锁 by[sid]/byStatus[sid]/thinkSec/tokens 之外不动 |
| 3 | listener 60s 后必清，不泄漏 | `setTimeout(() => removeListener)` 兜底 + watcher 退出时强制 cleanup |
| 4 | promptBy 仅活跃轮，不撑爆 state.json | completeTurn/skipTurn 入口 delete |
| 5 | 指纹随 prompt 自动演化 | promptHeaderBy 从 prompt.split('\n')[0] 切，不硬编码 |
| 6 | build*Prompt 第一行格式漂移会被发现 | 单测锁第一行非空 + 含轮号 |

## 改动清单（surgical）

| 文件 | 类型 | 改动 |
|---|---|---|
| `core/transcript-tap.js` | 不改 | emit 行为已定 |
| `core/turn-completion-watcher.js` | 改 | settle 后保留 listener 60s；新 emit 调 onTurnPatched |
| `core/roundtable-orchestrator.js` | 改 | dispatch 入口落 promptBy/promptHeaderBy；completeTurn/skipTurn 清 promptBy |
| `core/roundtable-watcher.js` | 改 | dispatchPromptToSub 加 verify 失败后 _autoRecoverSend；onSendStuck 回调；新增 resendCurrentPrompt 函数 |
| `main.js` | 改 | IPC `roundtable-resend-prompt` 接 resendCurrentPrompt；onSendStuck/onTurnPatched 推 renderer |
| `renderer/meeting-room.js` | 改 | 卡片逃生栏加 `[📤 发送]` + click handler；监听 `roundtable-send-stuck`/`roundtable-turn-patched` 事件 |
| `renderer/meeting-room.css` | 改 | `.mr-ft.send-stuck` 红边 + 按钮闪烁 keyframes |
| `tests/unit-orchestrator-patch-turn.test.js` | 改 | 加 promptBy 清理测试 |
| `tests/unit-roundtable-resend-prompt.test.js` | 新增 | 锁 echoSeen 分支 + 指纹切片 + send_stuck 状态机 |
| `tests/unit-roundtable-prompt-format-contract.test.js` | 新增 | 锁 build*Prompt 第一行非空+含轮号 |
| `tests/_e2e-resend-verify.js` | 新增 | 隔离 hub CDP E2E（自动恢复 + 手动按钮 + send_stuck UI） |

## 测试矩阵

### 单元

1. **patchTurnResult 300s 窗口**：mock transcriptTap 先 emit M1 → settle → 60s 后 emit M2（更长）→ assert onTurnPatched 被调；310s 后 emit M3 → assert listener 已 removed，无回调（用 fake timer 加速）。
1a. **跨轮污染防护**：mock 同一 sid 的 turn 1 settle → 30s 后 turn 2 dispatch（触发 cancelPatchListenersForSid）→ turn 2 emit → assert turn 1 的 onTurnPatched 不被调（老 listener 已被 cancel）。
1b. **manual_extracted 不被覆盖**：mock turn 1 settle → 用户调 manual extract（byStatus → manual_extracted）→ patch listener 触发 → assert text 被更新但 status 仍为 manual_extracted。
2. **echoSeen 分支决策**：mock writeToSession+getRoundtableLastActivity，分别构造 echoSeen=true/false 场景，assert _autoRecoverSend 写入 `\r` vs `prompt+\r` 的次数与时序。
3. **promptHeaderBy 切片**：assert turn 落入 state 时 promptHeaderBy[sid] === prompt.split('\n')[0]，且 promptBy[sid] === prompt 完整文本。
4. **promptBy 节流**：completeTurn/skipTurn 后 assert turn.promptBy 被 delete，promptHeaderBy 仍在。
5. **build*Prompt 格式契约**：assert fanout/debate/summary 三个 build 函数第一行非空 + 包含 `第 N 轮` 字样。

### 隔离 hub E2E（`_e2e-resend-verify.js`）

1. **场景 A：prompt 在输入框但 \r 丢**
   - mock 一次 `\r` no-op → 触发 verify 失败 → 自动恢复 enter_only → 卡片**不进** send_stuck
   - assert onSendStuck 回调未触发
2. **场景 B：prompt 完全没进 PTY**
   - mock writeToSession no-op → 触发 verify 失败 → 自动恢复 rewrite_full → 成功
3. **场景 C：自动恢复也失败 → send_stuck**
   - mock 全部 no-op → assert renderer 收到 `roundtable-send-stuck` → 卡片有 `.send-stuck` 类 → 按钮有 keyframes 动画
4. **场景 D：手动 [📤 发送] 真打**
   - 真实 3 claude 圆桌，发起一轮，等 settle 后点 `[📤 发送]` → assert IPC 返回 mode=enter_only / rewrite_full → 按钮短暂变绿
5. **场景 E：60s patch 窗口**
   - 真实 Claude turn 触发 M1+M2 序列（构造长任务让 stop_reason 二次出现）→ assert 卡片先显 M1 文本 → 几秒内自动升级到 M2 → 右上角浮 `自动补全 +N 字` 3s 后消失

## 部署 & 兼容

- 老 turn meta 没有 promptBy/promptHeaderBy/sendStatus → 默默兼容（按钮 disabled + 灰色 tooltip "本轮没有 prompt 记录，请发起新轮"）。
- IPC 新增不破坏老 IPC，纯加法。
- state.json schema 增字段不增层级，向前兼容。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 300s patch 窗口期内同一 sub 开了下一轮 → 老 listener 误捕获新轮 emit 把新轮答案 patch 到老轮卡片 | 卡片污染（老轮显示新轮内容）| 防护 #1：dispatchPromptToSub 入口处 `cancelPatchListenersForSid(sid)` 强制清掉这家身上的老 listener |
| 用户在窗口内已手动按了一键提取，自动 patch 又把状态从 manual_extracted 改成 completed | 丢失"用户帮过手"的信号 | 防护 #2：onTurnPatched 回调里 if (currentStatus === 'manual_extracted') 仅补 text 保持 status 不变 |
| EventEmitter maxListeners 默认 10，300s 窗口下并发 listener 可能触发 Node warning | 控制台噪音 | `transcriptTap.setMaxListeners(100)` |
| `_autoRecoverSend` 误判：prompt 实际进了但 PTY echo 太晚 → 重写 prompt 污染 | 罕见，但发生即提交错乱 | echoSeen 是基于 `FAST_PATH_QUIET_MS` (默认 200ms) 后的 quiet 信号，已经是非常保守的"echo 已稳定"判定；同时 _autoRecoverSend 的 verify 仍用同一物理信号，二次验证 |
| 手动按钮在历史轮可点 → resend 老轮的 prompt 给已 settle 的 sub | CLI 可能错乱 | 双重防护：(1) renderer 端按钮在 turn !== activeTurn 时 hidden；(2) 后端 resendCurrentPrompt 入口检查 turn.promptBy[sid] 存在（promptBy 在 turn settle 时已被节流删除），不存在则返回 `{ ok: false, reason: 'no_active_prompt' }` |
| build*Prompt 格式漂移没人发现 | 手动按钮静默失效 | 新增格式契约单测，CI 阻拦 |

## 开放问题（spec 评审时确认）

无——所有设计点已经过 brainstorming 逐节确认。

---

**变更日志**

- 2026-05-03：初稿（道雪 brainstorming + Claude Opus 整合）
- 2026-05-03：审批后修订 — patch 窗口 60s → 300s；新增防护 #1（跨轮污染：dispatch 入口清老 listener）+ 防护 #2（不覆盖 manual_extracted）+ EventEmitter maxListeners 提升
