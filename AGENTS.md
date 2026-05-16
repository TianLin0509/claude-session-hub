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

## 验证要求

- 语法级改动至少跑对应 `node --check` 或项目已有单测。
- UI/GUI 行为改动需要真实 Hub 实例 + CDP/Playwright 或截图证据；如果不能运行，要说明原因。
- 最终回答必须列出实际执行过的验证命令和结果；如果只做静态检查，不能说 E2E 通过。
