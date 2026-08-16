# Claude Session Hub 项目规范

## 铁律：Hub 依赖完整性（node_modules 不容许半坏）

**Hub 反复出现"桌面图标点开报错无法打开"，几乎每次根因都是 `node_modules` 缺了传递依赖（典型：`Cannot find module 'dijkstrajs'` — `qrcode` 的依赖）。`main.js` 顶部 `require('qrcode')` 一挂，整个 Electron 启动链终止。防止这种事反复发生，规则如下：**

**触发场景**（以下任一都算"node_modules 风险操作"）：
- `npm install` / `npm ci` / `npm prune` / `npm run dist`（electron-builder 会对源 `node_modules` 做 rebuild + prune）
- `git checkout` 切到 `package.json` 或 `package-lock.json` 不同的分支
- `git pull` 拉进了修改 lock 文件的 commit
- 任何手工删除/移动 `node_modules/` 子目录
- 被 Windows EBUSY 打断的 npm 操作（`debug.log` / native 模块被 electron.exe 锁住）

**硬性规则**：

1. **`npm run dist` 禁止在主工作目录跑**。必须在独立 worktree（如 `git worktree add ../hub-dist master` 新开目录）里打包，避免 electron-builder 的 rebuild/prune 污染源 `node_modules`。主工作目录只用于开发和启动 Hub。

2. **任何 node_modules 风险操作后，必须 smoke test 启动**：
   ```bash
   timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
   ```
   看到 `[群聊] hook server listening on 127.0.0.1:...` 才算通过（日志前缀是 `[群聊]` 不是 `[hub]`，`main.js` 里搜 `hook server listening` 可确认；照 `[hub]` 字面比对会把启动成功误判成失败）。端口被占用时会自动 fallback（3456→3460），日志里出现 `bind failed ... EADDRINUSE` 后跟着一行 listening 属正常。看到 `App threw an error during load: Cannot find module 'XXX'` 就是依赖缺失，立即 `npm install` 重对齐。**smoke test 未通过之前，绝不告诉用户"已修复/已完成"。**

3. **Hub 启动报 "Cannot find module"，第一反应执行 `npm install`**（按 `package-lock.json` 补齐），不要去怀疑代码或改 main.js。只有 `npm install` 后仍报同名模块错误，才深入查。

4. **`dist/*.exe` NSIS 安装器绝不能双击启动测试**。它是独立安装流程，装到别的目录，与源开发环境脱节。测试只走桌面快捷方式 `claudeWX.lnk`（指向 `node_modules/electron/dist/electron.exe` + 源工作目录）或 `start.bat`。

5. **Windows EBUSY 处理**：`npm install` 报 `EBUSY rename node_modules/electron/dist/debug.log` → 一定有 electron.exe 进程锁着该文件。先 `Get-Process electron | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-N) }` 筛出近期自己启动的进程（禁止动用户生产 Hub），`Stop-Process` 后再重试 install。

6. **多 worktree 并存时**：每个 worktree 有独立 `node_modules`，严禁 symlink 或共享。在 worktree A 里的 npm 操作不应影响 worktree B。

**血泪案例**：2026-04-19 用户桌面图标启动 Hub 报 `Cannot find module 'dijkstrajs'`，node_modules 被大规模清空（`npm install` 补回 182 个包）。推断起因是 04-16 `npm run dist` 在主工作目录跑 + 分支反复切换期间 npm 操作被 EBUSY 打断，留下长期半坏状态。用户明确表示已反复遇到同一问题。

**血泪案例 2**（2026-04-30）：worktree 清理时主 `node_modules` 再次半坏，桌面 Hub 启动报 `Cannot find module 'body-parser'`（express 的传递依赖被部分删除）。根因：清理脚本用了
```powershell
cmd /c rmdir "$wt\node_modules"          # 删 junction（Windows 下异步,1s 不够刷新）
Start-Sleep -Seconds 1
Remove-Item -Recurse -Force $wt           # PS 5.1 此条会"穿透 junction"删除目标内容
```
**Windows PowerShell 5.1 的 `Remove-Item -Recurse` 对 reparse point/junction 的处理 bug**：如果 junction 在 `Remove-Item` 启动前未完全消失，`-Recurse` 会跟随进入 junction 目标删除内容（PS 7+ 已修，5.1 仍带 bug）。结果是 worktree 共享的主 `claude-session-hub\node_modules` 被部分删除——express/qrcode 等顶层包还在但传递依赖（body-parser、dijkstrajs 等）丢失。

