# Codex 信号 Schema 速查

基于 `core/transcript-tap.js` 现有实现 + 真实 rollout 文件实测（codex 0.125.0）。

---

## 1. Rollout JSONL（`~/.codex/sessions/YYYY/MM/DD/rollout-<sid>.jsonl`）

每行一个事件 JSON。CodexTap 关心的事件类型：

### 1.1 `session_meta`（首行，绑定依据）

```json
{
  "timestamp": "2026-05-03T20:10:27.298Z",
  "type": "session_meta",
  "payload": {
    "id": "019def76-8c7f-7451-9427-3371e6c26903",
    "timestamp": "2026-05-03T20:10:17.114Z",
    "cwd": "C:\\Users\\lintian\\claude-session-hub",
    "originator": "codex_cli_rs",
    "cli_version": "0.125.0",
    "source": "mcp | cli",
    "model_provider": "openai",
    "base_instructions": { "text": "<可超 20KB>" }
  }
}
```

**绑定关键字段**：`payload.cwd`（与 Hub spawn 时 cwd 比对）+ `payload.timestamp`（容差窗口 [-10s, +5min]）。

**注意**：base_instructions.text 单行可超 20KB → 必须用 readline 读首行（`core/transcript-tap.js:603` `readFirstLine`）。

### 1.2 `event_msg` / `task_started`（取消 pending emit）

```json
{
  "timestamp": "...",
  "type": "event_msg",
  "payload": { "type": "task_started", ... }
}
```

CodexTap：清 `_pendingEmitTimer` + `_pendingText`，重新等下一次 `task_complete`。

### 1.3 `event_msg` / `task_complete`（**final_answer 判据**）

```json
{
  "timestamp": "...",
  "type": "event_msg",
  "payload": {
    "type": "task_complete",
    "last_agent_message": "<最终回答全文>",
    "duration_ms": 12345
  }
}
```

CodexTap：
1. 读取 `last_agent_message` 作为 `_pendingText`
2. 启动 3s debounce timer
3. 期间若收到新 `task_started` 则取消，否则 `emit('turn-complete')`

**Spec S2 `extractMode` 映射**：rollout 末尾命中此事件 → `final_answer`，对应 `source = manual_codex_rollout`。

### 1.4 `event_msg` / `agent_message`（**partial_commentary 降级判据**）

```json
{
  "timestamp": "...",
  "type": "event_msg",
  "payload": {
    "type": "agent_message",
    "message": "<commentary 阶段输出>"
  }
}
```

`extractLatestTurn` 降级路径：streaming 中拼接所有 `agent_message.message`（按 `sincePromptTs` 过滤）。

**Spec S2 `extractMode` 映射**：rollout 已绑定但无 `task_complete`，命中 ≥1 条此事件 → `partial_commentary`，对应 `source = manual_codex_rollout_streaming`。

---

## 2. PTY 字节流（codex CLI stdout/stderr）

**待 B0.2 真实采样确认精确字节序列**。已知信号点（基于现有 Resend & Auto-Recovery 经验）：

| 信号 | 形态（待确认） | 用于判定 |
|---|---|---|
| Echo prompt | 用户输入回显在 PTY（Claude/DS/GLM 通用） | `parseEcho` enter_only/rewrite_full |
| `[thinking]` | stderr | 进度信号（不是 ack） |
| **ack 信号** | （待录制）codex 收到 prompt 后特征字节，可能是 input box 清空 + spinner 启动 | `detectCodexAck` |
| **stuck 信号** | 发出后 N 秒内既无 echo 也无 ack | `detectCodexStuck`（超时判定） |

**采样策略（B0.2）**：用 `script` / `node-pty` 全程录 raw bytes，跑 3 类 prompt（短 / 中 / 长），重复 5 次取共性。

---

## 3. IPC payload（main ↔ renderer）

### 3.1 Renderer → Main（`ipcMain.handle`，4 个）

