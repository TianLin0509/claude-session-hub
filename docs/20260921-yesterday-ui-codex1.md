# 昨日之我：界面优化与其他模型

## 用户需求与设计

改善昨日之我的视觉层次，并增加代表非 Codex / Claude 会话的“其他”模型选项。

保留项目、结果、阅读三栏及拖动分隔线。面板改用中性灰白底色，绿色用于选中和继续会话；压缩顶部，统一筛选控件与文字层级。修复提问卡片继承主界面深色背景的问题。窄窗口下模型筛选可横向滚动，内容页签保持单行，返回结果按钮不再撑高，顶部允许独立滚动。

## 搜索契约

- `other` 是聚合过滤条件，不是存储在会话上的 provider。排除 codex、claude、meeting；群聊继续使用独立选项。
- 标题即时层、目录 / 归档 / Agent 层、SQLite 查询和兼容内存索引共用匹配逻辑。SQLite 在候选扫描预算之前过滤；真实模型名、计数和分页保持不变。
- 其他按钮零命中仍保留，选择可以持久化。现有模型单项选项保留。
- 发现来源白名单会丢失千问、智谱和 DeepSeek 原生的标题。本次改为依照 `ai-kinds` 收录已支持 AI 的已有标题与末段摘要；PowerShell 不收录。新来源在下一次正常增量刷新收录，不全量重建。
- 没有历史解析器的模型不因此获得完整正文搜索；已有摘要的时间仍为未知，不伪造真实消息时间。工具与文件仍不在搜索内容范围。

## 实际验证

PowerShell 执行：

```powershell
$files = @(Get-ChildItem tests\unit-session-search-*.test.js | ForEach-Object FullName)
node --test @files tests/unit-global-session-search-ui.test.js tests/unit-title-index.test.js
node tests/e2e-session-search-other-cdp.js
git diff --check
```

- 单测 135 / 135 通过。新增回归覆盖未来 / 未知已索引 provider、标题和归档交集、候选预算、分页、空查询、计数、已有来源回归及偏好恢复。
- 专项真实隔离 Hub / CDP 通过：8 个会话，“其他”返回 6 个；真实 Kimi wire.jsonl 经索引与 IPC 检索正文，实际输入及点击，归档 + 学习 Agent 交集、无结果及偏好持久化。1500 / 1024 / 760 / 375px 搜索面板无横向溢出；检查浅色与深色宿主主题。无页面错误，退出码 0，无强制终止。
- 对修改的 core / renderer JavaScript 以及专项 E2E 脚本逐个执行 `node --check`，全部通过。`git diff --check` 通过。
- 未运行全仓合并闸门，不宣称全仓或真实模型生成 E2E 通过。

## 基线问题，未计入通过

1. `node tests/e2e-global-session-search-cdp.js` 在修改前与修改后均于 375px 的整页宽度断言失败（416 != 375）。专项测试验证的是搜索面板自身，不改动背后主界面。旧 E2E 后续步骤没有被执行，不能计为通过。
2. 快速关闭 / 重开搜索并继续切换条件，测试实例出现 `0xC0000005` 退出和 CDP 超时。在独立基线工作树 `C:\AIWork\20260921-yesterday-baseline-codex1`、未修改的 `bfb280a` 上同样复现。未定位根因，未修复。该失败探针与完整通过的专项测试分别保留，不能把专项通过解释为重开场景通过。

## 交付

- 可离线打开的截图比较页：`output/playwright/yesterday-ui/review.html`。
- 四种宽度截图及专项证据：`output/playwright/yesterday-ui/`。
- 失败证据：同目录 `reopen-failure.json` / `baseline-reopen-failure.json`；旧全局 E2E 日志 `output/yesterday-global-e2e.log`。
- 分支 `feat/yesterday-ui-20260921`；普通会话交付候选，未合入 master，未升版本，未触碰生产进程及主目录已有修改。