7. **清理 worktree 含 node_modules junction 时,严禁混用 PowerShell `Remove-Item -Recurse`**。必须用 `cmd /c rmdir` 系列全程处理:
   ```powershell
   $wt = "C:\Users\lintian\AppData\Local\Temp\hub-XXX"
   if (Test-Path "$wt\node_modules") { cmd /c rmdir "$wt\node_modules" }
   # 验证 junction 真的消失了再继续(异步删除可能未完成)
   while (Test-Path "$wt\node_modules") { Start-Sleep -Seconds 1 }
   cmd /c rmdir /S /Q "$wt"   # 用 cmd 的 rmdir /S/Q,不用 PS Remove-Item -Recurse
   ```
   **严禁 `git worktree remove --force`（2026-07-12 血泪实锤）**：git 在 Windows 上同样会穿透 junction 递归删除——实测它在报 "Invalid argument" 失败前已按字母序删掉真 `node_modules` 的 @* 至 d* 共 136 个顶层包（electron 因被运行中 Hub 锁住而幸存）。唯一安全序列就是上面的 `cmd /c rmdir` 三步：先摘 junction → 轮询确认消失 → `rmdir /S /Q` 删目录 → 最后 `git worktree prune` 清理登记。
   **触发场景**：feature 分支合并完成后清理 worktree、`git worktree prune`、手工 rm worktree 目录、CI 自动化测试结束清理。
   **症状识别**：清理后下次 Hub 启动报 `Cannot find module '<dompurify/@xterm/marked 等>'`；renderer 白屏/全局脚本中断（`sessions is not defined`）。
   **修复 SOP（不 kill 生产 Hub）**：主目录 `npm install` 会被运行中 electron 锁 EBUSY → 改走旁路：临时目录放 package.json+lock → `npm ci --ignore-scripts` → 只把主目录缺失的顶层包拷回（不覆盖已有、跳过 electron）→ 隔离实例 smoke 验证。

## 铁律：任务栏图标变 Electron 原子，别再在窗口图标那一层修

**Windows 取任务栏图标的顺序是三层**：① `WM_GETICON`（`win.setIcon()` 只写这一层）→ ② 窗口类图标 `GCLP_HICONSM/HICON` → ③ 进程 exe 的图标资源。第 ① 层用 `SendMessageTimeout + SMTO_ABORTIFHUNG`，主进程一忙就超时；Explorer 崩溃重建任务栏时尤其容易踩到，然后 Windows 落到 ②/③ 并把结果缓存住。

**②③ 两层来自宿主 exe 的资源**。源码模式跑的是原装 `electron.exe`，里面就是 Electron 原子 —— 2026-08-15 实测：运行中的 Hub 窗口 `WM_GETICON` 是橙色 logo，`GCLP_HICON` 是原子。b4fd5d5（挂 show/restore）和 2f7425d（挂 watchdog onTick）都只在第 ① 层反复重贴，所以图标每隔一阵就变回去。

**根治**：`core/hub-exe-branding.js` 把 `electron.exe` 复制成同目录的 `AIGroupChatHub.exe`，用 `resedit`（纯 JS，electron-builder 的传递依赖）换掉图标资源和版本信息，快捷方式全部改指副本。**永不改写 `electron.exe` 本体** —— 本仓库的历史事故都是 node_modules 被写坏，副本坏了删掉即可，下次启动自动重建。

规则：
1. 再遇到"图标变原子"，先量三层再动手：`Get-ClassLongPtr(hwnd, -14)` 导出成 PNG 看一眼，别默认是窗口图标丢了。
2. `npm install` / `npm ci` 换过 Electron 会把整个 `node_modules/electron/dist` 重建，副本随之消失，桌面快捷方式会指向不存在的文件。修复一条命令：
   ```powershell
   .\node_modules\electron\dist\electron.exe .\scripts\repair-windows-shell-integration.js
   ```
   它会补副本 + 重指所有快捷方式。救急入口是桌面 `救Hub.lnk` 和 `start.bat`（都直调 electron.exe，不依赖副本）。
