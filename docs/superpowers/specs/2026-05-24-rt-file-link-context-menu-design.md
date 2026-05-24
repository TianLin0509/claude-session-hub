# rt-file-link 右键菜单设计

- **日期**：2026-05-24
- **作者**：立花道雪 + Claude（brainstorming）
- **状态**：设计阶段，待 writing-plans

## 目标

Hub 当前识别正文里的文件路径 / URL，包成 `<a class="rt-file-link" data-path="...">`，左键和右键都会触发 `openPreviewPanel`（右键实际上是浏览器默认菜单，等于无操作）。本设计新增**右键专属菜单**，提供 4 个常用动作；左键保持原状（直接预览）。

菜单 4 项（按出现顺序）：

1. **复制绝对路径** — 把路径文本塞剪贴板（粘出来是字符串）
2. **复制对应文件** — 把文件对象塞剪贴板（Windows 资源管理器 Ctrl+C 风格，粘出来是文件本身）
3. **打开上一级文件夹** — 资源管理器打开父目录并高亮该文件
4. **在外部打开** — 系统默认应用打开（文件）或外部浏览器打开（URL）

URL 类型的链接也弹菜单，但只显示「复制 URL」+「在外部浏览器打开」2 项（剩两项对 URL 无意义，直接隐藏不显示）。

## 非目标

- 不改变左键预览的任何行为
- 不引入全局 toast 通知系统（失败仅 `console.warn`）
- 不支持复制文件**内容**到剪贴板（用户明确要"对象"语义）
- 不支持复制多文件（一次右键只对应一个链接）
- 不支持自定义快捷键

## 架构

### 模块边界

新增 1 个 renderer 模块（`renderer/path-link-context-menu.js`）+ 1 个 main IPC handler（追加到 `main/ipc/path-handlers.js`），其余复用现有代码。

```
[正文 DOM]
  └─ <a class="rt-file-link" data-path="...">   ← path-link.js 已包好
       │ contextmenu 事件（capture 阶段）
       ▼
[path-link-context-menu.js]   ← 本设计新增
  │  • 解析 data-path → URL / 绝对路径 / 相对路径（按 session cwd 解析）
  │  • 根据类型动态隐藏/显示菜单项
  │  • 4 个 action 分发：
  │       copy-abs-path   → clipboard.writeText（renderer 直调）
  │       copy-file       → IPC 'clipboard-copy-file'   ←─┐
  │       show-in-folder  → shell.showItemInFolder（renderer 直调）
  │       open-external   → shell.openPath / openExternal（renderer 直调）
  ▼                                                         │
[main/ipc/path-handlers.js]  ← 追加 1 个 handler           │
  └─ ipcMain.handle('clipboard-copy-file', ...) ←──────────┘
       │ spawn powershell -NoProfile -NonInteractive -Command
       │   "Set-Clipboard -LiteralPath '<safe-quoted-path>'"
       ▼
[Windows 剪贴板 CF_HDROP]
       ▼
任意应用 Ctrl+V 粘出文件对象
```

### 文件清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 新增 | `renderer/path-link-context-menu.js` | 右键菜单 controller |
| 修改 | `renderer/index.html` | 新增 `<div id="path-link-context-menu">` 容器 + 4 个按钮 |
| 修改 | `renderer/renderer.js` | sidebar-ready 序列里 require 并 init 新 controller |
| 修改 | `main/ipc/path-handlers.js` | 追加 `clipboard-copy-file` handler |
| 新增（可选） | `renderer/styles/path-link-context-menu.css` | 如果复用现有 `.context-menu` 样式则不需要 |

## 详细设计

### 1. DOM 容器（`index.html`）

紧跟 line 101 现有的 `#terminal-context-menu` 后追加：

```html
<div class="context-menu" id="path-link-context-menu" style="display:none">
  <button class="context-menu-item" data-action="copy-abs-path"
          data-label-file="复制绝对路径" data-label-url="复制 URL">复制绝对路径</button>
  <button class="context-menu-item" data-action="copy-file" data-file-only>复制对应文件</button>
  <div class="context-menu-separator" data-file-only></div>
  <button class="context-menu-item" data-action="show-in-folder" data-file-only>打开上一级文件夹</button>
  <button class="context-menu-item" data-action="open-external">在外部打开</button>
</div>
```

