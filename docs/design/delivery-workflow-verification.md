# 逐成员文件交付：实现验证记录

日期：2026-09-26。分支：`feat/workflow-delivery-20260926-codex1`。基线：`96eacec`。未合入 master，未升版本，未修改生产 Hub 数据或重启生产实例。

## 范围与结构审查

新增协议、执行引擎和进度控件；已有设置保存路由、dispatcher、同席位收尾、休眠/关闭、重启恢复、工作台及 renderer 接入。无删除/重命名公共函数或模块；旧字段仅在明确转换到新配置时移除，旧执行快照保留。老开发群已有文件时保留旧协议。

新增 `onSubmission` 是 dispatcher 的可选回调，旧调用方无需提供。新增 `handoffMeetingTurn` 在最终文件交付后结算聊天监听器，并递增派发代际，兼容发送确认晚到。IPC 的失败均返回明确错误，持久化失败记录日志并提示界面；未知派工不自动重发。

已搜索 `deliveryVersion` / `fileFlowVersion`、引擎创建调用、设置转换、所有新 IPC、成员恢复分支、停止及关闭路径。没有已删除模块的残余引用。JavaScript 项目按 JS 调用链核对，不机械套用技能中的 Python 搜索范围。

## 实际验证

| 命令 | 结果与边界 |
|---|---|
| `node tests/unit-delivery-workflow.test.js` | 8 组通过。含多成员交付、聊天结束不推进、迟到文件、暂停与恢复、6 轮预算、异常/空正文/篡改、归属冲突、取消重开、继续去重、休眠与 writer 释放。 |
| `node tests/unit-dev-chat-handoff.test.js` | 2 例通过。真实 dispatcher 的跨席位交接、同席位等待；最终文件早于发送回执时，迟注册 watcher 仍结算。 |
| `node tests/unit-groupchat-dispatcher-contract.test.js` | 通过。新旧文件协议均守住显式 handoff 条件。 |
| `node tests/e2e-workflow-settings-a-cdp.js` | 10 项 GUI 检查通过。真实隔离 Hub 的首次打开、保存/重开、模板切换、无效设置、6 轮上限与窄窗口。提供方为夹具。 |
| `node tests/e2e-delivery-workflow-cdp.js` | 真实隔离 Electron、输入框、IPC、dispatcher、OS 管道夹具。验证多成员门槛、CLI final 无文件不推进、文件先到可交给另一席位、暂停保留晚到文件、明确恢复只派一次、最终 CLI 未结束也能完成、实际重启无重发；截图检查窄窗口控件和进度均留在输入区。提供方结果与文件由夹具控制。 |
| `node tests/e2e-delivery-workflow-live.js` | 真实默认 PTY：Claude Haiku `claude-haiku-4-5-20251001` → Codex `gpt-6-astra` 低推理，两个成员各自实际读取/写入/改名交付，自动完成两轮。只做简单交接，不宣称验证复杂开发或真实合并。 |
| `node scripts/run_unit_tests.js --strict` | 全量 581 个文件通过，287 秒；测试进程 PATH 补 `C:\Program Files\Git\bin`，不改系统 PATH。 |
| `node scripts/run_unit_tests.js --strict delivery workflow groupchat fixed-session meeting-room session-exclusive hub-restart dev-workbench prompt-submit-ui-contract` | 全量之后的相关范围回归 59 个文件通过，26.8 秒。其后最终 handoff 竞态修复单独跑上列 3 项单测通过。 |

首轮全量有 3 个失败：旧 dispatcher 源码契约只接受旧协议，已更新；另两项是 `spawnSync('sh')` 返回未启动，因为 Git bin 不在测试进程 PATH。保留首轮日志，补充测试环境后严格全量重新通过，没有使用 lenient 或跳过用例。

## 双遍审查

结构与契约遍由实现席执行；运行时遍由只读 reviewer 独立执行并复核。修复了：休眠后晚到文件唤醒下一席位、发送失败仍显示运行、历史启动时间阻挡正常补交、重启成员缺失时未走持久会话恢复，以及最终文件早于发送确认的聊天收尾竞态。相应夹具已通过。

跨 Hub 工作流互斥复用已测 SQLite 会话归属机制；本轮专门验证同进程独立引擎拒绝抢占及关闭后释放，未以两个真实模型 Hub 争抢同一任务做破坏性实测。中途恢复主要由引擎重建单测覆盖，真实进程重启验证的是已完成任务不重发。

## 证据

- `artifacts/delivery-workflow/unit-suite.log`：首轮失败及诊断。
- `artifacts/delivery-workflow/unit-suite-final.log`：严格全量通过。
- `artifacts/delivery-workflow/affected-final.log`：相关范围通过。
- `artifacts/workflow-a/gui-evidence.json`：设置 GUI。
- `artifacts/delivery-workflow/evidence.json`：协议 GUI、实际重启与截图。
- `artifacts/delivery-live/evidence.json`：真实模型、交付正文/哈希、独立 PID 与安全退出证据。

两个 GUI/真实 CLI 测试使用隔离数据、home、配置和独立 CDP 端口；正常关闭自己的 Hub，无强杀。真实 CLI 测试完成后删除本次复制的凭据配置文件。

## 产品边界

文件标识、哈希与提交记录保证本轮交接一致性，不代替事实核验、代码测试和独立审查。未知提交保守停住；阻塞文件保留，结束任务后可调整目标重开。新协议先覆盖在设置里保存的新任务，历史文件任务不自动迁移。

## 合入前追加审查（2026-09-26）

用户授权审核后合入。独立 reviewer 又发现两项恢复边界，已修复并补充回归：

- 暂停/取消/休眠增加控制版本号；接续操作在异步返回后再次核对，不能覆盖更晚的停止决定。
- 重启后原派工 Promise 不复存在，不能永远当作仍在执行。现在按持久化 attempt 的任务、步骤、派工次数和成员身份查证完成/中断或原生结束证据；证据不明确继续停住。核对只结算旧派工，只有用户明确继续才发送补交。本进程仍有活跃 Promise 时不提前结算。

`node tests/unit-delivery-workflow.test.js` 已扩展到 10 组通过；`node tests/unit-dev-chat-handoff.test.js` 2 例通过。最终合并闸门以最新主干的隔离 dry-run 与正式合并入口日志为准。