| Channel | Payload | Reply |
|---|---|---|
| `roundtable-manual-extract` | `{ meetingId, sid, sincePromptTs }` | `{ ok, text?, source?, mode?, reason?, detail?, extractMode? (本轮新增) }` |
| `roundtable-resend-prompt` | `{ meetingId, sid }` | `{ ok, reason?, detail? }` |
| `roundtable-skip-participant` | `{ meetingId, sid }` | `{ ok, reason? }` |
| `roundtable-resend-participant` | `{ meetingId, sid }` | `{ ok, reason? }` |

**v2 命名约束**：`mode` 字段保留现状语义 `{watcher_settle, patch_last_turn, text_only}`；新增 `extractMode` 字段承载 Spec S2 内容分级 `{final_answer, partial_commentary, no_task_complete_yet, no_rollout_bound}`。

### 3.2 Main → Renderer（`sendToRenderer`，6 个事件）

| Channel | Payload（关键字段） | 触发时机 |
|---|---|---|
| `roundtable-state-update` | `{ meetingId }` | turn 状态机切换（轮号、mode、参与者） |
| `roundtable-partial-update` | `{ meetingId, sid, status, ... }` | 单家 partial 状态变更 |
| `roundtable-turn-complete` | `{ meetingId, turnNum?, mode?, results?, meta? }` | turn settle |
| `roundtable-turn-patched` | `{ meetingId, turnNum, sid }` | 手动 extract 后回填 |
| `roundtable-soft-alert` | `{ meetingId, ... }` | 非阻塞提示 |
| `roundtable-send-stuck` | `{ meetingId, sid, kind }` | sendStatus 变 stuck |

---

## 4. B3.0 SPIKE 结论（codex fresh+ctx 注入路径）

`codex --help` (0.125.0) 已确认：

- `[PROMPT]` 位置参数：`Optional user prompt to start the session`
  - **缺点**：会触发 codex 立即应答，不能纯"先吃 ctx 不应答"
  - **优点**：CLI 原生支持，无需 PTY paste 长文本

- `-c key=value`：TOML 路径任意覆盖
  - 可设 `-c model_instructions_file=<path>`（cli-caller skill 2C 路径已实测）
  - 但这是 codex `exec` 子命令的参数，主交互模式下是否生效**待 B3.0 实测**

**两种方案对比**：

| 方案 | 实施成本 | 副作用 | 推荐度 |
|---|---|---|---|
| A. spawn 时把 ctx 拼到 `[PROMPT]` 位置参数 | 低 | 第一轮"被吃掉"——codex 会立即对 ctx 应答（多一次 turn） | ⭐⭐⭐ |
| B. `-c model_instructions_file=<path>` | 中（待确认主交互模式支持）| 0 副作用（系统级 instruction，不算一轮）| ⭐⭐⭐⭐⭐ |
| C. PTY paste（fallback） | 高 | OSC 闪屏 / 自动换行截断风险 | ⭐ |

**B3.0 SPIKE 待办**：
- [ ] 实测 `codex -c model_instructions_file=<path> [PROMPT]` 在主交互模式下是否生效（不写 `exec` 子命令）
- [ ] 若 B 不行，回退方案 A：评估"被吃一轮"对圆桌轮号的影响（Spec S5 的 `from_fresh+ctx` 角标含义需调整）

---

## 5. 后续 fixture 采样指引（待 B0.1-B0.3 完成后填）

| 文件 | 采样命令 | 验证标准 |
|---|---|---|
| pty-ack-success.bin | （待录制脚本）| 起 codex sub → `printf "test\\r" | tee` |
| pty-stuck-no-ack.bin | `HTTPS_PROXY=invalid:1` 后发 prompt | 30s 内无任何 PTY 字节回显 |
| rollout-with-task-complete.jsonl | 短 prompt"hello"跑完后 cp 到 fixture | 末行含 `task_complete.last_agent_message` |
| rollout-only-commentary.jsonl | 中长 prompt 跑到一半 ctrl-c | 含多条 `agent_message` 但无 `task_complete` |
| rollout-no-bind.empty | spawn 后立即 cp（session_meta 未刷新窗口）| 0 byte 或仅有空行 |
| ipc-timeline.json | 全程拦截 main ↔ renderer IPC | 含 ≥1 个 `partial_update` + 1 个 `turn-complete` |