3. `.ico` 里**不能有 512 的条目**：ICO 目录项的宽高各只有 1 字节，0 表示 256，没法表达 512。老 `create-shortcut.ps1` 写过一个 512，和真 256 项一样标成 `0x0`，同一文件里两个都自称 256×256。用 `-IconOnly` 只重生成图标、不动快捷方式。
4. `package.json` 的 `build.win.signAndEditExecutable` 不要再设 `false` —— 它会连 rcedit 一起跳过，打包出来的 exe 同样是原子图标（公司发布版 v1.4.0 就是这么来的）。它跟 VS Build Tools 无关，native rebuild 由 `npmRebuild:false` 管。

## 铁律：CLI 能力必须实测，且新功能要平等覆盖所有 CLI

**每加一个"给 Claude 的选项"，同一轮就要回答"codex / gemini / kimi 的对应能力是什么"。** codex 是日常主力，只做 Claude 等于半个功能。

**断言某个 CLI「没有某能力」之前必须实测**，来源按可信度排序：

1. **CLI 自己缓存的能力清单**。codex 是 `~/.codex/models_cache.json`，每个模型带 `supported_reasoning_levels` / `additional_speed_tiers` / `service_tiers`。
2. **不发 API 请求的子命令探枚举松紧**。`codex doctor --summary -c <k>=<v>` 的退出码：`approval_policy="banana"` → 1（严格枚举），`service_tier="banana"` → 0（**不校验**）。不校验的键 Hub 必须自己把关，别把乱值拼进命令行。
3. 二进制字符串表兜底（`codex.exe` 里搜 `service_tier` 附近）。
4. **用户自己的配置文件就是权威证据** —— 先读 `~/.codex/config.toml` 再下结论。

**血泪案例（2026-08-15/16）**：给新建会话加 fast 开关时，凭记忆断言"Codex 没有 fast 模式"，只给 Claude 做了开关。实测后发现 Codex 的 fast 就是 `service_tier`（模型目录写着 `{id:"priority", name:"Fast", description:"1.5x speed, increased usage"}`），**用户 config.toml 里早就全局写着 `service_tier = "fast"`**。同一轮还错误断言"xhigh 是 Claude `--effort` 专属、Codex 用了会报错"，实测每个 Codex 模型都支持 xhigh，5.6-sol/terra 还有比 max 更高的 `ultra`。

由此定下的两条实现口径：

- **Codex 思考强度按模型取**（`core/codex-model-catalog.js`）：gpt-5.6-sol 到 ultra，gpt-5.5 只到 xhigh。写死一份必然给某些模型多出或少掉档位。
- **`service_tier` 只提供实测有效值**（`core/codex-speed-tier.js`）：`inherit`(不覆盖) / `fast` / `flex`。**没有"关闭"这一档** —— 二进制里只匹配 `fast|flex|priority`，模型目录的 `default_service_tier` 是 null，即"不 fast"的表示是**键不存在**；而 `-c` 只能覆盖不能删键（TOML 没有 null）。想长期关掉改全局 config.toml，那才是 Codex 给的机制。别为了凑一个"关"字去猜字面量。

## 铁律：并行测试 Hub 实例（多 MCP / E2E 测试）

**Hub 原生支持 `CLAUDE_HUB_DATA_DIR` env var 实现运行时状态隔离。所有并行测试必须走这条路径，不得 copy 整个 node_modules 或忽略状态隔离——历史上那种做法已经造成 35+ 条防火墙规则污染 + 数 GB 磁盘垃圾 + 测试互相干扰。**

### 隔离契约

- **env 未设 → 生产行为**：数据目录 `~/.claude-session-hub/`，行为完全不变
- **env 设为 `<dir>` → 隔离生效**：`state.json`/`mobile-devices.json`/`images/`/`statusline-cache.json` 全部写入 `<dir>`；Chromium userData 由 `main.js` 自动 `app.setPath('userData', <dir>/electron-userdata)`；Hub 把 env 透传给 spawned Claude CLI 会话，statusline 脚本也命中同一隔离路径
- 代码入口：`core/data-dir.js` 的 `getHubDataDir()`（commit `aee5eb8` 引入）

### 启动模板 A — 同代码跑 N 个并行测试实例（最常见）

无需 worktree，从主目录直接起 N 个：

```powershell
# 实例 A
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-A"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9221

# 实例 B（另一个 PS 窗口或 subprocess）
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-B"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9222
```

端口会自动 fallback（hook 3456-3460、mobile 3470+），5 个以内并行无冲突。

### 启动模板 B — 不同分支代码并行测试

