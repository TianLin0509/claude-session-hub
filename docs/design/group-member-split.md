# 群聊总览与成员双屏

## 交互

- 群聊右上角提供两个 SVG 图标：群聊总览、成员双屏。新窗口默认总览；同窗口内按群聊保留布局；重启后仍为总览。
- 最多两个窗格。两人群直接展开；多人群通过窗格标题下拉或顶部成员状态入口选择左右成员。选择已显示的成员只聚焦，不重复挂载，不改变发送对象。
- 每屏显示成员 logo、名称、运行状态及独立会话历史。支持工具详情、原生审批、单成员停止、后台记录、多选复制和独立滚动。未显示成员的状态也出现在顶部入口。
- 底部始终使用原群聊输入框、草稿、目标头像和发送管线。聚焦/更换显示成员不改变 participants；@成员仍按原群聊契约派发。
- 成员休眠时保留休眠提示与显式恢复入口，不因切换布局自动唤醒；恢复仍经过会话独占检查。
- 中间分隔线支持拖动与方向键，Home 恢复等宽。群成员/群聊工具按钮返回总览并打开对应功能。
- 总览和成员各自保留阅读位置；隐藏成员视图保留 DOM 与审批表单，离开群聊时释放视图监听并保存阅读快照，返回时恢复已加载范围、锚点和 details 展开状态。

## 实现边界

- `group-member-split.js` 只管理窗口内的展示状态，不写持久布局、不修改成员列表、不派发 prompt、不创建 native writer。
- 群聊通过 `createSecondarySessionView(..., {groupMember:true})` 复用既有卡片/后台渲染，禁用独立 composer，挂载属于该成员的 Claude/Codex/ACP 原生控制。
- `split-session-view.js` 的阅读快照包含流式输出期间已挂载的历史数量，避免离开后重新只读最后 8 条而丢失阅读锚点。
- 群聊总览仍使用原渲染与 watcher；双屏中的 transcript 通过原生会话记录读取，群聊发送仍走原 dispatcher。

## Resume 后头像灰显修复

先用真实隔离 Hub 创建群聊、关闭窗口、同数据重开并点击侧栏群聊复现：两个成员已 connected，原生 ID 保持原值，但底部头像 label 与 checkbox 仍 disabled。

根因：打开群聊先根据 dormant 元数据渲染头像；随后 session-created 更新 sessions Map，却未触发群聊头像可用状态重绘。头像更新此前依赖不保证随后到达的 meeting 元数据变化。

修复：监听成员 session-created/updated/suspended/closed 生命周期，在 renderer 更新状态后核对头像禁用状态；仅在状态不一致时重绘目标头像行和输入提示。真实 dormant 成员仍禁用，不将未知状态伪装为已恢复。

## 验证入口

```text
node tests/unit-group-member-split.test.js
node tests/e2e-group-member-split-cdp.js
node tests/e2e-group-member-split-cdp.js --claude-approval
node tests/e2e-session-split-cdp.js
node scripts/run_unit_tests.js
```

GUI 使用真实隔离 Electron/CDP 点击和原生协议 fixture。它验证 Hub 交互、消息路由及生命周期，不代表真实供应商网络验收。
