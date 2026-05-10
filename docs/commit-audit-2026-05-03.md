# Commit Audit 2026-05-03

审计目标：揪出 Claude Session Hub 仓库 2026-05-02 当天 commit message 描述之外的"夹带改动"。
审计窗口：`b9fdaca`（2026-05-02 01:15:38）至 `7eafbae`（2026-05-03 00:11:43）。
审计方法：`git show <hash> --stat` + `git show <hash> -- <file>` 全量阅读 diff，与 commit message 描述比对。

---

## 审计范围（commit hash + subject 列表）

按时间正序：

| Hash | Time | Subject |
|---|---|---|
| `b9fdaca` | 01:15:38 | feat(ui): refine settings sidebar status display |
| `4163a20` | 02:06:33 | fix(memo): 把清空按钮改为关闭按钮 |
| `45349cf` | 02:13:31 | feat(arch): 圆桌 Shell/卡片分离 + 树形 sidebar + 逃生按钮 + 截断反转 (Plan 阶段 1) |
| `efe4042` | 09:37:29 | feat(meeting): Plan 阶段 2 + 圆桌 UI 槽位制重构（御三家配色） |
| `2c759ba` | 11:52:45 | refactor(meeting): 主驾重构 — 删除 pilot recap/私聊基础设施 + 引入 dispatchMode 路由 |
| `19fb760` | 12:12:14 | fix(meeting): 主驾 UI 视觉与行为对齐 — observer 模式下主驾真正灰化 |
| `457165c` | 12:25:12 | fix(meeting): 副驾发言时主驾视觉强制冻结（修复 v3） |
| `b2ea05a` | 13:11:47 | fix(meeting): drop dispatch visual layer (v4 minimal — preserve PTY truth) |
| `2783338` | 14:34:05 | fix(meeting): 三个圆桌 UI bug 修复（卡片状态/逃生按钮/Enter 提交） |
| `636cfd3` | 14:44:00 | fix(meeting): 一键提取按钮泛化 + ClaudeTap idle-timer 兜底 emit |
| `adb1f43` | 15:00:27 | refactor(ai-kinds): 建立 AI kind 单一真理源 + 修 4 个 P0 + 2 个 P1 硬编码 bug |
| `4b1c4bc` | 15:23:13 | fix(transcript-tap): GeminiTap idle-timer 兜底（修第一轮 token 延迟时卡片不更新） |
| `b1f2cb7` | 16:17:31 | feat(roundtable): plan F M1 — L1 BASE_RULES 简化 + L2 COVENANT_GENERAL |
| `27e4e9b` | 16:33:55 | feat(roundtable): plan F M2 — 注入矩阵 + timeline.md + 调度上下文段 |
| `72cf554` | 16:39:55 | feat(roundtable): plan F M3 — 摘要按钮 + 五元组 + summary-brief mode |
| `a90c17b` | 16:53:43 | fix(roundtable): plan F 多方审查发现的 3 个真 bug |
| `fd1d2e1` | 23:35:16 | feat(roundtable): 圆桌成员 CLI 软隔离（禁 skill+plugin）+ BASE_RULES 加"非任务执行"铁律 |
| `a9d4056` | 2026-05-03 00:11:32 | fix(main): 删除单实例锁恢复桌面图标多开（回退 2c759ba 夹带改动） |
| `7eafbae` | 2026-05-03 00:11:43 | fix(meeting): 圆桌输入框 keydown 检查 isComposing 修中文 IME 被吞 |

---

## 高风险夹带（影响功能/启动/数据完整性）

### H1. b9fdaca: 应用品牌全面改名（Claude Session Hub → 圆桌）

- commit: `b9fdaca` `feat(ui): refine settings sidebar status display`
- 夹带:
  - `C:\Users\lintian\claude-session-hub\package.json:2-21` `name` / `version` / `description` / `appId` / `productName` / installer icon 全部改名（`claude-session-hub` → `roundtable`，version `0.6.0` → `0.7.0`）
  - `C:\Users\lintian\claude-session-hub\main.js:395` `claude-wx.ico` → `roundtable.ico`
  - `C:\Users\lintian\claude-session-hub\main.js:405` 窗口 title `Claude Session Hub` → `圆桌`
  - `C:\Users\lintian\claude-session-hub\main.js:2253` Notification 默认 title 改名
  - `C:\Users\lintian\claude-session-hub\renderer\index.html:6` `<title>` 改名
  - main.js 全文 ~25 处 `[hub]` 日志前缀改成 `[圆桌]`
  - 新增 `roundtable.ico` 二进制
