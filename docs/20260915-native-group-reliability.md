# 原生会话确认、停止与群聊一致性

基线：master `6fbe9e9f521084db9da2bdf78f710eff5c3ba5e5`，v1.6.170。
实现位：`fix/native-group-reliability-20260915-codex1`。生产目录和运行中的 Hub 未改动；实现分支不提前升版本。

## 根因与修复

1. **未知提交被自动重试**：Codex 的 `uncertain` 在群聊捕获异常时丢失，分类表主要识别 Claude；串行和旧开发循环没有一致尊重 `autoRetry:false`。现在保留结构化不确定性，普通串行、旧循环的执行位和评审位均暂停核对，保留原始 attempt。无回执的派发异常也不自行重试。已定义的空结果有界重试继续保留。
2. **控制请求超时后仍写入／丢失晚到确认**：Claude 控制超时删除 pending，但 writeQueue 仍能执行该设置；已发出的成功回执也被当作过期丢弃。现在未写入请求过期后会在真实写入前取消；已写入的模型、速度和模式设置保留确认屏障，同一连接、epoch、request ID 的晚到回执才更新实际设置。确认前不能带着未知设置继续发送。晚到 Fast 确认也同步会话偏好与重启 overlay。Codex 同样禁止已过期且尚未写入的排队 RPC 稍后执行。
3. **停止期限被用来关闭进程**：Claude 停止未确认后不再因墙钟时间终止 writer；保留连接并继续消费本轮原生结束回执。Codex 补齐 pending／unknown 停止状态和重复点击去重；已明确拒绝的停止恢复原审批状态，真实原生终态才清除停止标记。
4. **群聊停止仍走旧按键路径**：原来仅 Claude 走原生 interrupt，Codex 会重复发 ESC，ACP 则根本不识别 ESC。现在三个原生 driver 均只调用一次 interrupt；PTY provider 仍使用自己的按键路径。
5. **Codex 群聊同步仍走旧提取路径**：现在按本轮 attemptId、原生 turnId、threadId 和 epoch 读取 `readOutcome`；缺失 ACK 时通过原生历史核对原始提交。未完成、空结果、身份变化、其他轮次都拒绝覆盖。本轮原生完成后提供“原生已完成 · 待同步”。开发文件交付仍保留其专用历史收录路径。
6. **群聊补充的排队被说成即时收到**：返回值区分 `queuedSids` 与 `deliveredNow`；已进入持久化原生队列的内容不再注入下次派工。界面明确显示 Claude 排队与 Codex 即时追加。实际 GUI 复现还发现普通串行运行中的输入没有进入补充入口，现与循环工作流共用补充投递；补充确认在面板刷新完成后显示，避免刚显示就被重建的面板清掉。
7. **Claude 后台缺 stderr**：接入现有分页诊断存储，保留真实原文；此前未采集的历史不补造。

## 确认期限的含义

`core/native-confirmation-policy.js` 集中定义默认 60 秒确认观察预算，沿用原 Codex RPC 预算，使 Claude 提交、状态控制与两家的停止使用同一默认值。可由已有 driver options 在测试或集成中覆盖。

该值不是供应商协议规定的模型执行上限，也不是“AI 停止工作”的证据。收到输入确认后，长时间思考、执行工具或等待审批不受此值截断。观察预算耗尽只代表结果待核对：群聊暂停后续派发、不重发、保留 writer 和原始身份。关闭会话才走明确的 writer 清理流程。启动、文件锁、资源大小等不同用途的预算没有被合并成同一个数。

## 群聊中仍保留的差异

| 行为 | Claude Code | Codex | 结论 |
| --- | --- | --- | --- |
| 执行中补充要求 | 当前 driver 排队到前一查询结束 | `turn/steer` 追加到当前轮 | 保留真实能力，明确提示 |
| 未知提交核对 | 同一 writer 的精确晚到 echo 可自行确认 | 缺失 RPC 回应时可通过 `thread/read` 核对 client ID 与内容 | 机制不同，均不得重发未知输入 |
| 原生模型、推理档、速度、计划及审批内容 | stream-json 控制与 Claude 工具审批 | App Server 控制与 Codex 原生审批 | 共用操作入口，具体选项保留原义 |
| 普通串行／开发文件交付／历史与后台 | Claude 原生身份与 journal | Codex thread/turn 与 journal | 共用群聊展示和流程，保存各自身份 |
| token 与上下文 | 累计调用消耗与最近上下文观测分开 | 原生用量事件 | 展示接近，统计口径不冒充等价 |

## 验证入口与证据边界

- `node --test tests/unit-native-confirmation-reliability.test.js tests/unit-native-backstage-status.test.js tests/unit-codex-native-session.test.js tests/unit-groupchat-recovery-ipc-contract.test.js`：55/55。
- `node tests/unit-loop-engine.test.js`：28 项，通过普通串行及旧循环的不重试、停止和恢复检查。
- `node scripts/run_unit_tests.js`（`HUB_UNIT_JOBS=2`，Git `bin` 在 PATH）：首轮 510/510；最终提交对应结果另记 artifacts 验证报告。
- `node tests/e2e-native-consumer-matrix-cdp.js --provider=claude --scenario=approval --view=group`；provider 同时覆盖 codex，scenario 同时覆盖 interrupted、disconnected，共六组。
- `node tests/e2e-claude-native-controls-cdp.js --late-control`：设置待核对可见、晚到确认生效、Fast overlay、计划模式与恢复。
- `node tests/e2e-claude-serial-late-echo-cdp.js`：真实确认预算后的晚到回执、同步及继续下一位。
- `node tests/e2e-codex-group-recovery-cdp.js`：真实群聊派发、原生核对按钮和同步按钮；只派发一次。
- `node tests/e2e-native-group-supplement-cdp.js`：混合群聊实际输入，分别验证排队与 steer。
- `node tests/e2e-backstage-status-cdp.js`：两家无正文输出时的动态提示和计时、审批、停止、断连及后台三视图。测试须保持测试页面可见；窗口被遮挡时页面按设计暂停动画和计时。

GUI 运行真实隔离 Electron、真实 IPC／组件和原生协议子进程 fixture，不是实际 Claude／Codex 模型服务的网络、质量或性能验收。测试未重启生产 Hub；用户正在运行的旧窗口不会自动获得这些改动。