- `data-file-only` 属性标记"仅文件路径显示"的 3 项；controller 根据当前链接类型决定显示/隐藏
- `data-label-file` / `data-label-url`：copy-abs-path 按钮文案根据类型在 `open()` 里切换（URL 显示「复制 URL」，文件显示「复制绝对路径」）
- 复用现有 `.context-menu` / `.context-menu-item` CSS（与 session 列表、终端选区菜单视觉一致）
- 分隔线 `.context-menu-separator`：Hub 现有 CSS 没这个类，新增 1 条 `<style>` 或加到 `styles.css`（1px 灰色分隔，2px 上下 padding）

### 2. Renderer Controller（`path-link-context-menu.js`）

#### 接口

```js
function createPathLinkContextMenuController({
  document,
  window,
  menuEl,            // #path-link-context-menu
  clipboard,         // require('electron').clipboard
  shell,             // require('electron').shell
  ipcRenderer,       // require('electron').ipcRenderer
  getSessionCwd,     // (sid) => string | null  (来自 renderer.js)
  normalizeLocalPathForOpen,  // (raw, cwd, requireExists) => string | null
  getActiveSessionId,// () => string | null
  requestAnimationFrameFn = requestAnimationFrame,
}) {
  function init() { ... }
  function open(linkEl, x, y) { ... }
  function close() { ... }
  return { init, open, close };
}
```

#### 事件接入

```js
// capture 阶段拦截，避免被 Electron 默认 contextmenu 或子元素 stopPropagation 抢走
document.addEventListener('contextmenu', (e) => {
  const a = e.target && e.target.closest && e.target.closest('a.rt-file-link');
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  open(a, e.clientX, e.clientY);
}, true /* capture */);
```

#### open(linkEl, x, y) 主流程

```
rawPath = linkEl.dataset.path
isUrl = /^https?:\/\//i.test(rawPath)

if isUrl:
    absPath = rawPath  // 直接用
    isFile = false
else:
    cwd = getSessionCwd(getActiveSessionId())
    absPath = normalizeLocalPathForOpen(rawPath, cwd, /*requireExistsForRel*/ false)
    if !absPath: return  // 无法解析为绝对路径 → 不弹菜单（让浏览器默认菜单接管）
    isFile = true

// 隐藏/显示菜单项
for el in menuEl.querySelectorAll('[data-file-only]'):
    el.style.display = isFile ? '' : 'none'

// copy-abs-path 按钮文案按类型切换
copyBtn = menuEl.querySelector('[data-action="copy-abs-path"]')
copyBtn.textContent = isUrl ? copyBtn.dataset.labelUrl : copyBtn.dataset.labelFile

// 把 absPath 暂存到 controller 闭包
currentTarget = { absPath, isUrl }

// 定位菜单（沿用 termCtxMenu 的边界 fallback 逻辑）
menuEl.style.display = 'block'
menuEl.style.left = x + 'px'
menuEl.style.top = y + 'px'
rAF(() => {
  rect = menuEl.getBoundingClientRect()
  if rect.right > window.innerWidth: menuEl.style.left = (x - rect.width) + 'px'
  if rect.bottom > window.innerHeight: menuEl.style.top = (y - rect.height) + 'px'
})
```

#### 4 个 action 分发

```js
// 在 init() 里给每个按钮挂 click handler，统一从 currentTarget 取数
'copy-abs-path' → clipboard.writeText(currentTarget.absPath)
'copy-file'     → ipcRenderer.invoke('clipboard-copy-file', currentTarget.absPath)
                    .then(r => { if (r && r.error) console.warn('[ctx-menu] copy-file failed:', r.error) })
'show-in-folder'→ shell.showItemInFolder(currentTarget.absPath)
'open-external' → currentTarget.isUrl
                    ? shell.openExternal(currentTarget.absPath)
                    : shell.openPath(currentTarget.absPath)
// 每个动作执行后 close()
```

#### 关闭逻辑

复用 termCtxMenu 风格——`document.mousedown` 在菜单外 close。`Escape` 键也 close（额外加 keydown 监听）。

### 3. Main IPC Handler（`path-handlers.js` 追加）