- 影响: 桌面快捷方式名 / 任务栏标题 / Windows 通知标题 / 安装包元信息全部变化；rebuild 时 NSIS 输出二进制名也会变。这是产品定位级改动，应该独立 commit + 可见的"rename release"，不该夹在一个 sidebar UI tweak 里。版本号也跳了 0.6 → 0.7，但 changelog 缺失。

### H2. b9fdaca: 新增 core/hub-config.js 整文件（172 行配置加载器）

- commit: `b9fdaca` `feat(ui): refine settings sidebar status display`
- 夹带: 新增 `C:\Users\lintian\claude-session-hub\core\hub-config.js` 全文件。引入新的优先级配置抽象（env > config.json > legacy secrets.toml > default），新增 Codex API 后端字段（`codex_backend` / `codex_api_*` / `codex_api_provider`），引入 `getConfig` / `clearConfigCache` / `saveConfig` / `getConfigPath` / `checkMissingConfig` API。
- 影响: 这是一个**架构层**新模块，下游 `core/session-manager.js` 后续 commit 还在 require 它（adb1f43、fd1d2e1），是依赖链的根。完全应单独 commit + tests。"refine sidebar status display"几乎不应触及此层。

### H3. b9fdaca: session-manager.js 引入 4 个新 session kind（gemini/codex/deepseek/glm-resume）+ Codex API 后端

- commit: `b9fdaca` `feat(ui): refine settings sidebar status display`
- 夹带:
  - `C:\Users\lintian\claude-session-hub\core\session-manager.js:178-184` 新增 `gemini-resume` / `codex-resume` / `deepseek-resume` / `glm-resume` 四种 session kind 的 isXxx 判定
  - `core\session-manager.js:103-141` 新增 `tomlString` / `getCodexApiHome` / `ensureCodexApiProfile` / `isCodexApiBackend` 四个 helper（写 codex-api-profile/config.toml + auth.json 到 hubDataDir）
  - `core\session-manager.js:431-617` Gemini/Codex/DeepSeek/GLM 启动 cmd 全部新增 `kind === 'X-resume'` 分支，分别走 `--resume latest` / `codex resume` / `claude --resume --model X --permission-mode bypassPermissions`
  - `core\session-manager.js:680-694` `relaunchCli` 同步识别 5 种新 kind
  - `core\session-manager.js:858` 导出 `clearSessionManagerConfigCache`
  - `main.js:2172` resume-session IPC 透传 `model` 字段；`RESUME_META_FIELDS` 数组追加 `'model'`
- 影响: 新增了完整的"按 kind resume picker" 启动路径（沿着 b9fdaca 改的 index.html "↻ 恢复 ▾" 下拉菜单），并把 Codex 接入了第三方 API 后端（packycode 默认）。这是两个**新功能**（按 AI 家族分发的 resume / Codex API 后端），都被 squash 进了 sidebar UI 的 commit。任何后续 PTY/启动行为问题排查时这次 commit 是高优嫌疑点。

### H4. b9fdaca: renderer 整体 sidebar 重构（远超 "refine status display"）

- commit: `b9fdaca` `feat(ui): refine settings sidebar status display`
- 夹带:
  - `renderer\index.html:13-90` sidebar header 区整块重写：`+ 新建` / `↻ 恢复` / `🎯 圆桌` / `⚙ 选项` 四组按钮 + 各自下拉菜单；删除"Sessions"标题和会话计数、删除"Search sessions…"搜索输入框
  - `renderer\renderer.js:300-303 / 542-548 / 1565-1581` 删除 `searchInputEl` / `searchQuery` / `filtered` 列表过滤逻辑（**搜索功能被静默删除**）
  - `renderer\index.html:170-...` 新增完整的 `#config-modal`（HTTP 代理 + Claude/Gemini/Codex/DeepSeek/GLM 五段独立配置详情），把"⚙ 选项 → 设置"打开的 modal 整块嵌入 HTML
- 影响: 用户原有的"sidebar 关键词搜索会话"工作流被无声删除，没有 commit message 提及，没有迁移路径，只有 sidebar 头部按钮重排。同时 Settings Modal 是个新 ~1400 行 UI 块，任何后续的配置 bug 都得回到这次 commit 找根因。

### H5. 2c759ba: Electron 单实例锁（已被 a9d4056 回退，但仍记录）

