# Codex agent_message_delta Spike Result

- **Date**: 2026-05-01
- **Codex CLI**: 当前用户版本（gpt-5.5 / 2026-05-01 多个 session 均测试）
- **Rollout 样本**: `C:\Users\lintian\.codex\sessions\2026\05\01\` 下 6 个 rollout-*.jsonl

## 实测结果

| Rollout | task_started | agent_message_delta | agent_message (最终) |
|---|---|---|---|
| 10:57:02 | 1 | 0 | 有 |
| 03:09:31 | 1 | 0 | 有 |
| 02:38:14 | 1 | 0 | 有 |
| 02:07:22 | 1 | 0 | 有 |
| 01:13:06 | 5 | 0 | 6 |
| 00:44:00 | 3 | 0 | 3 |

**Delta concat / last_agent_message 匹配率: 0.0%**

## 协议事实

当前 Codex CLI 版本的 `event_msg` 类型枚举:
- `task_started` / `task_complete`
- `user_message` / `agent_message`（最终态，整段一次落盘）
- `token_count`
- `exec_command_end` / `patch_apply_end` / `web_search_end`

**无 `agent_message_delta` 事件**。delta 字段也未在其他事件 payload 中出现。

## 决策

**跳过 Task 4 全部步骤。** Codex 仍走 main.js PTY 兜底（`_rtExtractStreamingText` 无 tap blocks 时的 fallback 路径）。

后续 Codex 升级到带 delta 协议的版本时，可重跑此 spike 决定是否回头补 CodexTap.delta 实现。

## 后续 plan 影响

- Task 3 (TranscriptTap 顶层代理) 仍保留 `this._codex.getStreamingText?.(sid)` 的可选链调用（spec §3.4.4），不会因为 codex 没实现而抛错。
- Task 5 (`_rtExtractStreamingText`) 对 codex 的 sid 永远走 PTY 兜底路径——和现状一致，无回归风险。
