# 主驾模式 + 按需查询历史 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 圆桌新增"主驾模式"——一键锁定 1 个 slot 单独深聊，关闭时主驾自动生成不限字数摘要 + markdown 历史镜像 + 段落目录（F5-A 智能切默认，UI 提供切到 F5-B 按轮切的 [切段] 按钮）注入到副驾下次 prompt。副驾基于摘要回答；不够细时用 Read 工具读对应段落 md。

**Architecture:** 复用既有 `general-roundtable-private-store.js`（主驾期间消息隔离存储）+ `_immersiveByMeeting` toggle 模式（per-meetingId 持久化）+ `meeting._timeline` 增量同步。新增 `core/pilot-recap-builder.js`（md 镜像生成 + segments 切分双模） + `summary-engine.js` 扩展支持 5 家 AI summarize。`dispatchRoundtableTurn` 加 `excludedSlots` 过滤（按 slot index）。`buildFanoutPrompt/buildDebatePrompt` 注入 recap 前缀（仅副驾、仅一次）。

**Tech Stack:** Electron / Node.js / Vanilla JS / CSS / IPC / 子进程 spawn / xterm.js / fs / JSON / Markdown

**前置依赖（必须已合入 master）：**
- `docs/superpowers/plans/2026-05-01-meeting-create-modal.md`（slot index 重构 + 5 选 3 自选）

**关联文档：**
- 设计：`C:\Users\lintian\claude-session-hub\docs\superpowers\specs\2026-05-01-roundtable-pilot-mode-design.md`
- HTML mockup：`C:\Users\lintian\claude-session-hub\docs\roundtable-pilot-mode-final-2026-05-01.html`

---

### Task 0: summary-engine 扩展 5 家 spike + 实现（前置）

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\summary-engine.js`
- Test: `C:\Users\lintian\claude-session-hub\tests\summary-engine-multi-kind.test.js`
- Spike script: `C:\Users\lintian\claude-session-hub\tests\_spike-summarize-5kinds.js`

- [ ] **Step 1: 写 spike 脚本验证 5 家可 summarize**

`tests/_spike-summarize-5kinds.js`：

```js
'use strict';
// Spike: 验证 5 家 CLI 都能用 headless / pipe 模式生成摘要
// 用法: node tests/_spike-summarize-5kinds.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAMPLE = `用户: 如何看美股科技股
AI: 当前美股科技股呈现分化...
用户: 我重点关注 AI/半导体
AI: 建议 NVDA + AVGO + AMD...`;
const SYSTEM = '你是一个总结助手，请总结对话要点。';
const PROMPT = `请总结以下对话:\n\n${SAMPLE}`;

const tests = {
  claude: () => callClaude('claude'),
  deepseek: () => callClaude('deepseek'),
  glm: () => callClaude('glm'),
  codex: () => callCodex(),
  gemini: () => callGemini(),
};

async function callClaude(kind) {
  const env = buildEnvForKind(kind);
  const sysFile = writeTmpSys();
  return spawnAndCollect(
    'claude', ['-p', '--append-system-prompt-file', sysFile],
    { env, stdin: PROMPT },
    60000
  );
}

async function callCodex() {
  const sysFile = writeTmpSys();
  return spawnAndCollect(
    'codex', ['exec', '-', '--skip-git-repo-check', '--json', '--full-auto',
             '-c', `model_instructions_file=${sysFile}`],
    { stdin: PROMPT },
    60000
  );
}

async function callGemini() {
  return spawnAndCollect(
    'gemini', ['--output-format', 'json', '-y'],
    { stdin: `${SYSTEM}\n\n${PROMPT}`, env: { ...process.env, GEMINI_SYSTEM_MD: writeTmpSys() } },
    60000
  );
}

function writeTmpSys() {
  const f = path.join(os.tmpdir(), `spike_sys_${Date.now()}.md`);
  fs.writeFileSync(f, SYSTEM, 'utf8');
  return f;
}

function buildEnvForKind(kind) {
  const env = { ...process.env };
  if (kind === 'deepseek') {
    env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
    env.ANTHROPIC_AUTH_TOKEN = process.env.DEEPSEEK_API_KEY;
    env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-deepseek');
  } else if (kind === 'glm') {
    env.ANTHROPIC_BASE_URL = process.env.GLM_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = process.env.GLM_API_KEY;
    env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-glm');
  }
  return env;
}

function spawnAndCollect(cmd, args, opts, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { env: opts.env, shell: false });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    if (opts.stdin) { p.stdin.end(opts.stdin); }
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: 'timeout', took: Date.now() - t0 }); }, timeout);
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && out.trim().length > 0, code, out: out.slice(0, 300), err: err.slice(0, 300), took: Date.now() - t0 });
    });
  });
}

(async () => {
  const results = {};
  for (const [kind, fn] of Object.entries(tests)) {
    process.stdout.write(`Testing ${kind}... `);
    try {
      results[kind] = await fn();
      console.log(results[kind].ok ? `✓ PASS (${results[kind].took}ms)` : `✗ FAIL: ${results[kind].error || results[kind].err}`);
    } catch (e) {
      results[kind] = { ok: false, error: e.message };
      console.log(`✗ FAIL: ${e.message}`);
    }
  }
  fs.writeFileSync(
    path.join(__dirname, '_spike-summarize-5kinds-result.md'),
    `# Summary Engine Multi-Kind Spike Result\n\n` +
    `- Date: ${new Date().toISOString()}\n\n` +
    `| Kind | Status | Time | Output Preview |\n|---|---|---|---|\n` +
    Object.entries(results).map(([k, r]) =>
      `| ${k} | ${r.ok ? '✓ PASS' : '✗ FAIL'} | ${r.took || 0}ms | ${(r.out || r.error || '').slice(0, 100).replace(/\|/g, '\\|')} |`
    ).join('\n')
  );
})();
```

- [ ] **Step 2: 跑 spike**

```bash
export DEEPSEEK_API_KEY=...  # 从 secrets.toml 读
export GLM_API_KEY=...
export GLM_BASE_URL=https://mydamoxing.cn

# 代理（如需）
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890

node tests/_spike-summarize-5kinds.js
cat tests/_spike-summarize-5kinds-result.md
```

预期：所有 5 家 PASS。失败的家记录在 result.md。

- [ ] **Step 3: 决策**

如果某家 FAIL，处理：
- Codex headless 不通 → 改走 PTY 注入兜底（用 `_rtSendToPty` 给临时 codex session 发"请总结"prompt 等 turn-complete）
- 在 spec / plan 风险章节记录降级路径

- [ ] **Step 4: 实现 summarizeWithKind**

修改 `core/summary-engine.js`：

```js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function summarizeWithKind(kind, system, prompt, options = {}) {
  const timeout = options.timeout || 60000;
  switch (kind) {
    case 'claude':
    case 'deepseek':
    case 'glm':
      return _callClaudeHeadless(kind, system, prompt, timeout);
    case 'codex':
      return _callCodexHeadless(system, prompt, timeout);
    case 'gemini':
      return _callGeminiPipe(system, prompt, timeout);
    default:
      throw new Error(`summarizeWithKind: Unsupported kind: ${kind}`);
  }
}

function _buildEnvForKind(kind) {
  const env = { ...process.env };
  if (kind === 'claude') {
    return env;  // 默认订阅
  }
  const cv = require('./hub-config').getConfig();
  if (kind === 'deepseek') {
    env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
    env.ANTHROPIC_AUTH_TOKEN = cv.DEEPSEEK_API_KEY;
    env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-deepseek');
  } else if (kind === 'glm') {
    env.ANTHROPIC_BASE_URL = cv.GLM_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = cv.GLM_API_KEY;
    env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-glm');
  }
  return env;
}

