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
   看到 `[hub] hook server listening on 127.0.0.1:...` 才算通过。看到 `App threw an error during load: Cannot find module 'XXX'` 就是依赖缺失，立即 `npm install` 重对齐。**smoke test 未通过之前，绝不告诉用户"已修复/已完成"。**

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
   或者直接用 `git worktree remove --force <path>`(git 自己处理 junction,但 PS 5.1 下也可能踩 bug,验证后再用)。
   **触发场景**：feature 分支合并完成后清理 worktree、`git worktree prune`、手工 rm worktree 目录、CI 自动化测试结束清理。
   **症状识别**：清理后下次 Hub 启动报 `Cannot find module '<express/qrcode/electron 子依赖>'`。

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

1. **禁止 `npx electron`**：junction 目录下 npx 会绕到全局 npm 的 electron 安装，抛 "Electron failed to install correctly"。必须直调 `<hub-dir>/node_modules/electron/dist/electron.exe`

2. **禁止 `npm install` 在测试副本里**：每次装 742MB 纯浪费。唯一正解是 `cmd /c mklink /J <worktree>/node_modules <main>/node_modules`。副作用：稳定路径让 Windows 防火墙/Defender 不会把每次测试的 electron.exe 当新未知程序

3. **禁止传 `--user-data-dir` CLI 参数**：`main.js` 检测到 env 后用 `app.setPath` 覆盖 userData，CLI 参数会被 shadow 掉——两套不一致路径只会让问题难排查。只设 env 即可

4. **worktree 必须 `git worktree add HEAD`**（不是 `master`）：测的是当前分支改动。前提是相关代码已 commit，否则 HEAD 拿的是上次 commit 版本

5. **`mklink /J` 必须 check returncode**：`subprocess.run(...).returncode != 0` 时立即 `pytest.fail`。否则留下没 node_modules 的空 worktree，下游 electron 启动失败报错晦涩

6. **pytest fixture 参考实现**：`C:\Users\lintian\.ai-team\tests\test_e2e_critical.py::_setup_hub_worktree` + `_start_hub`（commit `cacb791` 及之后）是唯一正确模板。禁止回退到老的 `npm install` + `npx electron` 写法

### 血泪案例

- 2026-04-19 四路代码审查发现：`main.js` 的 `ensureHooksDeployed()` 原本只在目标不存在时复制脚本，导致老用户机器永远拿不到新 statusline 的 env-dir 支持，隔离链条断掉（已修为内容比对覆盖，commit `5dd5dfe`）
- 同日清理 pytest 垃圾：`AppData\Local\Temp\pytest-of-lintian\pytest-NNN\hub-e2e\node_modules\electron\dist\electron.exe` 因每次是新路径 → 35+ 条防火墙 Allow 规则累积 + 约 3GB 磁盘占用
- 老测试 fixture `npm install --prefer-offline` 每次 120 秒 + 742MB；junction 后 <1 秒 + 0 字节
