# 2026-08-15 · 任务栏图标根治 + 新建会话选项 + 底部输入框

四件事：① 任务栏图标变 Electron 原子（根治）② 新建会话增加 fast / 思考强度 / MCP 档位
③ 底部输入框撤销 + ↑ 历史 + 卡片视图遮挡 ④ 后续优化建议。

---

## 1. 任务栏图标：根因与根治

### 之前为什么修不好

Windows 取任务栏按钮图标有三层来源：

| 层 | 来源 | 谁在写 |
|---|---|---|
| ① | `WM_GETICON`（ICON_SMALL2 → ICON_SMALL → ICON_BIG） | `BrowserWindow.setIcon()` |
| ② | 窗口类图标 `GCLP_HICONSM` / `GCLP_HICON` | Chromium 建窗口类时从**宿主 exe 的图标资源**取 |
| ③ | 进程 exe 内嵌图标资源 | — |

第 ① 层的查询是 `SendMessageTimeout + SMTO_ABORTIFHUNG`：主进程那一瞬间在忙（PTY 洪水、
state.json 落盘、transcript 解析）就超时。Explorer 崩溃重建任务栏时最容易踩到，
超时之后 Windows 落到 ②，并把结果缓存住。

**2026-08-15 实测（生产 Hub PID 55400，v1.6.10，含 2f7425d 的 watchdog 修复）**：

```
WM_GETICON big  → 橙色 logo   ✅
GCLP_HICON      → Electron 原子 ❌
GCLP_HICONSM    → Electron 原子 ❌
```

历史上三次修复（b4fd5d5 挂 `show`/`restore`，2f7425d 挂 watchdog `onTick`）
全都只在第 ① 层反复重贴，②③ 两层的原子一次都没动过。

**第二个污染源**：`package.json` 的 `build.win.signAndEditExecutable: false`
（f887f70，"为了不装 VS Build Tools 跳过签名"）连 rcedit 一起跳过了，
所以**公司发布版 v1.4.0 打出来的 exe 图标也是原子**。它和源码 Hub 共用同一个
AUMID `com.ai-group-chat-hub`，桌面还留着一个指向它的快捷方式。

### 做了什么

| 改动 | 文件 |
|---|---|
| 新增 `AIGroupChatHub.exe`（electron.exe 的品牌化副本，resedit 换图标 + 版本信息） | `core/hub-exe-branding.js`（新） |
| 后台生成脚本（ELECTRON_RUN_AS_NODE，220MB 读写不卡主进程） | `scripts/brand-hub-exe.js`（新） |
| 启动时检查 stamp，缺失/过期就后台重建，完成后重指快捷方式 | `main.js` `app.whenReady` |
| 桌面上其它 Hub 启动器（claudeWX.lnk 等）一起改指 | `core/windows-shell-integration.js` `repointHubDesktopShortcuts` |
| 一条命令修复入口（补副本 + 重指全部快捷方式） | `scripts/repair-windows-shell-integration.js` |
| 删掉 `.ico` 里非法的 512 条目（ICO 目录项宽高各 1 字节，0=256，无法表达 512） | `create-shortcut.ps1`（加 `-IconOnly`） |
| 去掉 `signAndEditExecutable: false` | `package.json` |
| 新 exe 路径加进防火墙白名单 | `scripts/firewall-whitelist-electron.ps1` |

**永不改写 `electron.exe` 本体**：本仓库两次重大事故都是 node_modules 被写坏
（2026-04-19 补回 182 个包、2026-07-12 被穿透删掉 136 个）。只新增副本的话，
E2E/隔离测试仍直调 electron.exe 行为零变化，副本坏了删掉即可，下次启动自动重建。

### 验证

品牌化副本起一个隔离实例，重新量三层：

```
WM_GETICON big  → 橙色 logo ✅
GCLP_HICON      → 橙色 logo ✅   （原来是原子）
GCLP_HICONSM    → 橙色 logo ✅   （原来是原子）
```

`electron.exe` mtime 仍是 4/29 19:08，一个字节未动。

### 已在本机执行的一次性清理

- 卸载公司发布版 v1.4.0（`Uninstall AI 群聊 Hub.exe /currentuser /S`，退出码 0，
  安装目录与注册表登记均已清空）。