async function _callClaudeHeadless(kind, system, prompt, timeout) {
  const env = _buildEnvForKind(kind);
  const sysFile = path.join(os.tmpdir(), `summary_sys_${Date.now()}_${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(sysFile, system, 'utf8');
  try {
    return await _spawnAndCollect('claude', ['-p', '--append-system-prompt-file', sysFile], { env, stdin: prompt }, timeout);
  } finally {
    try { fs.unlinkSync(sysFile); } catch {}
  }
}

async function _callCodexHeadless(system, prompt, timeout) {
  const sysFile = path.join(os.tmpdir(), `summary_sys_${Date.now()}_${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(sysFile, system, 'utf8');
  try {
    return await _spawnAndCollect(
      'codex',
      ['exec', '-', '--skip-git-repo-check', '--json', '--full-auto', '-c', `model_instructions_file=${sysFile}`],
      { stdin: prompt },
      timeout
    );
  } finally {
    try { fs.unlinkSync(sysFile); } catch {}
  }
}

async function _callGeminiPipe(system, prompt, timeout) {
  // 既有 Gemini pipe 实现
  // ... 保留
}

function _spawnAndCollect(cmd, args, opts, timeout) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: opts.env, shell: false });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    if (opts.stdin) p.stdin.end(opts.stdin);
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`spawn timeout after ${timeout}ms`));
    }, timeout);
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim().length > 0) resolve(out.trim());
      else reject(new Error(`spawn failed code=${code}: ${err.slice(0, 200)}`));
    });
  });
}

module.exports = { summarizeWithKind, _callGeminiPipe, /* 既有 export */ };
```

- [ ] **Step 5: 写 unit test**

`tests/summary-engine-multi-kind.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../core/summary-engine');

test('summarizeWithKind throws on unknown kind', async () => {
  await assert.rejects(
    () => engine.summarizeWithKind('unknown', 'sys', 'prompt'),
    /Unsupported kind/
  );
});

