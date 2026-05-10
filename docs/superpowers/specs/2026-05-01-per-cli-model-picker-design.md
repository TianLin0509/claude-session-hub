# Per-CLI Model Picker 设计

**日期**：2026-05-01
**作者**：立花道雪 + Claude
**状态**：待审

## 1. 背景与问题

Hub 终端标题栏右侧 model badge（`renderer/renderer.js:2581-2592`）当前点击后弹出 picker，但 picker 的模型清单（`MODEL_OPTIONS`，行 2600-2607）**写死为 6 个 Claude 模型**，且点击 item 后统一发送 `/model <id>\r` 到 PTY。

这导致：

- 用户启动 Codex/Gemini/DeepSeek/GLM 任意一种 CLI 后，picker 仍然展示 Claude 模型——错位
- 即使把清单换成对应 CLI 的模型，**Codex/Gemini 的 PTY 输入机制无法可靠提交 `/model <id>\r`**（实测 Gemini 0.40.1 把整个 chunk 当 paste，连 `hello\r` 都不提交，被认为是 bracketed paste mode 行为）
- Codex 源码层（[`slash_command.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/slash_command.rs)）明确 `SlashCommand::Model` 不在 `supports_inline_args()` 名单，**inline `/model <id>` 在 Codex 中绝无可能**

## 2. 目标与非目标

### 目标

- 5 类 session（claude / claude-resume / codex / gemini / deepseek / glm）的 model picker **展示各自专属模型清单**
- 切换可靠完成，UI 即时反馈
- yolo / bypass-approvals 模式在所有路径下保留（spawn / resume / 切模型 respawn 全保留）
- cwd / title / userRenamed / 对话上下文（codexSid / geminiChatId）在切模型后保留

### 非目标

- 会议室内 sub-session 的模型切换（第一版禁用，未来再说）
- Hub 自动检测 CLI 拒识 model ID（依赖 PTY 输出让用户自见）
- 模型清单动态从 CLI 拉取（用 curated 静态清单）

## 3. 关键决定

### 3.1 切换路径分流

| Kind | 切换机制 | 理由 |
|---|---|---|
| `claude` / `claude-resume` | 原地 `/model <id>\r` | Claude TUI 文档明确支持 inline，零侵入 |
| `deepseek` | 原地 `/model <id>\r` | 底层 CLI 是 `claude`（走 anyrouter 代理，`session-manager.js:431`），同 Claude |
| `glm` | 原地 `/model <id>\r` | 同 deepseek |
| `codex` | **kill + respawn with `--model`** | 源码确认 `/model` 不支持 inline + `codex resume <sid>` 接受 `--model` 全局 flag |
| `gemini` | **kill + respawn with `--model`** | PTY paste mode 不接受 `\r` 提交 + `gemini --model X --resume <chatId>` 已是 Hub 现有 spawn 模式 |

### 3.2 Codex/Gemini 的 yolo 不变量

由 spawn 路径硬编码保证，与 `opts` 字段解耦：

- Gemini：`session-manager.js:338` 起 cmd 永远 `' gemini --approval-mode yolo'`
- Codex：`session-manager.js:378/381/387/389` 任何分支永远含 `--dangerously-bypass-approvals-and-sandbox`

→ Unit test 锁住该不变量（§7）。

### 3.3 乐观更新

picker 点击 → 立刻把 `session.currentModel` 设为新选项 + 重绘 badge。spawn / statusline 完成后会校准（一致则无闪烁）。

## 4. 架构

```
┌─────────────────────────────────────────────────────────┐
│ renderer/renderer.js                                    │
│   showModelPicker(badge, sid)                           │
│     ├─ session.kind ∈ Claude family                     │
│     │     → ipcRenderer.send('terminal-input',          │
│     │         {sid, data: '/model <id>\r'})             │
│     │     (现有路径，仅扩清单)                          │
│     │                                                   │
│     └─ session.kind ∈ {codex, gemini}                   │
│           → ipcRenderer.invoke('respawn-with-model',    │
│               {sessionId, modelId})                     │
│             (新增 IPC)                                  │
│                                                         │
│ main.js                                                 │
│   ipcMain.handle('respawn-with-model', ...)             │
│     1. 校验 kind / meetingId / resumeMeta                │
│     2. sessionManager.closeSession(oldSid)              │
│     3. sessionManager.createSession(kind, {             │
│          model, useResume, cwd, title,                  │
│          codexSid / geminiChatId / ...                  │
│        })                                               │
│     4. sendToRenderer('session-respawned', ...)         │
│                                                         │
│ core/session-manager.js                                 │
│   isCodex resume 分支：opts.model 透传 --model           │
│   buildSpawnCmd(kind, opts)：抽出纯函数（测试驱动重构） │
└─────────────────────────────────────────────────────────┘
```

## 5. 改动清单

| 文件 | 改动类型 | 摘要 |
|---|---|---|
| `renderer/renderer.js:2598-2607` | 替换 | `MODEL_OPTIONS` → `MODEL_OPTIONS_BY_KIND`，5 张清单 |
| `renderer/renderer.js:2611-2643` | 改造 | `attachModelPickerHandler` 加前置校验（kind / meetingId / resumeMeta）；`showModelPicker` 按 kind 取清单；click handler 按 kind 分发 |
| `renderer/renderer.js`（新增 IPC 接收） | 新增 | `ipcRenderer.on('session-respawned')`：替换 sessionOrder 同位置、销毁老 sid 本地状态、切 active；`ipcRenderer.on('session-respawn-failed')`：toast + 清残留 |
| `main.js`（新增 IPC handler） | 新增 | `ipcMain.handle('respawn-with-model', ...)` |
| `core/session-manager.js:374-395` | 修改 | Codex resume 分支两条 cmd 加 `if (opts.model) cmd += ' --model ' + opts.model'`；fresh 分支硬编码 `gpt-5.5` 改成 `opts.model || 'gpt-5.5'`（向后兼容） |
| `core/session-manager.js`（重构） | 抽函数 | 5 类 cmd 拼接抽出 `buildSpawnCmd(kind, opts) → string`，便于 unit test |
| `tests/unit-model-picker.test.js` | 新建 | `MODEL_OPTIONS_BY_KIND` / `modelOptionsFor` / `canRespawnWithResume` 验证 |
| `tests/unit-build-spawn-cmd.test.js` | 新建 | yolo 不变量 + `--model` 透传锁定 |
| `tests/ipc-respawn-with-model.test.js` | 新建 | mock sessionManager 验 IPC handler 校验逻辑与事件发射 |

**Gemini spawn 路径行为零变化**：cmd 拼接逻辑（`session-manager.js:337-371`）已经把 `--approval-mode yolo` + `--model` + `--resume` 串好；抽 `buildSpawnCmd` 时只是搬位置，cmd 字符串与行为完全一致，由 unit test 锁定。

## 6. 数据规约

### 6.1 `MODEL_OPTIONS_BY_KIND`

```js
{
  claude: [
    { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M context)' },
    { id: 'claude-opus-4-7',     label: 'Opus 4.7' },
    { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M context)' },
    { id: 'claude-opus-4-6',     label: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6',   label: 'Sonnet 4.6' },
    { id: 'claude-haiku-4-5',    label: 'Haiku 4.5' },
  ],
  codex: [
    { id: 'gpt-5.5',       label: 'GPT-5.5' },
    { id: 'gpt-5.4',       label: 'GPT-5.4' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  ],
  gemini: [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-2.5-pro',       label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash',     label: 'Gemini 2.5 Flash' },
  ],
  deepseek: [
    { id: 'deepseek-v4-pro',   label: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  ],
  glm: [
    { id: 'glm-5.1',     label: 'GLM 5.1' },
    { id: 'glm-4.6',     label: 'GLM 4.6' },
    { id: 'glm-4.5-air', label: 'GLM 4.5 Air' },
  ],
}
```

`claude-resume` 通过 `modelOptionsFor()` 复用 `claude` 清单。

### 6.2 `respawn-with-model` IPC 协议

```ts
// renderer → main
invoke('respawn-with-model', {
  sessionId: string;
  modelId: string;
}) → Promise<{
  ok: boolean;
  newSessionId?: string;
  // 固定 error code（前 5 个为校验失败）；spawn 异常用 'respawn-failed' + errorDetail
  error?: 'session-not-found' | 'kind-not-respawnable' |
          'in-meeting' | 'no-codex-sid' | 'no-gemini-chat-id' |
          'respawn-failed';
  errorDetail?: string;  // 仅当 error === 'respawn-failed' 时携带 String(e)
}>

// main → renderer (success)
on('session-respawned', {
  oldSessionId: string;
  newSession: SessionInfo;  // 含新 sid + currentModel + ...
});

// main → renderer (failure)
on('session-respawn-failed', {
  oldSessionId: string;
  error: string;
});
```

## 7. 测试

### 7.1 自动化（必须）

- **Unit**：`MODEL_OPTIONS_BY_KIND` / `modelOptionsFor` / `canRespawnWithResume` 行为
- **Unit (yolo 不变量)**：`buildSpawnCmd('codex', {useResume:true, codexSid, model})` 必含 `--dangerously-bypass-approvals-and-sandbox` + `--model X`；`buildSpawnCmd('gemini', ...)` 必含 `--approval-mode yolo`；fresh / resume 全覆盖
- **IPC integration**：mock sessionManager 验 `respawn-with-model` handler 的校验路径（kind 不对 / meetingId 非空 / 缺 sid / 缺 chatId / valid path）

### 7.2 手工验证（用户最终验收）

| 步骤 | 期望 |
|---|---|
| Claude → 切 Sonnet 4.6 | badge 立刻变；PTY 末尾出现 `/model claude-sonnet-4-6`；statusline 校准（无闪烁） |
| DeepSeek → 切 V4 Flash | badge 立刻变；PTY 出现 `/model deepseek-v4-flash`，CLI 工作 |
| GLM → 切 GLM 4.6 | 同上 |
| Codex 跑 YOLO，发一条消息 → 切 GPT-5.4 | tab 闪 1-2s 后回来；PTY 显示 `codex resume <sid> --dangerously-bypass-approvals-and-sandbox --model gpt-5.4`；无 "Allow ...?" 弹窗（yolo 保留）；问"刚才让你做什么"能接上 |
| Gemini 跑 yolo，发"记住数字 42" → 切 Gemini 3.1 Pro → 问"记得数字吗" | spawn cmd 含 `--approval-mode yolo` + `--model gemini-3-pro-preview` + `--resume <chatId>`；回应含 42 |
| 同 model 重复点 | 菜单关，无 IPC、无 respawn |
| 会议室里 codex sub 上点 picker | toast "会议室中暂不支持切换模型"，session 不动 |
| Codex session 没有 codexSid（极少见）→ 点 picker | toast "无可恢复的对话 ID"，不发 IPC |

## 8. 风险与未来工作

| 风险 | 缓解 |
|---|---|
| Gemini 启动慢（1-3s + auth），respawn 后 badge stuck 在乐观值 | 第一版接受，未来可加"切换中..."旋转 indicator |
| `--model X` CLI 拒识（如不存在的 model ID） | curated 清单避免；运行时 PTY 报错由用户从终端自见，ringbuffer 检测会校准 badge |
| meetingStore 索引按 sid，respawn 后 newSid ≠ oldSid 会破坏会议室 | 第一版会议室禁用切模型回避；未来加 `meetingManager.replaceSub(meetingId, oldSid, newSid)` API |
| 圆桌跑动中切模型会断流 | 第一版禁用即可（被会议室禁用规则覆盖） |
| Hub 内部其他模块持有 sessionId 引用（如圆桌 orchestrator） | 第一版 respawn 仅限非会议室 session，无内部引用问题 |

## 9. 实施顺序建议

1. 抽 `buildSpawnCmd(kind, opts)` 纯函数（行为零变化）+ 写其 unit test 锁 yolo 不变量（先建立测试地基）
2. `core/session-manager.js` Codex resume 分支加 `--model` 透传
3. `renderer.js` 引入 `MODEL_OPTIONS_BY_KIND` / `modelOptionsFor` / `canRespawnWithResume` + unit test
4. `renderer.js` `attachModelPickerHandler` / `showModelPicker` 改造（加前置校验 + 分流）
5. `main.js` 加 `respawn-with-model` IPC handler + 写 IPC integration test
6. `renderer.js` 加 `session-respawned` / `session-respawn-failed` 事件接收
7. 隔离 Hub 手工跑 §7.2 全部 case 验收

每步完成后跑 unit + IPC test，全绿才推下一步。
