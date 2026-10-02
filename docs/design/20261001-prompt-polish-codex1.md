# 输入框 Prompt 整理

2026-10-01，实现分支 `feat/prompt-polish-20261001`。版本沿用项目规则，在正式合并时由合并入口升级。

## 用户行为

普通会话与群聊的发送按钮旁增加魔杖图标，悬停显示「整理 Prompt · DeepSeek Flash」。仅在用户点击时调用，整理结果回填原输入框，用户自行检查、修改、发送。提供一次撤销；继续修改后的草稿不会被撤销按钮覆盖。处理中显示「整理中…」，再次点击可取消。

请求前记录目标、完整草稿及编辑版本。等待期间打字、语音转写、发送、切换目标或销毁输入栏后，返回结果不得覆盖当前内容。读取长文本粘贴块时展开完整内容，写回和撤销沿用现有草稿持久化与粘贴块机制。

## 模型与边界

复用 Hub 官方 DeepSeek API 的 `deepseekApiKey`，调用 `https://api.deepseek.com/chat/completions`，模型 ID 为 `deepseek-flash`，明确设置 `thinking.type=disabled`，单次调用，不自动切换模型、不自动重试。密钥留在主进程，不传给输入栏。

12,000 字以内的草稿完整发送；超出时明确要求分段，禁止静默截断。25 秒超时，输入原稿保留。正文为空、输出截断或代码/反引号引用发生改变时拒绝应用结果。当前草稿是唯一发送的上下文，未读取历史、附件正文或项目记忆。保留指代，避免根据有限上下文补造信息。

整理提示词位于 `core/prompt-polish.js`：整理口头表达与结构，保留全部实质信息、否定、不确定性、授权程度及阶段边界；只采用草稿已有信息；路径、数字、命令、代码与模型名按原文保留；输出仅为可编辑的整理正文。

API 和生命周期在 `core/prompt-polish.js` 与 `main/ipc/prompt-polish-handlers.js`，共享输入栏交互在 `renderer/prompt-polish.js` 与 `.css`。不改变原有 Agent 提交管线，无新增依赖。

## 调研依据与取舍

- [DeepSeek 官方模型列表](https://api-docs.deepseek.com/quick_start/pricing/)：2026-10-01 核对，`deepseek-flash` 对应 DeepSeek V4.1 Flash。
- [DeepSeek 官方思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)：Chat Completions 用 `thinking.type=disabled` 选择非思考模式。
- [Prompt Optimizer](https://github.com/linshenkx/prompt-optimizer)：区分系统提示词与用户提示词，支持优化后测试和比较；Hub 只采用用户草稿整理。
- [该项目基础用户提示词模板](https://github.com/linshenkx/prompt-optimizer/blob/master/packages/core/src/services/template/default-templates/user-optimize/user-prompt-basic.ts)：采用简洁、直接输出及结构整理思路。模板包含补充信息的做法；依据用户本轮要求，Hub 提示词仅使用已有信息，并保留讨论与执行的差异。自行编写提示词，未复制其角色模板或实现。
- [Anthropic Prompt Improver](https://claude.com/blog/prompt-improver)：结构改写和任务实测具有参考价值。Hub 为交互速度采用一次整理，不引入多轮评估链路。

## 验证入口

- `node tests/unit-prompt-polish.test.js`：输入边界、Flash 参数、完整正文、代码保留、超时、取消、窗口隔离与生命周期。
- `node tests/e2e-prompt-polish-cdp.js --live`：真实隔离 Hub 中用鼠标和键盘验证普通会话/群聊、两种窗口尺寸、回填/撤销、请求期间输入、取消、失败与切换草稿；交互异常使用明确的模型夹具；另走一次真实官方 Flash API。
- `node scripts/20261001-prompt-polish-quality-codex1.js`：真实 API 检查语音讨论、执行阶段、路径/数字/条件、简短指代与代码保留，输出写项目 artifacts。
- `node scripts/run_unit_tests.js --jobs 8`：项目规定全量检查，使用共享测试锁。

改写质量属于模型行为。已验证样本不代表所有意图都能无误保留，也未证明最终 Agent 任务成功率提升；回填后仍由用户检查并发送。

## 本轮结果

- 项目全量入口通过：647 个测试文件，8 并发，199.8 秒。提交前工作树执行，基线 SHA 为 `e5dde8dd`；日志：`artifacts/20261001-prompt-polish-codex1/20261001-unit-suite-codex1.log`。
- 最终界面检查通过：18 项。包含普通 Claude/Codex 输入栏、群聊、1440×1000 与 1000×700、点击/回填/撤销、改写中继续输入、取消/迟到结果、错误保留原稿、切换群聊、粘贴块完整展开和撤销、手动发送后的迟到结果、改写后继续编辑不被撤销覆盖、未自动提交 Agent。CLI 回复为隔离原生协议夹具，整理功能另走真实官方 API。
- 最终真实界面点击 Flash API：约 765 毫秒返回，撤销恢复原稿成功。独立 5 类真实质量样本均通过，单次耗时 435–1452 毫秒。
- 最终界面证据：`artifacts/20261001-prompt-polish-codex1/1790911154616/20261001-prompt-polish-evidence-codex1.json`；真实质量输出：`artifacts/20261001-prompt-polish-codex1/20261001-live-quality-codex1.json`。
- 截图已读取检查；未重启生产 Hub，未合入或推送；新增依赖为零。
