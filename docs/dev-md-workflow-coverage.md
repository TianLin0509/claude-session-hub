# 开发群聊 MD 工作流 · 验收覆盖账本

> 对应任务书 `artifacts/20260908-041719-aihub-dev-md-workflow-task.md` 第 10.3 节的 A–F 用例表。
> 一个脚本有多少条 assert **不等于**完成多少项验收，所以这里逐项列：要求层级、实现位置、
> 脚本入口、实际结果、证据。**未执行**和**不适用**分开写，不混进「通过」。
>
> 复跑入口（都在本 worktree 里）：
> - U：`node scripts/run_unit_tests.js`
> - I：`node tests/dev-md-handoff-i-e2e.js`
> - L：`node tests/dev-md-handoff-l-e2e.js --stage=kickoff|full|fail-first --budget=<秒>`

## 状态口径

| 记号 | 含义 |
|---|---|
| 通过 | 本轮实际跑过并通过，有可复核证据 |
| 未执行 | 有实现但这一轮没跑，不算通过 |
| 未实现 | 功能本身还没做 |
| 部分 | 该用例被拆成几条，只有一部分跑过；未跑的那部分写清楚 |

## A 建房与场景

| ID | 层级 | 实现位置 | 脚本入口 | 结果 | 证据 / 说明 |
|---|---|---|---|---|---|
| A01 | I+L | `renderer/meeting-create-modal.js`（取消分岔）、`renderer/workflow-templates.js`（默认 discuss + mdHandoff）、`main/groupchat/loop-engine.js`（discuss/kickoff 阶段拦 loop:start） | I：`dev-md-handoff-i-e2e.js`「A01/I …」4 条；U：`unit-dev-scene-contract.test.js` | 通过 | 新房默认落讨论阶段、默认 mdHandoff、`loop:start` 返回 `dev_discuss_phase` |
| A02 | L | `core/dev-discuss.js` 的 kickoff prompt、`loop-engine.runKickoff` 只派一位 | L：`--stage=kickoff`/`full`「A02/L …」 | 通过 | 真实 Codex 自己写出并改名开题报告，报告含四项；派发目标只有 m1 |
| A03 | I+L | `renderer/workflow-templates.js`（`dev-task-solo` 不设 mdHandoff、devPhase=build） | U：`unit-dev-scene-contract.test.js`「极简起手」 | 部分（U 通过，I/L 未执行） | 极简不套用双席位链路已由单测守住；隔离实例与真实 CLI 上的极简全流程本轮未跑 |
| A04 | I | 老房间没有 `mdHandoff` / `devPhase` 字段即保持原行为 | U：`unit-loop-md-handoff.test.js`「老房间没有 mdHandoff 字段」 | 部分（U 通过，I 未执行） | 引擎层已守；「打开升级前的在途房间」这一具体现场未在隔离实例上重放 |

## B 交付判定与循环

| ID | 层级 | 实现位置 | 脚本入口 | 结果 | 证据 / 说明 |
|---|---|---|---|---|---|
| B01 | U+I | `core/dev-task-docs.js`（草稿/空文件不接收）、引擎交付闸门 | U：`unit-dev-task-docs.test.js` 2 条；I：「B01/I …」4 条 | 通过 | 草稿在、完成文件空、普通回复结束三种都不推进；审查未被派出 |
| B02 | L | 引擎接收后自动开工 | L：`--stage=kickoff`/`full`「B02/L …」 | 通过 | 接收后 devPhase 自动 → build，接收凭据落盘 |
| B03 | U+I | 账本按 pos + 指纹去重；任务目录按 meetingId 隔离 | U：`unit-dev-task-docs.test.js`「重复出现只算一次」「任务目录按群隔离」 | 部分（U 通过，I 未执行） | 「别的任务同名完成文件」这一条只有单测层证据（目录按群隔离使其结构上不可能），未在隔离实例上另造一个群验证 |
| B04 | I | 派发前重扫 `checkDeliveryOnce` | I：「B04/I …」2 条 | 通过 | 文件已存在时不重派工作位，交付被接收后正好派下一位一次 |
| B05 | I | `readDelivery` 有界重读 + 闸门保留阶段 | I：「B05/I …」2 条 | 通过 | 用同名目录制造读取失败；保留阶段、不判 FAIL、未记成评审未通过 |
| B06 | I | 接收凭据落盘，与 UI 忙闲无关 | I：「B06/I 交付凭据已持久化」 | 部分 | 凭据落盘已验；「上一位仍在收尾时显示已交付」这一条 UI 呈现未截图验证 |
| B07 | U+I | 裁决取自手册，聊天回执缺失不阻断 | U：`unit-loop-md-handoff.test.js`「B07」；I：「B07/I …」2 条 | 通过 | 群聊无任何协议字段时仍一轮收口 |
| B08 | U+I | 缺 RESULT → incomplete；矛盾 → 连指纹落盘；已接收被改 → 待核对 | U：3 条；I：「B08/I …」5 条 | 通过 | 缺 RESULT、矛盾、继续不消解矛盾、待核对期间不派人 |
| B09 | L | 全链路 + fixture 实际合并 | L：`--stage=full`「B09/L …」6 条 | 通过（25/25） | 断言已收紧：必须 RESULT=PASS、master 必须前进、代码与测试都改、合并后 master 上测试真过、实现分支确实被合并 |
| B10 | I+L | 从已知缺陷交付开始 | L：`--stage=fail-first` 6 条 | 通过（19/19） | fixture 里植入真实缺陷分支，真实审查位必须自己判 FAIL 并写阻断项，下一轮修复后复审 |
| B11 | U+I | `maxRounds` 计数；故障不消耗返工轮次 | U：`unit-loop-engine.test.js`（既有）、`unit-loop-md-handoff.test.js`「FAIL 走下一轮」 | 部分（U 通过，I 未执行） | 三轮上限的确定性计数由单测覆盖；「另插入一次网络/CLI 故障不额外消耗轮次」未在隔离实例上单独重放 |

