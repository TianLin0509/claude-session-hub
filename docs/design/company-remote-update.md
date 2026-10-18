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
  「残留嫌疑」只有一种：父进程已经不在、不在当前 Hub 和任何别的 Hub 进程树里、自己不是 Hub 主进程的 CodeAgent / node，孤立的 Electron 子进程（--type=）单独标注；CodeAgent 排前（2026-10-18 审核：开发机上把正在运行的生产 Hub 误标成残留）。
  
  hub（版本、启动时间、`parallelLimitSafe()`、通道队列快照、会话列表含 PID 与内存）、pool（只用「个人 / 号 1 / 号 2」，字段白名单）、
  logs（company-bridge.log、company-session-care.log、window-events.log 最后 N 行，默认 80、上限 200）。
- 脱敏：所有字符串过 `scrubText`（号身份）+ 口令/令牌样式、配对码、网址、本机用户名与用户目录；UUID 保留。
- 大小：整条消息（HTTP 正文 `{to,mid,blob}`）实测 < 60000 字节，超了按顺序降级：日志 40 行 → 15 行 → 进程前 10 → 日志省略 → 会话 20 个 → 进程前 5、会话省略 → 只留汇总 → 只留摘要，始终一条发完。
- 底线：只认当前配对代次；同一编号只处理一次；30 秒限频、同时只跑一条（回 refused 写原因）；只读，不读源码、不回传文件内容（日志尾部除外）；
  公司写 `logs/company-diag.log` 审计，界面给一条轻提示「对端查看了这台电脑的状态」（`notify(..., { quiet:true })`，不弹系统通知）。
  对端在看时公司接下来 10 分钟按 10 秒检查通道（同追问窗口），紧接着的追查更快送到。
- 时延：= 公司下一次检查通道（活跃 10 秒；空闲按公司设置，默认 30 秒）+ 采集（真机实测见 e2e）+ 家里检查（等回报时 5 秒，卡片与 MCP 等待时 2.5 秒）。
- 测试：`tests/unit-company-diag.test.js`（夹具系统接口）；`tests/e2e-company-diag.js`（双 Electron + relay_server.py + 公司版导出 + 真实进程枚举）。

## 测试

- 单测：`tests/unit-company-hub-admin.test.js`（控制器替身 + 内存通道两端；含宽限、中断—恢复、恢复失败、只恢复一次、看门狗、配对代次、取代旧指令）。
- 真实端到端：`tests/e2e-company-hub-remote-update.js`（两台隔离 Electron + relay_server.py + 本机更新源 + 真实替换脚本与重启）。
  差距：开发运行替换的是临时 resources 目录里的 app.asar，重启后显示的版本号不变；真包换版本由 `tests/e2e-app-update-packaged.js` 覆盖。
- 真实端到端（中断—恢复）：`tests/e2e-company-hub-restart-resume.js`（同一套双 Electron + 通道服务；CodeAgent 替身 = 真 Claude Code + Haiku 正在跑 75 秒命令 → 家里命令行 `--hub-restart --force` → 公司真实 `app.relaunch` 优雅重启 → 恢复会话、只发「继续」→ 家里收到该轮回执）。
  差距：替身是 Claude Code，不是公司真机 CodeAgent；update 走替换脚本重启的那条路径用同一份恢复逻辑，但端到端只跑了 restart。
