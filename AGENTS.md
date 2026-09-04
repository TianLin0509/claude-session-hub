# Hub Codex Rules

## 基本规则

- 默认用中文回答；交付 HTML、MD、截图、日志等本地产物时必须给绝对路径。
- 先读原始需求和相关设计文档，再判断 UI 或功能是否真的完成；AC 通过不等于功能完整。
- Bug 修复必须先找根因：复现、看日志、追调用链、确认根因、再改代码。不要猜测式补丁。
- 默认做窄改动、低风险、行为保持型修复；不要顺手重构无关模块。

## 生产 Hub 保护

- 禁止随意操作用户正在使用的生产 Electron/Hub 进程，包括 `npm start`、`electron .`、直接 kill `electron.exe`、改生产 `state.json`、改生产 Hub 配置，除非用户明确要求。
- 需要运行 Hub 做验证时，必须使用隔离数据目录，例如设置 `CLAUDE_HUB_DATA_DIR` 到临时目录，并使用独立 remote debugging port。
- Playwright/CDP 可以操作测试 Hub 窗口，但不能把脚本绕过真实 Hub 行为当作 E2E 结果。

## node_modules 完整性

- `npm install`、`npm ci`、`npm prune`、`npm run dist`、切换修改 `package.json` / `package-lock.json` 的分支，都属于 node_modules 风险操作。
- `npm run dist` 禁止在主工作目录直接跑；如需打包，应在独立 worktree 中执行，避免 electron-builder rebuild/prune 污染源目录。
- 风险操作后必须 smoke test Hub 启动。看到 hook server 正常监听才算通过；如果报 `Cannot find module`，优先按 `package-lock.json` 执行 `npm install` 补齐依赖。
- `dist/*.exe` NSIS 安装器不是开发启动验证方式；测试源环境应走 `node_modules\electron\dist\electron.exe` 或项目约定的启动脚本。
- 遇到 Windows `EBUSY` 时，先确认是否是自己启动的近期测试 `electron.exe` 锁文件；禁止误杀用户生产 Hub。

## 隔离测试模板

- 单代码多实例测试：从主目录启动，但每个实例使用不同 `CLAUDE_HUB_DATA_DIR` 和 remote debugging port。
- 分支并行测试：使用 `git worktree add <dir> HEAD`，并通过 junction 复用主目录 `node_modules`；不要在测试副本里重复 `npm install`。
- 禁止 `npx electron`；必须直调 `<hub-dir>\node_modules\electron\dist\electron.exe`。
- 禁止传 `--user-data-dir` 造成路径语义混乱；隔离只通过 `CLAUDE_HUB_DATA_DIR`。
- 创建 junction 后必须检查 return code；失败要立即停止验证并说明。

## UI 和终端风险区

- 主要 UI shell 在 `renderer\index.html`；普通 session 终端、侧边栏、preview、resize 逻辑主要在 `renderer\renderer.js` 和 `renderer\styles.css`。
- meeting room 专属 UI 主要在 `renderer\meeting-room.js` 和 `renderer\meeting-room.css`。
- 普通 session 输出链路应保持单写入：PTY data -> main -> renderer -> xterm。看到“重复回答”时，先排查 TUI 整屏重绘、resize/reflow、terminal reopen，而不是直接认定模型重复输出。
- 终端 resize 相关改动要特别谨慎；`ResizeObserver`、sidebar collapse、preview splitter、zoom、show terminal 都可能触发重绘。

## 往 CLI 输入框发 prompt（2026-09-03）

- **禁止盲发回车**：任何 `setTimeout(..., '\r')` 或 `text + '\r'` 合并单写都不许再出现。
  node-pty 在 Windows 上写的是有内部队列的 named pipe socket，长 payload 没排空时那个 `\r`
  会与 `BP_END` 落进同一个 stdin chunk 被 TUI 当粘贴尾巴吃掉 —— 固定毫秒数必然在某个体积上失效。
- 发 prompt 一律走 `session:send-prompt`（`main\ipc\prompt-submit-handlers.js`）或
  `groupChatWatcher.sendToPty`。裸 `terminal-input` 只留给真·按键和宿主 shell 短命令。