- commit: `2c759ba` `refactor(meeting): 主驾重构 — 删除 pilot recap/私聊基础设施 + 引入 dispatchMode 路由`
- 夹带: `C:\Users\lintian\claude-session-hub\main.js:316-326`（已被 a9d4056 删除）
  ```js
  const enforceSingleInstance = !process.env.CLAUDE_HUB_DATA_DIR;
  if (enforceSingleInstance && !app.requestSingleInstanceLock()) { app.exit(0); }
  if (enforceSingleInstance) {
    app.on('second-instance', () => { mainWindow.show(); mainWindow.focus(); });
  }
  ```
- 影响: 桌面图标双击启动会被踢回前台，破坏多开工作流。已由 a9d4056 回退。**用户已确认**。

### H6. 2c759ba: createWindow 启动时序改造

- commit: `2c759ba` `refactor(meeting): 主驾重构 — 删除 pilot recap/私聊基础设施 + 引入 dispatchMode 路由`
- 夹带: `C:\Users\lintian\claude-session-hub\main.js:443-456`
  ```js
  let hasShown = false;
  const showMainWindow = () => {
    if (hasShown || !mainWindow || mainWindow.isDestroyed()) return;
    hasShown = true;
    mainWindow.maximize();
    mainWindow.show();
  };
  ipcMain.once('renderer-sidebar-ready', showMainWindow);
  mainWindow.webContents.once('did-finish-load', showMainWindow);
  mainWindow.webContents.on('did-finish-load', () => { ... });
  setTimeout(showMainWindow, 4000);
  ```
  原本是 `mainWindow.maximize(); mainWindow.show();` 两行同步执行，改成事件驱动 + 4s setTimeout 兜底。新增 `renderer-sidebar-ready` IPC 信号（4163a20 里的 renderer.js 发出方）。
- 影响: 启动时序从"立即显示"改为"等 renderer ready 或 4s timeout"。如果 renderer 因任何问题阻塞 4 秒以上才显示，就是这次改动的副作用；如果 renderer 启动慢于预期（如冷启动 / 大量 session 历史），用户会看到 4s 黑屏。**目前未回退**。

### H7. 2c759ba: STARTUP_TRACE 日志桩

- commit: `2c759ba` `refactor(meeting): 主驾重构 — 删除 pilot recap/私聊基础设施 + 引入 dispatchMode 路由`
- 夹带: `C:\Users\lintian\claude-session-hub\main.js:28-33`
  ```js
  const STARTUP_TRACE = process.env.HUB_STARTUP_TRACE === '1';
  const STARTUP_T0 = Date.now();
  function traceStartup(msg) { if (!STARTUP_TRACE) return; console.log(...); }
  ```
- 影响: env-gated，无功能副作用，但 grep 时多一处 trace 桩。属于"调试遗留"，不该夹在 refactor 里。**目前未回退**。

---

## 中风险夹带（影响 UX 但不致命）

### M1. 4163a20: sidebar 树形展开 + AI logo 子项 + Init 异步重构（远超"清空按钮改关闭按钮"）

- commit: `4163a20` `fix(memo): 把清空按钮改为关闭按钮`
- 夹带:
  - `renderer\renderer.js:522-538` 新增 `_expandedMeetings` Set + `localStorage.hubExpandedMeetings` 持久化 + `toggleMeetingExpand` + `_aiLogoHtml` 辅助函数
  - `renderer\renderer.js:592-643` `renderSessionList` 内 meeting 行新增"▶ 展开箭头"+ 折叠状态 class，展开时把 `_meeting.subSessions` 渲染为缩进 child 行（含 model badge）
  - `renderer\renderer.js:2480-2491` `agentUsageLastSeen.gemini/codex` 新字段 + 时间戳追踪
  - `renderer\renderer.js:3759-3825` Init `(async () => {...})` 整段重写：从一次 `Promise.all([5 项])` 拆成主 3 项 + 异步 `.then` 后挂 `get-hub-config-raw` / `get-usage-cache`，并在 `renderSessionList` 后 `ipcRenderer.send('renderer-sidebar-ready')`（这个信号是 2c759ba `createWindow` 启动时序改造的另一半）
  - `renderer\renderer.js:3833-3856` `meeting-created` / `meeting-closed` handler 新增 `_expandedMeetings` 联动
  - `renderer\index.html:107-122` 删除"shell-area 包装"长注释 + 删除 `<div class="mr-terminals">` 元素（架构层删除）
- 影响: commit message 说"备忘录关闭按钮"，但实际包含 5 项独立改动。45349cf 的 commit message **自己都承认**："Task 1 sidebar 树形 (renderer.js) + Task 3 mr-terminals 删除 (index.html) 已被 4163a20 (memo 关闭按钮) 一并 commit"。是有意识的 squash，但夹带行为破坏 git 历史可读性，bisect 时按 commit message 找问题会迷路。

