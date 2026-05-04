# Codex Signals Fixtures

Phase 0 产物：codex 真实信号采样 + schema 文档。

服务于 Phase 1（拉取闭环）/ Phase 2（发送闭环）/ Phase 3（绑定 + 恢复）单测。

---

## 目录结构

```
tests/fixtures/codex-signals/
  ├── README.md                          # 本文件
  ├── schema.md                          # 信号字段 schema 速查
  ├── pty-ack-success.bin                # B0.2 录：codex 正常发送 ack 字节流
  ├── pty-stuck-no-ack.bin               # B0.3 录：发出后无 ack（切代理 / kill）
  ├── rollout-with-task-complete.jsonl   # B0.2 录：完整 task_complete 命中
  ├── rollout-only-commentary.jsonl      # B0.2 录：仅 agent_message，无 task_complete
  ├── rollout-no-bind.empty              # B0.3 录：rollout 文件创建但 session_meta 未刷新
  └── ipc-timeline.json                  # B0.2 录：圆桌一轮内的 IPC 事件序列
```

## 元数据头部约定

每个 fixture 文件**头部 1 行**记录元数据（JSONL 文件用注释行 / bin 文件用 sidecar `.meta.json`）：

```json
{
  "codex_cli_version": "0.125.0",
  "recorded_at": "2026-05-04T08:00:00Z",
  "scenario": "short-task | medium-task | long-task | stuck-proxy | stuck-kill",
  "hub_data_dir": "C:\\temp\\hub-codex-fixture",
  "prompt_summary": "（一句话）"
}
```

便于 codex 升级后跑 `npm run refresh-codex-fixtures` 检测过期 fixture。

---

## Phase 0 当前状态（v2 plan）

| 产物 | 状态 | 备注 |
|---|---|---|
| schema.md | ✅ 已落（基于现有 `core/transcript-tap.js` 真实读取真实 rollout 反推）|
| fake-codex-rollout.js | ✅ 已落（tests/helpers/）|
| fake-codex-pty.js | ✅ 已落 |
| fake-codex-ipc-harness.js | ✅ 已落 |
| pty-ack-success.bin / pty-stuck-no-ack.bin | ⏳ 待真实采样（B0.2/B0.3） |
| rollout-with-task-complete.jsonl 等 3 个 | ⏳ 待真实采样 |
| ipc-timeline.json | ⏳ 待真实采样 |

**待采样 fixture 必须真实跑 codex CLI 在隔离 Hub 实例（`CLAUDE_HUB_DATA_DIR`）下录制**——用户配合或我自启隔离 Hub（PID 白名单 before/after diff）。
