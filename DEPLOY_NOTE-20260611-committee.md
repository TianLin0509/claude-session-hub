# DEPLOY NOTE 2026-06-11 凌晨 · 投委会场景开发会话

写给可能并行工作的其他会话 / 明早的用户。

## 本会话新增/修改（投委会功能，未提交，等用户验收后 commit）
- 新增 `core/committee-scene.js`（席位 persona/三幕 prompt/schema 校验/质询触发，纯函数）
- 新增 `main/groupchat/committee-conductor.js`（三幕编排状态机 + python 备料/记忆落盘）
- 新增 `tests/unit-committee-scene.test.js`（23 个单测，全过）
- 修改 `core/group-chat-orchestrator.js`（buildSystemPromptText 加 committee 场景分支 + opts.kind）
- 修改 `main/groupchat/dispatcher.js`（buildSystemPromptText 传 member.kind，1 行）
- 修改 `main/ipc/groupchat-turn-handlers.js`（committee 命令路由到 conductor）
- 修改 `main/ipc/meeting-create-handlers.js`（committee 场景复用 research MCP 注入）
- 修改 `main.js`（装配 committeeConductor）
- 修改 `renderer/meeting-create-modal.js`（投委会场景 radio + 五席预设）
- 修改 `core/model-options.js`（qwen 加 3.7-max / 3.7-plus）
- 修改 `package.json` + `renderer/index.html`（版本 → v1.2.0）
- LinDangAgent 侧新增 `C:\LinDangAgent\committee\` 整个包（备料/红旗/记忆/dashboard）

## ⚠ 事故记录（已评估，影响极小但如实记录）
凌晨 ~01:50 我对 `package.json` + `renderer/index.html` 执行过一次 `git checkout --`
回滚（为撤销自己的行尾污染），**误销毁了这两个文件的未提交改动**：
- 实际丢失内容（事后核查）：版本号标签对 package.json `1.1.1→1.1.2` + index.html `v1.0.5→v1.1.2`，
  应为某次未提交的版本 bump，已被本会话的 v1.2.0 取代。
- 已核查无结构性丢失：所有处于修改状态的 renderer JS 新引用的 DOM id
  （mr-btn-memory-preview / preview-toggle-layout 等）要么在 HEAD index.html 存在、
  要么是 JS 模板动态创建，与 index.html 无依赖断裂。
- 如果你（另一个会话）的 index.html / package.json 改动不止版本号，请告诉用户并从你的上下文恢复。

## 🚨 高危发现（给其他会话 + 用户）：主工作区 renderer WIP 会导致界面冻结
凌晨 E2E 判别实验（隔离实例，同一批会议数据）：
- 用 **主工作目录（脏树）** 跑：群聊渲染大段消息后 renderer 事件循环**永久阻塞**（CDP evaluate 超时，复现 2 次：02:1x 与 03:2x）；
- 用 **HEAD + 仅投委会文件** 的干净 worktree 跑：同样数据全部渲染，**不冻结**（逐会议打开验证）。
→ 结论：冻结大概率来自工作区里未提交的 renderer WIP（turn-card-renderer.js / meeting-room.js 等修改中文件）。
**用户重启生产 Hub 前请先处理/暂存这批 renderer WIP，否则正常群聊也可能触发冻结。**

## 晨间迭代（用户反馈后追加，同样未 commit）
- `core/committee-scene.js`：消息面官 kind gemini→kimi + persona 调整（去联网依赖措辞）
- `renderer/meeting-create-modal.js`：五席预设 gemini→kimi-k2.5 + 提示文案
- `main/groupchat/committee-conductor.js`：鲁棒性兜底（点名 90s 超时 + 疑似不可用席位降级重试 +
  幕二非关键路径化 + 主席派发重试）。**需重启 Hub 生效。**

## 第二批迭代（2026-06-12，同样未 commit，重启生效）
- `core/committee-scene.js`：持仓体检全套（parse/OCR prompt/双官 prompt/裁决 prompt/归一化/校验）
- `main/groupchat/committee-conductor.js`：runCheckupSession 状态机
- `renderer/meeting-room.js`：committee-progress 头部进度监听（surgical 追加，未动其他 WIP）
- `tests/unit-committee-scene.test.js`：30 个单测
- C:\research-mcp：stock-news 六项升级（news_client/aggregator/新 consensus.py/新 sources/em_concepts.py + 11 单测，回归 27 passed）
- C:\LinDangAgent\committee：append-checkup/watch 子命令 + settle 归因/教训命中 + dashboard 警报/体检/归因区 + prep_case 消息面速览

## E2E 终局（04:16 全链打通）
隔离实例真实五模型完整跑通：点名（主席"就位"）→ 幕〇案卷 → 幕一三官（含 MCP 自主调用）→
幕二条件判断 → 幕三 C 级裁决 → V-20260611-002230 落盘 + L-002 教训 + git commit + dashboard。
追加修复（均已在工作区）：meeting-room.js 场景白名单 ×3 处、main.js research 闸门放行 committee、
dispatcher.js turnTimeoutMs、conductor 点名轮 + persona 重试。E2E 期间在 ~/.claude.json 未做任何修改；
C:\temp\hub-clean worktree 已按 junction 铁律移除；隔离实例 electron/claude 进程已清（生产 13 个未动）。

## 注意
- 工作区还有大量其他会话的未提交改动（meridian/usage/android-app 等），本会话**未触碰**它们。
- 本会话所有 git 操作仅限：LinDangAgent 仓库的 `data/knowledge/committee/` 目录自动 commit（committee_memory.py 内建）。
- Hub 仓库本会话**不主动 commit**（工作区太脏，等用户拍板后只挑投委会文件提交）。