需要 worktree，但 `node_modules` 必须用 junction 复用，不许 `npm install`：

```powershell
git worktree add C:\temp\hub-feat-X HEAD   # HEAD 不是 master
cmd /c mklink /J "C:\temp\hub-feat-X\node_modules" "C:\Users\lintian\claude-session-hub\node_modules"
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-feat-X-data"
C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe C:\temp\hub-feat-X --remote-debugging-port=9223
```

### 硬性规则

0. **从 Claude Code 会话里 spawn 测试 Hub 必须先剥离嵌套 env**（血泪 2026-06-11，排查 1.5h）：
   ```powershell
   Remove-Item env:CLAUDECODE, env:CLAUDE_CODE_CHILD_SESSION, env:CLAUDE_CODE_ENTRYPOINT, `
     env:CLAUDE_CODE_SESSION_ID, env:CLAUDE_HUB_PORT, env:CLAUDE_HUB_TOKEN, env:CLAUDE_HUB_SESSION_ID -ErrorAction SilentlyContinue
   ```
   否则测试 Hub spawn 的 claude 继承 `CLAUDECODE=1` 自认嵌套子会话 → **不写 transcript jsonl**（/exit 都不 flush）→
   transcript-tap 拿不到 turn 文本 → 手机 PWA / 远程模式收不到回复；且 `CLAUDE_HUB_PORT` 残留会让 stop hook 投给错误的 Hub。
   生产 Hub 从桌面快捷方式启动无此问题。

1. **禁止 `npx electron`**：junction 目录下 npx 会绕到全局 npm 的 electron 安装，抛 "Electron failed to install correctly"。必须直调 `<hub-dir>/node_modules/electron/dist/electron.exe`

2. **禁止 `npm install` 在测试副本里**：每次装 742MB 纯浪费。唯一正解是 `cmd /c mklink /J <worktree>/node_modules <main>/node_modules`。副作用：稳定路径让 Windows 防火墙/Defender 不会把每次测试的 electron.exe 当新未知程序

3. **禁止传 `--user-data-dir` CLI 参数**：`main.js` 检测到 env 后用 `app.setPath` 覆盖 userData，CLI 参数会被 shadow 掉——两套不一致路径只会让问题难排查。只设 env 即可

4. **worktree 必须 `git worktree add HEAD`**（不是 `master`）：测的是当前分支改动。前提是相关代码已 commit，否则 HEAD 拿的是上次 commit 版本

5. **`mklink /J` 必须 check returncode**：`subprocess.run(...).returncode != 0` 时立即 `pytest.fail`。否则留下没 node_modules 的空 worktree，下游 electron 启动失败报错晦涩

6. **pytest fixture 参考实现**：`C:\Users\lintian\.ai-team\tests\test_e2e_critical.py::_setup_hub_worktree` + `_start_hub`（commit `cacb791` 及之后）是唯一正确模板。禁止回退到老的 `npm install` + `npx electron` 写法

7. **测梦境/记忆功能必须额外隔离 home 与 key**（血泪 2026-08-01）：`CLAUDE_HUB_DATA_DIR` 只隔 Hub 自身状态，`memory-handlers` / `dream-consolidation` 的 home 仍指真实用户目录——隔离实例跑 `consolidation:run-now` 会扫真实 memory 孤岛并把蒸馏结果写进真实三件套；且 `DEEPSEEK_API_KEY` env 优先级高于 config.json，父进程的 key 会漏进隔离实例触发真实 LLM 调用。测这类功能必须同时设 `CLAUDE_HUB_HOME_DIR=<临时目录>` 与 `DEEPSEEK_API_KEY=`（空），参考 `tests\e2e-memory-panel-cdp.js`

### 血泪案例

- 2026-04-19 四路代码审查发现：`main.js` 的 `ensureHooksDeployed()` 原本只在目标不存在时复制脚本，导致老用户机器永远拿不到新 statusline 的 env-dir 支持，隔离链条断掉（已修为内容比对覆盖，commit `5dd5dfe`）
- 同日清理 pytest 垃圾：`AppData\Local\Temp\pytest-of-lintian\pytest-NNN\hub-e2e\node_modules\electron\dist\electron.exe` 因每次是新路径 → 35+ 条防火墙 Allow 规则累积 + 约 3GB 磁盘占用
- 老测试 fixture `npm install --prefer-offline` 每次 120 秒 + 742MB；junction 后 <1 秒 + 0 字节