## C 用户消息与成员上下文

| ID | 层级 | 实现位置 | 脚本入口 | 结果 | 证据 / 说明 |
|---|---|---|---|---|---|
| C01 | L | `main/ipc/groupchat-supplement-handlers.js` | L：「C01/L …」3 条 | 通过 | 本轮修了一处真缺陷：判断「谁在跑」原来只看内存 watcher，prompt 已提交但 watcher 未注册的窗口里插话被静默降级成待送达 |
| C02 | L | 同上（对审查位运行中发补充） | L：`--stage=fail-first` 时执笔者就是审查位，「C01/L …」即对审查位插话 | 通过 | fail-first 阶段的执笔者就是审查位，那一轮的插话即「对审查位运行中发补充」 |
| C03 | U+I+L | 逐成员账本 + dispatcher 注入 + 送达确认后才标已读 | U：`unit-user-supplement-delivery.test.js`；L：「C03/L …」2 条（比对真实 prompt 原文） | 通过 | L 层用采集到的**真实 prompt 原文**核对逐人送达与去重，不看 agent 自述 |
| C04 | U+I | `origin` 标记区分真实用户输入与 Hub 阶段指令 | U：2 条；I：「C04/I …」 | 通过 | Hub 派工不进插话账本；补充带 `origin: 'user'` |
| C05 | L | 原文不截断 | L：「C05/L …」 | 通过 | 多行 + 中文 + Windows 路径 + emoji + 长正文，原样保存 |
| C06 | U+I | 发送失败不标已读 | U：1 条；I：「C06/I …」 | 通过 | 失败保留待确认；原文完整 |
| C07 | L | CLI 私话不广播 | L：「C07/L …」2 条 | 通过 | 私话不进群聊、不推进阶段 |
| C08 | I | 任务结束后仍保存，不伪称全员已收 | U：1 条；I：「C08/I …」3 条 | 通过 | 含重启后待送达原文仍在 |

## D 中断与接续

| ID | 层级 | 实现位置 | 脚本入口 | 结果 | 证据 / 说明 |
|---|---|---|---|---|---|
| D01 | I | 停止保留阶段与文档 | U：`unit-loop-md-handoff.test.js`「停止保留现场」 | 部分（U 通过，I 未执行） | 「中断隔离 CLI 后用户恢复原会话」这一具体现场未重放 |
| D02 | I | 重启重扫接收凭据 | I：「D02/I …」2 条 + 「B04/I」 | 通过 | 真实重启同一数据目录，凭据与阶段都在 |
| D03 | I | 接收落盘后、派发前中断 | U：「B04/D02 文件已经在了」；I：「B04/I」 | 部分 | 派发前中断的等效现场（文件已接收但未推进）已验；未用真正的进程崩溃制造这个窗口 |
| D04 | I | 回执丢失时先核对成果 | U：`unit-loop-md-handoff.test.js`「派发失败但文件其实已经在了」 | 部分（U 通过，I 未执行） | 已实现「确认丢失但成果在就按成果算」 |
| D05 | I+L | fixture 已合并但回执缺失 | — | 未执行 | 本轮未造这个现场 |
| D06 | I | 停止意图落盘，迟到文件不触发派工 | U：3 条；I：「D06/I …」2 条 | 通过 | 含停止与完成文件并发 |
| D07 | U+I | 双击 / 旧请求晚到 / 状态损坏 | I：「D07/I …」6 条；U：`unit-loop-ipc-resume-entries.test.js` | 通过 | 修正误报后逼出两条真缺陷：状态记录被写坏时照单全收（现在损坏标记持久化）、IPC 层双击存在时序窗口（现在按群加在途标记） |
| D08 | I | Hub 重启后原 CLI 仍在执行 | — | 未执行（环境限制） | 隔离实例退出会带走它 spawn 的 CLI，无法在本机构造「Hub 退出但 CLI 存活」；按任务书要求如实记录，不宣称已验 |

