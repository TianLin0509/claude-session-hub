# 开发群聊创建简化与 prompt 编辑台

基线：`8dbb3894bcf178112a94a9bf6f71d43557312305`。实现分支：`feat/dev-simplify-20260910-codex1`。

## 行为

- 每次进入创建群聊默认开发场景，开发排列第一；默认选已有路径，仍可手动换工作目录方式。
- 删除“起手”整组卡片。保留用户选择的成员、模型和调优。
- 单 Agent 默认承担实现与合并，“独立开工”仅预填、保留草稿、可重复点击；用户 Enter 后按普通消息发送一条完整 prompt，不运行极简循环或阶段文件派工。
- 两位及以上成员保留原文件工作流：第一位实现、第二位独立验证与合并。
- 旧房间及旧配置继续兼容。单 Agent 自审不声称独立验证；项目原有审批与发布要求仍然有效。

## Prompt 编辑台

绝对路径：C:\VibeData\Artifacts\Reports\20260910-AIHUB-开发prompt编辑台-codex1.html

主流程按独立文本块计数为当前 7 项、本次 9 项。另有 8 项可选职责帽、12 项旧版兼容文本、29 项可选通用工作流文本及包装；总计 58 项，当前已有 56 项、本次新增 2 项。共享约束只计一次，首次/返工实现分开，动态轮次不重复计数。不是每轮都发送全部内容。

每项含触发条件、源码来源、原文、修改稿和备注。支持搜索、只看修改、浏览器本地保存、JSON 导入导出、Markdown 导出、保存含修改的 HTML。修改不会直接写回 Hub。

未计入跨场景基础聊天包装、模型系统指令、英雄人格或项目本地合同；这些属于其他层，不是开发场景预置。

## 已执行验证

以下命令在本工作树运行。Windows 单测 PATH 加入 `C:\Program Files\Git\bin`；启动 Electron 的命令清除父进程 `ELECTRON_RUN_AS_NODE`。

| 命令 | 结果 |
|---|---|
| `node scripts/run_unit_tests.js` | 418/418 文件全部通过；第二轮排队 184.8s，执行 187.0s |
| `node tests/dev-prep-controls-e2e.js --solo` | 8 项通过：真实单 Claude 创建、预填、草稿、多次点击、Enter、无自动第二轮 |
| `node tests/dev-prep-controls-e2e.js` | 21 项通过：双席位、路由、预填、三个宽度布局、旧房间兼容 |
| `node tests/dev-prep-controls-e2e.js --double-codex` | 22 项通过，含切通用后重开恢复开发/已有路径、两个独立 Codex 席位 |
| `node tests/dev-file-workflow-i-e2e.js` | 12 项通过：开题/文件交接、暂停、迟到交付、继续 |
| `node tests/e2e-dev-scene-project-library-cdp.js` | PASS：默认已有路径、项目库读取和实际选项选择 |
| `node tests/dev-prompt-catalog-e2e.js <上述 HTML 路径>` | 9 项通过：Chrome 实际载入/编辑/刷新/筛选/恢复/导入，校验三种导出的 Blob 内容，宽窄截图 |
| `node tests/meeting-create-modal-static.test.js` | 全部通过 |
| `node tests/unit-dev-scene-contract.test.js` | 14/14 通过 |
| `node tests/unit-dev-workspace-guard.test.js` | 19/19 通过 |
| `node --check`（修改的 JS）与 `git diff --check` | 通过 |

全量首轮 417/418：目录提示的旧文本断言仍要求旧文案，按新需求更新后全量通过。单独静态测试另修正了此前已经落后的默认发言人断言。

I 层使用真实隔离 Electron/UI/IPC/文件系统，Agent 派发器为受控 fixture，**不证明真实模型完成实现或合并**。HTML 导出验证检查浏览器生成的内容，未自动应用到源码。

截图/结果目录（均位于本任务工作树）：

- `output/playwright/dev-prep-1789063974340`：单 Agent。
- `output/playwright/dev-prep-1789064193097`：双 Agent。
- `output/playwright/dev-prep-1789064653949`：双 Codex 与重开默认值。
- `output/playwright/prompt-catalog-1789064734858`：交互 HTML。
- `output/20260910-dev-simplify-units-codex1.log`：完整全量输出。

## 交付边界

仅本地隔离工作树实现和提交，未合入 master、未推送、未升版本、未重启生产 Hub。版本由正式合并脚本负责。主目录原有两项 agent-league 未提交改动未处理。
