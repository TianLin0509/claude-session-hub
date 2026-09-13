# 搜索后台刷新开销修复

在多个 Hub 共用索引、会话持续输出时，后台刷新不断重写未变化的标题来源。`docs.source_key` 缺少索引，使来源删除触发正文表全扫描。本次保留多窗口和现有搜索刷新时效，修复这两个开销来源。

## 最终实现

- 为 `docs(source_key)` 增加幂等索引 `idx_docs_source`。旧库在下一次开库时补建；不升搜索 schemaVersion，不删库、不重建全文数据。
- 先确定本轮保留的 transcript 来源及其代表的 Hub/群聊，再补充标题来源，最后统一清理。标题行不会先被删除，也不会因为已有标题行而错误地跳过自己。
- 发现不完整、来源目录离线时，保留真实历史；识别旧版元数据指纹，避免旧标题把自己的更新屏蔽。
- 标题来源以完整可搜索投影（session 与 docs）生成指纹，覆盖改名、预览、时间、模型和恢复信息；未变化的记录保留原 rowid 和内容修订标记。
- 没有增加 15–30 秒刷新间隔，没有修改草稿、侧栏、渲染、生产配置或版本号。

## 独立根因验证

基线：`391984a9fc7a813f1884346cf14dc01dfeee07d3`。使用 SQLite online backup 从只读生产连接取得一致副本；所有删除与建索引实验只发生在副本上。副本有 4570 个来源、400196 段正文和 227 个 `hub:` 来源。

同一组 227 个来源逐个删除，每次整组事务回滚：

| 指标 | 补索引前 | 补索引后 |
|---|---:|---:|
| 删除耗时 | 215580.36 ms | 232.62 ms |
| 正文定位计划 | SCAN docs | SEARCH docs USING COVERING INDEX idx_docs_source |
| 实验后来源 / 正文数量 | 4570 / 400196 | 4570 / 400196 |

补建索引耗时 855.92 ms。以上是此时此机、同一副本上的删除步骤对比，不是整轮刷新或生产按键延迟。初次/后续缓存状态不同，不能把约 927 倍的实测比值当作普遍保证。源码查询计划和未改变的行数提供独立于墙钟计时的佐证。

## 验证

- 修复前新增回归：5 项中 4 项失败，分别复现缺少定位索引、普通标题重复写、标题更新后的重复写、群聊标题重复写。
- 修复后搜索聚焦回归：`node --test tests/unit-session-search-refresh-cost.test.js tests/unit-session-search-engine.test.js tests/unit-session-search-sqlite-index.test.js tests/unit-session-search-workspace.test.js`，最终 29/29 通过（新增文件含 6 项测试）。
- `HUB_UNIT_JOBS=2`，PATH 加入 `C:\Program Files\Git\bin` 后执行 `node scripts/run_unit_tests.js`：492 个文件全部通过，排队 0 秒、执行 269.4 秒。该轮结束后补充旧指纹/离线目录回归，仅修改测试，并再次通过上述聚焦回归。
- `node tests/e2e-session-search-multihub-cdp.js`：PASS。两个真实隔离 Hub（PID 35600、45932）共用一个测试数据目录；四次交替增量刷新标题不重写，两窗各搜到一条标题；向 transcript 追加内容后，两窗均经真实文件监听查到新内容，其他标题 rowid 保持不变。两实例均已正常退出。
- `node --check` 检查三个修改模块和新增 CDP 脚本；`git diff --check` 通过。
- 通用 `node tests/e2e-global-session-search-cdp.js` 未全通过：第 460 行窄屏 document 宽度断言得到 414，期望 375。未修改的同 SHA 独立基线也在同一断言失败（416 vs 375）；此前搜索、过滤、问答预览及截图阶段已完成。这是已复现的基线问题，本次没有修改 UI 或放宽断言。

新增双 Hub 验证脚本初次清理阶段使用了不存在的日志方法，已更正并完整重跑；遗留的本次测试窗口经核对父 PID、代码路径和 CDP 监听归属后正常关闭。生产窗口未受操作。

## 交付与证据

分支：`fix/search-refresh-cost-20260913-codex1`。

本 worktree 下 `artifacts/search-refresh-cost/` 保存副本基准脚本、结果 JSON、单测和候选/基线 E2E 日志；`output/playwright/search-multihub/` 保存双 Hub 结果和实例日志。副本包含真实历史，只作为本机验证资料，不提交 Git。

普通会话按 AGENTS.md 交付候选，不自行合入 master。生产尚未应用；合并位通过项目入口合并时统一抬版本。