## E 路径鲁棒性

| ID | 层级 | 实现位置 | 脚本入口 | 结果 | 证据 / 说明 |
|---|---|---|---|---|---|
| E01 | I+L | `core/dev-project-locator.js` 唯一命中即自主继续；开题报告「项目根：」绑定 | U：`unit-dev-project-locator.test.js`；I：「E01/I …」3 条 | 部分（U+I 通过，L 未执行） | 核实通过后自动进入实现、凭据落盘已在隔离实例验；真实 CLI 上「两位后续使用同一核实路径」未跑 |
| E02 | I | `resolveLaunchDir` 退到存在的祖先并明说是落脚点；核实不过不开工也不绑 | U：3 条；I：「E02/I …」3 条 | 通过 | 隔离实例上验了：项目根核实不过 → 停在开题、状态给出具体原因、未核实路径一律不绑 |
| E03 | U+I | 多候选只问一个问题；路径只是例子不当目标 | U：2 条；I：「E03/I …」3 条 | 通过 | 用派发桩记录的**真实 prompt 原文**核对，不是只看函数返回值 |
| E04 | I | worktree（.git 是文件）算有效现场；子目录能找到仓库根；任务目录与工作目录解耦 | U：4 条 + `unit-dev-workspace-guard.test.js` 3 条；I：「E04/I …」3 条 | 通过 | worktree 被绑定、建房不再拦仓库子目录（按仓库根建群）、交接文档不随项目路径漂移 |

## F 回归

| ID | 层级 | 实现位置 | 脚本入口 | 结果 | 证据 / 说明 |
|---|---|---|---|---|---|
| F01 | L | 卡片人话 + MD 承载细节 | — | 部分 | MD 由真实 agent 写出并可打开（L 层证据目录里有原文）；「卡片可独立理解 + 点击打开附件」的 UI 截图未做 |
| F02 | U+I | 既有提交链路 / 极简 / 版本策略回归 | U：`node scripts/run_unit_tests.js` 全量 | 通过 | 全量单测全绿；版本号未改，留给合并脚本 |

## 本轮明确未完成

1. **D05 / D08**：未造对应现场。D08 属任务书允许的环境限制（无法在本机保持「Hub 退出但 CLI 存活」）；D05（fixture 已合并但回执缺失）是本轮时间未及。
2. **E01–E04 的 L 层**：I 层已在隔离实例上验过；真实 CLI 上的路径纠正未跑。
3. **A03 / A04 / B03 / B11 / D01 / D03 / D04 的 I 层**：只有单测层证据。
4. **F01 的 UI 截图**：没有做界面截图证据。

以上一律记为「未执行」，不计入通过。


## 本轮实际运行记录（2026-09-08）

| 层 | 命令 | 结果 | 证据目录 |
|---|---|---|---|
| U | `node scripts/run_unit_tests.js` | 392 个文件全过 | 终端输出 |
| U | 同上（第五轮修完后重跑） | 392 个文件全过 | 终端输出 |
| I | `node tests/dev-md-handoff-i-e2e.js` | 56 / 56（含新增的 E01–E04 九条） | 隔离数据目录见运行日志 |
| L | `node tests/dev-md-handoff-l-e2e.js --stage=full --budget=1200` | 25 / 25（路径闸门加上之后又跑了一遍，仍 25/25） | `evidence/`：开题报告、合并手册、master 测试输出、fixture 图、逐人送达 JSON |
| L | `node tests/dev-md-handoff-l-e2e.js --stage=fail-first --budget=1200` | 19 / 19 | 同上，另含 `review-1-fail.md`（真实 FAIL）与 `review-2.md`（复审 PASS） |

L 层 full 的真实合并：`b394057 merge: feat/greet-greeting`（`--no-ff` 合进 master），
合并手册的 VERIFIED 记录了它亲跑测试、变异回放、试合并再 abort、最终生成合并提交。

L 层 fail-first 的真实返工：第一轮 `RESULT: FAIL`，阻断项写明「默认问候语被写死为 'hi'，
分支上 `node test.js` 输出 `BROKEN default` 退出码 1」；第二轮实现位在同一分支上
`fix: restore default greeting compatibility`，复审 `RESULT: PASS` 并合并
（`6eb95d8 merge: feat/greeting-defective`）。
