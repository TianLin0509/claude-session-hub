# 开发群聊 Codex 按需启动

本轮用户明确授权设计、实现、审核并合入主干。前一轮项目库任务已交付完成，不重写它的阶段文件。本文件记录本次变更与验收。

## 目标与范围

开发群聊保留稳定席位、Hub 会话 ID、工作目录、模型和权限配置；Codex 席位第一次真正收到任务时才启动原生后端及线程。普通 Codex 会话和其他 provider 保持已有启动方式。讨论阶段提前给合并位发言也应启动，不把启动时机写死为合并阶段。

## 根因与方案

建群时 meeting-create-handlers 遍历席位调用 createSession；SessionManager 在创建 CodexNativeSession 后自动 start。首轮之前的线程不一定已有持久历史，但 Hub 已保存其 ID；重启后的 resume 因 no rollout 失败。

使用现有原生会话包装器保留逻辑身份，增加可持久化的 unstarted 连接状态，并跳过开发群聊空席位的自动 start。所有实际发送仍走原有 ready/start/send 管线及单实例启动 Promise，保留轮次、停止与提交去重保护。查看卡片与调整未启动席位配置不应创建线程。

空线程恢复不能仅以没有 turnId 判断。新版本为线程创建和提交尝试保留独立原子凭证，在请求写入前同步记录提交尝试；只有确证未提交的线程才允许 no rollout 后有界重建。旧版本缺少凭证时，不假装知道没有提交，提供明确的人工确认入口；已有历史或未决提交不得新建替代。

## 验收

- 创建开发双席位后，两席位可见，尚未发送时无原生线程；首次发言只启动目标席位。
- 未使用席位经过重启仍为尚未启动；第一次派工成功；已使用席位恢复原线程。
- 并发启动共用一个 Promise；重复提交 ID 不产生第二次任务；停止/关闭能阻止排队发送。
- 创建与提交之间断线，凭证证明未提交时只重建一次；已提交、凭证损坏/缺失/配置域不符时不得自动替换。
- 模型/思考强度/权限/MCP/工作目录保留；未启动席位不被 UI 标成断线。
- 真实隔离 Hub + CDP 及受控 App Server 证明建群、首次发送、重启和错误路径。受控后端不宣称真实模型 E2E。
- 全量单测、隔离完整副本 merge_task.py --dry-run、正式入口合并并推送，版本由入口更新。

## 保护与回退

只在 C:\AIWork\20260911-codex-lazy-start-codex1 实现，不修改生产 state/config，不重启生产进程，不操作主目录两份哲学模块在途修改。失败保持明确状态，不能为得到可发送状态而清空历史。回退用审核后的提交 revert；保留原生历史与创建/提交凭证。

## 实现验证记录

- 基线：4a1d474716cff43b1377556363ce405ca05281f2；分支：fix/codex-lazy-start-20260911-codex1。
- `node tests/unit-codex-lazy-start.test.js`：9/9，通过真实 stdio 后端 fixture 验证启动、提交去重、重启、停止、损坏凭证与配置域隔离；新增断言先复现 eager connecting，再修复。
- `node tests/unit-codex-native-session.test.js`：26/26；`node tests/unit-codex-native-options.test.js` 与创建、恢复、transcript IPC 契约通过。
- `node scripts/run_unit_tests.js`：435/435，114.4 秒等待测试锁，执行 182.2 秒。最后补充的只读 IPC 断言与无历史 picker 参数单独复验；最新集成仍须由合并入口全量亲验。
- `node tests/e2e-codex-lazy-start-cdp.js`：真实隔离 Electron + CDP 三组验收通过。GUI 找出关闭时把 unstarted 写成 disconnected 的遗漏，修复后跨 Hub 重启通过。证据在 worktree 的 `output/lazy-start/gui/`。
- GUI 的原生后端与阶段交付文件为受控 fixture，不代表真实模型执行项目或真实代码合并。旧会话 fixture 同时设置隔离 state.json 和单会话备份；没有写生产状态。
- 原有 native GUI 脚本的卡片按钮选择器与重发入口已经过时，更新为当前后台按钮及正文确认操作；最后一轮结果和主干集成证据记录在交付 HTML。
- `node --check core/codex-native-session.js`、`node --check core/codex-start-journal.js`、`node --check renderer/codex-native-controls.js`、`git diff --check` 通过。

本次由同一 Codex 按用户授权实现并自审，不将自测称为独立审查。最终提交、最新主干集成、正式合并 SHA 与版本以最终 HTML 及合并日志为准。
