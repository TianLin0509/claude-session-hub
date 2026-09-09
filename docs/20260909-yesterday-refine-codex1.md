# 昨日之我：筛选栏与正式项目库

用户反馈：筛选控件视觉零碎，缺少最近 24 小时 / 3 天；项目列表不能把任意会话目录当成项目，必须与 AI 群聊项目库一致。

## 实现

- 筛选栏改为独立的一行四组控件，统一高度、边框、圆角、下拉箭头和焦点；窄窗口自动两列。排序方向保留独立可访问名称。
- 时间新增 `24h`、`3d`，与旧选项共用 `sinceTimestamp`。按当前时刻回溯 24 / 72 小时，首次请求固定 from/to，分页维持同一范围。
- 项目菜单、左侧项目栏调用群聊同一个 `workspace:prepared-projects`，名称和顺序保持一致；不再根据搜索结果的 cwd/projectLabel 生成选项，零命中项目仍保留。
- 该接口可选 `searchRoots: true` 读取正式仓库的 Git worktree 登记，普通群聊调用行为不变。目录身份用于内部归属，项目名用于展示。同名项目不会混合，子目录按边界匹配，嵌套正式项目优先归最近的根。
- 新 `projectFilter` 在 SQLite 候选扫描之前应用，标题即时层使用同一谓词。旧 `project` 文本接口保留兼容，面板不再使用它。
- 无归属记录仍可从“全部会话”找到。已删除但仍有 Git 登记的 worktree 保留历史映射；目录已重新使用且没有相符 Git 指针时不继承旧归属。Windows 扩展路径、UNC、斜杠和盘符大小写统一处理。
- 加载失败明确提示；失效选择不会扩大成全部。异步加载根据当前选择派生状态，忽略乱序响应与关闭后的回调。
- 实际 E2E 发现并修复旧 `restoreMeeting` 丢弃 workspace/workspaceLabel 的问题。搜索读取历史群聊时，磁盘有项目而旧 live metadata 为空，则保留磁盘项目。群聊来源签名单独升级，后台重新解析该类来源；无需重建整个搜索库。

## 验证与审查

- `node scripts/run_unit_tests.js`：404 个测试文件通过，136.3 秒。
- `node --test tests/unit-global-session-search-ui.test.js tests/unit-session-search-projects.test.js tests/unit-session-search-sources.test.js`：最后补充回归后 17/17 通过。
- `node tests/meeting-room-persist.test.js`：恢复与持久化验证通过。
- `node tests/e2e-global-session-search-cdp.js`：隔离 HOME/data/CDP/工作根，真实 UI 通过。正式菜单与群聊 IPC 相同；正式项目覆盖根、子目录、worktree 三种来源，排除同名相邻目录；24h/3d/7d 分别返回 1/2/3 个会话；零命中项目保持可选；1500/760 截图检查，375 宽无水平溢出；控制台无错误。
- 结构与契约遍：删除的 `knownProjects` 无残留，项目根仅通过新结构传递，标题/正文/游标一致；项目库接口新增可选参数，现有调用无需修改。没有删除模块。
- 独立运行时遍：修复扩展 Windows 路径漏匹配、复用目录误归属、项目加载时选择变化导致误报三类问题，独立探针复验通过。

主要证据位于本 worktree 的 `output/20260909-yesterday-refine-*` 与 `output/20260909-refine-review-codex2-*`。真实 UI 截图：`output/playwright/global-session-search/global-session-search-1788966302451-11176.png`。

合并由独立席位对冻结提交执行仓库 MERGER 合同；合并脚本统一升三处版本。生产 Hub 不重启，原有两份未提交文件保留。
