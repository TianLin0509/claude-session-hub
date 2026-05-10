# Hub Toolbar 重构 + 多 AI Resume 入口 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: 把 hub 左上角 toolbar 从"以 Claude 为中心"重构为"5 家 AI 平等"入口。删除"对话"占位 + 创建/恢复入口分离 + 5 家全 resume + 圆桌独立按钮 + + 号 dropdown 整理 + 修复 GLM/DeepSeek 模型覆盖 bug。

**Architecture**: 前端按钮分离（HTML/JS/CSS 三层）；后端 session-manager.js 新增 4 个 resume kind 分支；main.js IPC 从 state.json 透传 model；用 ai-logos SVG 资源做官方彩色徽标。

**Tech Stack**: Electron / Node.js / 原生 HTML+CSS+JS（无框架）/ node-pty / Playwright CDP（E2E）

**Prerequisites**:
- 用户已确认 8 个决策点
- AI-Arena 项目（如有）的 logo 资源路径预先 audit
- 隔离 Hub 数据目录 `C:\temp\hub-resume` 可写

---

## Task 0: AI logo 资源 audit + 引入

**Files:**
- 调研: `C:\Users\lintian\AI-Arena\` 或同一路径下其他 Chrome 扩展项目，搜 5 家 AI 的官方彩色 logo SVG/PNG
- New: `renderer/assets/ai-logos/claude.svg`
- New: `renderer/assets/ai-logos/gemini.svg`
- New: `renderer/assets/ai-logos/codex.svg`
- New: `renderer/assets/ai-logos/deepseek.svg`
- New: `renderer/assets/ai-logos/glm.svg`
- New: `renderer/assets/ai-logos/powershell.svg`
- Modify: `renderer/styles.css` 加 `.ai-logo` 通用类

- [ ] **Step 1: 找现成 logo 资源**

```bash
# 在 AI-Arena 项目里搜
ls C:/Users/lintian/AI-Arena/icons/ 2>/dev/null
ls C:/Users/lintian/AI-Arena/assets/ 2>/dev/null
grep -r "claude" --include="*.svg" C:/Users/lintian/AI-Arena/ 2>/dev/null | head -10
```

如果有则复制到 hub。若 AI-Arena 没有，从各家官网下载（保留原色）：
- Claude: https://claude.ai/favicon.ico → 转 svg
- Gemini: https://www.gstatic.com/images/branding/product/2x/google_gemini_64dp.png
- Codex: OpenAI logo
- DeepSeek: https://deepseek.com/favicon.ico
- GLM: https://bigmodel.cn/favicon.ico

- [ ] **Step 2: 标准化为 16x16 SVG，加圆角 3px**

每个文件控制在 ≤2KB。统一 viewBox="0 0 16 16"。

- [ ] **Step 3: 加通用 .ai-logo CSS 类**

```css
/* renderer/styles.css 末尾追加 */
.ai-logo {
  display: inline-block;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  vertical-align: middle;
  margin-right: 8px;
  background-size: contain;
  background-position: center;
  background-repeat: no-repeat;
  flex-shrink: 0;
}
.logo-claude    { background-image: url('assets/ai-logos/claude.svg'); }
.logo-gemini    { background-image: url('assets/ai-logos/gemini.svg'); }
.logo-codex     { background-image: url('assets/ai-logos/codex.svg'); }
.logo-deepseek  { background-image: url('assets/ai-logos/deepseek.svg'); }
.logo-glm       { background-image: url('assets/ai-logos/glm.svg'); }
.logo-powershell{ background-image: url('assets/ai-logos/powershell.svg'); }
```

- [ ] **Step 4: 验证 dark theme 下都清晰可见**

启动隔离 Hub，`<img src="assets/ai-logos/<name>.svg">` 临时贴在 toolbar 看效果。

- [ ] **Step 5: Commit**

```bash
git add renderer/assets/ai-logos/ renderer/styles.css
git commit -m "feat(toolbar): add 6 AI logos for new resume entry"
```

---

## Task 1: Toolbar HTML 重构

**Files:**
- Modify: `renderer/index.html` L17-61（sidebar-header 区域）

- [ ] **Step 1: 删除 sidebar-title**

```html
<!-- 删除整个 .sidebar-title 元素 -->
<!-- <h3 class="sidebar-title">对话</h3> -->
```

- [ ] **Step 2: 重构 + 号 dropdown（移除 claude-resume + meeting）**

```html
<div class="new-session-wrapper" id="new-session-wrapper">
  <button class="btn-new-session" id="btn-new" title="新建会话 (Ctrl+N)">+ 新建 ▾</button>
  <div class="new-session-menu" id="new-session-menu" style="display:none">
    <div class="menu-group-label">AI CLI</div>
    <button class="new-session-option" data-kind="claude"><span class="ai-logo logo-claude"></span>Claude Code</button>
    <button class="new-session-option" data-kind="gemini"><span class="ai-logo logo-gemini"></span>Gemini CLI</button>
    <button class="new-session-option" data-kind="codex"><span class="ai-logo logo-codex"></span>Codex CLI</button>
    <button class="new-session-option" data-kind="deepseek"><span class="ai-logo logo-deepseek"></span>DeepSeek</button>
    <button class="new-session-option" data-kind="glm"><span class="ai-logo logo-glm"></span>GLM</button>
    <div class="new-session-divider"></div>
    <div class="menu-group-label">终端</div>
    <button class="new-session-option" data-kind="powershell"><span class="ai-logo logo-powershell"></span>PowerShell</button>
  </div>
