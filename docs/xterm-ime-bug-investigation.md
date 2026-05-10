# xterm 中文输入卡死调查

> 调查日期：2026-05-02 / 只读静态分析（**未启动 Hub、未实测**）
> 任务：定位"圆桌操作之后切回普通 session、xterm 输入框中文打不进 / 数字勉强行"的根因。
> 仓库：`C:\Users\lintian\claude-session-hub`

---

## 症状摘要（含关键线索的解读）

用户报告：
1. Hub 同时开了 1 个普通 Claude session（xterm 终端）+ 1 个圆桌
2. 在圆桌里**操作过**（具体不清楚——可能输入过中文 / 切过焦点 / 关过卡片）
3. 切回普通 session，**输入框无法正常输入中文**
4. **数字 "123" 勉强能进**
5. **状态相关**：开 Hub 直接进普通 session 没问题，只在某次圆桌操作后出现

### 关键线索的技术解读

> "数字勉强行 + 中文打不进 = 焦点跑偏到非 xterm 的可见 input 元素 + IME composition 链路被某个状态卡住"

xterm.js 的 IME 路径：
- xterm 内部维护一个 `<textarea>`（class `xterm-helper-textarea`），位置 absolute、零宽、几乎不可见但可接收键盘事件
- 用户键盘 → helper textarea 触发 `compositionstart/update/end` + `input` → xterm 把 commit 后的字符串发给 PTY (`terminal.onData`)
- **数字/英文 ASCII 不走 IME，可以直接由普通 contenteditable / input 元素显示**（IME 框是空的，按数字键直接落字）
- **中文/日文必须经 IME composition session**——如果焦点在某个不正确的元素上，或某个 contenteditable 在 layout 出问题（display:none / 父节点移动 / textarea 被 detach 又 reattach），IME composition 会被静默丢

所以"数字勉强行 + 中文打不进"≈ **可见 contenteditable 抢到了焦点 + 它的 keydown handler 把 IME Enter 当作"发送"导致每次按 Enter 选词都被吞** 或 **xterm helper textarea 的 IME 状态被破坏后 composition 死锁**。

---

## 已读代码路径

