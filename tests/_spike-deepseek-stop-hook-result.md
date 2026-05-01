# DeepSeek Stop Hook Spike Result

- Date: 2026-05-01
- DeepSeek model: deepseek-v4-pro (Hub-managed Claude Code CLI session)
- Transcript scanned: `C:\Users\lintian\.claude-deepseek\projects\C--Users-lintian\a725ca9c-b6d0-45a2-92ad-efb1bd555502.jsonl`
- Lines: 155 · Assistant turns: 69
- Block shape: `text=15 thinking=24 tool_use=30` (same shape as Claude transcripts)
- Assistant message keys: `id, type, role, model, content, stop_reason, stop_sequence, usage`
- `stop_reason: 'end_turn'` present: YES

## 决策

**PASS** — DeepSeek 写出的 JSONL 与 Claude 完全同 schema（claude CLI 本身写出，CONFIG_DIR 隔离不影响 schema）。
ClaudeTap.notifyStop / JsonlTail / streamingBuf 三条路径已用 path 参数化，对路径无硬假设，
仅需 `_backendFor(kind)` 把 `'deepseek'` / `'glm'` 路由到 `this._claude` 即可让圆桌 timeline + streaming preview 复用 ClaudeTap。

## Hub Stop hook trigger note

`session-hub-hook.py` 是从 `~/.claude-deepseek/settings.json`（Hub 启动时由 `ensureHooksDeployed` 写入）
里读取的，触发路径与生产 Claude session 一致。本 spike 通过转录文件存在性 + end_turn 块出现确认了
"DeepSeek session 实际跑到了 end_turn"——下游 hook stop event 与 ClaudeTap.notifyStop 的链路在
`main.js` 里只与 sid 索引有关，与 kind 无关，不需额外验证。

## 跟进路径

继续按 plan Task 1 的简单 1-line fix（`_backendFor` 加 deepseek/glm → ClaudeTap）。
不需要新增 DeepSeekTap 类。
