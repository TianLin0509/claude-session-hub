---
feature_ids: []
topics:
  - usage-refresh
  - quality-gate
  - codex
  - claude
doc_kind: quality_gate_report
created: 2026-07-11
---

# Hub Usage 刷新修复 Quality Gate

## Gate 结论

- **本次 usage 修复范围：通过。** 红测、目标单测、真实 Codex app-server、隔离 Electron/CDP 用户路径均有本轮证据。
- **仓库全局 Gate：未全绿。** 全量运行得到 `178 passed / 6 failed / 2 skipped`；其中 5 个稳定失败落在本任务未修改、且任务开始前已处于脏状态的 card/group-chat/session-list 路径；第 6 个 state-store 并发用例单独重跑通过，属于波动项。未擅自修复这些用户改动。
- 当前基线：本地 `master`，HEAD `4b3d78c`；未 rebase 到 `origin/master`（`8b4ab81`），因为共享工作树存在大量用户未提交改动。

## 愿景覆盖（Step 0）

原始需求来自当前对话：

> “hub 里的 codex usage 刷新有点问题，刷新不了……帮我排查下是什么问题？”
>
> “顺便也看下 claude 的 usage 刷新怎么样，是否能改进。”
>
> “帮我修改。”

| # | 用户目标 | 实现 | 证据 |
|---|----------|------|------|
| 1 | Codex 点击后真正刷新 | 优先启动一次性 app-server，调用 `account/rateLimits/read` | 真实 reader 返回 `17% / 3%`；隔离 UI 显示“实时” |
| 2 | 不再被旧 `100% / 28%` 卡住 | JSONL 以最新 coherent reset 窗口为锚；live cache 到 reset 失效 | 受控 E2E 从 `100/28` 刷到 `7/1`，后台 scanner 后不回退 |
| 3 | 刷新时间可信 | renderer 优先使用 `observedAt`，缓存写入不再伪造 freshness | controller 单测 + 隔离 UI 初始显示 5m、实时后显示刚刚 |
| 4 | Claude 可理解、可改进 | 明确“无新快照”；保留 101% 文本但条宽 clamp 100% | controller 单测 + CDP 截图 |
| 5 | 不影响生产 Hub | 全程隔离数据目录、随机 CDP 端口、PID 白名单关闭 | 两次 E2E 后进程退出、临时目录删除 |

## 功能验收

| 要求 | 状态 | 代码位置 | 测试覆盖 |
|------|------|----------|----------|
| app-server live reader | ✅ | `main/usage/codex-app-server-usage.js` | `unit-codex-app-server-usage.test.js` + 本机真实调用 |
| live 优先、失败降级 JSONL | ✅ | `main/ipc/usage-handlers.js` | `unit-usage-ipc-contract.test.js` |
| coherent JSONL 合并 | ✅ | `main/usage/agent-usage-parser.js` | `unit-agent-usage-parser-contract.test.js` |
| source observation time | ✅ | `main.js`、`renderer/account-usage-controller.js` | controller 单测 + CDP E2E |
| Claude 无新快照反馈 | ✅ | `main.js`、renderer controller | controller 单测 + CDP E2E |
| 101% 视觉不溢出 | ✅ | renderer controller | controller 单测 + CDP E2E |
| CLI `/usage` 多账号隔离 | ✅ | `main/usage/scoped-codex-cli-usage.js` | `unit-scoped-codex-cli-usage.test.js` |
| auth 切换拒绝旧 JSONL | ✅ | `main/usage/agent-usage-parser.js` | parser contract |
| app-server reset / 进程树安全 | ✅ | `main/usage/codex-app-server-usage.js` | app-server unit + 真实进程计数 |
| Claude 等待竞态 | ✅ | `main/ipc/usage-handlers.js` | usage IPC contract |

## 设计稿对照（Step 5）

- `designs/**/*.pen`：项目无 `designs` 目录，无匹配设计稿。
- 本次 UI 是既有 usage 卡片上的状态短标签，不改变卡片信息架构。
- 已执行真实 Electron/CDP 视觉验证。

## 验证命令与结果

### Red → Green