- 移除桌面 `AI 群聊 Hub（公司发布版 v1.4.0）.lnk`（同 AUMID + 原子图标的最后一个入口）。
- 桌面 `AI Group Chat Hub.lnk` / `AI 群聊 Hub.lnk` / `claudeWX.lnk` 全部改指 `AIGroupChatHub.exe`。
- 重新生成 `claude-wx.ico`：8 个条目，每个 declared 尺寸与实际 PNG 一致。

**开始菜单那份要等 Hub 重启才会定型** —— 当前运行的是旧代码，它的 watchdog 每 15 秒
会把开始菜单快捷方式改回 electron.exe。重启后自动收敛。

### 后续风险与救急

`npm install` / `npm ci` 换 Electron 版本时会重建整个 `dist` 目录，副本随之消失，
快捷方式会指向不存在的文件。修复：

```powershell
.\node_modules\electron\dist\electron.exe .\scripts\repair-windows-shell-integration.js
```

不依赖副本的救急入口：桌面 `救Hub.lnk`、`start.bat`（都直调 electron.exe）。

---

## 2. 新建会话：fast / 思考强度 / MCP 档位

### 改动前

- fast **写死开启**，唯一开关是全局环境变量 `CLAUDE_HUB_NO_FAST=1`。
- 思考强度只对 Claude 可见；Codex 的 `model_reasoning_effort` 写死 `max`，无 UI。
- MCP 档位只对 Codex 可见（默认 lean）；**Claude 全量继承**七个全局 MCP，
  每个一个常驻子进程，开几个会话就很可观。

### 改动后

| 档位 | Claude | Codex / DeepSeek | 其它 |
|---|---|---|---|
| 快速模式 (fast) | ✅ 开关，**默认开** | 不显示（Codex CLI 没有 fast 模式） | — |
| 思考强度 | `--effort`：max/xhigh/high/medium/low，默认 max | `-c model_reasoning_effort`：max/high/medium/low，**默认 max（不变）** | — |
| MCP 加载 | full/lean/browser/wireless，**默认 full（= 改动前行为）** | lean/browser/wireless/full，默认 lean（不变） | — |

**没有任何默认值被改动** —— 三档的默认组合与改动前逐字一致，只是现在可以调。

> **2026-08-16 更正**：上面这段初版里有两处凭记忆下的错误结论，已在下面第 2b 节
> 全部实测更正并补齐实现。保留原文以便对照——Codex **有** fast（`service_tier`），
> 且 `xhigh` 不是 Claude 专属。

几个刻意的取舍：

- ~~**Codex 没有 fast 模式**，不造一个假开关。~~ ← **错**，见 §2b。
- ~~**Codex 的枚举里没有 `xhigh`**，混进去 CLI 启动即报错。~~ ← **错**，见 §2b。
- **Claude 的 MCP 默认必须是 full**。Codex 默认 lean 是它自己的历史选择；把 Claude
  也改成 lean 会让一堆依赖 MCP 的会话突然少工具。
- **群聊成员的 Codex effort 仍然钉死 max**：一个房间里成员各调各的档位，产出没法互相比较
  （`unit-codex-resume-model-source.test.js` 有源码级守卫）。
- fast 勾着时 UI 会写明代价：2026-06-11 实测 fastMode 交互式会话不落盘 transcript jsonl，
  卡片视图收不到回复。以前只能全局一刀切，现在可以按会话关。

**Claude MCP 档位的实现**：Claude CLI 没有逐个禁用的开关，用
`--mcp-config <过滤后的文件> --strict-mcp-config`。strict 是关键——只给 `--mcp-config`
不加 strict 的话 CLI 会和全局配置合并，等于白干。用户的 `~/.claude.json` 一个字节不动。

**顺手修掉一个空转 bug**：Codex 的 wireless 档只放行 `superwireless`，而用户
`~/.codex/config.toml` 里那个 server 实际叫 `superran` —— 于是 wireless 档把唯一想留的
那个也禁掉了。现在两个名字都放行。

新增：`core/claude-mcp-profile.js`、`tests/unit-claude-mcp-profile.test.js`。
档位随 resume / fork / restart / relaunch 一起继承（persistence 白名单 + session-store）。

---