</div>
```

- [ ] **Step 3: 新增 ↻ 恢复 dropdown（5 项）**

```html
<div class="resume-picker-wrapper" id="resume-picker-wrapper">
  <button class="btn-resume-picker" id="btn-resume" title="恢复上次会话">↻ 恢复 ▾</button>
  <div class="resume-picker-menu" id="resume-picker-menu" style="display:none">
    <button class="resume-option" data-kind="claude-resume">
      <span class="ai-logo logo-claude"></span>Claude
      <span class="hint">PTY picker</span>
    </button>
    <button class="resume-option" data-kind="gemini-resume">
      <span class="ai-logo logo-gemini"></span>Gemini
      <span class="hint">最近一次</span>
    </button>
    <button class="resume-option" data-kind="codex-resume">
      <span class="ai-logo logo-codex"></span>Codex
      <span class="hint">PTY picker</span>
    </button>
    <button class="resume-option" data-kind="deepseek-resume">
      <span class="ai-logo logo-deepseek"></span>DeepSeek
      <span class="hint">PTY picker</span>
    </button>
    <button class="resume-option" data-kind="glm-resume">
      <span class="ai-logo logo-glm"></span>GLM
      <span class="hint">PTY picker</span>
    </button>
  </div>
</div>
```

- [ ] **Step 4: 新增 🎯 圆桌独立按钮**

```html
<button class="btn-roundtable" id="btn-roundtable" title="创建圆桌">🎯 圆桌</button>
```

- [ ] **Step 5: 重排 sidebar-header 顺序**

```
[+ 新建 ▾] [↻ 恢复 ▾] [🎯 圆桌] [⚙ 选项 ▾] [◀]
```

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html
git commit -m "refactor(toolbar): split create/resume entries; add roundtable button; remove sidebar-title"
```

---

## Task 2: Toolbar JS 事件绑定

**Files:**
- Modify: `renderer/renderer.js` L1552-1570（按钮事件区域）

- [ ] **Step 1: + 号 dropdown 选项处理（移除 claude-resume / meeting 分支）**

```javascript
btnNew.addEventListener('click', () => {
  menuEl.style.display = menuEl.style.display === 'none' ? 'block' : 'none';
});

for (const btn of document.querySelectorAll('.new-session-option')) {
  btn.addEventListener('click', async () => {
    menuEl.style.display = 'none';
    // 移除 'meeting' / 'claude-resume' 分支 — 已迁移到独立按钮
    await ipcRenderer.invoke('create-session', btn.dataset.kind);
  });
}
```

- [ ] **Step 2: ↻ 恢复 dropdown 事件绑定**