- `node tests/unit-agent-usage-parser-contract.test.js`：缺 `observedAt` / 新 0% 被旧正值覆盖 → PASS。
- `node tests/unit-usage-ipc-contract.test.js`：仍返回 JSONL 而非 live → PASS。
- `node tests/unit-account-usage-controller-contract.test.js`：101% 条宽溢出 → PASS。
- `node tests/unit-codex-app-server-usage.test.js`：目标模块不存在 → PASS。
- 审查追加红测：跨 profile `/usage`、旧 auth JSONL、live 跨 reset、不可用 fallback、stdin/timeout cleanup、Claude await 竞态、徽标过期均先失败后通过。

### 静态检查

- `node --check main.js`：exit 0。
- `node --check main/usage/agent-usage-parser.js`：exit 0。
- `node --check main/usage/codex-app-server-usage.js`：exit 0。
- `node --check main/usage/claude-statusline-usage.js`：exit 0。
- `node --check main/usage/scoped-codex-cli-usage.js`：exit 0。
- `node --check main/ipc/usage-handlers.js`：exit 0。
- `node --check renderer/account-usage-controller.js`：exit 0。

### 目标回归

- usage parser、app-server reader、scoped CLI usage、Claude selector、usage IPC、renderer controller、Codex scope、usage filter：8 组全部 PASS。
- 本机真实 app-server：订阅 profile `default`，返回 `17% / 3%`，调用前后相关进程计数 `11 → 11`。

### 全 unit 回归

- 命令范围：`tests/unit-*.test.js`，隔离 `CLAUDE_HUB_DATA_DIR`。
- 结果：`178 passed / 6 failed / 2 skipped / 186 total`。
- 5 个稳定失败路径：`renderer/renderer.js`、`core/transcript-tap.js`、`core/group-chat-orchestrator.js`、`renderer/meeting-room.js`、`renderer/session-list-renderer.js` 对应既有 contract；这些文件均不在本次 usage 修复范围，且任务开始前已被用户修改。
- `unit-state-store-concurrent-load.test.js` 在全量并发运行时丢 1/100，单独重跑为 `1 passed / 0 failed`，未归因到 usage 改动。

### Electron/CDP E2E

- 命令：`node tests/e2e-usage-refresh-cdp.js`。
- 工作目录：`C:\Users\lintian\claude-session-hub`。
- 实例：隔离数据目录 + 随机 CDP 端口；未连接生产 Hub。
- 数据源：独立 `CODEX_HOME`、受控 fake app-server `7/1`、真实格式陈旧 JSONL `100/28`；未读取本机 `~/.codex/sessions`。
- 初始：Claude `101/14`、Codex `100/28`，数据年龄 5m。
- 点击并等待后台 scanner 一轮后：Claude “无新快照”；Codex `7/1`、“实时”、source `app-server`；101% bar width 为 100%。
- 证据：`C:\Users\lintian\claude-session-hub\artifacts\usage-refresh-e2e-20260711.png`。

## Artifact Hygiene（Step 7.5）

- 仓库根目录媒体/设计工件（工作树）：无。
- HEAD 差异中的根目录媒体/设计工件：无。
- E2E 图片位于正式 `artifacts/` 目录。

## 独立审查

- 第一轮审查提出 4 项 P2：跨周缓存、不可用 fallback、Claude 混合时间、徽标过期；均完成红测 → 修复 → 复审通过。
- 第二轮审查提出多 profile CLI quota、auth 切换、live reset、进程树、Claude await 竞态、E2E 假绿共 6 项；修复后复审结论为 **APPROVE**，未发现残留 P1/P2，可通过 merge-gate。
- 最终 E2E 暴露 `changed` 的“数值变化 / 新快照”语义错位；改为优先判断 `observedAt` 前进、无时间戳才比较用量后，目标单测与 E2E 重新通过，提出问题的审查者最终结论为 **APPROVE**，无残留 P1/P2。

## 已知边界

- Codex app-server 整体命令仍标记 experimental；实现具备超时和 JSONL fallback，不把本机能力假设为永久稳定协议。
- Claude 内部 OAuth usage 路径未接入；默认继续以 Claude Code statusline 为真相源，避免读取私有凭据。
- 当前 auth 之后没有任何 JSONL 时宁可显示无数据，也不会把旧账号历史快照重新标成当前账号。
- 本轮不提交、不 rebase、不清理共享脏工作树。