## 2b. 更正（2026-08-16）：Codex 其实两个速度旋钮都有

用户指出"创建 codex 会话时没有 fast 之类的选项，这不对"。回头实测 codex-cli 0.144.0，
上一节两处结论都是错的。

### 实测证据

`~/.codex/models_cache.json`（codex 自己缓存的模型目录）：

| 模型 | default | supported_reasoning_levels | additional_speed_tiers |
|---|---|---|---|
| gpt-5.6-sol | low | low medium high **xhigh max ultra** | fast |
| gpt-5.6-terra | medium | low medium high xhigh max ultra | fast |
| gpt-5.6-luna | medium | low medium high xhigh max | fast |
| gpt-5.5 / gpt-5.4 | medium | low medium high xhigh | fast |
| gpt-5.4-mini / 5.3-codex-spark | medium/high | low medium high xhigh | （无） |

`service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }]`，
`default_service_tier: null`。**用户 `~/.codex/config.toml` 里早就写着 `service_tier = "fast"`。**
codex TUI 的状态行就叫 `Fast on` / `Fast off`。

配置层的枚举松紧（`codex doctor --summary -c <k>=<v>` 退出码）：

```
approval_policy="banana"        → exit 1   严格枚举，被拒
sandbox_mode="banana"           → exit 1   严格枚举，被拒
service_tier="banana"           → exit 0   不校验
model_reasoning_effort="banana" → exit 0   不校验
```

后两个不校验 —— 所以 Hub 这侧必须自己把关，不能把乱值拼进命令行。

### 改了什么

| 项 | 文件 |
|---|---|
| `service_tier` 档（inherit/fast/flex）+ 读用户全局值用于显示 | `core/codex-speed-tier.js`（新） |
| 按模型取思考强度档位（读 models_cache.json，含 ultra） | `core/codex-model-catalog.js`（新） |
| `CODEX_EFFORT_LEVELS` 补上 xhigh / ultra；拼 `-c service_tier=` | `core/session-manager.js` |
| 弹窗要档位目录的 IPC `codex:tuning-catalog` | `main/ipc/workspace-handlers.js` |
| 「速度通道 (service_tier)」下拉 + 思考强度跟着模型变 | `renderer/index.html`、`renderer/workspace-controller.js` |
| `codexSpeedTier` 随 resume / fork / restart / relaunch 继承 | session-store / persistence / session-handlers / resume-handlers |

新建 Codex 会话现在有：

- **速度通道 (service_tier)**：`跟随全局配置（当前：fast）` / `Fast · priority 通道，1.5× 速度` / `Flex · 更慢更省`
- **思考强度**：选 gpt-5.6-sol 时是 ultra/max/xhigh/high/medium/low；换成 gpt-5.5 自动缩到 xhigh/high/medium/low，
  原来选的 max 回落到该模型支持的最高档（xhigh），而不是拼一个它不认识的值。

### 为什么没有"关闭 fast"这一档

二进制里对 `service_tier` 只匹配 `fast` / `flex` / `priority` 三支，模型目录的
`default_service_tier` 是 null —— "不 fast"在 Codex 里的表示是**这个键不存在**，
而不是某个字面量。`-c` 只能覆盖不能删键（TOML 没有 null）。用户全局已经写死 fast 时，
没有任何**可证实**的字面量能在单次启动里把它关掉，所以不猜。UI 上如实写明：
「跟随全局配置」不覆盖 `~/.codex/config.toml`，要长期关掉请改那里。

### 群聊仍然钉死

群聊成员的 effort 和 service_tier 都不给单独调（一个房间里成员各调各的，产出没法互相比较）。
`unit-codex-resume-model-source.test.js` 有源码级守卫。

---

## 2c. 卡片视图「复制对话」支持任意轮数

原来下拉写死 1/2/3，`normalizeRoundCount` 把越界值一律打回 **1**，想复制整段只能点三次再手动拼。

- 选项改为按**当前卡片里真实存在的完整轮数**重建，最后一项标「· 全部」；
  旁边新增「/ 共 N 轮」把上限直接摆出来（`renderer/recent-turn-copy.js` 的 `refreshRoundOptions()`）。