- 闭环四环节缺一不可：分块投喂 → 体积自适应 settle + 等折叠标记 → 等语义确认
  （`agent-turn-started`）→ 缺确认才补一次有界回车。拿不到确认要如实报 `stuck` 并在 UI 上亮出来。
- 契约测试 `tests\unit-prompt-submit-ui-contract.test.js` 守住以上各条，改动前先读。
- 加 CLI 输出的模式匹配时必须拿真实样本核对：折叠标记正则曾漏掉现版 Claude 的
  `[Pasted text #1 +120 lines]`，导致 paste 巡检对 Claude 长期失效而无人察觉。

## 验证要求

- 语法级改动至少跑对应 `node --check` 或项目已有单测。
- UI/GUI 行为改动需要真实 Hub 实例 + CDP/Playwright 或截图证据；如果不能运行，要说明原因。
- 最终回答必须列出实际执行过的验证命令和结果；如果只做静态检查，不能说 E2E 通过。

## 梦境系统与记忆面板（2026-08-01）

- 管线在 `core\dream-consolidation.js`（采集→蒸馏→落盘；写前快照 + changelog.jsonl 可回溯），只读巡检在 `core\memory-inspector.js`。
- **规范库（home 桶）自身不是孤岛**：巡检、孤岛采集、`mergeIslandBucket` 三处都必须排除它——它是所有 junction 的目标，漏判会把规范库合并进自己或把已共享内容重复蒸馏（2026-08-01 三连坑）。
- 增量去重：候选按内容指纹（excerpt sha256）跳过已蒸馏项，指纹只在上轮蒸馏成功后标记；`state.json` 的 processed 上限 500 条。
- 孤岛桶可在面板「一键并入规范库」（`memory:merge-island` → `claude-memory-link.mergeIslandBucket`，机械合并非蒸馏），行为记 changelog。
- IPC 在 `main\ipc\memory-handlers.js`；面板在 `renderer\memory-panel.js` / `memory-panel.css`，从用量 ticker「记忆」按钮打开。按钮监听必须挂 document 委托——ticker 每次 render 重建 innerHTML，挂在面板 DOM 里会在首次 open 前失效。
- 自动沉淀只写目标文件末尾 `<!-- dream:begin/end -->` 托管区，手写正文区不得动；用户级四件套（kimi/claude/codex/gemini）与工作区根 AGENTS.md+CLAUDE.md+GEMINI.md 多写保持逐字一致，缺哪份不补建。
- 隔离验证梦境/记忆功能必须同时设 `CLAUDE_HUB_HOME_DIR`（否则 memory 孤岛采集扫真实 home、写真实三件套）并清空 `DEEPSEEK_API_KEY`（env 优先于 config.json，父进程的 key 会漏进隔离实例）。
- 测试：`node tests\unit-dream-consolidation.test.js`、`node tests\e2e-memory-panel-cdp.js`。

## 版本号（2026-08-29）

- 用户规矩：**所有对 Hub 的改动，完成后在同一提交里同步升版本号**（默认 patch 位；纯文档/纯测试可不动）。
- 理由：Hub 源码模式运行且没有单实例锁，桌面上常年并存多个实例各持不同时刻的代码。窗口标题 `AI 群聊 Hub：PID <pid> v<version>` 动态读 `package.json`，版本号是唯一能一眼确认"这个窗口跑的是不是新代码"的信号。
- 同步 3 处：`package.json` 的 `version`、`package-lock.json` 的顶层 `version` 和 `packages[""].version`。用 `node tests\unit-hub-version-sync.test.js` 守。
- 不要动 `tests\unit-hub-exe-branding.test.js` / `tests\unit-process-lifecycle-journal.test.js` 里的版本字面量——那是 fixture 输入和 `app.getVersion` mock，不是生产版本号。
- 升版本会触发 `core\hub-exe-branding.js` 重建 `AIGroupChatHub.exe`；该路径已处理"副本被运行中的 Hub 占用"（先 rename 成 `.stale-*` 再替换），**不要为此关生产实例**。