### M2. b9fdaca: package.json 新增 sharp + png-to-ico 依赖

- commit: `b9fdaca` `feat(ui): refine settings sidebar status display`
- 夹带: `C:\Users\lintian\claude-session-hub\package.json:38-39` devDependencies 新增 `png-to-ico` ^3.0.1 / `sharp` ^0.34.5；package-lock.json 因此变化 ~800 行。
- 影响: 这俩是图标生成工具（用于把新增的 logo 转 .ico）。属于本 commit"应用改名"附属操作，但 sidebar status display 本身完全不需要 sharp。npm install 时新增 ~50MB 依赖。

### M3. 7eafbae: 删除"🔧 进 shell"逃生按钮 + 扩展 partial.status 状态映射

- commit: `7eafbae` `fix(meeting): 圆桌输入框 keydown 检查 isComposing 修中文 IME 被吞`
- 夹带:
  - `renderer\meeting-room.js:349-360` `partial.status` 新增 4 个分支处理：`absent` / `errored` / `manual_extracted` / `soft_alert`（功能扩展）
  - `renderer\meeting-room.js:560-562` 删除 `<button data-rt-escape="enter-shell">🔧 进 shell</button>` 按钮（+ 注释从"三大按钮"改"两大按钮"）
  - `renderer\meeting-room.js:912` resend 失败时 alert 文案中"点 [🔧 进 shell] 自己看 PTY"改成"从左侧 sidebar 点该子 session 进 shell"
- 影响: 2783338 的 commit message 明确说"逃生按钮永久常驻：[一键提取] [跳过] [🔧 进 shell] 三按钮"，但 7eafbae 把"进 shell"按钮删除了，commit message 一字未提。用户卡死时少了一个直接逃生入口（理论上仍可经左侧 sidebar 树形展开点子 session 完成，但需多一次操作）。同时 4 个新 partial.status 分支是 UI 状态扩展，与 IME 修复完全无关。

---

## 低风险夹带（注释/日志/格式等无害项）

### L1. b9fdaca: 全文日志前缀 [hub] → [圆桌] 替换

- commit: `b9fdaca`
- 夹带: main.js 全文 ~25 处日志前缀替换
- 影响: 无功能副作用，仅日志输出/grep 时需要匹配新前缀。属于品牌改名 H1 的一部分。

### L2. b9fdaca: main.js relaunchCli 中加 `model` 字段透传到 `info.currentModel.id`

- commit: `b9fdaca`
- 夹带: `core\session-manager.js:720` `_personaInfo` 返回值新增 `info.currentModel ? { model: info.currentModel.id } : {}`
- 影响: 配合 H3 让 model 字段在 resume 链路中保留。无独立副作用。

### L3. efe4042: cli-ready-status 阈值 1500 → 500（main.js:1717-1728）

- commit: `efe4042` `feat(meeting): Plan 阶段 2 + 圆桌 UI 槽位制重构（御三家配色）`
- 验证: commit message 自己列出"cli-ready-status 优先读 roundtableReady 快路径 + 阈值 1500→500 (DeepSeek/GLM 走 Claude router 启动屏偏少)"。
- 影响: 阈值变化是 commit message 描述的范围内，**不算夹带**，但要注意它把"empty-marker buffer 长度判 ready"门槛降到 1/3，可能导致部分 Claude/GLM 启动屏更短的情形被误判为 ready（误差容忍度变低）。仅作背景告知。

---

## Clean commits（diff 与 message 一致的）

- `45349cf`: clean（自己承认部分代码已被前一个 commit "代领"，但本 commit 范围内 diff 与 plan 阶段 1 主体描述相符；main.js immersive handler no-op 与 message 一致）
- `efe4042`: clean（御三家槽位 CSS + Plan 阶段 2 修复完全对齐 message）
- `19fb760`: clean（pilot 视觉 v2，CSS + JS 与 message 描述完全对齐）
- `457165c`: clean（pilot 视觉 v3，message 自述清晰）
- `b2ea05a`: clean（v4 删除 dispatch 视觉层，message 与 diff 完全对齐）
- `2783338`: clean（三个 bug 修复，每条都有对应 diff）
- `636cfd3`: clean（一键提取 + idle-timer，message 详尽对齐 diff）
- `adb1f43`: clean（ai-kinds 单一真理源 + 6 个 bug，message 列举完整对应 diff）
- `4b1c4bc`: clean（GeminiTap idle-timer，与 ClaudeTap 同套思路对齐）
- `b1f2cb7`: clean（plan F M1 BASE_RULES + COVENANT_GENERAL 拆分，与 message 一致）
- `27e4e9b`: clean（plan F M2 注入矩阵 + timeline.md，新模块 + 测试齐全）
- `72cf554`: clean（plan F M3 摘要按钮 + 五元组）
- `a90c17b`: clean（plan F 后置审查 3 个真 bug 修复）
- `fd1d2e1`: clean（圆桌 CLI 软隔离 + BASE_RULES 铁律，message 对齐 diff）
- `a9d4056`: clean（明确说明在回退 2c759ba 夹带）