// E2E test (跳过 CI，本地运行)
if (process.env.RUN_E2E_SUMMARIZE) {
  test('summarizeWithKind claude returns text', async () => {
    const out = await engine.summarizeWithKind('claude', 'You summarize.', 'Hello');
    assert.ok(out.length > 0);
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add core/summary-engine.js tests/_spike-summarize-5kinds.js tests/_spike-summarize-5kinds-result.md tests/summary-engine-multi-kind.test.js
git commit -m "feat(summary-engine): expand summarizeWithKind to 5 AI families"
```

---

### Task 1: pilotSlot state + IPC `roundtable:pilot-toggle`

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\meeting-room.js`
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

- [ ] **Step 1: 加 meeting.pilotSlot 字段**

`core/meeting-room.js` Meeting 对象初始化时加：

```js
const meeting = {
  // ... 既有字段
  pilotSlot: null,  // 0|1|2|null
};
```

加 getter/setter：

```js
setPilotSlot(meetingId, slotIndex) {
  const m = this.meetings.get(meetingId);
  if (!m) return false;
  m.pilotSlot = slotIndex;
  meetingStore.markDirty(m);
  return true;
}

getPilotSlot(meetingId) {
  return this.meetings.get(meetingId)?.pilotSlot ?? null;
}
```

- [ ] **Step 2: 加 IPC handler**

`main.js`：

```js
ipcMain.handle('roundtable:pilot-toggle', async (_e, { meetingId, slotIndex }) => {
  if (slotIndex !== null && (typeof slotIndex !== 'number' || slotIndex < 0 || slotIndex > 2)) {
    throw new Error(`Invalid slotIndex: ${slotIndex}`);
  }
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);

  const prevSlot = meeting.pilotSlot;
  meetingManager.setPilotSlot(meetingId, slotIndex);

  // 持久化 per-meetingId
  state.pilotSlotByMeeting = state.pilotSlotByMeeting || {};
  state.pilotSlotByMeeting[meetingId] = slotIndex;
  await saveState();

  let recapIdx = null;
  if (slotIndex === null && prevSlot !== null) {
    // 关闭主驾 → 触发摘要生成
    try {
      recapIdx = await _generatePilotRecap(meetingId, prevSlot);
    } catch (e) {
      console.error('[pilot-toggle] _generatePilotRecap failed:', e);
      // 不抛错，让用户至少能关闭主驾
    }
  }

  return { ok: true, recapIdx };
});
```

`_generatePilotRecap` 在 Task 4 实现。

- [ ] **Step 3: state.json 持久化字段**

`saveState` / `loadState` 中确保 `state.pilotSlotByMeeting` 序列化。Hub 启动时 `loadState` 后遍历 meetings：

```js
for (const [mid, slot] of Object.entries(state.pilotSlotByMeeting || {})) {
  const m = meetingManager.getMeeting(mid);
  if (m) m.pilotSlot = slot;
}
```

- [ ] **Step 4: smoke test + Commit**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

DevTools 测试：

```js
await window.electronAPI.invoke('roundtable:pilot-toggle', { meetingId: '<mid>', slotIndex: 0 });
// 应返回 { ok: true, recapIdx: null }
await window.electronAPI.invoke('roundtable:pilot-toggle', { meetingId: '<mid>', slotIndex: null });
// 应返回 { ok: true, recapIdx: <number 或 null> }
```

```bash
git add core/meeting-room.js main.js
git commit -m "feat(main): add pilotSlot state + roundtable:pilot-toggle IPC"
```

---

### Task 2: dispatchRoundtableTurn 加 excludedSlots 过滤

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

- [ ] **Step 1: 改 dispatchRoundtableTurn 主循环**

找到 `dispatchRoundtableTurn`（约 main.js:705-849），在 for loop 给 PTY 发 prompt 处加过滤：

```js
async function dispatchRoundtableTurn(meeting, mode, userInput, opts = {}) {
  const subSids = meeting.subSessions || [];
  const pilotSlot = meeting.pilotSlot;  // 新增

  for (let i = 0; i < subSids.length; i++) {
    // 主驾期间跳过副驾
    if (pilotSlot !== null && pilotSlot !== undefined && i !== pilotSlot) {
      console.log(`[dispatch] skip slot ${i} (pilotSlot=${pilotSlot})`);
      continue;
    }
    const sid = subSids[i];
    // ... 既有 _rtSendToPty 等逻辑
  }
}
```

- [ ] **Step 2: 主驾期间消息存进 private store**

`dispatchRoundtableTurn` 中接收每个 sub 的 turn-complete 后：

```js
if (pilotSlot !== null) {
  const pilotSid = subSids[pilotSlot];
  privateStore.appendRoundtablePrivateTurn(
    hubDataDir, meeting.id, sessions.get(pilotSid)?.kind || 'unknown',
    userInput, response
  );
  // 注：既有 private store 按 kind 分类。如果允许同 kind 重复（meeting-create-modal 后），
  // 需要在 private-store 加按 sid 分类。本期视依赖 plan 进度再决定是否同步改造。
}
```

⚠ 如果 private-store 仍按 kind 分类，需扩展为按 sid（meeting-create-modal plan 已规划）。

- [ ] **Step 3: turn-complete await 仅等主驾**

主驾期间 `Promise.all([waitFor(slot1), waitFor(slot2), waitFor(slot3)])` 改成只等主驾：

```js
const waitPromises = [];
for (let i = 0; i < subSids.length; i++) {
  if (pilotSlot !== null && pilotSlot !== undefined && i !== pilotSlot) continue;
  waitPromises.push(waitForSubTurnComplete(subSids[i]));
}
await Promise.all(waitPromises);
```

- [ ] **Step 4: smoke test + Commit**

启动隔离 Hub → 主驾开启 → 发消息 → DevTools console 看 `[dispatch] skip slot ...` log。

```bash
git add main.js
git commit -m "feat(main): dispatchRoundtableTurn skips non-pilot slots when pilot mode active"
```

---

### Task 3: Toolbar [🚗 主驾] 按钮 + dropdown

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js`（renderToolbar 区域，约 1915-1967 行）
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`

- [ ] **Step 1: 加按钮 HTML**

`renderToolbar` 函数中，在 [总结发言] 按钮后、[总结人 dropdown] 前后加：

```js
function renderToolbar(meeting, container) {
  const pilotSlot = meeting.pilotSlot;
  const slotLabels = ['⚡皮卡丘', '🔥小火龙', '💎杰尼龟'];
  const pilotBtnLabel = pilotSlot !== null && pilotSlot !== undefined
    ? slotLabels[pilotSlot] : '关';
  const pilotBtnClass = pilotSlot !== null && pilotSlot !== undefined ? 'active' : '';

  container.innerHTML = `
    <button id="mr-rt-debate-btn" class="mr-rt-tb-btn primary" ${pilotSlot !== null ? 'disabled' : ''}>
      🤝 群策群力
    </button>
    <button id="mr-rt-summary-btn" class="mr-rt-tb-btn warm" ${pilotSlot !== null ? 'disabled' : ''}>
      📝 总结发言
    </button>
    <span class="mr-rt-tb-divider"></span>
    <label class="mr-rt-tb-pick ${pilotSlot !== null ? 'dim' : ''}">
      总结人: <select id="mr-rt-summary-pick" ${pilotSlot !== null ? 'disabled' : ''}>...</select>
    </label>
    <button id="mr-pilot-btn" class="mr-rt-tb-btn pilot ${pilotBtnClass}">
      🚗 主驾:<span id="mr-pilot-label">${pilotBtnLabel}</span> ${pilotSlot !== null ? '▾' : ''}
    </button>
    <span id="mr-pilot-menu" class="mr-pilot-menu" style="display:none;">
      <div class="mr-pilot-option" data-slot="0">⚡ Slot 1 · 皮卡丘</div>
      <div class="mr-pilot-option" data-slot="1">🔥 Slot 2 · 小火龙</div>
      <div class="mr-pilot-option" data-slot="2">💎 Slot 3 · 杰尼龟</div>
      <div class="mr-pilot-option" data-slot="-1">关闭主驾</div>
    </span>
    <span id="mr-rt-tb-status" class="mr-rt-tb-status ${pilotSlot !== null ? 'pilot-on' : ''}">
      ${pilotSlot !== null ? `主驾中 · 仅 Slot ${pilotSlot + 1} 接收` : '已 N 轮 · 等待提问'}
    </span>
  `;
  _bindPilotEvents(meeting);
}
```

- [ ] **Step 2: 加事件绑定**

```js
function _bindPilotEvents(meeting) {
  const btn = document.getElementById('mr-pilot-btn');
  const menu = document.getElementById('mr-pilot-menu');
  const options = document.querySelectorAll('.mr-pilot-option');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  // 点外部关闭菜单
  document.addEventListener('click', () => { menu.style.display = 'none'; }, { once: true });

  options.forEach(opt => {
    opt.addEventListener('click', async (e) => {
      e.stopPropagation();
      const slotStr = opt.dataset.slot;
      const slotIndex = parseInt(slotStr, 10);
      const targetSlot = slotIndex === -1 ? null : slotIndex;
      menu.style.display = 'none';
      try {
        const result = await window.electronAPI.invoke('roundtable:pilot-toggle', {
          meetingId: meeting.id, slotIndex: targetSlot,
        });
        meeting.pilotSlot = targetSlot;
        _applyPilotUi(meeting);
        if (targetSlot === null && result.recapIdx !== null) {
          // recap 已经通过 timeline-append IPC 推送，UI 自动更新
        }
      } catch (err) {
        console.error('[pilot-toggle] failed:', err);
        alert('切换主驾失败：' + err.message);
      }
    });
  });
}

function _applyPilotUi(meeting) {
  const pilotSlot = meeting.pilotSlot;
  // 重新 render toolbar
  renderToolbar(meeting, document.getElementById('mr-rt-toolbar'));
  // 卡片视觉
  document.querySelectorAll('.mr-ft').forEach((card, i) => {
    card.classList.toggle('pilot-locked', pilotSlot === i);
    card.classList.toggle('pilot-observer', pilotSlot !== null && pilotSlot !== i);
  });
  // 输入框 placeholder
  const inputBox = document.getElementById('mr-input-box');
  if (inputBox) {
    inputBox.dataset.placeholder = pilotSlot !== null
      ? `🚗 主驾中（仅 Slot ${pilotSlot + 1} 接收）...`
      : '圆桌讨论：发普通文本启动一轮 / @debate / @summary @<who> / @<who> 单聊';
  }
}
```

- [ ] **Step 3: CSS**

`renderer/meeting-room.css` 加：

```css
.mr-rt-tb-btn.pilot {
  background: rgba(248, 81, 73, 0.18);
  border: 1px solid #f85149;
  color: #f85149;
  font-weight: 600;
}
.mr-rt-tb-btn.pilot.active {
  background: rgba(248, 81, 73, 0.4);
  box-shadow: 0 0 0 2px rgba(248, 81, 73, 0.3);
  color: #fff;
}
.mr-rt-tb-status.pilot-on {
  color: #f85149;
  font-weight: 600;
}
.mr-pilot-menu {
  position: absolute;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 4px 0;
  min-width: 180px;
  z-index: 100;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}
.mr-pilot-option {
  padding: 6px 12px;
  font-size: 12.5px;
  cursor: pointer;
  color: #e6edf3;
}
.mr-pilot-option:hover { background: rgba(88, 166, 255, 0.12); }

/* 卡片视觉 */
.mr-ft.pilot-locked {
  border-color: #f85149;
  border-width: 2px;
  box-shadow: 0 0 24px rgba(248, 81, 73, 0.2);
}
.mr-ft.pilot-observer {
  opacity: 0.35;
  filter: grayscale(0.6);
}
.mr-rt-tb-pick.dim { opacity: 0.4; }
```

- [ ] **Step 4: 真测**

启动隔离 Hub → 进圆桌 → 点 [🚗 主驾:关] → 选 Slot 1 → assert 按钮高亮红 + 卡片 1 红边 + 卡片 2/3 dim。

- [ ] **Step 5: Commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(renderer): toolbar [pilot] toggle + dropdown + cards visual"
```

---

### Task 4: 切回流程 · 摘要 + md 镜像 + timeline 写入

**Files:**
- New: `C:\Users\lintian\claude-session-hub\core\pilot-recap-builder.js`
- Modify: `C:\Users\lintian\claude-session-hub\main.js`（_generatePilotRecap）

- [ ] **Step 1: 写 pilot-recap-builder 骨架**

`core/pilot-recap-builder.js`：

```js
'use strict';
const fs = require('fs');
const path = require('path');

function splitByTurn(turns) {
  return turns.map((t, i) => {
    const userInput = (t.userInput || '').replace(/\s+/g, ' ').trim();
    let title = userInput.slice(0, 30);
    if (userInput.length < 5) {
      const aiAns = (t.response || '').replace(/\s+/g, ' ').trim().slice(0, 15);
      title = `Q: ${userInput} · A: ${aiAns}`;
    } else {
      title = `Q: ${title}`;
    }
    return {
      idx: i + 1, mode: 'turn', title,
      mdLineStart: 0, mdLineEnd: 0,
      turnRange: [i, i + 1],
    };
  });
}

function splitBySmart(turns, segmentTitles) {
  if (!Array.isArray(segmentTitles) || segmentTitles.length === 0) {
    return splitByTurn(turns);
  }
  const N = Math.max(1, Math.min(segmentTitles.length, 10));
  const titles = segmentTitles.slice(0, N);
  const turnsPerSeg = Math.ceil(turns.length / N);
  return titles.map((title, i) => ({
    idx: i + 1,
    mode: 'smart',
    title: String(title).trim().slice(0, 60),
    mdLineStart: 0, mdLineEnd: 0,
    turnRange: [i * turnsPerSeg, Math.min((i + 1) * turnsPerSeg, turns.length)],
  }));
}

async function build(mdPath, turns, segments, meta) {
  const lines = [];
  lines.push(`# 主驾期会话历史 · Slot ${meta.pilotSlot + 1} (${meta.pilotKind})`);
  lines.push(`> ${formatDateRange(turns)} · ${turns.length} 轮 · 主驾 ${meta.pilotKind}`);
  lines.push('');

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const startLine = lines.length + 1;
    lines.push(`<!-- segment ${i + 1} start -->`);
    lines.push(`## 段落 ${i + 1} · ${seg.title}`);
    lines.push('');

    const turnsInSeg = turns.slice(seg.turnRange[0], seg.turnRange[1]);
    for (const t of turnsInSeg) {
      const turnNum = turns.indexOf(t) + 1;
      lines.push(`### 第 ${turnNum} 轮 (${formatTime(t.ts)})`);
      lines.push(`**用户**: ${t.userInput}`);
      lines.push(`**${meta.pilotKind}**: ${t.response}`);
      lines.push('');
    }
    lines.push(`<!-- segment ${i + 1} end -->`);
    lines.push('');
    seg.mdLineStart = startLine;
    seg.mdLineEnd = lines.length - 1;
  }

  await fs.promises.writeFile(mdPath, lines.join('\n'), 'utf8');
  return segments;
}

async function rebuildMd(mdPath, turns, segments, meta) {
  return build(mdPath, turns, segments, meta);
}

function formatDateRange(turns) {
  if (!turns.length) return '';
  const first = new Date(turns[0].ts || Date.now());
  const last = new Date(turns[turns.length - 1].ts || Date.now());
  return `${first.toISOString().slice(0, 16).replace('T', ' ')} ~ ${last.toISOString().slice(11, 16)}`;
}

function formatTime(ts) {
  return new Date(ts || Date.now()).toISOString().slice(11, 19);
}

module.exports = { splitByTurn, splitBySmart, build, rebuildMd };
```

- [ ] **Step 2: 写 _generatePilotRecap**

`main.js`：

```js
const recapBuilder = require('./core/pilot-recap-builder');
const summaryEngine = require('./core/summary-engine');
const privateStore = require('./core/general-roundtable-private-store');

async function _generatePilotRecap(meetingId, prevSlot) {
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) return null;

  const pilotSid = meeting.subSessions[prevSlot];
  const pilotSession = sessionManager.getSession(pilotSid);
  if (!pilotSession) return null;
  const pilotKind = pilotSession.kind;

  // 1. 取 private store 本次主驾期间的 turns
  // 注：此处假设 private-store 已支持按 sid 分类（见 Task 2 注释）
  const turns = privateStore.getRoundtablePrivateTurnsForSession(
    hubDataDir, meetingId, pilotSid
  ) || [];

  // 2. 短主驾兜底（≤1 轮）
  if (turns.length <= 1) {
    const userInput = turns[0]?.userInput || '';
    return _appendTimelineRecap(meeting, {
      text: turns.length === 1
        ? `用户私下问了 Slot${prevSlot + 1}（${pilotKind}）："${userInput}"`
        : `用户开启了主驾但未发消息`,
      recapMdPath: null,
      segments: [],
      segmentMode: 'turn',
      pilotSlot: prevSlot, pilotKind, turnCount: turns.length,
    });
  }

  // 3. F5-A 智能切：调主驾生成摘要 + 段落目录
  const promptText = _buildSummaryPrompt(turns);
  const systemText = '你正在总结你和用户刚才的对话。请按用户要求输出摘要 + 段落目录。';

  let summaryText, segmentTitles;
  try {
    const llmOutput = await summaryEngine.summarizeWithKind(pilotKind, systemText, promptText);
    ({ summaryText, segmentTitles } = _parseSummaryWithSegments(llmOutput));
    if (!summaryText || summaryText.length < 10) {
      throw new Error('summary too short');
    }
  } catch (e) {
    console.warn('[pilot-recap] summary failed, falling back to F5-B:', e.message);
    summaryText = '（摘要生成失败，已降级为按轮切分；可点击切段重试）';
    segmentTitles = null;
  }

  // 4. 生成 segments + md 镜像
  const segments = segmentTitles && segmentTitles.length > 0
    ? recapBuilder.splitBySmart(turns, segmentTitles)
    : recapBuilder.splitByTurn(turns);

  const arenaDir = path.join(hubDataDir, 'arena-prompts');
  await fs.promises.mkdir(arenaDir, { recursive: true });
  const mdPath = path.join(arenaDir, `${meetingId}-pilot-recap-${Date.now()}.md`);
  await recapBuilder.build(mdPath, turns, segments, { pilotKind, pilotSlot: prevSlot });

  // 5. 写 timeline
  const recapIdx = _appendTimelineRecap(meeting, {
    text: summaryText,
    recapMdPath: mdPath,
    segments,
    segmentMode: segmentTitles ? 'smart' : 'turn',
    pilotSlot: prevSlot,
    pilotKind,
    turnCount: turns.length,
  });

  return recapIdx;
}

function _buildSummaryPrompt(turns) {
  const dialogue = turns.map((t, i) =>
    `[轮 ${i + 1}]\n用户: ${t.userInput}\n你: ${t.response}\n`
  ).join('\n');

  return `请总结你和我刚才的对话要点（多少字合适都由你决定，不需要简短）。

最后请用 1 行附段落目录（按主题切，1-10 段，每段一行格式：\`段落 N: <主题>\`）。

对话历史:
${dialogue}`;
}

function _parseSummaryWithSegments(llmOutput) {
  // 找最后一段 "段落 N: ..." 块作为目录
  const lines = llmOutput.split('\n');
  const segLineRegex = /^段落\s*\d+\s*[:：]\s*(.+)$/;
  const segIdxs = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (segLineRegex.test(lines[i].trim())) {
      segIdxs.unshift(i);
    } else if (segIdxs.length > 0) {
      // 段落块到此结束（向前扩展时遇到非段落行）
      break;
    }
  }
  let summaryText, segmentTitles;
  if (segIdxs.length > 0) {
    const firstSegLine = segIdxs[0];
    summaryText = lines.slice(0, firstSegLine).join('\n').trim()
      .replace(/^段落目录\s*[:：]?\s*$/m, '')  // 删可能的"段落目录:"标头
      .replace(/^---+\s*$/m, '').trim();
    segmentTitles = segIdxs.map(idx => {
      const m = lines[idx].trim().match(segLineRegex);
      return m ? m[1].trim() : '';
    }).filter(Boolean);
  } else {
    summaryText = llmOutput.trim();
    segmentTitles = null;
  }
  return { summaryText, segmentTitles };
}