| 文件:行号 | 一句话总结 |
|---|---|
| `renderer/renderer.js:780` `getOrCreateTerminal` | 创建 xterm Terminal + FitAddon + WebLinks，缓存到 `terminalCache`（单例 per sid）。包含 `attachCustomKeyEventHandler` (line 850)，仅拦截 Ctrl+V/Ctrl+C/Ctrl+方向，**没有 IME 处理**。|
| `renderer/renderer.js:1001` `showTerminal` | **line 1009 `terminalPanelEl.innerHTML = ''`** 清空 terminal-panel——这会**强行 detach 旧的 xterm helper textarea**。然后 line 1091-1093 用 `if (!termContainer.contains(cached.container)) appendChild` reparent。|
| `renderer/renderer.js:1086` | termContainer 点击 → `cached.terminal.focus()`，焦点回 xterm。|
| `renderer/renderer.js:1112` | `showTerminal` 末尾在 rAF 里调 `cached.terminal.focus()`，**只在 `opts.focus=true` 时**。selectSession 传 `{ focus: switching }`，**switching = activeSessionId !== id**，即重复点击同一个 sid 时不 focus。|
| `renderer/renderer.js:1166-1167` | `mountFloatingInput` —— 每次 showTerminal 都 dispose 旧 floating input 后重新挂一个新的。|
| `renderer/renderer.js:1451-1506` `mountFloatingInput` | **创建一个 contenteditable div `.floating-input-box`**，挂在 `.terminal-panel` 上（line 1469）。**这个就是用户视觉上能看到的"输入框"。**|
| `renderer/renderer.js:1481-1491` 🔥 | **floating input 的 keydown handler 没有 `isComposing` / `keyCode === 229` 守卫**：用户输中文按 Enter 选 IME 候选词时，被 `e.preventDefault() + sendInput()` 拦截，把"半成品中文"发去 PTY + 清空 textbox。|
| `renderer/renderer.js:1589-1625` `selectSession` | 切换会话入口。**line 1592-1593 `mrp.style.display = 'none'`——只是隐藏圆桌 panel，不调 `closeMeetingPanel`**。|
| `renderer/renderer.js:3006-3101` | document-level keydown capture，仅 Ctrl/Meta 组合键，line 3007 提前 return，**对纯中文输入无影响**。|
| `renderer/meeting-room.js:127` `index.html` | 圆桌输入框 `#mr-input-box` 是**静态全局 DOM**（不是动态创建/销毁），是 contenteditable。|
| `renderer/meeting-room.js:2428-2530` `setupInput` | 圆桌输入框首次绑定 keydown。**line 2501-2512 已加 `isComposing` 守卫（commit 7eafbae）**。模块级 `_inputBound = true`，绑定一次永不解绑。|
| `renderer/meeting-room.js:1292-1297` | `openMeeting` 末尾用 `setTimeout 50ms` 主动 `inputBox.focus()` 抢焦点到圆桌输入框。|
| `renderer/meeting-room.js:1300-1319` `closeMeetingPanel` | 关闭圆桌 panel（**仅在用户点关闭按钮 / `meeting-closed` IPC 时调用**，普通切换不调）。|
| `renderer/meeting-room.js:1810` `mountSubTerminal` | **已是 no-op**（commit 45349cf 删了圆桌内部 xterm，改为子 session 主区路径）。|
| `renderer/meeting-room.js:1837-1900` `robustFit` | commit 18d0f6b 修复后，rAF 等容器有 layout 才 fit + `term.refresh(0, rows-1)` 强制重绘。**但只在 `mountSubTerminal/switchFocusTab/renderFocusMode` 调用**——普通 session 走 `renderer.js` 自己的 `fitAddon.fit()`，不走 robustFit。|
| `main.js:1992-2018` (commit 18d0f6b) | `terminal-resize` IPC 加了去重 cache。跟 IME 无关（只影响 SIGWINCH）。|
| `main.js:417-423` `webPreferences` | `nodeIntegration: true, contextIsolation: false, sandbox: false, webviewTag: true`。**没有禁用 spellcheck，也没改 IME 配置**。|

### 全局搜索的关键阴性结果

```
Grep "compositionstart|compositionend|compositionupdate" → No matches
```

**整个仓库没有一处 composition 事件监听**——意味着没有任何代码主动维护 IME composition 状态。任何 IME 卡死都是浏览器默认行为出问题。

---

## 假设列表（按信心度倒序）

### 假设 1 [HIGH] — floating input bar 的 keydown 没 isComposing 守卫，IME Enter 选词被吞

**位置**：`renderer/renderer.js:1481-1491`

```js
inputBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendInput();        // ← 立即把 inputBox.innerText 发去 PTY + 清空
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); terminal.focus(); }
});
```

**触发路径**：
1. 用户视线锁定的"输入框"是 `.floating-input-box`（位于 terminal-panel 底部，每次 showTerminal 重 mount）。它是 contenteditable。
2. 用户在它里面输中文，IME 框弹出候选词。
3. 用户按 Enter 选词 = IME 的 commit 动作。但 keydown handler 不区分 `e.isComposing === true` / `e.keyCode === 229`，**直接 `preventDefault() + sendInput()`**。
4. `sendInput`（line 1472-1479）取 `inputBox.innerText`——此时**候选词还没 commit 进 DOM**，所以拿到的可能是空字符串或半成品文本，被发去 PTY 然后 clear。
5. 用户感觉"我打了中文按 Enter，但中文没出来"——和 commit 7eafbae 修圆桌输入框的症状**完全一致**（圆桌的输入框已经在 commit 7eafbae 修过，但 floating input bar 是相同 bug 的姊妹品，**还没修**）。

**对"数字勉强行"的解释**：✅ **完美吻合**。
- 数字纯 ASCII，不走 IME，按下 1/2/3 直接 `keypress` → contenteditable 的默认行为落字。
- 用户继续按 Enter 才会触发 sendInput——但用户描述说"勉强能进"，意味着数字会显示在框里（DOM 里有），只是按 Enter 才会清空。这跟 line 1481-1491 的行为完全一致：**没按 Enter 时数字一直留在框里**，看上去"勉强能进"。
- 中文情况：每次按一个字 → IME 弹候选词 → 想选词必须按 Enter 或 Space → Enter 触发 sendInput 发送+清空 → **永远拼不出完整中文**。

