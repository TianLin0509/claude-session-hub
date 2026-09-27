# Claude Session Hub 项目规则

Codex / Kimi 等直接读本文件，Claude 经 `CLAUDE.md` 的 `@AGENTS.md` 导入同一份正文。每条规则的来历、事故案例和完整操作步骤见 `docs/agent-rules-background.md`；两处冲突时以本文件为准。

## 生产目录与 worktree

- 主工作目录 `C:\Users\lintian\claude-session-hub` 就是生产：桌面快捷方式直接运行它，且 `main-bootstrap.js` 不装单实例锁，在这里改到一半，下次重启就生效。仓库只有 `master` 一条线。
- 改 Hub 先开 worktree：`git worktree add C:\AIWork\<YYYYMMDD>-<任务>-<席位> -b <分支>`，再 `cmd /c mklink /J <worktree>\node_modules <主目录>\node_modules`（检查返回码）。席位（`-claude1` / `-codex1`）必带，这是并发时区分谁改了什么的唯一信号。
- 在 worktree 提交后，报告改了什么、测了什么，用户同意才合入 master；不在主目录 commit 功能改动。例外：纯文档、用户当次明说直接在主干改的小修、紧急修复（事后说明）。
- 双席位开发群聊中，用户亲自发送开题提示词即授权开题范围内实现，并由独立合并位验证后按项目入口合并；本项目的环境、验证与合并入口在 `.agents/AUTHOR.md`、`.agents/MERGER.md`。
- 主目录出现别人的未提交改动时，先查清归属；不 `git add -A` 扫进自己的提交，也不 `git checkout --` 冲掉。
- 不关闭、重启或 kill 用户在用的生产 Hub，不改生产 `state.json` 与配置；需要运行 Hub 就起隔离实例。

## node_modules 完整性

`main.js` 启动时 require 的任一传递依赖缺失，整个 Hub 就打不开，已多次发生。

- 风险操作：`npm install` / `ci` / `prune` / `run dist`；切换或 pull 进改了 `package.json` / `package-lock.json` 的提交；手工删改 `node_modules`；被 EBUSY 打断的 npm 操作。
- 日常 worktree 的 `node_modules` 是指向生产的 junction，里面禁止任何 npm 安装、裁剪、打包；要动依赖先问用户，并改用自带独立 `node_modules` 的 worktree。`npm run dist` 只在后者里跑。
- 风险操作后做 smoke：`timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20`。看到 `[群聊] hook server listening on 127.0.0.1:...` 才算通过（前缀是 `[群聊]`；`EADDRINUSE` 后 fallback 到下一端口属正常）。未通过前不说已修复。
- 报 `Cannot find module` 先按 lock 执行 `npm install`。主目录被运行中的 electron 锁住（EBUSY）时走旁路：临时目录 `npm ci --ignore-scripts`，只把主目录缺失的顶层包拷回（跳过 electron），不杀生产 Hub；需要停进程时只停自己近期启动的。
- `dist/*.exe` 安装器不用于测试；测试走 `node_modules\electron\dist\electron.exe`、桌面快捷方式或 `start.bat`。
- 清理带 junction 的 worktree：`cmd /c rmdir <wt>\node_modules` → 轮询到 junction 消失 → `cmd /c rmdir /S /Q <wt>` → `git worktree prune`。不用 `git worktree remove --force` 或 PowerShell `Remove-Item -Recurse`：两者在 Windows 上都会穿透 junction，删掉生产依赖（2026-04-30、07-12 实际发生）。

## 隔离测试