function _appendTimelineRecap(meeting, payload) {
  const idx = meeting._nextIdx++;
  const entry = {
    idx,
    sid: 'system',
    tag: 'pilot-recap',
    text: payload.text,
    recapMdPath: payload.recapMdPath,
    segments: payload.segments,
    segmentMode: payload.segmentMode,
    pilotSlot: payload.pilotSlot,
    pilotKind: payload.pilotKind,
    turnCount: payload.turnCount,
    ts: Date.now(),
  };
  meeting._timeline.push(entry);
  meetingStore.markDirty(meeting);
  // 推 IPC
  const wins = BrowserWindow.getAllWindows();
  wins.forEach(w => w.webContents.send('timeline-append', { meetingId: meeting.id, entry }));
  return idx;
}
```

- [ ] **Step 3: 真测主驾切回**

启动 Hub → 创建圆桌 → 开主驾 Slot 1 (Claude) → 发 3 轮主驾消息 → 关闭主驾 → 等 ~30s → assert：
- `<arena>/<mid>-pilot-recap-<ts>.md` 文件存在
- meeting._timeline 末尾有 tag='pilot-recap' 条目
- DevTools 收到 `timeline-append` IPC

- [ ] **Step 4: Commit**

```bash
git add core/pilot-recap-builder.js main.js
git commit -m "feat(main): _generatePilotRecap with F5-A smart segment + md mirror"
```

---

### Task 5: F5-B 切换 IPC `roundtable:pilot-segment-mode`

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`

- [ ] **Step 1: 加 IPC handler**

