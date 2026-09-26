# CLI 与辅助卡片统一检查（2026-09-26）

用户授权：审核 c7d25d6 已合入的修复，然后深挖 Codex，并把其他提供方统一到真实 CLI + 辅助卡片。补充要求：移除截图中的「暂未确认消息提交 / 补发 / 忽略」横幅。

基线：ecb962f，生产未提交内容不动。实施分支 fix/cli-card-audit-20260926-codex1。

## 验收范围

- 审核前轮身份切换、分支、恢复、停止、重启、提交确认改动。
- Codex 真实 UI：发送、停止、长文、斜杠命令、新线程、恢复、分支、卡片与右栏。
- 其他提供方：Claude、DeepSeek Codex、Gemini、Kimi，及千问、DeepSeek Harness、GLM 的真实 TUI、状态和持久化记录。
- 提交横幅去除；明确发送失败仍保留可见反馈与草稿。
- 不修改生产状态、凭据、进程，不在共享 node_modules 安装依赖。

## 当前证据

- c7d25d6 已在 master；无需重复合并。
- DeepSeek Codex 已跑 PTY，但缺少 agentRuntime 标记及 Codex hook 部署，状态链路不完整。
- 千问、DeepSeek Harness、GLM 当前使用 ACP；本机各 CLI 均提供 TUI 入口。
- 千问支持 --json-file、--session-id、--resume、--fork-session；可从真实 TUI 同步结构化记录。
- 待核实：GLM、DeepSeek Harness 的持久化记录与生命周期接口、旧 ACP 历史迁移。

本文件随实现追加实际验证与未验证边界，不能把此清单当作已完成结论。