- 刷新时机用 `#msg-overlay` 上的 **MutationObserver**，不跟卡片渲染管线耦合；
  另外在 `setVisible(true)`、下拉获得焦点、点复制按钮时各刷一次。
- **顺带修掉一个真 bug**：卡片是异步挂载的，工具条初始化时往往一轮都没有。
  老写法会把 localStorage 里存的偏好（比如 8 轮）当场夹到 1 并写回，永久抹掉。
  现在"想要几轮"（`desiredCount`）与下拉框显示值分开，显示值只是
  `min(想要的, 现在最多能给的)`，对话变长后自动回到用户原本要的轮数。

**注意上限的真实边界**：卡片历史只从 transcript 尾部拉 50 条 turn
（`main/ipc/transcript-handlers.js` 的 `limit: 50`），所以上限是"最近 50 turn 内的完整轮数"，
不是会话史上的总轮数。要更多得先把 `parseOpts.limit` 调大。

E2E 实测（9 张卡 = 4 个完整轮次）：下拉给出 `1/2/3/4`，末项「4 轮 · 全部」，
标签「/ 共 4 轮」，点复制得到 `已复制 4 轮` 且包含老实现够不到的第 1 轮。

---

## 3. 底部输入框

### 3a. Ctrl+Z 撤销

以前发送后 `inputBox.textContent = ''` —— 纯 DOM 赋值，浏览器不记账，
contenteditable 的原生撤销栈当场清空，Ctrl+Z 什么也回不来。

改成 `replaceContenteditableText()`：`selectAll` + `execCommand('insertText'/'delete')`，
原生 Ctrl+Z / Ctrl+Y 直接可用，不用自己维护一套 undo 栈（自己写的还得处理 IME、
粘贴、拼写纠正）。带兜底：execCommand 失败或内容对不上时退回直接赋值——
**清空失败会让下一次回车重发同一条消息**，这个比撤销栈重要。

### 3b. ↑/↓ 召回发过的消息

新增 `renderer/floating-input-history.js`（纯逻辑 + 可注入 storage）：

- 按 session 分桶，localStorage 持久化，每桶 30 条、最多 40 个 session（不会无限涨）。
- ↑ **只在框为空或光标已在最开头时**接管 —— 在多行 prompt 中间按 ↑ 想上移一行，
  结果整段被历史顶掉，这种手感事故比没有历史更糟。
- ↓ 只在浏览历史时接管；翻回底部还原进入浏览前的草稿（空串也照还原）。
- 自己敲字就退出浏览态；Esc 第一下退出浏览+还原草稿，第二下才把焦点还给终端。
- IME 组字期间完全不接管（候选词翻页也用方向键）。

### 3c. 卡片视图遮挡（只显示两行）

根因在 `renderer/styles/card-view.css`：`.msg-overlay` 是
`position:absolute; z-index:50` + 不透明底色，靠 `top:43px / bottom:60px` 给
header 和输入栏让位。**这两个数是写死的**，而输入栏是 flex column
（任务预设 chips 24 + 预设预览 48 + 输入框最高 120 + padding），实际能长到 220px。
超出 60px 的部分被整个盖住，而且 overlay 没有 `pointer-events:none`，那片区域连点都点不到。
PTY 视图没事只是因为那时 overlay 整个 `display:none`。

改成 `top: var(--term-header-h, 43px)` / `bottom: var(--fi-bar-h, 60px)`，
由 `observeTerminalPanelChrome()` 的 ResizeObserver 写回实测高度；
再给 `.floating-input-bar` 加 `position:relative; z-index:60` 作保险层。

**E2E 实测（真实 renderer + 真实样式表）**：

| | 卡片层底边 | 输入栏顶边 | 被遮挡 |
|---|---|---|---|
| 写死 60px（旧） | 1430 | 1326 | **104px** |
| 变量驱动（新） | 1325 | 1326 | **0** |

输入框可见高度 120px = 完整 max-height（不再是 2 行）。

---

## 4. 验证

