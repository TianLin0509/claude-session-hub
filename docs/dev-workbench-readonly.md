# 开发工作台：A 只读任务清单

用户选定 A 方案并增加项目下拉筛选。页面仅提供当前/历史/讨论、项目筛选、搜索、展开来源和进入群聊。项目按绑定目录区分，名称相同显示完整路径；不按名字猜同一仓库。项目筛选影响范围计数与用户待决数，搜索再缩小列表。

## 来源契约

- 双席位阶段复用 `dev-file-workflow.fromNames`，只读合法文件链；正文不参与派工。当前阶段未写摘要时显示已知交接事实。
- 单 Agent 的 `任务记录.md`、双席位的当前阶段文档使用一个 `hub-task-view` 代码块。文件创建不代表开工，普通讨论保持 `discussion`。聊天不再要求 PLAN/UPDATE 标签。
- 不自动改写历史记录。无结构区显示“进度未记录”；旧协议独立展示，其 ASK/FAIL 不计入新的用户待决数。保留原群聊入口。
- 一个群聊对应一个任务。不同任务应新建群聊，避免旧文件链沿用。未来如增加原地新任务，必须由 Hub 发放新 taskViewId 并隔离任务文件；本版不从任意 prompt 猜新代次。
- 运行态复用 `getSessionRuntimeTruth`，一次回复完成不改变任务阶段。

```hub-task-view
{"schema":"hub.task-view.v1","taskId":"实际群聊 ID","revision":1,"phase":"implementing","summary":"实际进展一句话","decision":null,"evidence":[]}
```

phase：discussion / implementing / reviewing / waiting / paused / completed / stopped。
summary 为 1–600 字；revision 从 1 开始，只增不减。块必须唯一，taskId 必须匹配本群（存在 taskViewId 时使用该值）。待决事项格式为 `{id,text,recipient:"user",resolved:false}`，明确解决后置 true；普通聊天不清除待决事项。

evidence 是最多 12 个 `{kind,ref}` 的原文引用。仅展示引用不构成自动验证。可选 merge 为 `{candidate,commit,target}`，前两项完整 40 位 SHA，target 是 refs/heads/... 或 refs/remotes/...；以绑定工作目录运行只读 Git 检查候选→合并提交→目标 ref 的可达性。仅支持保留候选祖先的合并；squash/rebase 无对应祖先时显示待核对，不猜映射。核对本地 remote-tracking ref 不意味着本轮已 fetch 远端。已合并不代表生产窗口已加载新代码。

## 鲁棒性与限制

任务目录在 worker 中定点异步读取，最多 4 个并发；后台每 2 秒补扫已知任务，覆盖只有文件变化、无聊天推送的场景，同时比较运行态到期变化。worker 读取 10 秒超时会终止并重建，失败可重试，不静默吞掉。限 1 MB、严格 UTF-8、唯一摘要、完整类型检查、路径 realpath 边界、读前后 stat 与目录阶段快照一致性检查。短暂半写、冲突、降序 revision 保留上次合法快照并标明待核对；没有上一份则明确不可用。合法记录缓存到 Hub 数据目录 workbench-cache，重启后仍验证修订号，缓存失败会显式提示。读取不创建任务文件、不派工。前端只订阅统一增量快照，epoch/sequence 缺口重读，不按颜色推断分类。

工作台旧写 IPC 拒绝所有变更请求。来源预览通过只读 IPC 限定到当前任务的当前阶段文件，纯文本显示，避免执行文档内指令。暂无独立审查的结构化自动认证，文档完成只显示“已报告完成”或“文件流程已完成”；不能宣称独立审查通过。

## 验证

`node scripts/run_unit_tests.js` 为全量入口。
`node tests/dev-workbench-cdp-e2e.js` 转到新的真实隔离 Hub 只读工作台检查；使用生产 UI/IPC/文件系统，任务文档为测试输入，不调用模型。
`node tests/unit-dev-task-view.test.js` 覆盖解析、阶段边界、失效记录、交接链与只读 IPC。
`node tests/unit-dev-board-render.test.js` 覆盖证据、导航、缺失、转义与已移除的写入口。

Windows 验证进程的 PATH 需包含 Git 的 bin 目录，使既有钩子测试能够启动 sh；缺少 sh 的 ENOENT 是验证环境失败，不能按单测通过处理。CDP 首次点击等待 DOM complete 与字体就绪，避免全局函数先于 DOMContentLoaded 监听赋值导致测试提前点击；不放宽任务投影完成判据。

重构核对：保留 ran.js/CSS 入口和面板显隐兼容函数，调用方仍有效；生产前端无旧写 IPC 调用。结构与契约遍核对调用链，运行风险遍交只读 reviewer；运行态到期通知与缓存保存失败后的重试已修复并以专项测试复核。该范围审查不等同于对其他模块或真实模型工作流的独立认证。