```js
ipcMain.handle('roundtable:pilot-segment-mode', async (_e, { meetingId, recapIdx, mode }) => {
  if (!['smart', 'turn'].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}`);
  }
  const meeting = meetingManager.getMeeting(meetingId);
  if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);

  const recap = meeting._timeline?.find(e => e.idx === recapIdx);
  if (!recap || recap.tag !== 'pilot-recap') {
    throw new Error(`Recap not found at idx ${recapIdx}`);
  }

  // 取出本次主驾的 turns（按 mdPath 关联可能丢失，用 pilotSlot 反查）
  const pilotSid = meeting.subSessions[recap.pilotSlot];
  const turns = privateStore.getRoundtablePrivateTurnsForSession(hubDataDir, meetingId, pilotSid) || [];
  if (turns.length === 0) {
    throw new Error('No private turns found for this recap');
  }

  let segments;
  if (mode === 'turn') {
    segments = recapBuilder.splitByTurn(turns);
  } else {
    // F5-A：再调一次主驾生成段落目录
    const pilotKind = sessionManager.getSession(pilotSid)?.kind;
    try {
      const llmOutput = await summaryEngine.summarizeWithKind(
        pilotKind,
        '请仅输出对话的段落目录（按主题切，1-10 段，每段一行：`段落 N: <主题>`），不要其他文字。',
        _buildSummaryPrompt(turns)
      );
      const { segmentTitles } = _parseSummaryWithSegments(llmOutput);
      segments = recapBuilder.splitBySmart(turns, segmentTitles || []);
    } catch (e) {
      throw new Error(`F5-A failed: ${e.message}`);
    }
  }

  // 重建 md
  if (recap.recapMdPath) {
    await recapBuilder.rebuildMd(recap.recapMdPath, turns, segments, {
      pilotKind: recap.pilotKind,
      pilotSlot: recap.pilotSlot,
    });
  }

  recap.segments = segments;
  recap.segmentMode = mode;
  meetingStore.markDirty(meeting);

  // 推 IPC
  const wins = BrowserWindow.getAllWindows();
  wins.forEach(w => w.webContents.send('timeline-update', { meetingId, idx: recapIdx, entry: recap }));

  return { ok: true, segments, segmentMode: mode };
});
```

- [ ] **Step 2: smoke test + Commit**

DevTools：

```js
const result = await window.electronAPI.invoke('roundtable:pilot-segment-mode', {
  meetingId: '<mid>', recapIdx: <idx>, mode: 'turn',
});
// 应返回新 segments
```

```bash
git add main.js
git commit -m "feat(main): roundtable:pilot-segment-mode IPC for A/B switch"
```

---

### Task 6: buildFanoutPrompt / buildDebatePrompt 注入 recap 前缀

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\roundtable-orchestrator.js`

- [ ] **Step 1: 加 helper findLatestPilotRecap**

```js
function findLatestPilotRecap(timeline) {
  if (!Array.isArray(timeline)) return null;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].tag === 'pilot-recap') return timeline[i];
  }
  return null;
}
```

- [ ] **Step 2: buildFanoutPrompt 加注入逻辑**

```js
function buildFanoutPrompt(turnNum, userInput, ctx) {
  const recap = findLatestPilotRecap(ctx.meeting?._timeline);
  const isWasPilot = (recap?.pilotSlot === ctx.targetSlotIndex);
  const cursor = ctx.meeting?._cursors?.[ctx.targetSid] || 0;
  const hasInjectedBefore = recap && cursor > recap.idx;

  if (recap && !isWasPilot && !hasInjectedBefore && recap.segments) {
    const segLines = recap.segments.map((s, i) =>
      `   段落 ${i + 1} [行 ${s.mdLineStart}-${s.mdLineEnd}]   ${s.title}`
    ).join('\n');
    const mdPathLine = recap.recapMdPath
      ? `📂 完整历史: ${recap.recapMdPath} (${recap.segments.length} 段)\n${segLines}\n\n若摘要够则直接答；不够可用 Read 工具读对应段落（offset+limit）。\n`
      : '';

    // 标记已注入：cursor 推进到 recap.idx + 1
    if (ctx.meeting._cursors) {
      ctx.meeting._cursors[ctx.targetSid] = recap.idx + 1;
    }

    return `[圆桌 · 第 ${turnNum} 轮 · 默认提问]

## 你刚才暂时离场（用户和 Slot${recap.pilotSlot + 1}（${recap.pilotKind}）通过 ${recap.turnCount} 轮深聊）

${recap.text}

${mdPathLine}
## 现在用户问大家:
${userInput}

请独立回答（你看不到另两家观点，本色发挥即可）。`;
  }

  // 主驾自己 / 没有 recap → 走原 prompt 路径
  return originalBuildFanoutPrompt(turnNum, userInput, ctx);
}
```

注：`originalBuildFanoutPrompt` 是改造前的实现，保留在文件中。

- [ ] **Step 3: buildDebatePrompt 同理**

```js
function buildDebatePrompt(turnNum, userInput, lastTurn, targetSid, sidLabelFn, ctx) {
  // recap 注入逻辑（同 buildFanoutPrompt）— 如果是副驾的第一次回归
  const recapPrefix = _maybeRecapPrefix(ctx, sidLabelFn);
  const original = originalBuildDebatePrompt(turnNum, userInput, lastTurn, targetSid, sidLabelFn);
  return recapPrefix ? `${recapPrefix}\n\n${original}` : original;
}

function _maybeRecapPrefix(ctx, sidLabelFn) {
  // ... 抽取 buildFanoutPrompt 中相同的判断逻辑
}
```

- [ ] **Step 4: 单测**

`tests/orchestrator-recap-injection.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildFanoutPrompt, findLatestPilotRecap } = require('../core/roundtable-orchestrator');

test('findLatestPilotRecap returns last entry with tag=pilot-recap', () => {
  const timeline = [
    { idx: 0, sid: 'sid1', text: 'a' },
    { idx: 1, sid: 'system', tag: 'pilot-recap', pilotSlot: 0 },
    { idx: 2, sid: 'sid2', text: 'b' },
  ];
  const r = findLatestPilotRecap(timeline);
  assert.equal(r?.idx, 1);
});

test('buildFanoutPrompt injects recap prefix for non-pilot slot', () => {
  const ctx = {
    meeting: {
      _timeline: [{ idx: 5, sid: 'system', tag: 'pilot-recap',
                    pilotSlot: 0, pilotKind: 'claude', turnCount: 3,
                    text: 'summary text', recapMdPath: 'C:\\test.md',
                    segments: [{ idx: 1, title: 't1', mdLineStart: 5, mdLineEnd: 30 }] }],
      _cursors: { 'sid-2': 0 },
    },
    targetSid: 'sid-2',
    targetSlotIndex: 1,  // 非主驾
  };
  const prompt = buildFanoutPrompt(2, '新问题', ctx);
  assert.match(prompt, /你刚才暂时离场/);
  assert.match(prompt, /summary text/);
  assert.match(prompt, /C:\\test\.md/);
});

test('buildFanoutPrompt does NOT inject for pilot slot itself', () => {
  const ctx = {
    meeting: { _timeline: [/* 同上 */], _cursors: {} },
    targetSid: 'sid-1',
    targetSlotIndex: 0,  // 主驾自己
  };
  const prompt = buildFanoutPrompt(2, '新问题', ctx);
  assert.doesNotMatch(prompt, /你刚才暂时离场/);
});
```

- [ ] **Step 5: Commit**

```bash
git add core/roundtable-orchestrator.js tests/orchestrator-recap-injection.test.js
git commit -m "feat(orchestrator): inject pilot-recap prefix to non-pilot slots once"
```

---

### Task 7: Timeline UI 渲染 [主驾回顾] 折叠卡片

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js`
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.css`

- [ ] **Step 1: timeline 渲染入口加 tag 分流**

找到 timeline 渲染函数（应该是 `_renderTimeline` 或类似），加：

```js
function _renderTimelineEntry(entry) {
  if (entry.tag === 'pilot-recap') {
    return _renderPilotRecapEntry(entry);
  }
  // 既有渲染逻辑
}
```

- [ ] **Step 2: 写 _renderPilotRecapEntry**