```
244 个可直接运行的 `*.test.js` 文件全通过
  （另有 2 个固定端口的手工 CDP 文件，需要预先启动 9229/9230 监听，不计入自动集）
  新增 4 个：unit-hub-exe-branding / unit-floating-input-history /
            unit-claude-mcp-profile / unit-codex-speed-tuning
  改 4 个既有契约测试（理由见下）
tests/e2e-session-create-options-cdp.js  通过（隔离实例 + CDP：档位/几何/撤销栈/历史全量断言）
tests/e2e-recent-turn-copy-cdp.js        通过（9 卡 = 4 轮，能复制全部 4 轮）
tests/e2e-terminal-runtime-state-cdp.js  通过（Claude/Codex 运行、空闲、等输入三态）
tests/e2e-codex-task-started-running-cdp.js 通过（含真实 event_msg turn_aborted 结构）
tests/unit-windows-shell-integration.test.js  14/14
品牌化 exe 隔离实例：GCLP_HICON / HICONSM 均为橙色 logo
```

改过的既有契约测试及理由：

- `unit-workspace-new-session-tuning.test.js` —— effort/MCP 选项从写死 HTML 改成按 kind
  动态填充（Claude 有 xhigh、Codex 没有，写死必然给其中一家拼出非法值），
  断言相应从 HTML 移到 JS 选项表；同时新增"Claude MCP 默认必须是 full"的守卫。
- `unit-codex-resume-model-source.test.js` —— 原来断言源码里字面出现
  `buildCodexReasoningConfigArg(CODEX_REASONING_EFFORT)`。现在单人会话可选档位，
  改成断言 createSession 与 relaunch **两条**命令都在 `meetingId` 存在时钉死 max，
  并加一条"三目不能写反"的守卫。守护的约束没有放松。
- `unit-claude-mcp-profile.test.js` —— 我自己上一轮写错的断言（"xhigh 应回落 max"）
  按实测更正为"xhigh / ultra 原样通过"。
- `unit-recent-turn-copy.test.js` / `-contract.test.js` —— `normalizeRoundCount('9') === 1`
  和"HTML 里必须有 1/2/3 三个 option"正是这次要拆的限制，改成校验
  "上限跟着实际轮数走"与"选项由 JS 按轮数重建"，并加了越界/空对话/全部轮次的用例。

---

## 5. 还可以做的（未实施，供决策）

1. **档位记忆升级为持久化**：现在切 kind 会记住上次选择，但 Hub 重启就忘。
   写进 `state.json` 的话，"我一向用 Lean MCP" 这类偏好就不用每次重设。
2. **按 workspace 记忆档位**：无线目录自动放行 superran 已经是这个思路的雏形。
   可以扩展成"这个项目默认用 Codex + medium"。
3. **会话模板/预设**：把 kind + model + 三档 + workspace 存成一个命名模板
   （"投研 Claude"、"轻量改代码 Codex"），一键新建。比记忆更显式。
4. **创建前的资源预览**：底部摘要现在只显示落地路径。可以加上"本次会拉起 N 个 MCP 进程
   / 预计常驻内存"，让 Lean 与 Full 的差别在点下去之前就看得见。
5. **Ctrl+N 直接建 Claude 绕过弹窗**（`keyboard-shortcuts.js:134`）拿不到任何档位，
   会静默用全默认。可以改成打开弹窗，或让它沿用上次的档位。
6. **弹窗里没有"名称"输入框**：标题靠首问后自动生成。想手动命名只能建完再改名。

---

## 6. Codex 复核补丁（2026-08-15）

- 新增基于 **当前 PTY 逻辑屏** 的 Claude/Codex 状态判定：强运行标记优先，输入框与状态栏
  同时出现才判空闲；确认页判为「等你操作」。PTY 字节量本身不再充当完成证据。
- Codex 同时保留 rollout 权威事件：`task_started` 开工、`task_complete` 完成、
  `event_msg(payload.type=turn_aborted)` 取消；实测 0.147.0 的 abort 是最后这种嵌套结构。
- 修复 Claude CLI 原地 relaunch 丢失本会话 `effort` / MCP 档位的问题；关闭 fast 的选择也继续继承。
- 修复 `workspace-controller.js` 中混入的原始 NUL 字节，以及真实 CLI 诊断把 prompt 里的完成标记
  当成回答标记的假阳性。
- 真实隔离 Hub 验证：Codex 0.147.0 完整经历 idle → running → idle；Claude 当时命中账号
  session limit，正确经历 running → needs-input，未伪报完成。生产 Hub 未重启、未关闭。