**对"只是某次圆桌操作之后才出现"的解释**：⚠️ **不完全吻合**。
- 这个 bug 应该开 Hub 直接进普通 session 就能复现——除非用户没在 floating input 输入过中文（floating input 在 commit 45349cf 之前是新增的？需查）。
- **但有一个状态依赖路径**：圆桌 `openMeeting` line 1292-1297 主动 focus 圆桌输入框；用户切回普通 session 时焦点不一定还在 xterm helper textarea，可能仍在圆桌输入框（display:none 后焦点丢失，下次 click 任意 contenteditable 都可能抢焦点）。**Floating input bar 在 panel 底部很显眼，用户更可能点它**。

**用户可执行的验证步骤**：

```
用户：
1. 启动 Hub，开一个普通 Claude session，先不要开圆桌
2. F12 打开 DevTools → Console
3. 在终端区域底部找到"输入消息… Enter 发送, Shift+Enter 换行"那个浮动输入框（class=floating-input-box），点击进入它
4. 输入"你好"
5. 期待 Y：如果按 Enter 选词时"你好"被吞 / 半成品发出去 / 框被清空 → 说明 floating input bar IME 已坏（独立于圆桌）
6. Console 输入：
     document.querySelector('.floating-input-box').addEventListener('compositionstart', () => console.log('comp-start'));
     document.querySelector('.floating-input-box').addEventListener('compositionend', e => console.log('comp-end', JSON.stringify(e.data)));
   再输中文按 Enter，看是否打出 'comp-start' 但没有 'comp-end' —— 如果是，证实假设 1。
7. 然后关掉这个普通 session、再开圆桌 → 操作 → 切回新建一个普通 session → 重复步骤 4-6。
   - 如果在圆桌操作前后症状一致 → 证实假设 1 是固有 bug，不需要圆桌触发
   - 如果只在圆桌操作后才坏 → 排除假设 1，进入假设 2/3
```

---

### 假设 2 [HIGH] — 焦点丢失：圆桌切回普通 session 后焦点不在 xterm helper textarea

**位置**：`renderer/renderer.js:1589-1625` `selectSession` + `renderer/meeting-room.js:1292-1297` `openMeeting`

**触发路径**：
1. 用户进圆桌：`openMeeting` line 1292-1297 用 `setTimeout 50ms` 主动 `document.getElementById('mr-input-box').focus()`，焦点 → 圆桌 contenteditable。
2. 用户在圆桌做某些操作（如点过截断链接 → enter-shell → selectSession 子 sid）。
3. 用户从 sidebar 点"普通 session" → `selectSession(id)`：
   - line 1592-1593：`mrp.style.display = 'none'`（圆桌 panel 隐藏，**输入框被 hidden**）
   - 注意：**没有显式 blur**。Chromium 在 `display:none` 时确实会丢焦点，但**`document.activeElement` 会变成 `<body>`**。
4. line 1605：`switching = activeSessionId !== id`。**如果用户回的是同一个 activeSessionId 的普通 session（例如他切到圆桌之前活跃过这个 session，activeSessionId 没改），switching = false**。
5. line 1615：`showTerminal(id, { focus: false })`——**不 focus 终端！**
6. 此时 `document.activeElement === <body>`，键盘事件落到 body。
7. 用户开始打字：
   - **数字键**：body 不接收特殊处理，但用户可能下意识点了 floating input bar（屏幕底部最显眼），数字落在 floating input 里 → "勉强能进"
   - **中文**：Windows IME 在 `<body>` 焦点上不会启动 composition session（必须 input/textarea/contenteditable），所以 IME 候选窗根本不弹 → "中文打不进"

