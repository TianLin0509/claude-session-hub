---
feature_ids: []
topics:
  - usage-refresh
  - codex
  - claude
  - account-quota
doc_kind: bug_report
created: 2026-07-11
---

# Hub Codex / Claude Usage 刷新失真

## 报告人

- 用户于 2026-07-11 通过 Hub 侧栏截图报告 Codex usage 点击刷新后不更新，并要求同时检查 Claude usage 刷新。
- 证据图片：`C:\Users\lintian\.claude-session-hub\images\20260710171704-3a74a6.png`

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 期望：点击 usage 刷新后获取当前账户配额，并准确显示数据时间。实际：Codex 在已有更新快照时仍显示旧的 `100% / 28%`，同时标记“刚刚”；Claude 点击刷新只重读旧 statusline 快照。 |
| **2. 证据** | 01:16:43 Codex JSONL 已产生 `2% / 0%`，01:17:04 UI 仍为 `100% / 28%`。用真实候选调用 `mergeCodexRateLimitCandidates()` 可稳定复现。诊断期间 app-server `account/rateLimits/read` 返回 `7% / 1%`，Hub 缓存仍为 `100% / 1%`。 |
| **3. 已确认根因** | (a) `refresh-usage-now` 只清本地解析缓存并重扫 JSONL，没有主动获取服务端配额；(b) 5h/7d 合并可被历史正值钉住；(c) UI freshness 使用缓存写入时间；(d) Codex CLI `/usage` 用全局变量跨 profile 串值；(e) 登录切换后无新 JSONL 时会把旧账号快照挂到新 scope；(f) app-server 缓存跨 reset 不失效；(g) Claude 在等待 Codex 时更新会出现“新数值 + 无新快照”的竞态。Claude 主动刷新本身仍只能重读 statusline 缓存。 |
| **4. 诊断策略** | 沿 `refresh-usage-now → scanAgentSessions → mergeCodexRateLimitCandidates → renderer` 逆向追踪；对照真实 JSONL、生产 usage-cache、Claude statusline-cache；用本机 Codex app-server 做只读对照。 |
| **5. 超时策略** | app-server 主动读取设置短超时；失败时必须返回可见错误并降级 JSONL，不能阻塞侧栏或静默伪成功。若三次实现仍暴露新的跨模块共享状态问题，停止补丁并重新评估 usage 数据源架构。 |
| **6. 预警策略** | 红测没有按预期失败、刷新成功却未携带来源时间、0% 再次被过滤、主动读取失败导致旧缓存被标记“刚刚”，任一出现都说明修复方向错误。 |
| **7. 用户可见交互修正** | Codex 手动刷新优先展示实时 app-server 数据；失败时显示回退来源/错误。Claude 无新 statusline 时明确显示“无新快照”，进度条宽度限制在 100%，原始超限值保留为文本。 |
| **8. 验收** | 先新增失败测试：跨窗口 `100/28 + 2/0` 必须选择 `2/0`；手动刷新优先 live Codex，失败才回退；缓存重扫不得伪造 freshness；Claude 无新快照有明确结果；101% 条宽不溢出。之后跑相关单测、语法检查和隔离 Hub 浏览器验证。 |

## 复现步骤

1. 保留一个包含旧 Codex `100% / 28%` 的 JSONL 快照。
2. 产生 reset 窗口不同的新快照 `2% / 0%`。
3. 点击 Hub usage 刷新按钮或直接调用现有合并函数。
4. 现状返回旧 `100% / 28%`；期望返回最新 coherent snapshot `2% / 0%`。

## 修复方案

1. 新增独立的一次性 Codex app-server usage reader：`initialize` 后调用 `account/rateLimits/read`，按当前 profile 的 `CODEX_HOME` 启动，短超时；Windows 使用进程树回收，并处理 stdin 断管。
2. 手动刷新优先 live reader；失败后强制重扫 JSONL，并把降级原因返回 renderer。
3. JSONL 合并以最新 coherent snapshot 的 reset 窗口为锚；只在同一窗口内允许单调最大值，合法 `0%` 不得被历史正值抹掉。
4. 分离 refresh attempt 与 source observation 时间；UI age 只使用源时间。
5. Claude 保持 statusline 为默认真相源，但手动刷新返回 `changed/no-new-snapshot`，避免伪成功；限制进度条宽度。
6. Codex CLI `/usage` 按 session、sessions root 与 auth epoch 隔离；当前 auth 之后没有 JSONL 时返回无数据，不再复用旧账号。
7. 缓存的 app-server 窗口到 reset 时间后失效；Claude provider 状态在 Codex await 结束时以最终 cache 复算。

## 取舍

- 不直接调用 Claude 二进制内的私有 `/api/oauth/usage`，避免耦合未公开 OAuth 凭据格式。
- 不通过 PTY 向用户正在使用的 Codex/Claude 会话注入 `/usage`，避免打断交互。
- 不复活已从当前工作树删除的完整 `codex-app` 会话模式；只新增 usage 专用小客户端。

## 验证方式

- 单元测试：usage parser、usage IPC、renderer controller、Codex live reader、profile/auth scoped CLI quota、reset 失效与进程树清理。
- 静态检查：涉及的 Node.js 文件执行 `node --check`。
- 集成验证：隔离 `CLAUDE_HUB_DATA_DIR`、独立 `CODEX_HOME` 与 CDP 端口；用受控 app-server `7/1` 和陈旧 JSONL `100/28`，实际点击并等待后台 scanner 后仍保持 `7/1`。
- 生产保护：不重启、不点击、不修改用户正在使用的生产 Hub 数据目录。