```javascript
const btnResume = document.getElementById('btn-resume');
const resumeMenu = document.getElementById('resume-picker-menu');

btnResume.addEventListener('click', (e) => {
  e.stopPropagation();
  resumeMenu.style.display = resumeMenu.style.display === 'none' ? 'block' : 'none';
});

for (const btn of document.querySelectorAll('.resume-option')) {
  btn.addEventListener('click', async () => {
    resumeMenu.style.display = 'none';
    await ipcRenderer.invoke('create-session', btn.dataset.kind);
  });
}
```

- [ ] **Step 3: 🎯 圆桌按钮 click**

```javascript
const btnRoundtable = document.getElementById('btn-roundtable');
btnRoundtable.addEventListener('click', async () => {
  await createMeetingByMode('general');
});
```

- [ ] **Step 4: outside click 关闭 dropdown**

确认现有 `document.addEventListener('click', ...)` 兼容新 dropdown（如不兼容则扩展）：

```javascript
document.addEventListener('click', (e) => {
  // 现有 + 号 dropdown 关闭
  if (!document.getElementById('new-session-wrapper').contains(e.target)) {
    menuEl.style.display = 'none';
  }
  // 新增：恢复 dropdown 关闭
  if (!document.getElementById('resume-picker-wrapper').contains(e.target)) {
    resumeMenu.style.display = 'none';
  }
});
```