**对"数字勉强行"的解释**：✅ **吻合，但需要假设用户点了 floating input bar 后才打字**。
- 如果用户只在 xterm 区域打字，焦点是 body，那数字也打不进。
- 但人对"看不见的输入"会本能找一个能输入的可见框——floating input 是默认存在的，最容易点中。
- 数字落在 floating input → 有视觉反馈"勉强进了"；切到中文 → IME 候选词框弹了但按 Enter 选词被假设 1 的 bug 吞 → "中文打不进"。

**对"只是某次圆桌操作之后才出现"的解释**：✅ **吻合**。开 Hub 直接进普通 session 时，selectSession 是首次调用，switching = true → focus xterm → 一切正常。只有"圆桌切回（特别是 activeSessionId 没变的同一普通 session）"才会触发 switching=false → 不 focus → 焦点丢失。

**用户可执行的验证步骤**：

```
用户：
1. 启动 Hub，先开普通 session A，发一句话确保焦点稳定
2. F12 → Console，输入并保持监控：
     setInterval(() => console.log('focus:', document.activeElement?.className || document.activeElement?.tagName), 500);
3. 开圆桌、切到圆桌，看 Console：focus 应变成 mr-input-box
4. 从 sidebar 点普通 session A 切回
5. 期待 Y：focus 是否变成 'xterm-helper-textarea'（class）/ 'TEXTAREA'（tag），还是变成 'BODY'？
   - 如果是 BODY 或 floating-input-box → 证实假设 2，焦点确实丢失到 body / floating input
   - 如果是 xterm-helper-textarea → 排除假设 2，进入假设 3
6. 同时在 Console 输入：
     document.querySelector('.xterm-helper-textarea')?.focus();
   然后立刻试中文输入。如果一秒钟内 IME 恢复正常 → **金标准证实假设 2**。
```

---

### 假设 3 [MEDIUM] — xterm helper textarea 被 detach/reattach 后 IME composition 状态死锁

**位置**：`renderer/renderer.js:1009` (`terminalPanelEl.innerHTML = ''`) + `:1091-1093` (reparent)

**触发路径**：
1. 用户首次 selectSession 普通 session → `showTerminal` 创建 termContainer + `cached.container`（含 xterm helper textarea）→ append。
2. 用户切到圆桌 → `selectMeeting` → `terminalPanelEl.style.display = 'none'`（line 734）——**没动 cached.container**。
3. 用户切回同一普通 session → `selectSession` → `showTerminal`：
   - **line 1009 `terminalPanelEl.innerHTML = ''`**：terminalPanelEl 内部所有节点被销毁（旧 header + 旧 termContainer + cached.container 一并被 detach）
   - line 1011-1088：建新 header、新 termContainer
   - **line 1091-1093**：`!termContainer.contains(cached.container) → appendChild(cached.container)`。把 cached.container 从 detached 状态重新插入新树。
4. **detach + reattach 期间**，xterm 内部维护的 helper textarea 也跟着被 detach 又 reattach。Chromium 对一个 detach 时正处于 `compositionstart` 但还没 `compositionend` 的 textarea 有已知怪行为：
   - reattach 后 `isComposing` 标记可能残留 true，但 IME 内部 session 已死，新 composition 无法启动
   - 或 textarea 看似活但 IME 不再选它做输入目标
5. 数字（不需要 composition）继续可输入；中文（必须 composition）卡住。

**对"数字勉强行"的解释**：✅ **吻合**。数字不需要 composition，textarea 只要能接 keypress 就行；中文必须 composition session 健康。

**对"只是某次圆桌操作之后才出现"的解释**：✅ **吻合**。
- 圆桌 panel 用 `display: flex`（meeting-room.js:1250）覆盖在 terminal-panel 上方；切回时 selectSession 才**第一次**触发 `terminalPanelEl.innerHTML = ''`（如果用户切回同一个 session，cached.container 早就在 terminalPanelEl 树下，innerHTML='' 把它带飞）。
- 不开圆桌就不会有这种 detach/reattach 周期。

**对假设 1/2 的关系**：⚠️ 这是**底层 bug**，假设 1/2 是**上层症状或加剧器**。如果假设 3 成立，光修 floating input keydown / 焦点也不能根治。

**用户可执行的验证步骤**：