```js
const { spawn } = require('child_process');

ipcMain.handle('clipboard-copy-file', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return { error: 'invalid path' };
  }
  try {
    const stat = await fs.promises.stat(filePath);
    // 允许文件和文件夹都复制
    if (!stat.isFile() && !stat.isDirectory()) {
      return { error: 'not a file or directory' };
    }
  } catch (e) {
    return { error: 'file not found' };
  }

  return new Promise((resolve) => {
    // -LiteralPath 不解释通配符；单引号路径 + 内部单引号 → 双单引号转义（PowerShell 字符串转义规则）
    const escaped = filePath.replace(/'/g, "''");
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Set-Clipboard -LiteralPath '${escaped}'`
    ], { windowsHide: true });

    let stderr = '';
    ps.stderr.on('data', (d) => { stderr += d.toString(); });
    ps.on('close', (code) => {
      if (code === 0) resolve({ success: true });
      else resolve({ error: stderr.trim() || `exit ${code}` });
    });
    ps.on('error', (e) => resolve({ error: String(e && e.message || e) }));
  });
});
```

**安全性**：
- `path.isAbsolute` 拒绝相对路径（IPC 端拒守，理论上 renderer 已保证）
- `-LiteralPath` 不解释 `*` / `?` 通配符，避免误匹配
- 单引号路径 + 单引号双写转义，杜绝 `'; Remove-Item ...` 注入
- `windowsHide: true` 避免 cmd 窗口闪现

**性能**：
- 单次 spawn ≈ 100-300ms（PowerShell 启动开销），用户右键操作非高频，可接受
- 异步 Promise，不阻塞 UI

### 4. Renderer 入口接线（`renderer.js`）

在已有 controller 初始化序列附近（参考现有 `termCtxMenuController.init()` 处）追加：

```js
const { createPathLinkContextMenuController } = require('./path-link-context-menu');

const pathLinkCtxMenu = createPathLinkContextMenuController({
  document, window,
  menuEl: document.getElementById('path-link-context-menu'),
  clipboard, shell, ipcRenderer,
  getSessionCwd,
  normalizeLocalPathForOpen: _normalizeLocalPathForOpen,  // 已存在内部函数，需 export 到 window 或 require 拿到
  getActiveSessionId: () => activeSessionId,
});
pathLinkCtxMenu.init();
```

**注意**：`_normalizeLocalPathForOpen` 当前在 renderer.js 内部作用域。需要把它暴露到 module 出口或挂到 window，让新 controller 可调。

### 5. 与现有 click 监听器的关系

- `meeting-room.js:573` 全局 `click` 监听器 → 不变，左键继续走 `openPreviewPanel`
- `renderer.js:1373` `.msg-overlay` 内的 `click` 监听器 → 不变
- 本设计只新增 `contextmenu` capture 监听器，**事件类型完全不同，不冲突**

## 数据流（典型场景）

### 场景 1：右键绝对路径文件，复制对应文件

```
用户右键 <a class="rt-file-link" data-path="C:\foo\bar.html">
  → capture 阶段 contextmenu 拦截
  → open(linkEl, x, y)
       isUrl=false, absPath="C:\foo\bar.html", isFile=true
       菜单显示全部 4 项 + 分隔线
  → 用户点击「复制对应文件」
  → ipcRenderer.invoke('clipboard-copy-file', "C:\foo\bar.html")
  → main: spawn powershell Set-Clipboard -LiteralPath 'C:\foo\bar.html'
  → 200ms 后剪贴板包含文件对象
  → close()
用户切到资源管理器/QQ/邮件 Ctrl+V → 粘出 bar.html 文件
```

### 场景 2：右键 URL，外部浏览器打开

```
用户右键 <a class="rt-file-link" data-path="https://example.com">
  → contextmenu 拦截 → open()
       isUrl=true, absPath="https://example.com", isFile=false
       菜单只显示 2 项：「复制 URL」+「在外部打开」
       data-file-only 的 3 项全部 display:none
  → 用户点击「在外部打开」
  → shell.openExternal("https://example.com")
  → 默认浏览器打开
```

### 场景 3：右键相对路径，session cwd 缺失

```
用户右键 <a class="rt-file-link" data-path="docs/foo.md">
  → contextmenu 拦截 → open()
       cwd = getSessionCwd(...)  // 返回 null（dormant session / 未注册）
       absPath = normalizeLocalPathForOpen("docs/foo.md", null, false) → null
       open() 早 return，不显示菜单
  → 浏览器默认菜单接管（一般为空菜单或浏览器自带 inspect）
```

这是有意识的取舍：相对路径无法解析时与其展示 4 个全置灰的按钮，不如直接不弹，行为退化为"右键无响应"。极少触发，可接受。

## 错误处理

| 失败场景 | 处理 |
|---------|------|
| `clipboard.writeText` 抛异常 | 极罕见；try/catch + console.warn |
| `shell.openPath` 返回非空字符串（错误信息） | console.warn |
| `shell.showItemInFolder` 文件不存在 | Electron 自身会打开父目录而不高亮，无需额外处理 |
| `clipboard-copy-file` IPC 失败 | main handler 返回 `{ error }`，renderer console.warn，菜单仍正常关闭 |
| PowerShell 启动失败（极端：被 AV 拦截） | `ps.on('error')` 兜底 |

