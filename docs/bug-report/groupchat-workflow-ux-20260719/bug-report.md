---
feature_ids:
  - groupchat-minimal-actions
  - groupchat-serial-autosave-prompts
  - groupchat-real-timeline
  - groupchat-turn-interrupt
  - groupchat-new-member-history
topics:
  - groupchat
  - serial-workflow
  - timeline
  - interrupt
  - context-delivery
doc_kind: bug-report
created: 2026-07-19
---

# AI 群聊工作流与时序问题报告

## 原始需求

1. 删除群聊输入区的“综合共识、互相挑错、生成交接、引用焦点卡、复制本轮”五个低频按钮。
2. 串行工作流配置改动立即生效，不再要求点击保存。
3. 每一步的每个 AI 可配置仅对该 AI 生效的追加 prompt，并提供“Claude 出方案、Codex 优化并执行”的建议模板。
4. 群聊与普通会话同时显示开始工作时间和完成时间；群聊 AI 卡片按真实完成时序呈现。
5. 群聊可一键向本轮所有已收到 prompt 且仍在运行的 AI 发送 Ctrl+C，结束本轮、恢复输入并显示中断状态。
6. 新增成员首次回答前应收到它未见过的全部用户提问和 AI 回复，不能只有上一轮发言。

## 复现与证据

| 问题 | 复现路径 | 已确认调用链与根因 |
| --- | --- | --- |
| 五个无用按钮 | 打开任意群聊，观察输入框上方 | `meeting-room.js::_updateInputPreflight()` 注入 `_renderNextActionBar()`，且有两套重复点击分发。 |
| 串行配置需保存 | 打开“串行工作流”，调整步骤后直接关闭 | `workflow-config-modal.js` 只在 `_save()` 中调用 `onSave`，普通编辑仅修改弹窗内局部状态。 |
| 无逐 AI prompt | 查看步骤成员 chip | 配置模型只有 `steps`，调度器对同一步所有目标复用同一个 `userInput`。 |
| 卡片时序错误 | 并行或串行发送，让后列 AI 先完成 | `Promise.allSettled()` 保留目标数组顺序；`completeTurn()` 等全部结束后按成员顺序统一创建消息，未持久化每个 AI 的开始/完成时间。 |
| 群聊无法一键中断 | 本轮运行时观察输入区 | dispatcher 虽保存 `activeWatchers`，但没有 meeting/turn 上下文，也没有 interrupt IPC；watcher 状态机没有 `interrupted` 终态入口。 |
| 新成员缺完整上下文 | 对话多轮后添加新 AI，再让其回答 | `buildFirstDelta()` 最终复用 `buildDelta()`；后者无条件过滤全部 `role === 'user'` 历史消息，因此新成员首次只见系统提示、未读 AI 回复和当前问题。 |

## 修复边界

- 不改生产 Hub 状态，不启动生产实例。
- 普通成员继续使用增量上下文；只有首次投递的新成员得到完整未见历史。
- 中断只作用于当前 meeting 本轮仍活跃的 watcher，不广播到其他群聊或无关 session。
- 用户问题保留在时间线中并标记本轮中断，同时原问题回填输入框便于修改重发。
- 串行逐 AI 追加 prompt 不进入可见用户消息，只进入对应目标 AI 的实际 source prompt。

## 验收证据要求

- 新增红测覆盖完整历史、真实完成顺序、双时间、逐 AI prompt 与 meeting 隔离中断。
- 对应单测转绿，相关既有回归测试通过。
- 隔离 Electron 实例验证：按钮精简、配置自动生效、右键 prompt、真实双时间、中断恢复输入。
- 由非本实现者完成跨模型审查，修正阻断项后再提交。