---

## 待人工判断（灰色地带）

### G1. b9fdaca 是不是"重命名 release"

如果 b9fdaca 的真实意图是"把项目从 Claude Session Hub 正式更名为'圆桌'"，那它整体是一个 release commit，应当独立成 PR / 单独打 tag。subject 写成 "feat(ui): refine settings sidebar status display" 严重低估了影响面。建议**人工确认**：
- 是否要把 b9fdaca 拆分成"rename release"（package.json/main.js 标识）+ "settings UI"（sidebar/Modal）+ "Codex API backend"（hub-config.js + session-manager.js）三个 commit
- 如果不打算拆分，至少在 CHANGELOG 里补一条 "v0.7.0 — 项目更名为圆桌 + Codex 第三方后端 + 设置中心 UI"

### G2. 4163a20 + 45349cf 的"协同 squash"是否可接受

这两个 commit 由 plan 阶段 1 拆分而成，但部分代码被错误地放进了 4163a20（memo 修复）。45349cf 在 message 里诚实承认。是否需要事后整理（如 git rebase 修 message，或合并为一次 fixup commit）由你判断。从审计角度，这是已知账目，不构成欺诈。

---

## 建议：top 3 应优先回退或单独修复的夹带

### 1. 拆分 b9fdaca（最优先）

包含 ≥4 项重磅变更（应用改名、新配置层、Codex API 后端、Sidebar 新功能 + 设置 Modal、删除搜索功能）。任何后续启动/品牌/配置 bug 都将首先怀疑这个 commit。建议：
- 如果还在本地未推送，`git rebase -i HEAD~N` 拆成 4 个独立 commit
- 如果已推送，至少补一份 release note 把这 4 项拆开记录，并把"删除会话搜索"作为 breaking change 公示
- 验证：`grep -r "Claude Session Hub" .`（应仅剩 docs / changelog）；`renderer\renderer.js` 里 `searchQuery` 已彻底无遗存

### 2. 处理 2c759ba 剩余夹带（H6 createWindow 启动时序 + H7 STARTUP_TRACE）

a9d4056 已回退单实例锁，但启动时序改造（事件驱动 + 4s setTimeout）和 STARTUP_TRACE 仍在 main.js 里。建议：
- **H6 启动时序**：评估是否要回到原始的 `maximize() + show()` 同步两行。事件驱动方案的好处是"等 renderer ready 再显示"避免白屏闪烁，但代价是引入 4s 兜底（renderer 卡住时用户会看到 4 秒黑屏）。如果保留，应在 commit 里明确记录"启动时序：等 renderer-sidebar-ready 或 4s timeout"。
- **H7 STARTUP_TRACE**：env-gated 无害，可保留，但建议挪到 `core/dev-trace.js` 或类似位置避免主入口噪音；或者直接 revert（生产环境永远 env 不命中）。
- 验证：`HUB_STARTUP_TRACE=1 npm start` 看 trace 是否仍按预期打印；冷启动测桌面图标双击平均显示时间是否在 4s 内。

### 3. 7eafbae 复核"🔧 进 shell"按钮删除

7eafbae 的 commit message 仅讲 IME 修复，但删除了 2783338 刚刚才"永久常驻"的逃生按钮。建议：
- 跟用户确认是否有意删除（也许是 7eafbae 同期的另一个修复决定）
- 如果是有意删除，补一个独立 commit 解释"逃生入口改走 sidebar 子 session 单击"的设计权衡
- 同时复核 partial.status 4 个新分支（absent / errored / manual_extracted / soft_alert）是不是 IME 修复时顺手 cherry-pick 的别处代码——这些状态映射本应在 2783338 或 636cfd3 等 status 相关 commit 里出现
- 验证：用户在 thinking 状态下能否找到"进 shell"入口；4 个新 partial.status 在哪个 IPC 真实触发，是否需要后端配套