```js
function _renderPilotRecapEntry(entry) {
  const expandedKey = `pilot-recap-expanded-${entry.idx}`;
  const expanded = sessionStorage.getItem(expandedKey) === '1';

  const segLines = (entry.segments || []).map((s, i) =>
    `   段落 ${i + 1} [行 ${s.mdLineStart}-${s.mdLineEnd}]   ${escapeHtml(s.title)}`
  ).join('\n');

  return `
    <div class="mr-pilot-recap-card" data-recap-idx="${entry.idx}" data-mode="${entry.segmentMode}">
      <div class="mr-pilot-recap-header">
        <span>📒</span>
        <span class="mr-pilot-recap-title">[主驾回顾 · ${escapeHtml(entry.pilotKind)} · ${entry.turnCount} 轮]</span>
        <div class="mr-pilot-recap-actions">
          <button class="mr-pilot-recap-toggle">${expanded ? '收起 ▴' : '展开 ▾'}</button>
          <div class="mr-pilot-segment-mode-wrap">
            <button class="mr-pilot-segment-btn">切段:${entry.segmentMode === 'smart' ? '智能' : '按轮'} ▾</button>
            <div class="mr-pilot-segment-menu" style="display:none;">
              <div data-mode="smart">智能（F5-A · 主驾按主题切）</div>
              <div data-mode="turn">按轮（F5-B · Hub 按对话轮切）</div>
            </div>
          </div>
        </div>
      </div>
      <div class="mr-pilot-recap-body" style="${expanded ? '' : 'display:none;'}">
        <div class="mr-pilot-recap-text">${renderMarkdown(entry.text)}</div>
        ${entry.recapMdPath ? `
          <pre class="mr-pilot-recap-segments">📂 完整历史: ${escapeHtml(entry.recapMdPath)} (${entry.segments?.length || 0} 段)
${segLines}

若摘要够则直接答；不够可用 Read 工具读对应段落（offset+limit）。</pre>
        ` : ''}
      </div>
    </div>
  `;
}
```

- [ ] **Step 3: 绑定事件**

在 timeline render 完成后：

```js
function _bindPilotRecapEvents() {
  document.querySelectorAll('.mr-pilot-recap-card').forEach(card => {
    const recapIdx = parseInt(card.dataset.recapIdx, 10);

    // 展开/收起
    card.querySelector('.mr-pilot-recap-toggle').addEventListener('click', () => {
      const body = card.querySelector('.mr-pilot-recap-body');
      const btn = card.querySelector('.mr-pilot-recap-toggle');
      const expanded = body.style.display !== 'none';
      body.style.display = expanded ? 'none' : '';
      btn.textContent = expanded ? '展开 ▾' : '收起 ▴';
      sessionStorage.setItem(`pilot-recap-expanded-${recapIdx}`, expanded ? '0' : '1');
    });

    // 切段菜单
    const segBtn = card.querySelector('.mr-pilot-segment-btn');
    const segMenu = card.querySelector('.mr-pilot-segment-menu');
    let lastModeSwitchTs = 0;

    segBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      segMenu.style.display = segMenu.style.display === 'none' ? 'block' : 'none';
    });

    segMenu.querySelectorAll('div[data-mode]').forEach(opt => {
      opt.addEventListener('click', async (e) => {
        e.stopPropagation();
        const mode = opt.dataset.mode;
        segMenu.style.display = 'none';

        // debounce 2s
        const now = Date.now();
        if (now - lastModeSwitchTs < 2000) {
          alert('切换太频繁，请稍候');
          return;
        }
        lastModeSwitchTs = now;

        segBtn.disabled = true;
        segBtn.textContent = '切换中...';
        try {
          const result = await window.electronAPI.invoke('roundtable:pilot-segment-mode', {
            meetingId: state.currentMeetingId, recapIdx, mode,
          });
          // timeline-update IPC 会推回新 entry，自动重渲染
        } catch (err) {
          console.error('[pilot-segment-mode] failed:', err);
          alert('切换段落模式失败：' + err.message);
        } finally {
          segBtn.disabled = false;
        }
      });
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.mr-pilot-segment-menu').forEach(m => m.style.display = 'none');
  });
}
```

- [ ] **Step 4: 处理 timeline-update IPC**

```js
window.electronAPI.on('timeline-update', ({ meetingId, idx, entry }) => {
  if (meetingId !== state.currentMeetingId) return;
  // 找到对应的 timeline DOM 节点替换
  const card = document.querySelector(`.mr-pilot-recap-card[data-recap-idx="${idx}"]`);
  if (card) {
    card.outerHTML = _renderPilotRecapEntry(entry);
    _bindPilotRecapEvents();  // 重新绑定
  }
});

window.electronAPI.on('timeline-append', ({ meetingId, entry }) => {
  if (meetingId !== state.currentMeetingId) return;
  // 在 timeline 容器末尾追加
  const container = document.getElementById('mr-timeline');
  if (container && entry.tag === 'pilot-recap') {
    container.insertAdjacentHTML('beforeend', _renderPilotRecapEntry(entry));
    _bindPilotRecapEvents();
  }
});
```

- [ ] **Step 5: CSS**

```css
.mr-pilot-recap-card {
  background: #161b22;
  border: 1px solid #bc8cff;
  border-radius: 8px;
  padding: 12px 14px;
  margin: 12px 0;
  box-shadow: 0 0 24px rgba(188, 140, 255, 0.12);
}
.mr-pilot-recap-header {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 600;
}
.mr-pilot-recap-title { color: #bc8cff; }
.mr-pilot-recap-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; position: relative; }
.mr-pilot-recap-toggle, .mr-pilot-segment-btn {
  background: #1c232c; border: 1px solid #30363d;
  border-radius: 3px; padding: 2px 8px;
  font-size: 11px; color: #e6edf3; cursor: pointer;
}
.mr-pilot-segment-btn {
  background: rgba(63, 185, 80, 0.12);
  border-color: #3fb950; color: #3fb950;
}
.mr-pilot-segment-menu {
  position: absolute; right: 0; top: 100%;
  background: #161b22; border: 1px solid #30363d; border-radius: 4px;
  padding: 4px 0; min-width: 240px;
  z-index: 100; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}
.mr-pilot-segment-menu div {
  padding: 6px 12px; font-size: 12px; cursor: pointer; color: #e6edf3;
}
.mr-pilot-segment-menu div:hover { background: rgba(63, 185, 80, 0.12); }
.mr-pilot-recap-body { margin-top: 10px; font-size: 13px; color: #e6edf3; line-height: 1.55; }
.mr-pilot-recap-text { margin-bottom: 10px; }
.mr-pilot-recap-segments {
  background: #1c232c; border-radius: 4px; padding: 10px 12px;
  font-family: "JetBrains Mono", Consolas, monospace; font-size: 11.5px;
  white-space: pre; overflow-x: auto; color: #8b949e;
}
```

- [ ] **Step 6: Commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(renderer): timeline pilot-recap card with collapse + A/B mode toggle"
```

---

### Task 8: 主驾期间 timeline 占位

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\renderer\meeting-room.js`

- [ ] **Step 1: 监听主驾期间 turn 增加**

主驾期间，每次 dispatchRoundtableTurn 完成后会发 `roundtable-turn-complete` IPC。renderer 监听：

```js
let _pilotPlaceholderTurns = 0;

window.electronAPI.on('roundtable-turn-complete', ({ meetingId, turnNum }) => {
  if (meetingId !== state.currentMeetingId) return;
  const meeting = state.meetings.get(meetingId);
  if (meeting?.pilotSlot !== null && meeting?.pilotSlot !== undefined) {
    _pilotPlaceholderTurns++;
    _updatePilotPlaceholder();
  }
});

function _updatePilotPlaceholder() {
  let ph = document.getElementById('mr-pilot-placeholder');
  const meeting = state.meetings.get(state.currentMeetingId);
  if (!meeting || meeting.pilotSlot === null || meeting.pilotSlot === undefined) {
    if (ph) ph.remove();
    _pilotPlaceholderTurns = 0;
    return;
  }
  if (!ph) {
    const tlContainer = document.getElementById('mr-timeline');
    ph = document.createElement('div');
    ph.id = 'mr-pilot-placeholder';
    ph.className = 'mr-pilot-placeholder';
    tlContainer.appendChild(ph);
  }
  ph.textContent = `📒 主驾对话进行中（已 ${_pilotPlaceholderTurns} 轮）...`;
}
```

