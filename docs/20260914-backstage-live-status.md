# Codex / Claude 后台动态状态

用户希望：原生 CLI 收到消息后，即使长时间没有正文，也有类似 thinking 动态指示；随时进入后台能辨认正在执行或已停止。

原界面只在底部用 11px 文本显示状态，未翻译 starting；原终端模式还会隐藏该行。无输出时欢迎内容没有跟随运行状态。

本次在现有后台工具栏的位置增加共享动态状态，不向 xterm 写入模拟字符，不改变终端尺寸，不改原生生命周期。

| 原生状态 | 后台提示 |
| --- | --- |
| 正在连接 | 正在连接 + 动态指示 |
| 消息尚未确认 | 正在发送 + 动态指示 |
| Claude 确认收到，未开始输出 | 已收到 · 等待开始 + 动态指示与等待时间 |
| 原生本轮已启动 | 思考 / 执行中 + 动态指示与运行时间 |
| 待审批/提问 | 等待你确认，不转圈 |
| 停止请求已发出 | 正在停止，直到引擎终态确认 |
| 完成/中断/失败 | 已完成 / 已停止 / 执行失败，不转圈 |
| 断线或未知提交 | 连接已断开 · 状态待核对 / 状态待核对，不转圈 |
| 休眠历史入口 | 会话已关闭，不显示仍在执行 |

三种后台视图均保留顶部状态，离开后台暂停本地计时与动画，重新进入立即使用当前原生快照。
计时仅渲染时间差，不拉取原文、不轮询引擎、不制造终端输出；静默多久都不会推断“已停止”。
连接可用且本轮未结束，只能证明当前收到的运行状态，不能由动画证明服务端持续计算或完全健康。界面详细说明明确区分这两点。

系统选择“减少动画”时尊重该设置，保留文字和递增计时；普通动画模式显示旋转圆环。本机测试发现系统启用了减少动画，专项分别验证两种设置。

实现：`core/native-backstage-status.js`、`renderer/codex-backstage.js`、`renderer/styles/codex-backstage.css`。
验证：

```powershell
node --test tests/unit-native-backstage-status.test.js tests/unit-codex-backstage-renderer.test.js
node tests/e2e-backstage-status-cdp.js
node tests/e2e-codex-backstage-cdp.js
node tests/e2e-claude-codex-parity-cdp.js
node scripts/run_unit_tests.js
```

专项 GUI 使用真实隔离 Hub 和原生协议 fixture，通过真实键鼠操作发送消息、换视图、停止及审批，并让 fixture 子进程真实退出验证断线提示。它不代表真实模型服务可用性验收。