```
用户（必须实测，纯静态扫不出 Chromium textarea detach 行为）：
1. 启动 Hub，开普通 session A
2. F12 → Console:
     window.__taRef = document.querySelector('.xterm-helper-textarea');
     console.log('ta exists:', !!window.__taRef, 'parent:', window.__taRef?.parentElement?.className);
3. 开圆桌，切到圆桌
4. Console:
     console.log('after-rt: ta still in doc?', document.contains(window.__taRef), 'same?', window.__taRef === document.querySelector('.xterm-helper-textarea'));
5. 切回普通 session A
6. Console:
     const ta2 = document.querySelector('.xterm-helper-textarea');
     console.log('back: ta same?', window.__taRef === ta2, 'in doc?', document.contains(window.__taRef));
   - 如果 ta2 是新对象（!== __taRef）→ xterm 重新 open 过, 旧 ta 被销毁。问题是旧 IME session 是否被清掉
   - 如果 ta same 但 in-doc=false → detach 没有 reattach（bug 严重）
   - 如果都 same → reattach 成功，问题在状态而非引用
7. 直接对 ta2 试输入：
     ta2.focus();
     // 现在试着打中文
   - 如果中文恢复正常 → 是焦点问题（假设 2）
   - 如果中文仍卡 → 是 detach/reattach 后 textarea 自身坏了（证实假设 3）
```

---

### 假设 4 [LOW] — 圆桌输入框 `_inputBound` 永久 true + display:none 后未清焦点引用

**位置**：`renderer/meeting-room.js:2466-2467, 1300-1319`

**触发路径**：
1. 圆桌 setupInput 首次绑定 keydown 后 `_inputBound = true`。
2. selectSession 切回普通 session 不调 closeMeetingPanel → `_inputBound` 仍 true，圆桌 keydown handler 仍然挂在 `#mr-input-box` 上。
3. `#mr-input-box` 是静态全局 DOM，仅 panel display:none，**DOM 自身仍存在于 document.body**（被一个 display:none 父节点包裹）。
4. 理论上 display:none 元素不接收键盘事件——所以这个绑定不应该再生效。
5. **但 `mr-input-box` 的 IME composition 状态如果在切走之前正处于 active**（用户在圆桌中文打了一半就直接点 sidebar 切走），display:none 触发的焦点丢失 + composition 中断可能 leak 一个浏览器全局 IME 状态——理论可能但少见。

**对"数字勉强行"的解释**：⚠️ 部分。display:none 元素不接事件，所以纯逻辑解释不了"数字进 + 中文不进"。除非走 Chromium IME 全局锁的边缘 case（不可观测）。

**用户可执行的验证步骤**：

```
用户：
1. 启动 Hub
2. F12 → Console: setInterval(() => console.log('mr-input still bound:', !!document.getElementById('mr-input-box')), 1000);
3. 开圆桌，输入"你好"但不要按 Enter（停在 IME 候选词亮起状态）
4. 立刻点 sidebar 切回普通 session
5. 期待 Y：如果中文输入卡死且 Console 也能拿到 mr-input-box → 证据弱；
   切换前不输中文（什么都不打）就切走，再切回普通 → 如果还是卡死，排除假设 4。
   只在"切走时 IME 半成品状态"才卡 → 假设 4 加分。
```

---

### 假设 5 [LOW] — IME 焦点被某个不可见的全屏 modal-overlay 抢走

**位置**：`renderer/index.html:131,143` + 各种 modal-overlay（resume-modal / search-modal / config-modal / pair-modal / meeting-create-modal）

**触发路径**：圆桌创建走 `meeting-create-modal.js`（line 215 `_modalEl.style.display = 'flex'`）。如果 modal close 路径有 bug 没把 display 恢复成 none、或者 `dialog` element 的 inert/aria-modal 状态遗留，可能截获焦点。

**对症状的解释**：⚠️ 弱。如果 modal 真的还在，用户能看到。除非是某种 z-index=∞ 但 opacity=0 的隐形覆盖层。

**用户可执行的验证步骤**：