- 并行或 E2E 测试用 `CLAUDE_HUB_DATA_DIR=<临时目录>` 隔离状态（未设时即生产目录 `~/.claude-session-hub/`；入口 `core/data-dir.js` 的 `getHubDataDir()`，Chromium userData 与 spawned CLI 自动跟随），加独立 `--remote-debugging-port`；hook 端口 3456–3460、mobile 3470+ 会自动 fallback。只设这个 env，不传 `--user-data-dir`；直调 `<hub>\node_modules\electron\dist\electron.exe`，不用 `npx electron`；测试副本用 junction 复用依赖，不 npm install。
- 测分支代码：`git worktree add <dir> HEAD`（相关改动先 commit），再按上面的方式建 junction。
- 从 Claude Code 会话启动测试 Hub 前，剥离 `CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_HUB_PORT`、`CLAUDE_HUB_TOKEN`、`CLAUDE_HUB_SESSION_ID`。否则子 claude 自认嵌套会话、不写 transcript，stop hook 也会投给错误的 Hub。
- 测记忆或梦境时，再设 `CLAUDE_HUB_HOME_DIR=<临时目录>` 并清空 `DEEPSEEK_API_KEY`，否则会扫描、改写真实记忆并触发真实 LLM 调用。参考 `tests\e2e-memory-panel-cdp.js`；pytest 模板见 `C:\Users\lintian\.ai-team\tests\test_e2e_critical.py::_setup_hub_worktree`。
- 真机 E2E 调用 Claude 优先用 haiku，只跑必要场景。
- 测试窗口不打断用户（2026-09-26）：`tests/helpers/hub-launcher.js` 默认 `background`（屏幕外、不激活、不进任务栏、照常渲染），写 `visible` 的也按后台跑，`HUB_E2E_SHOW_WINDOWS=1` 才真正可见。后台实例默认用内存剪贴板；页面内原生复制（Ctrl+C、`webContents.copy`）仍写系统剪贴板，这类测试设 `CLAUDE_HUB_E2E_REAL_CLIPBOARD=1`。测试 Hub 与 `scripts/run_unit_tests.js` 以低于正常优先级运行（`HUB_TEST_PRIORITY=normal` 恢复；合并闸门固定正常优先级，避免带超时的测试被饿住误回滚）。实现见 `core/e2e-desktop-sandbox.js`。

## 实现与验证

- 先读原始需求和相关设计文档，再判断是否完成；AC 通过不等于功能完整。
- Bug 先复现、看日志、追调用链找到根因再改，不做猜测式补丁。默认窄改动、行为保持，不顺手重构无关模块。
- 语法级改动至少跑 `node --check` 或相关单测。UI 行为改动要在隔离实例上用 CDP/Playwright 模拟真人操作或留截图证据，不用后端 IPC 冒充 E2E；无法运行时说明原因。
- 最终回答列出实际执行的验证命令和结果；只做了静态检查就不说 E2E 通过。

## 往 CLI 输入框发 prompt

- CLI 为核心（2026-09-25 用户拍板）：Claude / Codex 默认在 PTY 里跑真实 TUI。状态以 CLI hook 为权威（Claude `settings.json`；Codex `<CODEX_HOME>/hooks.json`，由 `core/codex-hook-integration.js` 部署并写 trusted_hash），落盘 transcript / rollout 是强信号，屏幕识别只能推向「运行中 / 等待」，不能判完成。卡片读 CLI 自己的落盘记录（Claude 走 `core/claude-disk-transcript.js`）。会话身份靠 `--session-id` 与 hook 上报的 session_id + transcript_path 精确绑定，不按 cwd + 时间窗推断。设计见 `docs/design/cli-pty-core.md`。
- 原生后端（Codex App Server / Claude stream-json）只是回退开关：`CLAUDE_HUB_AGENT_RUNTIME=native` 或 config.json `runtime.agent = "native"`，UI 不暴露；开启时走结构化控制接口，未知提交先核对原生历史，不自动重发。
- 发 prompt 一律走 `session:send-prompt`（`main/ipc/prompt-submit-handlers.js`）或 `groupChatWatcher.sendToPty`；裸 `terminal-input` 只用于真按键（ESC、Ctrl+C、方向键）和宿主 shell 短命令。
- 不用固定延时发回车，也不把 `text + '\r'` 合成一次写入。原因：Windows 上 node-pty 写的是带内部队列的 named pipe，长 payload 未排空时 `\r` 会与粘贴结束符落进同一个 stdin chunk，被 TUI 当粘贴尾巴吞掉；任何固定毫秒数都会在某个体积上失效（2026-04 到 06 返工 6 次）。
- 提交闭环四环节缺一不可（`core/pty-prompt-submit.js`）：分块投喂（不劈开 UTF-16 代理对）→ 体积自适应 settle 并等折叠标记 → 等语义确认（Claude `UserPromptSubmit` / Codex `task_started`，汇到 `agent-turn-started`）→ 缺确认才补一次有界回车。拿不到确认就如实报 `stuck` 并在 UI 亮出「补发」（`.fi-stuck`）；补发也走同一闭环。
- 契约测试 `tests/unit-prompt-submit-ui-contract.test.js` 守住以上各条，改动前先读。
- 新增对 CLI 输出的模式匹配时，拿真实样本核对：`core/paste-trapped-detector.js` 的折叠标记正则曾漏掉现版 Claude 的 `[Pasted text #1 +120 lines]`，paste 巡检因此长期失效无人察觉。

