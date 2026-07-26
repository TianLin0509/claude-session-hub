---
feature_ids: []
topics: [card-view, codex, transcript-binding, session-isolation, race-condition]
doc_kind: bug-report
created: 2026-07-12
---

# Codex 卡片视图跨会话串线

## 报告人

- 用户于 2026-07-12 提供生产 Hub 截图并要求修复、全面审计卡片视图。
- 调查者：Codex。

## Bug 诊断胶囊

| 栏位 | 内容 |
| --- | --- |
| 1. 现象 | 同一会话顶部显示 `Codex 2 / gpt-5.6-sol / C:\Users\lintian`。PTY 是 AI Arena 视觉审查，卡片却显示无线信道仿真审计。期望：卡片与 PTY 必须来自同一原生 Codex thread。 |
| 2. 证据 | 截图：`C:\Users\lintian\.claude-session-hub\images\20260711172317-6b54a4.png`、`C:\Users\lintian\.claude-session-hub\images\20260711172325-0b0a25.png`。生产状态中 Hub session `6c48a104-148b-4295-84fa-b0850fc21525` 被持久化到 rollout `019f516d-c76d-7cf1-88ac-dd4cd8af5f4a`；PTY 主题实际存在于同秒创建的顶层 rollout `019f516d-c3b1-7b60-98ed-89de224810f9`。错误 rollout 的 `thread_source=subagent`、`parent_thread_id=019f49ff-cd9c-7a82-a730-0231f092a2e8`。 |
| 3. 问题假设或根因 | **已确认主根因**：`CodexTap._tryBind()` 只按 cwd + 五分钟时间窗匹配，且只有一个本进程 pending session 时直接接受首个枚举到的 rollout；它既不排除 Codex 内部 subagent，也不要求群聊已知 prompt 匹配。因此相邻 subagent rollout 抢先绑定并把错误 `codexSid/transcriptPath` 持久化。**审计确认的第二问题**：卡片增量加载和 `turn-complete-event` 仅在异步 IPC 前检查 active session，IPC 返回期间切会话会把旧 session 卡片挂进新 overlay。 |
| 4. 诊断策略 | 逆向追踪 `DOM -> parse-session-transcript IPC -> session.transcriptPath -> transcriptTap session-bound -> CodexTap._tryBind`；用生产 `state.json`、rollout 首行 metadata 和内容关键词交叉验证；对照已有 same-cwd prompt 测试与历史 `prevent codex card session mixups` 修复。 |
| 5. 超时策略 | 若 30 分钟内无法用真实 rollout metadata 复现，则增加 CodexTap debug snapshot 与隔离多 rollout fixture；若第三次修复仍失败，停止补丁并重新评估绑定架构。 |
| 6. 预警策略 | 测试若必须依赖目录枚举顺序、固定 sleep 或生产 state 改写，说明方向错误；任何修复若影响明确 `codexSid/transcriptPath` resume 绑定，立即回退到根因调查。 |
| 7. 用户可见交互修正 | 卡片只接受当前 Hub 顶层 Codex 会话的 transcript；快速切换会话时，迟到的异步结果不再污染当前卡片区域。 |
| 8. 验收 | 先新增红测覆盖 `subagent rollout 抢绑定`、`群聊单 pending 仍须 prompt 匹配`、`增量/完成事件 await 后 session guard`；修复后运行相关 parser/binding/card-view 单测，并在隔离 Hub 做 GUI/CDP 验证。 |

## 复现步骤

1. 保持另一个 Codex 顶层 thread 在同一 cwd 工作，并让它于附近时间 spawn subagent。
2. 在 Hub 新建含 Codex 成员的群聊；Hub 为该成员注册 pending transcript tap。
3. 扫描器先枚举到外部 subagent rollout。
4. 切到该 Hub 成员的卡片视图。
5. 实际结果：卡片加载 subagent 的历史；PTY 仍是 Hub 自己的顶层 Codex 对话。

## 根因调用链

`CodexTap._scanOnce()` → `CodexTap._tryBind(rolloutPath)` → cwd/time 单候选直接命中 → `_bindRolloutToHubSession()` → `session-bound` → `main.js` 持久化 `codexSid/transcriptPath` → `parse-session-transcript` → `loadSessionHistoryToOverlay()`。