不引入 toast/弹窗——这些操作失败用户能立即从"剪贴板里没东西"察觉，无需打扰式提示。

## 测试策略

### 单元测试（pytest 风格，可选）

`path-link-context-menu.js` 的纯函数部分（决定 isUrl / 解析 absPath）可抽出测试，但模块本身是 DOM 交互重的 controller，单测 ROI 低。

### E2E 测试（必须）

Hub E2E 通过 CDP 驱动，参考现有 `tests/test-e2e.js`。在隔离 Hub 实例里：

1. 启动 Hub（`CLAUDE_HUB_DATA_DIR=...`）
2. 注入一段带绝对路径的文本到 meeting room 时间线
3. 等渲染出 `.rt-file-link` 元素
4. CDP `Input.dispatchMouseEvent` 模拟右键点击
5. 断言 `#path-link-context-menu` `display:block`
6. 模拟点击各菜单项，断言副作用：
   - 复制绝对路径 → `await page.evaluate(() => navigator.clipboard.readText())` 比对
   - 复制对应文件 → 用 PowerShell `Get-Clipboard -Format FileDropList` 校验
   - 打开上一级文件夹 → 检测 `explorer.exe` 新进程（白名单 PID before/after diff）
   - 在外部打开 → 检测目标进程启动

测试必须遵守 [feedback_e2e_real_user.md](../../../../.claude/projects/C--Users-lintian/memory/feedback_e2e_real_user.md) 和 [feedback_e2e_pid_whitelist.md](../../../../.claude/projects/C--Users-lintian/memory/feedback_e2e_pid_whitelist.md)：真实 UI 驱动 + PID 白名单 diff，禁止时间窗口推断杀进程。

### Smoke test

提交前最低标准：

1. 启动隔离 Hub
2. 手工触发一条 AI 输出含路径
3. 右键链接，4 个动作各试一次，看预期效果
4. URL 链接右键，确认只显示 2 项
5. 相对路径链接右键，确认无菜单（如能造出此场景）

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| `contextmenu` capture 监听被 Electron 默认行为/iframe 抢走 | 用 capture phase + `preventDefault` + `stopPropagation`，参考 termCtxMenu 现有实现已验证可行 |
| `_normalizeLocalPathForOpen` 暴露后破坏封装 | 仅暴露纯函数（输入输出明确，无副作用），不暴露 sessions Map 直接访问 |
| PowerShell spawn 性能差/被 AV 拦截 | 失败有兜底；用户可改用「复制绝对路径」+ 资源管理器手动定位作为 fallback |
| 跨平台（macOS/Linux） | Hub 目前事实上是 Windows-only（CLAUDE.md PowerShell 铁律），本设计 Windows 专属，其他平台 `clipboard-copy-file` 返回 `{ error: 'platform not supported' }`，菜单项可置灰但实际 Hub 用户全在 Windows，影响 0 |
| 菜单和现有 left-click 同时触发 | 不会——contextmenu 和 click 是不同事件类型；capture 阶段 preventDefault 也只阻止默认 contextmenu，不影响后续 click |

## 验收标准

- [ ] 右键 .rt-file-link（绝对路径文件）弹出 4 项菜单
- [ ] 右键 URL 链接弹出 2 项菜单（复制 URL + 外部浏览器）
- [ ] 右键相对路径且 cwd 不可解析时不弹菜单
- [ ] 「复制绝对路径」后剪贴板文本与路径相等
- [ ] 「复制对应文件」后能在资源管理器 Ctrl+V 粘出文件
- [ ] 「打开上一级文件夹」后资源管理器打开且文件被高亮
- [ ] 「在外部打开」按文件/URL 各自走 shell.openPath / openExternal
- [ ] 左键行为 100% 不变（仍直接预览）
- [ ] 菜单视觉与现有 session/terminal 右键菜单一致
- [ ] 菜单超出窗口边界时自动翻转定位
- [ ] 点击菜单外 / Escape 关闭菜单

## 不在本设计范围

- 给 `<pre>` 代码块内的路径添加右键菜单（path-link.js 当前主动跳过 `<pre>`/`<code>`，扩到这里要先评估正则误判风险）
- 多选/批量复制文件
- 菜单项可配置（用户增删）
- Mac/Linux 支持
