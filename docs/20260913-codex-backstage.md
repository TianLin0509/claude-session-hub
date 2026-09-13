# Codex 后台：CLI 风格工作记录与原始信息

用户确认 `artifacts/backstage-mock/20260913-backstage-mock-codex1.html` 后，要求先适配 Codex，并保留像 CLI 一样直接查看具体报错的能力。本次仅改变普通 Codex / Codex resume 后台；Claude、DeepSeek、千问、智谱尚不启用新界面。

## 使用体验

- 工作记录按原生步骤增量更新；用户消息、回答、命令、诊断有清楚的层次。已完成回答渲染安全 Markdown，流式文字不逐字重新解析 Markdown。
- 失败步骤自动展开，原始错误独立显示在有界日志预览之外；不把工具失败或重连提示误判为整轮失败。
- 可选择清爽 CLI / 经典 CLI、字号；完整内容按页展开，也能切换原始记录或导出。
- 保留原终端、原输入框、审批、提问、停止等控制。旧共享 broker 不支持新记录接口时使用原终端，并在工具栏提示后台待升级，不中止正在运行的任务。
- 阅读历史时不会强拉到底；点击回到最新可恢复跟随。卡片页、其他 session 和不可见窗口暂停后台读取。

## 数据和开销

`CodexNativeSession -> CodexBackstage -> SQLite WAL journal -> broker readBackstage -> IPC -> renderer`。

只有原生 writer 采集；多个 Hub 向同一个 broker 分页读取。原生 Thread/Turn/Item 仍是状态唯一来源，展示不修改执行状态，也不补发 prompt。

保存命令、工作目录、原始输出、工具结果、退出码、原生 error/code/data/stack、审批原始请求，以及 App Server stderr。已知环境或配置凭据在 stderr 进入记录前脱敏。stderr 没有可靠的 thread 身份，明确标为共享进程来源，不伪装成当前任务独有错误。这里的原始记录指原生接口实际提供的信息，不是旧 CLI 的屏幕录像。

记录事务按输出触发并合并约 50 ms，达到 256 KiB 待写数据时提前提交；没有空闲轮询。字段预览最多 4096 字符，详情每页最多 16 × 8192 UTF-16 字符，历史每次导入最多 40 项。工作记录最多保留 180 个 DOM 步骤，原始记录最多 60 个 chunk，较早内容仍保存在 journal 中。新界面显示时释放隐藏 xterm 的 canvas/WebGL 资源，保留兼容缓冲。

Journal 不自动删除原始信息，会随输出占用磁盘。启用前的 stderr 无法补录；较早对话仅能从 Codex 提供的历史按需补入。导出包含当前已采集/已补入的记录，截止到导出开始读取时的序号；逐块附带来源和时间。遇到跨块单独 UTF-16 码元时以显式 JSON 标记保留，避免转 UTF-8 时损坏。保存、读取、导出失败均明确显示，不误报成功。

## 验证与审查

- `node tests/unit-codex-backstage.test.js`：16 项，覆盖大输出保真、NUL、跨块 Unicode、快照修订、原生 RPC 错误、历史失败分页、凭据脱敏、缓存释放、磁盘失败及短写。
- `node tests/unit-codex-native-mode.test.js`：3 项；`node tests/unit-codex-native-session.test.js`：30 项；独立复审另执行 shared session 4 项。
- `node tests/e2e-codex-backstage-cdp.js`：两个真实隔离 Electron Hub + 受控原生 stdio fixture，覆盖流式 DOM 身份、滚轮、错误实际可见、完整导出、长原文分页、快速切换、审批、停止、草稿、字号与共享读取。没有调用真实云端模型，因此不等于实际服务端网络故障验收。
- `node tests/e2e-pty-design-cdp.js`：原终端兼容、深浅主题、窄屏、选择/搜索、卡片切换及真实 PowerShell。
- 运行时由只读 reviewer 独立审阅，原文保存和错误传播的边界缺口已修复并复验。结构与 GUI 由实现位自审；最终候选仍须通过项目合并脚本的完整集成检查。

后续给其他 AI 适配时，应复用同一套展示契约，但先分别确认其原生工具输出、错误、历史和请求身份，不依靠终端文字猜状态。