## 修复方案

1. transcript 绑定层拒绝 Codex 内部 subagent rollout；Hub PTY 对应的是顶层 CLI thread。
2. 群聊/meeting Codex session 标记为必须用已提交 prompt 匹配 rollout；即使当前进程只有一个 pending session，也不能仅凭 cwd/time 绑定。
3. 卡片异步 load/append 在 IPC 返回后再次检查 active session、当前 view 与 load generation，丢弃迟到结果。
4. transcript IPC 对明确 `codexSid` 与传入 rollout 路径做一致性校验，避免已有错误路径继续被无条件信任。

## 取舍

- 不改生产 `state.json`，避免在用户运行时直接修数据。
- 不隔离或改写全局 `CODEX_HOME`，避免破坏 Codex 现有历史与 resume 行为。
- 不靠扩大/缩小时间窗碰运气；时间邻近不是会话所有权证据。

## 验证方式

- TDD 红绿测试：绑定所有权、群聊 prompt 绑定、renderer 异步切换竞态、IPC 路径一致性。
- 相关回归测试：Codex parser、resume bind、same-cwd、card-view contract、多轮一致性。
- 隔离 Hub：独立 `CLAUDE_HUB_DATA_DIR` + 独立 CDP 端口，验证卡片/PTY 同会话与快速切换。

## 实施结果（2026-07-12）

### 已修复

1. rollout 元数据层统一识别并拒绝 Codex `subagent` 文件；按 SID、按 cwd 回退以及直接路径绑定均不再接受子会话。
2. meeting Codex 会话必须以真实用户 prompt 证明 rollout 所有权；仅有一个 pending 会话时也不能再凭 cwd/时间抢绑。
3. 已绑定 Hub 会话拒绝后到达的竞争 rollout 覆盖；cwd 回退改为选择最接近启动时刻的顶层 rollout。
4. transcript IPC 校验主进程、renderer、SID/cwd 回退的候选路径；Claude 同步修正为主进程绑定优先。
5. resume 检测到历史状态指向 subagent 时废弃该 SID/路径并进入 Codex 选择器，不再把子线程恢复成 Hub PTY。
6. 卡片全量/增量加载与 `turn-complete-event` 增加 session、view、generation 三重异步所有权检查。
7. 增量读取暂时为空、报错或抛异常时保留现有卡片；关闭会话时清理加载代次和 stop fallback timer。
8. 卡片渲染签名补入 `ts/model/kind`，避免元数据变化时因文本相同而不刷新。
9. 修正“不支持的后端”占位文案，明确卡片视图同时支持 Claude 与 Codex。
10. 修正两条已漂移的 Codex 回归契约：缺失/被拒 SID 走 picker；当前 `task_complete` 防抖为 400ms。

### 新鲜验证证据

- 最终相关回归合并 37 个测试文件：90 tests，89 pass，0 fail，1 个既有 fixture 缺失而 skip。
- 全部 Codex/卡片相关单测：49 tests，49 pass，0 fail。
- 语法检查：14 个相关 JS 文件全部 `node --check` 通过。
- 差异检查：`git diff --check` 通过，仅有仓库既有 LF/CRLF 提示。
- 隔离 GUI/CDP E2E：顶层 rollout 挂载 2 张卡片；subagent 挂载 0 张且返回 `codex rollout not found`；快速切换和完成事件竞态均未泄漏旧 session DOM。
- E2E 使用独立数据目录与 CDP `9376`，隔离 Hub 已正常退出；未启动、重启或修改生产 Hub。

### 交付边界

- 未直接改写生产 `state.json`。现有污染记录仍作为诊断证据保留；新代码生效并恢复该会话时会拒绝 subagent 绑定并进入安全选择流程。
- 工作树在本任务开始前已有大量未提交修改，且相关文件存在用户改动；本次未做整树提交，避免夹带或覆盖无关工作。
- 受“禁止自审”和当前无独立 reviewer 的约束，本轮完成了质量门禁与隔离 E2E，但未冒充 peer review 结论。