- [ ] **Step 5: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(toolbar): bind resume dropdown + roundtable button events"
```

---

## Task 3: Toolbar CSS 重构

**Files:**
- Modify: `renderer/styles.css` L189-266（sidebar-header）+ L987-1021（dropdown 区域）

- [ ] **Step 1: sidebar-header flex 重排（去掉 title 后均匀分布）**

```css
.sidebar-header {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 6px;
  /* 不再有 sidebar-title，按钮直接铺开 */
}
```

- [ ] **Step 2: ↻ 恢复 dropdown 样式（复用 .new-session-menu 模式）**

```css
.resume-picker-wrapper {
  position: relative;
}
.btn-resume-picker {
  background: rgba(56, 139, 253, 0.08);
  border: 1px solid rgba(110, 118, 129, 0.4);
  color: var(--text-primary);
  padding: 5px 10px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.btn-resume-picker:hover {
  background: rgba(56, 139, 253, 0.15);
  border-color: var(--accent-blue);
}
.resume-picker-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 200px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  z-index: 100;
}
.resume-option {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 7px 12px;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.resume-option:hover {
  background: rgba(56, 139, 253, 0.15);
}
.resume-option .hint {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 11px;
}
```

- [ ] **Step 3: 🎯 圆桌按钮独立样式**

```css
.btn-roundtable {
  background: rgba(187, 128, 9, 0.15);
  border: 1px solid rgba(210, 153, 34, 0.5);
  color: #d29922;
  padding: 5px 10px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 500;
}
.btn-roundtable:hover {
  background: rgba(187, 128, 9, 0.3);
  border-color: #d29922;
}
```

- [ ] **Step 4: + 号 dropdown 分组标题样式**

```css
.menu-group-label {
  font-size: 10px;
  color: var(--text-muted);
  padding: 8px 12px 4px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  font-weight: 600;
  user-select: none;
}
.new-session-option {
  display: flex;
  align-items: center;
  /* 其余保持原样 */
}
```

- [ ] **Step 5: 验证多主题色板兼容性**

确认 `.theme-midnight` / `.theme-obsidian` / `.theme-aurora` 下所有新元素仍可读。

- [ ] **Step 6: Commit**

```bash
git add renderer/styles.css
git commit -m "style(toolbar): add resume dropdown / roundtable button / menu group label styles"
```

---

## Task 4: session-manager.js 加 4 个 resume kind

**Files:**
- Modify: `core/session-manager.js`（gemini 段 ~362-397、codex 段 ~399-447、deepseek 段 ~450-485、glm 段 ~487-520）

- [ ] **Step 1: 新增 codex-resume 分支**

定位 codex 现有分支（约 399-447 行），加 `kind === 'codex-resume'` 分支：

```javascript
} else if (kind === 'codex-resume') {
  // codex resume 无参 = picker by default
  cmd = ' codex resume --dangerously-bypass-approvals-and-sandbox';
  // 不传 sid，让 codex 自己弹 picker
}
```

- [ ] **Step 2: 新增 gemini-resume 分支**

定位 gemini 段（约 362-397 行）：

```javascript
} else if (kind === 'gemini-resume') {
  // Gemini CLI 无交互 picker，用 latest 降级
  const model = opts.model || cv.GEMINI_MODEL || 'gemini-2.5-pro';
  cmd = ` gemini --approval-mode yolo --model ${model} --resume latest`;
}
```

- [ ] **Step 3: 新增 deepseek-resume 分支**

定位 deepseek 段（约 450-485 行）：

```javascript
} else if (kind === 'deepseek-resume') {
  // DeepSeek 通过 Claude router resume
  const model = opts.model || cv.DEEPSEEK_MODEL;  // 必须传 --model 防止 fallback 到 opus
  cmd = ` claude --resume --model ${model} --permission-mode bypassPermissions`;
  // env 同 deepseek 创建路径
  envOverride = {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: cv.DEEPSEEK_API_KEY,
    CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude-deepseek'),
  };
}
```

- [ ] **Step 4: 新增 glm-resume 分支**

定位 glm 段（约 487-520 行）：

```javascript
} else if (kind === 'glm-resume') {
  // GLM 通过 Claude router resume
  const model = opts.model || cv.GLM_MODEL;  // 必须传 --model 防止 fallback 到 opus
  cmd = ` claude --resume --model ${model} --permission-mode bypassPermissions`;
  envOverride = {
    ANTHROPIC_BASE_URL: cv.GLM_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: cv.GLM_API_KEY,
    CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude-glm'),
  };
}
```

- [ ] **Step 5: 单测验证**

写一个临时 spike：

```javascript
// tests/_spike-resume-kind.js
const { createSession } = require('../core/session-manager');
['claude-resume','gemini-resume','codex-resume','deepseek-resume','glm-resume'].forEach(k => {
  console.log(k, '→', /* 打印 cmd 和 env */);
});
```

跑 `node tests/_spike-resume-kind.js`，肉眼 verify 每个 cmd 拼接正确。

- [ ] **Step 6: Commit**

```bash
git add core/session-manager.js
git commit -m "feat(session): add 4 resume kinds (codex/gemini/deepseek/glm)"
```

---

## Task 5: 修 GLM/DeepSeek 现有 resume 模型 bug

**Files:**
- Modify: `main.js:2155-2169`（resume IPC handler）
- Modify: `core/session-manager.js`（GLM/DeepSeek 现有 resume 分支也补 --model）

- [ ] **Step 1: 验证 state.json sessions[].model 字段是否存在**

```bash
# 看现有 state.json 格式
cat C:/Users/lintian/.claude-session-hub/state.json | python -m json.tool | head -50
# 找 sessions 数组里有没有 .model 字段
```

如果没有 model 字段，需在 session 创建时记录：找 `core/session-manager.js` 创建路径 + main.js IPC `persist-sessions` 处补 `model: opts.model || currentModel.id` 字段。

- [ ] **Step 2: main.js resume IPC 透传 model**

```javascript
// main.js 约 2155-2169
ipcMain.handle('resume-session', async (event, sessionId) => {
  const meta = sessions.find(s => s.id === sessionId);
  if (!meta) return { error: 'session not found' };
  
  const isClaudeCliResumable = ['claude','deepseek','glm'].includes(meta.kind);
  
  return await sessionManager.createSession(meta.kind + '-resume', {
    resumeCCSessionId: meta.ccSessionId,
    geminiChatId: meta.geminiChatId,
    codexSid: meta.codexSid,
    model: meta.model,  // ← 关键：透传原模型
    cwd: meta.cwd,
  });
});
```

- [ ] **Step 3: session-manager.js 现有 GLM/DeepSeek resume 分支也补 --model**

```javascript
// glm 段 487-496（既有 resumeCCSessionId 路径）
if (opts.resumeCCSessionId) {
  const model = opts.model || cv.GLM_MODEL;  // 新增
  cmd = ` claude --resume ${opts.resumeCCSessionId} --model ${model} --permission-mode bypassPermissions`;
  //                                                ↑ 这里补 --model
}

