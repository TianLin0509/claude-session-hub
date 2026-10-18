# 家里远程让公司 Hub 更新 / 重启（2026-10-17，v2.1.8）

田哥：「允许我在家里用 claude 远程让公司的 AI HUB 自己重启更新——这样我就不用为了更新 AI HUB 专门到公司一趟了」。

## 链路

家里会话（MCP `company_hub_update` / `company-ask.js --hub-update|--hub-restart|--hub-status` / 无线页「公司联动」按钮）
→ `core/company-bridge/home.js` `hubAdmin()` 经加密通道发 `{ type:'hub-admin', op, id, gen, force }`
→ 公司 `core/company-bridge/hub-admin.js` → 现有一键更新控制器 `main/app-update-controller.js`（check → download → apply）
→ 公司发 `{ type:'hub-admin-status', id, phase, note, current, latest, at, lastResult? }` → 家里存最近 20 条、发通知、面板显示。

## 公司一端状态机

| 阶段 | 含义 |
|---|---|
| checking / downloading | 查版本、多源下载与 sha256 校验（控制器负责） |
| waiting | 已下载，等「通道里没有在作答的轮次、没有在忙的 CodeAgent 会话」；最多等宽限期 `restartGraceMinutes`（默认 3 分钟，0–30，0 = 不等；`force` = 0），到时走「中断—恢复」（见下节）；等待期间新任务只排队不派发 |
| applying / restarting | 已报「即将重启」（或「中断 N 个任务后重启」）并等这条消息送出（`link.flush`），调用 `apply()` 或 `app.relaunch()+quit()`；本进程里这段时间也不派发新任务；看门狗：3 分钟内进程没退出就清标记、判 failed 并回报 |
| 结束态 | up-to-date、failed、refused（设置里关了）、busy（已有一条在跑）、superseded（等待中被新指令取代）、unsupported（不是安装版）、updated、rolled-back、restarted |

- 只认当前配对代次（job 记下 `gen`，解除或重新配对后等待中的指令作废并回报）；同一编号只处理一次；同一时间只跑一条。
  例外：旧指令还在 waiting 时，新指令带 `force` 或换了动作就取代它（旧的报 superseded），同动作不带 force 仍回 busy。
- 不接受来自通道的文件或网址；版本只取发行源清单，`planUpdate` 保证不降级。只走增量包：完整安装包的安装向导要人点（oneClick:false），远程退出后没人点 Hub 就一直关着，所以回 failed 说明原因。
- 重启后：通道接通时读 `takeLastResult()` 的结果，报 updated（已更新到 vX）/ rolled-back（原因 + 已回滚到 vY）；没读到结果报 failed。
  中途重启（停在下载或等待）报 failed，可以再发。版本变化时公司也主动报一次 online（不发通知），家里面板据此显示公司版本。
- 设置 `allowRemoteAdmin`（默认 true），在公司「AI特战队专用功能」设置的「同时处理」下方。

## 中断—恢复（2026-10-17 v2.1.9）

田哥 22:40（人在公司实测远程重启）：「有时候不能等所有会话都完成，可以先记着，先重启中断，等重启完后再恢复——效率更高。」

1. **宽限**：在干活的 = 通道里在作答的轮次（会话在忙、刚发出 3 分钟内、或原生记录 10 分钟内还在写 `transcriptFresh`）+ 本机在忙的 CodeAgent 会话（人自己开的也算）。宽限内都答完就直接重启。
2. **记下**：宽限到了还有在干活的，把它们写进通道数据库里的 `hubAdmin.resumeAfterRestart = { jobId, boot, at, items:[{ sessionId, kind:'bridge'|'local', thread, round, interruptedAt }] }`；通道轮次标 `resumePending`（期间 collect 不按「会话已关闭」判失败），给家里发一条「这一轮先记下，重启后接着做」，然后报「中断 N 个任务后重启」并重启。没能开始重启就作废清单。
3. **恢复**（下一次启动，`boot` 不同才处理；主窗口加载完、钩子服务在听之后）：逐项先标「恢复中」再动手 → `resumeSession` 按原编号恢复 → 恢复后它已自己接着做就不再发，否则经正规发送入口（`session:send-prompt` 同一路径，等 CLI 就绪、分块提交、语义确认）只发纯「继续」。`receipt-reader.js` 的 `BARE_CONTINUE` 把它认作同一轮的延续，回执归属不变；`hub-admin.js` 启动时断言 `RESUME_TEXT` 被它认出。
4. **结果**：通道轮次保持在途、记下 `resumedAt`（之后的「没答上」计时从这里起算），回执照常发回；恢复失败的按 `failRound` 报回家里（家里可补收或追问）。本机会话恢复失败记进 `resumeIssues`，侧栏标「重启打断」，悬停看原因（24 小时内、之后没人在那个会话里打字才显示）。处理完清单即清空，回报「已恢复 N 个，失败 M 个（原因）」。
5. **只恢复一次**：程序在恢复途中又重启时，标了「恢复中」的项不再发第二遍，通道轮次报失败。看门狗判重启没成时，同一份清单在本进程里处理：会话还活着的算没被中断，不发「继续」。
6. **恢复期间的补收与 CLI 没就绪（2026-10-18，v2.1.10 真机 Q-1017-23 第 12/13 轮）**：
   - 这一轮还标着待恢复、在清单里待处理 / 恢复中 / 等 CLI 就绪，或已恢复发了「继续」但之后还没写出新回答（30 分钟内，原生记录还在写时最多 3 小时）：家里补收（recollect）不判失败，回「公司 Hub 刚重启，这一轮正在自动接着做，回执到了会照常发回，不用重问」，轮次保持在途；恢复失败、已落 error 的照原流程。
   - `cli-not-ready` 来自 `group-chat-watcher.js` 的 `sendToPty`：会话刚启动 / 刚恢复时最多等 60 秒普通输入框，等不到就明确不发。`resumeSession` 只负责拉起进程、不等就绪，重启后带长记录的 CodeAgent `--resume` 启动超过 60 秒就会撞上。现在派发和恢复发「继续」遇到它都不判失败：派发退回排队（`retryAt`），恢复清单项标 `waiting-ready` 留在清单里，都隔 15 秒再发，最多等 5 分钟，超时才按原失败流程报回并写明 `cli-not-ready`。只有明确没发出（`notSent`）才重试，正文不会重复。

