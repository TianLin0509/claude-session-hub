# Claude 对齐 Codex：交互和运行开销

用户优先使用 Claude / Codex，要求以最新 Codex 体验为基准，兼顾 Qwen、DeepSeek CLI、Zhipu，并保护生产窗口。此前 ACP 修复已合入 a55c766（v1.6.159）；本文描述随后补齐的 Claude 差异。

## 对照范围

检查 fe04cc0（默认卡片）、00a6b6c（历史窗口和空闲开销）、6aac84e（共享原生后台）、19a2f0a / e2bd612（收起后台升级提示）、48bb6da（精简工具栏）、c2fa12b / 7255a28（输出状态与回答导航），保留最新群聊 journal 卡片行为。

| 能力 | 处理与边界 |
| --- | --- |
| 默认卡片、最新消息、历史分页、问题导航 | 沿用共有界面；真实隔离 Hub 验证 Claude 与 Codex 历史切换 |
| 大工具输出 | Claude 活动卡只携带有界摘要；查看/复制全文按精确会话、输入 UUID、工具 ID 读取原文；后台记录和工作流保持完整 |
| 多 Hub 同一会话 | 沿用一个原生 writer；Claude 后续更新只发新增/变化的已完成消息，当前流内容仍完整同步；首个全量快照保持完整 |
| 新旧窗口共存 | 仅所有观察者声明支持时使用消息增量；旧观察者存在时保留完整旧协议；新观察者的初次快照不能吞掉旧观察者待收的增量 |
| 审批和提问 | Claude 使用 Codex 样式、可点击选项和多行输入；按 epoch / request / submission 保留其他问题的答案、焦点；提交中禁止重复操作 |
| 停止 | 同步锁存停止意图、撤销未实际写入的旧允许回复、拒绝迟到请求；以原生终态确认，超时进入待核对，不重发 |
| 后台输出 | Claude 获得同样的只读输出外观、行高与阅读跟随；所有原生后台的真实滚轮直接滚动逻辑缓冲，防止回灌或延迟 DOM 同步吞掉上翻；向下回到底部恢复跟随 |
| 当前活动 | Claude 仅当前输入 UUID 或活跃后台活动可以更新输入栏状态；历史工具不覆盖新轮次 |
| 模型、推理、速度、计划模式、恢复 | 保留各自原生控制接口；检查现有 Claude GUI 控件、断线恢复和多 Hub 控制权移交 |
| 群聊 | 审批、停止、未知结果同步到成员卡；开发工作流使用现行整阶段回执屏障，旧结果不能结算新阶段 |

## 为什么降低开销

旧 Claude 共享消息在每次短更新时重新编码已完成的大工具结果。合成 8 MB 历史、24 次小更新的同一序列化基准：总载荷从 192,014,520 bytes 降至 12,360 bytes，累计耗时 376.34 ms 降至 0.265 ms。此处是序列化测量，不是整个应用速度或物理磁盘 IO。

真实隔离 Electron + 协议子进程 fixture 中，10 个工具共约 8 MB 输出，普通卡片 IPC 约 31,817 字符；连续输入、提问、工具全文分页和停止通过，采样 IPC 最大约 1.4 ms。原生管道按约 8 ms 工作片主动让出事件循环，完整帧顺序、错误传播和 EOF / process close 收尾由回归守护。

## 实际验证与审阅

- `node tests/e2e-claude-codex-parity-cdp.js`：真实鼠标、键盘、滚轮；大结果摘要/全文、草稿、多个问题、停止 pending 与终态。
- `node tests/e2e-native-runtime-efficiency-cdp.js`：三 Hub；Claude / Codex 一个 writer、观察者草稿、审批和控制权移交。
- `node tests/e2e-claude-native-controls-cdp.js`：12 项 GUI，包括速度、计划模式和后台入口。
- `node tests/e2e-claude-native-cdp.js --mode=recovery`：5 项恢复检查。
- `node tests/e2e-native-consumer-matrix-cdp.js --provider=claude --scenario=approval --view=group`；另跑 `interrupted`、`disconnected`：群聊和成员界面状态、导航后不误结算。
- `node tests/e2e-claude-native-fileflow.js`：4 项实际输入、文件交付和阶段接续；更新过时的“未收到前阶段回执便派工”测试预期，不改变工作流实现。
- 新增消息增量、工具详情、停止竞态、管道公平调度单测，并运行现有后台任务、关闭、传输、共享后台和面板单测。
- 双遍自审：结构/调用契约一遍，异步/错误/并发/数据完整性一遍。修复回灌强制置底、异步 DOM 滚动丢失、停止按钮未禁用、EOF 后缓冲未排空便收到 process close 的问题；没有独立审查者。
- 旧首页仪表盘已被 34d95d1 替换；消费者测试改验当前欢迎页导航与真实原生状态，不恢复废弃指标/刷新按钮。

完整候选和最新主干的集成由 `python scripts/merge_task.py <完整 SHA> --dry-run` 检查，全量 `node scripts/run_unit_tests.js` 通过后才正式合并、升版本、推送；最终 SHA 和证据路径见交付报告。

集成期间同步主干 4d0c76a（v1.6.160）的原样斜杠输入和原生命令卡片改动，保留 Claude 的新 slash 参数/回执检查及共用命令刷新，不覆盖另一任务的实现。

历史切换额外做了 CPU profile / Chromium trace：默认隐藏窗口的整秒长任务位于 `LayerTreeHost::WaitForCommitCompletion`，包括光标闪烁定时器，并非 JavaScript 重建卡片。仅在临时测试入口关闭后台限速后，同一 3 会话、每会话 80 轮数据的 4 次切换，卡片刷新约 12.9–15 ms，Renderer 总任务时间约 55–106 ms，无长任务。该对照模拟前台调度，未修改生产 BrowserWindow 的限速/省电策略，不能当成真实桌面所有负载下的延迟承诺。可用 `$env:HUB_CARD_PROFILE='1'; $env:HUB_CARD_UNTHROTTLED='1'; node tests/e2e-card-history-windowing-cdp.js` 重现剖析；`PROFILE_ONLY` 不宣称分页 E2E 通过。

## 能力边界

以上 GUI 使用真实 Hub 与受控原生协议进程，没有调用收费模型，不能据此承诺所有真实供应商负载都不会卡。历史首次读取仍需工作，旧的磁盘转录解析未在本任务全部改为有界投影。完整原始记录保留，摘要不能替代全文。

Claude / Codex 的模型档位、权限语义、恢复身份来自各自原生协议，不伪造相同能力。ACP 三家继承共用卡片和原生后台阅读改进及 v1.6.159 的存储修复；本任务未给 ACP 新增 Codex / Claude 同等级跨 Hub writer 转交。已运行旧窗口不会自动热替换；本任务没有重启生产 Hub。