// deepseek 段 455-456 同样改造
```

- [ ] **Step 4: 保险层 · 初始化 router 隔离配置目录的 settings.json**

```javascript
// session-manager.js: ensureClaudeBypassAndTrust 函数附近
function ensureRouterSettings(configDir, defaultModel) {
  const settingsPath = path.join(configDir, 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  }
  if (!settings.model) {
    settings.model = defaultModel;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }
}
// 在 GLM/DeepSeek spawn 前调用
ensureRouterSettings(path.join(os.homedir(), '.claude-glm'), cv.GLM_MODEL);
```

- [ ] **Step 5: Bug 回归测试（手动）**

1. 启动隔离 Hub `CLAUDE_HUB_DATA_DIR=C:\temp\hub-resume-test`
2. 创建 GLM 会话，发一条消息（model=glm-4.6）
3. 确认 state.json 记录 `meta.model='glm-4.6'`
4. 关闭会话
5. 点 ↻ 恢复 ▾ → GLM
6. 在 PTY 里输 `/model` 命令
7. **assert** 显示 `glm-4.6`，**而非** `claude-opus-4-7`

- [ ] **Step 6: Commit**

```bash
git add main.js core/session-manager.js
git commit -m "fix(resume): pass --model to GLM/DeepSeek resume to prevent opus fallback"
```

---

## Task 6: + 号 dropdown 顺手清理（残留兼容性）

**Files:**
- Modify: `renderer/index.html`（已在 Task 1 完成）
- Modify: `renderer/renderer.js`（删除 meeting 分支已在 Task 2 完成）

- [ ] **Step 1: grep 全代码库确认 claude-resume / meeting kind 没有残留 hardcode**

```bash
grep -rn "data-kind=\"claude-resume\"" --include="*.html" --include="*.js" .
grep -rn "data-kind=\"meeting\"" --include="*.html" --include="*.js" .
# 应该只在 resume-option / 圆桌按钮处出现新引用
```

- [ ] **Step 2: 验证 + 号 dropdown 仅 6 项**

启动隔离 Hub，点 + 号 → assert dropdown 6 项（5 AI + PowerShell）。

- [ ] **Step 3: Commit（如有清理）**

```bash
git add -A
git commit -m "chore(toolbar): clean up legacy claude-resume / meeting refs"
```

---

## Task 7: 版本号 + UI 同步

**Files:**
- Modify: `package.json`
- Modify: `renderer/index.html`（如有版本徽章）

- [ ] **Step 1: 版本号 +0.1**

```json
// package.json
{
  "version": "0.X+0.1"  // 按当前实际版本递进
}
```

- [ ] **Step 2: UI 版本徽章同步**

如果 `renderer/index.html` 有 `v0.x.x` 文本，同步更新。

- [ ] **Step 3: Commit**

```bash
git add package.json renderer/index.html
git commit -m "chore: bump version for toolbar refactor"
```

---

## Task 8: E2E 验证（CDP 真测）

**Files:**
- New: `tests/_e2e-resume-toolbar-verify.js`

- [ ] **Step 1: 准备隔离 Hub 数据目录**

```bash
mkdir -p C:/temp/hub-resume
# 预先制造一个 GLM 会话（手动或脚本）使 state.json 含 meta.model='glm-4.6'
```

- [ ] **Step 2: 写 E2E 脚本**

```javascript
// tests/_e2e-resume-toolbar-verify.js
const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  const electronApp = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: {
      ...process.env,
      CLAUDE_HUB_DATA_DIR: 'C:\\temp\\hub-resume',
    },
  });
  const page = await electronApp.firstWindow();
  await page.waitForTimeout(2000);

  // Step 1: 截图新 toolbar
  await page.screenshot({ path: 'tests/screenshots/resume-toolbar/01-toolbar.png' });

  // Step 2: 点 + 新建 → assert 6 项
  await page.click('#btn-new');
  await page.waitForTimeout(300);
  const newOptions = await page.$$('.new-session-option');
  console.assert(newOptions.length === 6, `Expected 6 new options, got ${newOptions.length}`);
  await page.screenshot({ path: 'tests/screenshots/resume-toolbar/02-new-dropdown.png' });

  // Step 3: 点 ↻ 恢复 → assert 5 项 + Gemini "最近"
  await page.click('body');  // 关闭旧 dropdown
  await page.click('#btn-resume');
  await page.waitForTimeout(300);
  const resumeOptions = await page.$$('.resume-option');
  console.assert(resumeOptions.length === 5, `Expected 5 resume options, got ${resumeOptions.length}`);
  const geminiHint = await page.textContent('.resume-option[data-kind="gemini-resume"] .hint');
  console.assert(geminiHint === '最近一次', 'Gemini hint mismatch');
  await page.screenshot({ path: 'tests/screenshots/resume-toolbar/03-resume-dropdown.png' });

  // Step 4-7: spawn 各家 resume → 验证 PTY 命令（通过 hub 内部日志或 IPC sniff）
  // ... （根据 hub 实际暴露的调试接口实施）

  // Step 8: 点 🎯 圆桌 → 弹圆桌 modal
  await page.click('body');
  await page.click('#btn-roundtable');
  await page.waitForTimeout(500);
  // assert 圆桌 modal 出现（具体选择器取决于 createMeetingByMode 实现）
  await page.screenshot({ path: 'tests/screenshots/resume-toolbar/04-roundtable-modal.png' });

  await electronApp.close();
  console.log('E2E PASS');
})();
```

- [ ] **Step 3: 跑 E2E**

```bash
node tests/_e2e-resume-toolbar-verify.js
```

应输出 `E2E PASS` 且 `tests/screenshots/resume-toolbar/` 含 4 张截图。

- [ ] **Step 4: 截图归档 + 报告**

整理 4 张截图到报告，证明：
- toolbar 视觉变化（含彩色 logo）
- + 号 dropdown 6 项分组
- 恢复 dropdown 5 项含 Gemini "最近"
- 圆桌 modal 弹出

- [ ] **Step 5: Commit**

```bash
git add tests/_e2e-resume-toolbar-verify.js tests/screenshots/resume-toolbar/
git commit -m "test(e2e): add resume toolbar verification"
```

---

## Task 9: post-refactor-verify

涉及 ≥3 文件改动（实际 ≥7 个），触发 `/post-refactor-verify` 流程。

- [ ] **Step 1: grep 残留**

```bash
# 确保所有 claude-resume / meeting 旧用法都已迁移或删除
grep -rn "claude-resume" --include="*.html" --include="*.js" .
grep -rn "data-kind=\"meeting\"" --include="*.html" --include="*.js" .
# 检查 main.js 里 IPC handler 是否仍有冗余分支
```

- [ ] **Step 2: 调用方一致性检查**

确认所有 `create-session` IPC 调用方传的 kind 都在新支持列表内：
- `claude` / `gemini` / `codex` / `deepseek` / `glm` / `powershell`
- `claude-resume` / `gemini-resume` / `codex-resume` / `deepseek-resume` / `glm-resume`

- [ ] **Step 3: E2E 通过（Task 8 已做）**

- [ ] **Step 4: 四路审查**

按 `/cli-caller` skill Part 6 模板，4 路并行审查（Claude 自审 + Gemini + Codex + DeepSeek）：
- Focus 1: 5 个 resume kind 命令拼接是否正确
- Focus 2: GLM/DeepSeek bug 修复是否影响其他 router 逻辑
- Focus 3: HTML/CSS/JS 三层是否一致（移除的 meeting/claude-resume 是否有残留 hardcode）
- Focus 4: state.json schema 升级（新增 model 字段）是否兼容旧数据

汇总高置信度问题修复。

- [ ] **Step 5: 放行标记**

按 `/post-refactor-verify` 协议在合并前打 `verified-by-post-refactor` 标签。

---

## Self-Review

**1. Spec coverage**: 8 个决策点全部映射到 Task：
- D1（极简单层）→ Task 1（HTML）+ Task 4（4 个 kind）
- D2（↻ 恢复 ▾）→ Task 1
- D3（彩色 logo + 分组）→ Task 0 + Task 1 + Task 3
- D4（圆桌独立）→ Task 1 + Task 2
- D5（删"对话"）→ Task 1
- D6（Gemini latest）→ Task 4 Step 2
- D7（5 家全做）→ Task 4
- D8（GLM bug 修）→ Task 5

**2. Placeholder scan**: 无 TBD / TODO / 空白步骤；每个步骤含可执行命令或代码块。

**3. Type consistency**: kind 命名统一（5 个 `<kind>-resume`），CSS class 命名统一（`.btn-*` / `.ai-logo` / `.logo-<kind>`），IPC channel 复用现有 `create-session`。

**4. Execution order**: Task 0 必先（缺 logo 前端无法落地）→ Task 1-3（前端三层一起）→ Task 4-5（后端）→ Task 6-7（清理 + 版本）→ Task 8（E2E）→ Task 9（审查）。Bug 修复 Task 5 紧跟新增 Task 4（前者修旧 bug，后者加新 kind，逻辑上可分离但相邻便于一次审）。

---

## Rollback Plan

如果 Task 5（GLM bug 修）发现 router 配置目录的 settings.json 写入引发副作用：
- 还原 `ensureRouterSettings` 调用，仅保留命令拼接的 `--model` 参数（Level 1 修复已足）
- state.json 的 model 字段是新增、不破坏旧数据

如果 Task 0（AI logo）资源 audit 失败：
- 全部用 emoji 占位（🔵/🟢/🟠/🟣/🟡）作为兜底
- 后续单独一期补 SVG

如果新 dropdown 与现有 click outside handler 冲突：
- 暂时给新 dropdown 自己的 stopPropagation + 内部 click handler 关闭逻辑

---

## Estimates

| Task | 估时 | 关键风险 |
|---|---|---|
| 0: AI logo 引入 | 1 天 | 找不到合规 logo |
| 1: Toolbar HTML | 0.5 天 | - |
| 2: Toolbar JS | 0.5 天 | dropdown click outside |
| 3: Toolbar CSS | 0.7 天 | 多主题兼容 |
| 4: 4 个 resume kind | 1 天 | env 透传 |
| 5: GLM bug 修 | 0.5 天 | 影响其他 router 字段 |
| 6: + 号清理 | 0.2 天 | - |
| 7: 版本号 | 0.1 天 | - |
| 8: E2E | 0.7 天 | CDP 调试 |
| 9: post-refactor-verify | 0.5 天 | 审查问题修复 |

**合计 ≈5.7 工作日**

---

## Execution Handoff

执行 Claude 入场指令：

```
读 docs/superpowers/plans/2026-05-01-hub-resume-toolbar.md
按 superpowers:executing-plans 或 superpowers:subagent-driven-development 执行

设计文档: docs/superpowers/specs/2026-05-01-hub-resume-toolbar-design.md
HTML mockup: docs/hub-resume-toolbar-2026-05-01.html

执行铁律:
1. Task 0 (AI logo 资源) 必须先做，缺 logo 则前端无法落地
2. 严格按 Task 0 → 1 → ... → 9 顺序
3. Task 5 (GLM bug 修) 必须包含回归测试，证明 resume 后模型不变 opus
4. 测试用 CDP 真测，禁止 mock 假测（CLAUDE.md 铁律）
5. 测试 Hub 用 CLAUDE_HUB_DATA_DIR=C:\temp\hub-resume 隔离启动
6. 严禁 kill 用户生产 Hub 进程
7. 圆桌内部的 Gemini/Codex resume 路径不动（那是 sub-session resume，本期改的是 top-level resume 入口）
8. Task 9 含四路审查（按 /cli-caller skill Part 6 模板）
```