## 直查通道（2026-10-18，op:'diag'）

田哥 16:2x：「AI HUB 信息、电脑信息等，是否也可以不通过 codeagent，而直接通过脚本读取 + 压缩来完成？……减少排队，给出另一种通道。」
背景：v2.1.11 远程更新后并行上限被「内存余量」卡到 1，6 个问题排队，家里只看得到「受内存余量限制」。

- 链路：家里 `HomeBridge.hubAdmin({ op:'diag', sections, lines })`（MCP `company_diag`、`company-ask.js --diag`、无线页「公司联动」的「公司电脑状态」卡片）
  → `{ type:'hub-admin', op:'diag', id, gen, sections }` → 公司 `hub-admin.js diag()` → `diag.js collect()` 直接读系统接口与 Hub 状态
  → 脱敏 → JSON → gzip → base64url → `{ type:'hub-admin-status', phase:'diag', note:摘要, diag, diagBytes, elapsedMs, degraded? }`。
  不开 CodeAgent 会话、不占并行名额、不排队；老版本家里只看到 note 摘要（照常通知），新版家里解压存最近 5 份、不弹通知。
- 段落（白名单，各自 try/catch）：machine（内存、CPU 0.5 秒采样、开机时长、C/D 盘）、processes（`core/process-inspector.js` 的 Win32_Process 快照，15 秒超时；
  前 20、CodeAgent 数与内存、Hub 自身、按会话终端 PID 归属的会话内存；不回传命令行）。
  「别的 Hub」：当前 Hub 进程树外的 Hub 主进程（不带 --type=）连同它整棵进程树，一律不算残留、进保护名单（`protectedPids`），名下空空又没窗口的单独提示「可能是没退出的旧主进程」；
  认 Hub：安装版按程序名 AIGroupChatHub.exe；开发版 electron.exe 要命令行里带 Hub 源码目录（有 main-bootstrap.js 与 core/company-bridge），别的 Electron 程序不算。
  「Hub 后台脚本」：用 Hub 程序跑脚本、按设计脱离进程树的（ordinary-browser-daemon.js、web-roundtable worker.js、apply-update.ps1）不是主进程也不是残留，进保护名单。
  CodeAgent 只认：可执行文件名以 codeagent 开头；node 入口脚本在 npm 包目录 node_modules\[@scope\]codeagent* 里；或在本机配置的 CodeAgent 安装目录下（命令是绝对路径时取其目录）。路径里随便哪层目录名带 codeagent、命令行里提到 codeagent 都不算（二审）。
  残留分两档（2026-10-18 审核）：「嫌疑」= 不属于任何 Hub 且命中 `process-reclaim.js` 的残留形态白名单，或父进程已不在、活了 ≥10 分钟的 CodeAgent / node / 孤立 Electron 子进程，只供参考；
  「可结束」= 嫌疑里的 CodeAgent 或白名单形态，父进程已不在、活了 ≥30 分钟，整棵进程树没有可见窗口，量得到 CPU 时最近几乎不动（同 process-reclaim.js；三期 kill-orphans 只认这一档）。隔离测试实例可用 `CLAUDE_HUB_DIAG_LEFTOVER_MIN_AGE_MS` 改短。
  top 行的残留标记与残留列表同一套规则。
  
  hub（版本、启动时间、`parallelLimitSafe()`、通道队列快照、会话列表含 PID 与内存）、pool（只用「个人 / 号 1 / 号 2」，字段白名单）、
  logs（company-bridge.log、company-session-care.log、window-events.log 最后 N 行，默认 80、上限 200）。
