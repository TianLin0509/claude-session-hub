# DEPLOY NOTE 2026-08-31 · Workspace / Memory Hardening（v1.6.28）

## 裁决

本补丁修复 v1.6.27 独立审计发现的可安全落地问题：多 Hub 并发写 workspace 注册表、平铺工作根被 Session/群聊标题改名、记忆面板混列 provider、Codex local memories 缺席、当前 DeepSeek runtime 误判、隔离 Hub 读取生产 Claude memory，以及 Dream UI 对采集范围表述过宽。

普通 Session transcript 的自动蒸馏**没有在本补丁中仓促启用**。现有 consolidation 只处理被修改的 seed `AGENTS.md` 与 Claude memory 孤岛；UI 和 LLM prompt 现已如实说明这一边界。后续 transcript → episode → promotion 管线需独立设计与验收，不能把普通对话直接自动晋升为规则。

## 修复

### 1. workspace 注册表多进程事务

- 所有写操作改成：跨进程锁 → 持锁后重读最新磁盘状态 → 修改 → 临时文件 → Windows rename 有界重试。
- 拿不到锁时显式返回 `WORKSPACE_REGISTRY_BUSY`，拒绝无锁覆盖。
- `touchWorkspace`、`dismissArchive`、`archiveDraft`、`updateSuggestedName`、`listWorkspaces` 全部纳入事务。
- 压测：6 进程 × 40 个不同 workspace，240/240；6 进程 × 60 次同一 flat root，全部进程成功、注册表恰好 1 条。

### 2. 平铺工作根名称稳定

- flat root 持久标记 `permanentRoot: true`。
- Session 占位名、群聊 `未命名群聊`、auto-title 均不得改根名。
- `workspace:list` 会自愈 v1.6.27 已污染的 label/suggestedName/autoNamedAt。
- 真实隔离 Electron `create-meeting` 回归：meeting.workspaceLabel 与注册表 label 均保持根目录名。

### 3. Provider-aware 记忆面板

- “当前会话”只列该 runtime 实际读取的规则，不再混入其它 CLI，也不重复 flat-root 文件。
- Codex：按 Session 自己的 `CODEX_HOME` 展示 `memories/`、启用状态、主文件和 rollout summary 数量。
- Claude：只展示 CLAUDE.md 链与该 cwd 的 `.claude` bucket。
- DeepSeek：当前会话按 Codex runtime；只有 `deepseek-legacy*` 走 `.claude-deepseek`。
- Gemini/Kimi：只展示各自可核验的规则面，不冒充 Claude memory。
- “改完立即生效”改为“新启动会话读取；已打开会话需重开”。

### 4. Dream / consolidation 诚实边界

- UI 改名为 “Seed / memory 孤岛整理器”。
- 总览、设置、记录页明确：不采集普通 Session transcript、工具结果、commit/test 或用户纠正。
- LLM system prompt 使用当前 `workspaceRoot`，移除硬编码 `C:\Vibe`，并禁止声称看过未采集证据。

### 5. DeepSeek 隔离与 Gemini 工作根规则

- `claude-memory-loader` 现在遵守 `CLAUDE_HUB_HOME_DIR`；缓存键包含 source path，切换 home 不复用生产注入文件。
- meeting-room 预览同样动态解析隔离 memory index。
- 已补 `C:\AIWork\GEMINI.md`，AGENTS/CLAUDE/GEMINI 三份正文哈希一致、UTF-8 无替换字符。

### 6. 干净 worktree 测试可移植性

- `unit-chuxin-cli-visibility` 不再假定 Hub worktree 必须与 `chuxin-research` 同级；依次支持 `CHUXIN_RESEARCH_ROOT`、同级目录和用户主目录。
- 因此嵌套 clean worktree 可直接跑完整套件，不再需要把 sibling-path 假失败人工豁免。

## 验证

- `node --check`：16/16。
- 核心单测：34/34（含多进程、provider-aware、DeepSeek HOME、Dream prompt、版本同步与锁失败显式报错）。
- `node tests\e2e-flat-workspace-cdp.js`：PASS，含真实 `create-meeting` 根名回归。
- `node tests\e2e-memory-panel-cdp.js`：PASS，含 Codex 当前会话真实 UI、local memories、零混链/零重复。
- `node tests\e2e-groupchat-create-cdp.js`：PASS。
- `node tests\e2e-launch-center-cdp.js`：`success: true`，errors 空。
- 干净 commit 全量：871 tests，867 pass / 0 fail / 4 skip，耗时约 61.5 秒。
- 上述四条 Electron/CDP E2E 均在同一干净 commit 上复跑通过。

## 生产边界

- 未关闭、重启或修改运行中的生产 Hub 进程。
- 生效需要用户正常重启 Hub；不得按命令行子串终止生产 Electron。
- `C:\AIWork\GEMINI.md` 是工作根部署文件，不在 Hub Git 提交内。