## CLI 能力：实测，并平等覆盖

- 每加一个给 Claude 的选项，同一轮回答 Codex / Gemini / Kimi 的对应能力；Codex 是日常主力，只做 Claude 等于半个功能。
- 断言某 CLI「没有某能力」前先实测，依据按可信度：CLI 缓存的能力清单（`~/.codex/models_cache.json`）→ 不发请求的子命令（`codex doctor --summary -c <k>=<v>` 的退出码可判断枚举是否严格）→ 二进制字符串 → 用户自己的 `~/.codex/config.toml`。2026-08-15 曾凭记忆误判 Codex 没有 fast 和 xhigh。
- Codex 思考强度按模型取（`core/codex-model-catalog.js`）；`service_tier` 只提供实测有效的 inherit / fast / flex（`core/codex-speed-tier.js`），没有「关闭」档：不 fast 的表示是键不存在，`-c` 删不掉键，想长期关闭改全局 config.toml。

## 会话独占（2026-09-14）

- 同一 session 同时只能在一个 Hub 打开；其他 Hub 显示占用者 PID/版本并拒绝打开，不恢复共享查看、控制权转移或后台 broker 订阅。
- 关闭会话或窗口先保存最终记录并停止原生 writer，再释放归属；另一 Hub 从最新持久化记录恢复同一原生会话、历史和草稿。窗口关闭后不驻留托盘。
- 未打开的会话只是历史入口：不订阅实时状态、不启动用量监听、不回写旧快照。跨 Hub 保留原生单 writer、持久化事务锁和定时任务去重。契约见 `docs/design/session-exclusive-ownership.md`。

## UI 与终端风险区

- 主 UI 在 `renderer/index.html`；普通 session 的终端、侧栏、preview、resize 在 `renderer/renderer.js` 与 `renderer/styles.css`；meeting room 在 `renderer/meeting-room.js` / `.css`。
- 输出链路保持单写入：PTY data → main → renderer → xterm。看到「重复回答」先查 TUI 整屏重绘、resize/reflow、terminal reopen，不急于认定模型重复输出。
- resize 相关改动格外谨慎：`ResizeObserver`、侧栏折叠、preview splitter、zoom、show terminal 都会触发重绘。

## 记忆与昨日之我