- 脱敏：所有字符串过 `scrubText`（号身份，整次直查只读一次号池做快照，量大小时封装消息也用这份）+ 口令/令牌样式、配对码、网址、本机用户名与用户目录；UUID 保留。
  会话标题只有通道会话（purpose=company-bridge，「1018-Q1-codex」这类编号）保留，其余置空。
- 开关：公司设置「状态查看」（`allowRemoteDiag`，默认开，独立于远程更新开关），关了回 refused。
- 能力声明：公司每条 hub-admin-status 带 `caps:['diag']`；家里看到公司报过版本却没带 diag 能力（旧版会把指令静默丢掉）就直接报「版本过旧，不支持直查」，不白等。
- 大小：整条消息（HTTP 正文 `{to,mid,blob}`）实测 < 60000 字节，超了按顺序降级：日志 40 行 → 15 行 → 进程前 10 → 日志省略 → 会话 20 个 → 进程前 5、会话省略 → 只留汇总 → 只留摘要，始终一条发完。
- 底线：只认当前配对代次；同一编号只处理一次；30 秒限频、同时只跑一条（回 refused 写原因）；只读，不读源码、不回传文件内容（日志尾部除外）；
  公司写 `logs/company-diag.log` 审计，界面给一条轻提示「对端查看了这台电脑的状态」（`notify(..., { quiet:true })`，不弹系统通知）。
  对端在看时公司接下来 10 分钟按 10 秒检查通道（同追问窗口），紧接着的追查更快送到。
- 二期段落（2026-10-18 追加，只读）：
  - codeagent：`<命令> --version`（隐藏窗口、8 秒超时、10 分钟内复用；命令取本机配置）、个人账号登录状态与到期时间、号池可用 / 需登录数；
    额度读开着的 CodeAgent 会话屏幕（最近活动的 8 个，headless xterm 渲染后按 `codeagent-screen-stats.js parseCodeAgentCredit` 取 Credit 行），按号归并，号用代称。
  - airview：进程名白名单（python / pythonw / py / matlab / simulink / octave / 名字带 airview 的），名称、PID、内存、启动时间、已运行时长、归属会话，只给一句标签（AirView 运行器 / MATLAB / Python），不回传命令行；
    设置里的「仿真结果目录」（`resultDirs`，默认 `C:/AirView`，公司设置页可改，最多 10 个）+ 代码位置，广度优先、深 6 层、4 秒 / 3 万个条目封顶，跳过 node_modules / .git 等，
    只认结果后缀（mat、csv、txt、log、json、xlsx、png、fig、h5、npz 等，源码后缀不在内），返回最近更新的 30 个文件的相对路径、大小、修改时间，不打开文件。
  - features：main 给原始状态（`deps.featureStatus`），diag.js 只挑字段：论坛（最近一次抓取时间、成功与否、各站点需登录 / 报错）、简报（今天的生成时间、失败说明、数据刷新错误）、
    手机对话（最近成功、最近错误）、桌宠形象（下载状态与错误、已下载的形象、包文件时间作为最近成功）；不带帖子、消息、会话正文。
- 时延：= 公司下一次检查通道（活跃 10 秒；空闲按公司设置，默认 30 秒）+ 采集（真机实测见 e2e）+ 家里检查（等回报时 5 秒，卡片与 MCP 等待时 2.5 秒）。
- 测试：`tests/unit-company-diag.test.js`（夹具系统接口）；`tests/e2e-company-diag.js`（双 Electron + relay_server.py + 公司版导出 + 真实进程枚举）。

## 远程维护（2026-10-18 三期，op:'act'）

田哥 16:4x：「可以的，我建议都做」。先 diag 再 act；每个动作单独白名单（`core/company-bridge/remote-act.js`）。

- 链路：家里 `HomeBridge.act({ action, params })`（MCP `company_act`、`company-ask.js --act …`、「公司电脑状态」卡片上的按钮，均二次确认）→ `{ type:'hub-admin', op:'act', id, gen, action, params }`
  → 公司 `hub-admin.js act()` → `RemoteAct.run()` → `{ type:'hub-admin-status', phase:'act'|'refused', note, act:{ action, ok, … 前后对比 } }`。家里存最近 10 条，MCP / 命令行默认等约 45 秒直接返回。