```
用户：
1. 复现 bug（圆桌操作后切回普通 session 卡死）
2. F12 → Console:
     [...document.querySelectorAll('.modal-overlay,[role="dialog"]')].forEach(m => console.log(m.id, getComputedStyle(m).display, getComputedStyle(m).visibility, m.classList.contains('hidden')));
3. 期待 Y：所有 modal 应是 display:none 或 hidden class。若发现某个 modal 仍 display:flex → 证实假设 5。
```

---

## 推荐优先验证顺序

1. **先验证假设 2（焦点丢失）**——最快、最可观测、Console 一行命令出结果。
   - 如果 `document.activeElement` 在切回普通 session 后是 `<body>` 或 `floating-input-box`（不是 `xterm-helper-textarea`），**问题大概率就在这里**，假设 1 顺带激化症状。
   - 修复成本最低（一行：`selectSession` 末尾强制 `cached.terminal.focus()`）。

2. 如果假设 2 排除（焦点确实在 xterm-helper-textarea），**验证假设 3**（textarea detach/reattach 后 IME 死锁）——需要实测对比 textarea 引用、试焦点重设是否能恢复中文。

3. 然后**验证假设 1**——floating input bar 中文 Enter 吞字，**这个是独立 bug**，不需要圆桌触发也应该能复现。如果用户描述的"输入框"指的就是 floating input bar，那假设 1 就是真凶。

4. 假设 4 / 5 仅作为兜底，证据较弱。

---

## 不能确诊的盲区（坦诚说哪些静态扫描查不到）

1. **Chromium textarea detach/reattach 后 IME 内部状态行为**：浏览器实现细节，没文档化、没单元测试可查。**只能实测假设 3**。

2. **用户视觉上的"输入框"指的是哪个**：报告里没写"那个浮动在终端底部的"还是"xterm 区域里的"。Hub 至少有 4 个可能"输入框"：
   - `xterm-helper-textarea`（不可见）
   - `.floating-input-box`（contenteditable，挂 terminal-panel 底部，每次 showTerminal 重建）
   - `#mr-input-box`（圆桌输入框，display:none 跟随 panel）
   - `#mr-input-target`（select，不能输文字）
   **必须问用户：你说的"输入框"长什么样？在哪？** 否则 5 个假设可能都对错位置。

3. **"具体操作记不清"**：圆桌里有 6+ 个 contenteditable 写入路径（mention 菜单 / 截断链接点击 / 逃生按钮 alert 弹出等），无法静态推断哪条路径触发状态污染。

4. **`activeSessionId !== id` 的 switching 判定**（renderer.js:1605）：决定 showTerminal 是否 focus xterm。但 selectMeeting 不动 activeSessionId（line 731 设为 null），所以圆桌后切回普通 session 时 activeSessionId 应该是 null → switching=true → 应该 focus。**这个细节让假设 2 的强度从 HIGH 降到 HIGH-with-caveat**——但只有用户实测能确认 setSession 路径上的 activeSessionId 演化。

5. **多开 Hub / 双窗口情况**：用户可能开了 2 个 Hub 实例，IME 焦点可能被另一个进程的窗口抢——这只能用 `document.hasFocus()` 实测排除。

6. **Windows IME 自身的 bug 历史**：微软 IME / 搜狗 IME / 第三方 IME 在 Electron 上有已知差异。如果用户切了 IME，不同 IME 行为可能不同——只能让用户实测复现并报告 IME 类型。

---

## 给用户最该先跑的一条命令

打开 DevTools Console，复现 bug 后立即贴这一行：

```js
JSON.stringify({ active: document.activeElement?.tagName + '.' + (document.activeElement?.className || '<no-class>'), hasFocus: document.hasFocus(), taExists: !!document.querySelector('.xterm-helper-textarea'), taFocused: document.activeElement === document.querySelector('.xterm-helper-textarea'), floatingExists: !!document.querySelector('.floating-input-box'), mrInputExists: !!document.getElementById('mr-input-box'), mrPanelDisplay: document.getElementById('meeting-room-panel')?.style.display })
```

输出能一次性定位假设 2 / 假设 3 / 假设 1 中哪个是真凶。