- 记忆页是左侧第六个功能按钮，三个 tab：当前上下文、记忆文件库、造梦。只有「当前上下文」跟随聚焦 session（群聊先打开成员 session）；文件库与造梦是全局入口。
- 加载证据要分清：磁盘存在、预计加载、已发送、正文已读取不能混称，没有原生证据就标未知。Claude `InstructionsLoaded` 只证明加载路径，没有正文快照，磁盘预览须标注「当前磁盘内容，非当时快照」。Codex 注入由 `core/memory-native-context.js` worker 从绑定 rollout 提取 AGENTS 指令和 developer Memory 块。
- 临时目录不自动复制 AGENTS.md、不默认 git init；工作区祖先规则随真实消息发送并留回执。文件库折叠未改动的旧副本，手改和未知的保留；全局规则有差异只提示不覆盖。只读清单：`scripts/audit-memory-rules.js`。
- 造梦由普通实体 session 执行，素材来自昨日之我 SQLite 正文导出的任务快照；原生 `MEMORY.md` 和规则文件只读，产物只写 Hub 数据目录的 `DREAM_INDEX.md` 与 `topics/*.md`，校验后原子发布，成功才推进整理游标。
- 梦境索引只随用户亲手发送的下一条消息提交（自动派发不带，压缩后重发，搜索与造梦素材剥掉索引），只按原生回执显示已发送。旧规则沉淀 scheduler 不再自动启动，旧数据与兼容 IPC 保留但新 UI 不提供写操作。
- 昨日之我只检索自然语言（用户口径）：工具调用不进全文索引，只在 `docs` 表留 ≤120 字符元信息；`docs_fts` 触发器带 `WHEN scope <> 'tool'`，请求里的 `tool` 忽略而非报错。每个会话另有一份只含对话的聊天记录 md（Hub 数据目录 `transcripts/`），可直接分享路径。`SCHEMA_VERSION` 升级会丢弃重建并 VACUUM，首次启动重建期间搜索结果不完整。
- 旧梦境兼容代码（`core/dream-consolidation.js`、`core/memory-inspector.js`）：规范库（home 桶）是所有 junction 的目标，巡检、孤岛采集、`mergeIslandBucket` 三处都必须排除它；旧沉淀只写文件末尾 `<!-- dream:begin/end -->` 托管区；旧 IPC 保留在 `main/ipc/memory-handlers.js`。
- 模块：服务 `core/hub-memory-service.js`，历史导出 `core/memory-history.js`，IPC `main/ipc/hub-memory-handlers.js`，文件库发现 `core/hub-memory-catalog.js`，页面 `renderer/memory-panel.js`。设计见 `docs/design/memory-mvp.md`。测试：`node --test tests/unit-hub-memory.test.js`、`node tests/e2e-memory-panel-cdp.js`、`node tests/unit-dream-consolidation.test.js`；协议夹具通过不代表云端模型提炼质量。

## 任务栏图标

- 图标变成 Electron 原子时，先量三层再动手（`WM_GETICON` → 窗口类图标 → exe 资源；用 `Get-ClassLongPtr(hwnd, -14)` 导出 PNG 看）。只在 `win.setIcon()` 那一层修会反复复发。
- 根治方式：`core/hub-exe-branding.js` 把 electron.exe 复制成 `AIGroupChatHub.exe` 并替换图标资源，快捷方式指向副本；永不改写 electron.exe 本体。
- 重装 Electron 后副本消失，修复：`.\node_modules\electron\dist\electron.exe .\scripts\repair-windows-shell-integration.js`；救急入口是桌面 `救Hub.lnk` 与 `start.bat`。
- `.ico` 里不能有 512 条目（ICO 目录只能表达到 256；只重生成图标用 `create-shortcut.ps1 -IconOnly`）；`package.json` 的 `build.win.signAndEditExecutable` 不设 `false`（会连 rcedit 一起跳过，打包出原子图标）。

## 版本号

- 窗口标题 `AI 群聊 Hub：PID <pid> v<version>` 是确认「这个窗口跑的是否新代码」的唯一信号，所以每次合入都升版本。
- 分支不改版本号：`scripts/merge_task.py` 在合并时执行 `node scripts/bump-version.js` 把 patch +1（配置读 `.agents/project.json` 的 `versionFiles` / `versionBump`），因为并行分支都改同样三行，必然冲突。minor/major 用 `--set x.y.z`，须用户同意。
- 三处同步：`package.json` 的 `version`，`package-lock.json` 的顶层 `version` 与 `packages[""].version`；`node tests/unit-hub-version-sync.test.js` 守。不改 `tests/unit-hub-exe-branding.test.js`、`tests/unit-process-lifecycle-journal.test.js` 里的版本字面量（那是 fixture）。
- 升版本会让下次启动重建 `AIGroupChatHub.exe`，占用情况已处理（先改名为 `.stale-*`），不必为此关闭生产实例。