- 底线：只认当前配对代次；公司设置「远程维护」（`allowRemoteMaintain`，默认开，关了回 refused）；按动作限频（kill-orphans 60 秒，其余 10 秒）；同时只做一个；
  参数家里先核、公司再核（`parseParams`）；每次写 `logs/company-act.log`，界面轻提示「对端执行了：…」（不弹系统通知）；公司每条回报带 `caps:['diag','act']`，旧版公司家里直接说明不支持。
- suspend-idle：只动 purpose=company-bridge、不在干活、没有排队 / 在途问题的会话，走 `suspendSession` 现有底线（置顶、正看着、群聊成员不收；空闲不足 1 分钟不收）；人自己开的会话一律不动。回报休眠了哪些、跳过哪些及原因、可用内存前后。
- kill-orphans（二审加固）：重新枚举的结果里找不到当前 Hub 主进程就整体拒绝（fail-closed）；隔 1.5 秒采两次量 CPU，量不到或最近还在用的不结束；发出结束后最多轮询 5 秒，回报区分「已结束」和「已发出结束请求、未确认」。
- kill-orphans：对端传 `targets:[{pid,startedAt}]`（最多 20 个），必须在 5 分钟内那次直查记下的「可结束」清单里（`hubAdmin.lastDiagKillable`，PID + 启动时间都一致）；
  动手前重新枚举进程、用同一套参数（`diag.js analyzeOptions`）再判一次：仍是「可结束」、启动时间没变（PID 没被复用）、不在保护名单（当前 Hub 进程树、所有别的 Hub 主进程及其进程树、Hub 后台脚本、本进程）才结束。
  只按 PID 结束（`process.kill(pid)`），绝不按命令行匹配；结束前后各记一次可用内存，结束过的从清单里划掉。
- set-parallel：`memFloorPct` / `maxParallel` / `maxParallelIdle` 走 `setSettings` 的校验与上下限；`restoreAfterHours`（0.25–24）到点由通道定时器（`hubAdmin.advance`）恢复原值并告诉家里。
  计划记 `values`（最初原值）与 `applied`（远程最后设下的值）：到点只恢复仍等于 `applied` 的键，期间在设置页手动改过的保留现值并记审计；第二次调整不带恢复时间时沿用原计划的时间、并入这次改的键、恢复到最初原值。
- cancel-queued：只取消排队的那一轮——第 1 轮就在排队（还没开会话）时整个问题记为 cancelled；追问轮只给该轮落 error（「第 N 轮被对端取消」），线程状态照常推导，之后还能追问。`advance` 循环里每个问题处理前都重读，派发途中（开会话、恢复会话之后）再核一次这一轮还在排队，取消不会被旧对象写回（二审）。retry：复用 `CompanyBridge.retry`。
- 版本探测：`cmd.exe` 用 `windowsVerbatimArguments` 原样传参；8 秒超时只按 PID 用 `taskkill /T` 结束这里自己起的那一个 cmd 进程树（全功能唯一用 /T 的地方）。
- 结果目录扫描：每个条目都看时间预算与条数，每次 readdir / stat 3 秒超时，整段 6 秒硬上限，到点交出已扫到的。
- 隔离测试实例可用 `CLAUDE_HUB_DIAG_LEFTOVER_MIN_AGE_MS`（残留最短存活时间）、`CLAUDE_HUB_ACT_HOUR_MS`（「1 小时」的长度）缩短等待，只在设了 `CLAUDE_HUB_DATA_DIR` 时生效。
- 测试：`tests/unit-company-remote-act.test.js`；`tests/e2e-company-remote-act.js`（双 Electron + 通道服务 + CodeAgent 替身 = 真 Claude Code + Haiku 开出真的通道会话 + 人为制造的残留进程）。

## 测试

- 单测：`tests/unit-company-hub-admin.test.js`（控制器替身 + 内存通道两端；含宽限、中断—恢复、恢复失败、只恢复一次、看门狗、配对代次、取代旧指令）。
- 真实端到端：`tests/e2e-company-hub-remote-update.js`（两台隔离 Electron + relay_server.py + 本机更新源 + 真实替换脚本与重启）。
  差距：开发运行替换的是临时 resources 目录里的 app.asar，重启后显示的版本号不变；真包换版本由 `tests/e2e-app-update-packaged.js` 覆盖。
- 真实端到端（中断—恢复）：`tests/e2e-company-hub-restart-resume.js`（同一套双 Electron + 通道服务；CodeAgent 替身 = 真 Claude Code + Haiku 正在跑 75 秒命令 → 家里命令行 `--hub-restart --force` → 公司真实 `app.relaunch` 优雅重启 → 恢复会话、只发「继续」→ 家里收到该轮回执）。
  差距：替身是 Claude Code，不是公司真机 CodeAgent；update 走替换脚本重启的那条路径用同一份恢复逻辑，但端到端只跑了 restart。