主驾关闭（IPC 返回 recapIdx）后调用 `_updatePilotPlaceholder()` 移除占位。

- [ ] **Step 2: CSS**

```css
.mr-pilot-placeholder {
  background: #1c232c;
  border: 1px dashed #30363d;
  border-radius: 6px;
  padding: 10px 14px;
  margin: 8px 0;
  font-size: 12px;
  color: #8b949e;
  font-style: italic;
}
```

- [ ] **Step 3: Commit**

```bash
git add renderer/meeting-room.js renderer/meeting-room.css
git commit -m "feat(renderer): timeline pilot in-progress placeholder"
```

---

### Task 9: 边界场景

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\main.js`
- Modify: `C:\Users\lintian\claude-session-hub\core\pilot-recap-builder.js`

- [ ] **Step 1: md 路径漂移检测**

在 `core/roundtable-orchestrator.js buildFanoutPrompt` 注入 recap 前：

```js
// recap.recapMdPath 校验
if (recap.recapMdPath) {
  try {
    fs.accessSync(recap.recapMdPath, fs.constants.R_OK);
  } catch {
    // md 不存在了，仅注入摘要不附 path
    recap = { ...recap, recapMdPath: null };
  }
}
```

- [ ] **Step 2: F5-A 切段质量校验**

`_parseSummaryWithSegments` 后检查：

```js
if (segmentTitles && segmentTitles.length > 10) {
  console.warn('[pilot-recap] too many segments, capping to 10');
  segmentTitles = segmentTitles.slice(0, 10);
}
if (segmentTitles && segmentTitles.length < 1) {
  segmentTitles = null;  // 降级到 F5-B
}
```

- [ ] **Step 3: 主驾期间 mention 灰显**

`renderer/meeting-room.js` 的 mention 菜单渲染（约 1973-1979 行）：

```js
function _renderMentionMenu() {
  const meeting = state.meetings.get(state.currentMeetingId);
  if (meeting?.pilotSlot !== null && meeting?.pilotSlot !== undefined) {
    return '<div class="mr-mention-disabled">主驾模式中，请先关闭主驾再使用 mention</div>';
  }
  // 既有逻辑
}
```

- [ ] **Step 4: Commit**

```bash
git add main.js core/pilot-recap-builder.js core/roundtable-orchestrator.js renderer/meeting-room.js
git commit -m "feat: pilot-mode edge cases (md drift / segment validation / mention disable)"
```

---

### Task 10: state.json 持久化 pilotSlot

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\core\meeting-store.js`

- [ ] **Step 1: 序列化时纳入 pilotSlot**

`core/meeting-store.js` 的 save 函数：

```js
function buildSerialized(meeting) {
  return {
    schemaVersion: 1,
    id: meeting.id,
    _timeline: meeting._timeline,
    _cursors: meeting._cursors,
    _nextIdx: meeting._nextIdx,
    pilotSlot: meeting.pilotSlot,  // 新增
    savedAt: Date.now(),
  };
}
```

反序列化时赋值：

```js
function restoreToMeeting(meeting, data) {
  // ... 既有
  if (data.pilotSlot !== undefined) {
    meeting.pilotSlot = data.pilotSlot;
  }
}
```

- [ ] **Step 2: smoke test 持久化**

启动 Hub → 开主驾 → 关 Hub → 重启 → assert meeting.pilotSlot 为 null（已通过 _generatePilotRecap 关闭）。
开主驾后 → 不发消息直接关 Hub → 重启 → assert meeting.pilotSlot 仍为开启状态（尚未通过 _generatePilotRecap）。

- [ ] **Step 3: Commit**

```bash
git add core/meeting-store.js
git commit -m "feat(meeting-store): persist pilotSlot field"
```

---

### Task 11: 版本号

**Files:**
- Modify: `C:\Users\lintian\claude-session-hub\package.json`

- [ ] **Step 1: 改版本**

```bash
grep -n '"version"' package.json
```

把 version `+0.1`（如 `0.5.0` → `0.6.0`）。

- [ ] **Step 2: UI 版本徽章同步**

```bash
grep -n "v0\." renderer/index.html renderer/meeting-room.js
```

- [ ] **Step 3: smoke test + Commit**

```bash
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -10
git add package.json renderer/
git commit -m "chore: bump version (pilot mode)"
```

---

### Task 12: E2E 验收

**Files:**
- Create: `C:\Users\lintian\claude-session-hub\tests\_e2e-pilot-mode-verify.js`

- [ ] **Step 1: 写 E2E 脚本**

`tests/_e2e-pilot-mode-verify.js`：

```js
'use strict';
// E2E 验收 — 主驾模式
// 用法：node tests/_e2e-pilot-mode-verify.js
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9261;
const SHOT_DIR = path.join(__dirname, 'screenshots', 'pilot-mode');

async function shot(client, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const { data } = await client.Page.captureScreenshot({ format: 'png' });
  const file = path.join(SHOT_DIR, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`[shot] ${file}`);
}

async function evalJs(client, expr) {
  const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

(async () => {
  const targets = await CDP.List({ port: CDP_PORT });
  const target = targets.find(t => t.type === 'page');
  const client = await CDP({ target: target.webSocketDebuggerUrl });
  await client.Page.enable();
  await client.Runtime.enable();

  // 假设已有圆桌打开
  await new Promise(r => setTimeout(r, 1500));
  await shot(client, '00-baseline.png');

  // Step 1: 开主驾 Slot 1
  await evalJs(client, `document.getElementById('mr-pilot-btn').click()`);
  await new Promise(r => setTimeout(r, 200));
  await evalJs(client, `document.querySelector('.mr-pilot-option[data-slot="0"]').click()`);
  await new Promise(r => setTimeout(r, 600));
  await shot(client, '01-pilot-on.png');

  // assert 卡片视觉
  const card1Locked = await evalJs(client, `document.querySelectorAll('.mr-ft')[0].classList.contains('pilot-locked')`);
  if (!card1Locked) throw new Error('Card 1 not pilot-locked');
  console.log('[ok] pilot mode UI applied');

  // Step 2: 发 3 轮主驾消息
  for (let i = 1; i <= 3; i++) {
    await evalJs(client, `
      const ib = document.getElementById('mr-input-box');
      ib.textContent = '主驾测试问题 ${i}';
      // 触发发送（按 Ctrl+Enter 或点发送按钮，视实现）
      document.getElementById('mr-send-btn')?.click();
    `);
    await new Promise(r => setTimeout(r, 15000));  // 等 turn-complete
  }
  await shot(client, '02-after-3-turns.png');

  // Step 3: 关闭主驾
  await evalJs(client, `document.getElementById('mr-pilot-btn').click()`);
  await new Promise(r => setTimeout(r, 200));
  await evalJs(client, `document.querySelector('.mr-pilot-option[data-slot="-1"]').click()`);

  // 等摘要生成 (max 60s)
  let recapAppeared = false;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const exists = await evalJs(client, `!!document.querySelector('.mr-pilot-recap-card')`);
    if (exists) { recapAppeared = true; break; }
  }
  if (!recapAppeared) throw new Error('Recap card not appeared in 60s');
  await shot(client, '03-recap-appeared.png');

  // assert md 文件存在
  const recapMdPath = await evalJs(client, `
    document.querySelector('.mr-pilot-recap-segments')?.textContent.match(/C:\\\\\\S+\\.md/)?.[0]
  `);
  if (recapMdPath) {
    if (!fs.existsSync(recapMdPath)) throw new Error('Recap md missing: ' + recapMdPath);
    console.log('[ok] recap md exists:', recapMdPath);
  }

  // Step 4: 切到 F5-B 按轮模式
  await evalJs(client, `document.querySelector('.mr-pilot-segment-btn').click()`);
  await new Promise(r => setTimeout(r, 200));
  await evalJs(client, `document.querySelector('.mr-pilot-segment-menu div[data-mode="turn"]').click()`);
  await new Promise(r => setTimeout(r, 3000));
  await shot(client, '04-segment-turn.png');

  const newBtnText = await evalJs(client, `document.querySelector('.mr-pilot-segment-btn').textContent`);
  if (!/按轮/.test(newBtnText)) throw new Error('Mode not switched to turn: ' + newBtnText);
  console.log('[ok] segment mode switched to turn');

  // Step 5: 发新消息（多人）
  await evalJs(client, `
    const ib = document.getElementById('mr-input-box');
    ib.textContent = '那 Tesla 呢';
    document.getElementById('mr-send-btn')?.click();
  `);
  await new Promise(r => setTimeout(r, 30000));  // 等三家都答完
  await shot(client, '05-after-resume.png');

  console.log('[ok] all E2E assertions passed');
  await client.close();
})().catch(e => {
  console.error('[FAIL]', e);
  process.exit(1);
});
```

