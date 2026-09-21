# 昨日之我：D 聚焦搜索

用户选定五个 mock 中的 D 后实现。分支 `feat/yesterday-ui-20260921`，工作树 `C:\AIWork\20260921-yesterday-ui-codex1`。生产目录未改动，未合并 master。

## 交付行为

- 浅紫灰背景、居中搜索卡、紧凑结果列表。常显全部 / Claude / Codex / 其他 / 群聊，以及项目、时间。
- Agent、内容范围、归档、置顶、其他模型细分和排序收进“筛选”，按钮显示已启用条件数。归档、置顶入口自动展开。
- 搜索和方向键选择不请求原文；点击结果或 Enter 打开阅读抽屉。Esc 先关闭抽屉并回到搜索框，再关闭整个搜索。抽屉打开时背景 inert，Tab 限定在阅读区域。
- 阅读保留会话概览、命中位置、原始对话、产物、Markdown、公式、复制引用、继续会话。阅读样式不继承宿主深色卡片背景。
- 最近搜索来自本地真实记录，没有示例关键词。原有分页、加载、失败、缺失原文、索引状态均保留。
- “其他”包含非 Codex / Claude 的模型会话，群聊单列；来源过滤在全文候选预算之前生效，标题层和归档等组合筛选语义一致。
- 修复搜索继续 Claude 会话后的精确定位：原始 entry ID 与 `claude-message-<entry ID>` 显示卡片 ID 对应，不使用文本模糊匹配。

## 验证

以下命令在本工作树运行：

```powershell
node --check renderer/global-session-search.js
node --check renderer/renderer.js
node --test --test-concurrency=1 tests/unit-global-session-search-ui.test.js tests/unit-session-search-*.test.js tests/unit-search-control-chars.test.js tests/unit-search-user-text-denoise.test.js
node tests/e2e-session-search-other-cdp.js
node tests/e2e-global-session-search-cdp.js
git diff --check
```

- 搜索相关单测 138/138 通过。首次并发运行中，文件监控服务的进度事件断言出现一次时序失败；串行完整回归全部通过，没有修改或弱化该测试。
- D / 其他专项：真实隔离 Electron Hub，JSONL → SQLite → IPC → 界面；物理点击、键盘输入、方向键、Enter、Esc，其他模型数量、正文、归档×Agent、空结果、偏好、重新打开、1500/1024/760/375 四档窗口与两种宿主主题通过；renderer 错误为空，测试实例退出码 0。
- 全量搜索 CDP：预热、进度、项目归属及 worktree、时间范围、三类来源、内容范围、Markdown 只读预览、键盘、响应式、打开群聊、Claude 原会话恢复和精确高亮、偏好重载全部通过。
- Claude 恢复使用项目已有 stream-json 协议夹具，不连接真实模型。旧测试的无效 Claude ID / PTY 启动夹具已迁移为有效 UUID / 原生协议夹具；断言检查活动会话、原生连接和实际高亮卡片。
- 窄窗口几何断言约束搜索自身；宿主背景在 375px 的既有横向溢出另记于专项 JSON 的 bodyWidth。允许 Chromium 缩放产生小于 1 CSS px 的舍入。

## 证据与边界

- `output/playwright/yesterday-d/verification.json`：D 专项详细结果与退出记录。
- `output/playwright/yesterday-d/yesterday-d-search.png`、`yesterday-1500.png`、`yesterday-search-375.png`、`yesterday-375.png`：真实 Hub 截图。
- `output/playwright/global-session-search/global-session-search-1790010136404-45084.json`：完整搜索回归结果。
- `output/yesterday-d-unit.log`、`output/yesterday-d-e2e.log`、`output/yesterday-d-global-e2e.log`：测试日志。

隔离运行使用独立数据目录、home 和 CDP 端口，DEEPSEEK_API_KEY 为空。未启动、关闭、重启生产 Hub，未修改生产数据或依赖，未提前升版本。

“其他”不是所有 provider 都已具备无损全文归档的声明：已有完整解析器的来源检索其对话，只有元数据的来源保留标题/已有输出摘要。没有新增远程检索或真实模型质量验证。