- [ ] **Step 2: 启动隔离 Hub + 跑 E2E**

```bash
export CLAUDE_HUB_DATA_DIR=/c/temp/hub-pilot
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9261 &
sleep 4
# UI 中创建 meeting + 进会议室

node tests/_e2e-pilot-mode-verify.js
```

- [ ] **Step 3: 截图归档 + Commit**

```bash
git add tests/_e2e-pilot-mode-verify.js tests/screenshots/pilot-mode/.gitkeep
git commit -m "test(e2e): pilot-mode verify with 5-step flow"
```

- [ ] **Step 4: 关闭隔离 Hub**

```bash
ps -ef | grep "hub-pilot" | grep -v grep | awk '{print $2}' | xargs -r kill
```

---

### Task 13: post-refactor-verify

涉及 8+ 文件改动，触发 `/post-refactor-verify` 流程。

- [ ] **Step 1: grep 残留**

```bash
grep -rn "pilotSlot" main.js core/ renderer/
grep -rn "pilot-recap" main.js core/ renderer/
grep -rn "summarizeWithKind" core/ main.js
```

assert 命名一致 + 无 dead reference。

- [ ] **Step 2: 调用方一致性**

```bash
grep -rn "_buildEnvForKind" core/
grep -rn "splitByTurn\|splitBySmart\|recapBuilder" main.js core/
```

assert pilot-recap-builder 的 export 与 main.js 调用一致。

- [ ] **Step 3: E2E 重跑（Task 12 已做）**

确认 5/5 PASS。

- [ ] **Step 4: 四路审查**

按 `/cli-caller` skill Part 6 多方审查模板：
- 文件：本份改动的所有 git diff
- 输出：高/中置信度问题列表

- [ ] **Step 5: 处理审查反馈**

每条高置信度问题 → 修复 + 新 commit。

- [ ] **Step 6: 放行标记**

通过则在 `docs/post-refactor-verify-records.md` 追加：

```markdown
## 2026-05-XX · pilot-mode
- E2E: 5/5 PASS
- 多方审查: <四路结果>
- 高置信度问题: 0 (或修复 commit hash 列表)
- 放行人: 立花道雪
```

```bash
git add docs/post-refactor-verify-records.md
git commit -m "verify: post-refactor 4-way review pass for pilot mode"
```

---

## Self-Review

### Spec coverage
- 主驾命名 → 全 plan 用 "pilot" 命名 ✓
- 不限字数摘要 + 主驾自己生成 → Task 4 `_buildSummaryPrompt` ✓
- 三层架构 D' + F2 + F5 → Task 4 (D'/F2) + Task 5 (F5 切换) + Task 6 (前缀注入) ✓
- F5-A & B 双模 → Task 4 默认 A + Task 5 切到 B ✓
- summary-engine 5 家扩展 → Task 0 ✓
- toolbar [🚗 主驾] 按钮 → Task 3 ✓
- 卡片 dim/locked → Task 3 ✓
- timeline [主驾回顾] 卡片 → Task 7 ✓
- 主驾期间占位 → Task 8 ✓
- 边界（短主驾 / md 漂移 / mention 灰显） → Task 9 ✓
- 持久化 → Task 10 ✓
- 版本号 → Task 11 ✓
- E2E + post-refactor-verify → Task 12, 13 ✓

### 类型一致性
- `pilotSlot: 0|1|2|null` 在 state / IPC / orchestrator / renderer 全程一致 ✓
- `tag: 'pilot-recap'` 在 main.js / orchestrator / renderer 一致 ✓
- `segments[]` schema 在 builder / IPC / renderer 一致（`{idx, mode, title, mdLineStart, mdLineEnd, turnRange}`） ✓
- `segmentMode: 'smart'|'turn'` 命名一致 ✓
- IPC channel 命名 `roundtable:pilot-toggle` / `roundtable:pilot-segment-mode` 一致 ✓

### 占位符扫描
- 无 TBD / TODO / "implement later" ✓
- 每步含具体代码 ✓
- 命令含具体参数 ✓

### 执行顺序铁律

Task 0 (summary-engine spike + 实现) → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13

特别注意：
- **Task 0 必须先做**（决定后续是否需要 PTY 注入兜底）
- **Task 4 必须在 Task 6 之前**（recap 数据结构定型才能注入）
- **Task 5 在 Task 4 之后**（A/B 切换依赖已有 recap）
- **Task 7 在 Task 4 之后**（timeline 渲染依赖 recap entry schema）
- **Task 12 E2E 必须真测**：CDP 操作真按钮，禁止后端 IPC 假装
- **前置依赖**：本期严格依赖 `2026-05-01-meeting-create-modal.md`（slot index 重构）合入。否则按 slot 排除会因 kind 复用而错乱

---

## 回滚预案

- 任何 Task 失败 → `git reset --hard <last-good-commit>`
- 整体撤回 → `git revert <range>`，保留 docs/
- 用户生产 Hub 不受影响（隔离测试 + 未推 master 之前）

---

## 估时

- Task 0（summary-engine 5 家 spike + 实现）：2 天
- Task 1（pilotSlot state + IPC）：0.5 天
- Task 2（dispatchTurn 过滤）：0.5 天
- Task 3（toolbar 按钮 + 卡片视觉）：0.7 天
- Task 4（切回流程 + recap-builder）：1.5 天
- Task 5（F5-B 切换 IPC）：0.3 天
- Task 6（prompt 注入）：0.5 天
- Task 7（timeline UI 渲染）：1 天
- Task 8（主驾期间占位）：0.3 天
- Task 9（边界场景）：0.5 天
- Task 10（持久化）：0.2 天
- Task 11（版本）：0.1 天
- Task 12（E2E）：0.7 天
- Task 13（post-refactor-verify）：0.7 天

**合计 ~9.5 工作日**（spike 通过）/ ~10.5 天（spike 失败需补 PTY 兜底）

---

## Execution Handoff

```
读 C:\Users\lintian\claude-session-hub\docs\superpowers\plans\2026-05-01-roundtable-pilot-mode.md
按 superpowers:executing-plans 或 superpowers:subagent-driven-development 执行

设计文档: C:\Users\lintian\claude-session-hub\docs\superpowers\specs\2026-05-01-roundtable-pilot-mode-design.md
HTML mockup: C:\Users\lintian\claude-session-hub\docs\roundtable-pilot-mode-final-2026-05-01.html

执行铁律:
1. Task 0 (summary-engine 5 家 spike) 必须先做
2. 严格按 Task 0 → ... → 13 顺序
3. 测试用 CDP 真测，禁止 mock 假测（CLAUDE.md 铁律）
4. 测试 Hub 用 CLAUDE_HUB_DATA_DIR=C:\temp\hub-pilot 隔离启动
5. 严禁 kill 用户生产 Hub 进程
6. **前置依赖**：必须等 meeting-create-modal plan 合入后再做（slot index 架构）
7. 主驾期间消息存进 private store 时按 sid 索引（meeting-create-modal 已规划，本期复用）
8. Task 13 (post-refactor-verify) 含四路审查（按 /cli-caller skill Part 6 模板）
9. 不影响现有功能：旧 meeting 打开 + 主驾 OFF 时行为完全一致
```
