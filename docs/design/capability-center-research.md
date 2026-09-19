# 技能中心：竞品调研与 Hub 实现决策

调研日期：2026-09-19。依据官方文档与本机源码；未操作用户登录中的 Codex App / Claude App，未把文档展示当成本机账号已开放功能。本文所称 MCP 是 AI 调用外部工具的标准连接方式；插件是技能、连接及其他扩展的安装包。

## 结论、原因与边界

Hub 采用能力库、AI 覆盖对比、当前会话三个视图。能力库回答“我有什么”，对比回答“每个 AI 有什么入口”，当前会话回答“这次连接报告了什么”。它们证据不同，不能共用一个已加载勾选状态。

原因是 Hub 同时管理多个原生客户端与多个账号/项目，而两家官方产品主要管理自己的生态。完整本地技能可以共享，但安装状态、账号授权、项目禁用配置、运行时能力不能靠目录链接一起同步。代价是多一个对比视图和更明确的状态文字；边界是没有回执就显示未确认，不启动历史会话来查询。

## 官方经验与采用情况

| 来源 | 经确认的经验 | 对 Hub 的处理 |
|---|---|---|
| [Claude 统一目录](https://support.claude.com/en/articles/14328846-browse-skills-connectors-and-plugins-in-one-directory) | Customize 集中 Skills、Connectors、Plugins；浏览与安装后的管理分开 | 把类型下拉提升为直接可见的分类栏，保持一个侧栏入口。Hub 当前展示本地能力库，不伪造完整云端商店 |
| [OpenAI 插件目录](https://learn.chatgpt.com/docs/plugins) | 用途简介、来源分类、安装详情；插件可需要独立连接授权；新会话生效 | 列表突出名称与用途，详情逐步展开来源，安装不等于当前可用 |
| [Claude 插件使用](https://support.claude.com/en/articles/13837440-use-plugins-in-claude) | 插件包含技能、连接器、子代理；Chat 与 Cowork 对 hooks / 子代理支持不同 | 展示已发现的 Skill / MCP 组成及反向来源；其他扩展给盘点边界，不标成通用能力 |
| [Claude Code 插件管理](https://code.claude.com/docs/en/discover-plugins) | Discover、Installed、Marketplaces、Errors 分开；安装前可以查看组成、范围 | 保留读取异常入口；补齐先展示具体新增计划，再按该计划执行。没有元数据不估算上下文 token 成本 |
| [Claude 插件结构](https://code.claude.com/docs/en/plugins-reference) | 支持自定义技能目录和 MCP 配置路径/内联声明 | 解析默认目录与声明路径，保留父插件、禁用状态；仅展示白名单元数据，不执行配置 |
| [Claude 工具访问](https://support.claude.com/en/articles/13730515-manage-claude-s-tool-access) | 会话可采用自动/始终可用/按需方式 | 不把目录发现等同于正文已读，也不替 Hub 各原生客户端模拟统一加载开关 |
| [Codex 本地技能](https://learn.chatgpt.com/docs/build-skills) | 用户目录 .agents/skills，支持目录链接，技能按需读取；禁用配置另行管理 | 整目录共享保留脚本与资料，保留专用适配；技能入口不等于依赖已装、已读正文 |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | skills/list 和 MCP 状态可查询；plugin/list/read/install/uninstall 明示仍在开发，不供生产客户端调用 | 撤除试验版 plugin/list 请求；Codex 会话明确显示插件状态未确认，本地插件仍展示；Claude 保留原生初始化回执 |

## 与现有 Hub 的衔接

- 左侧技能拼图图标沿用现有 rail；与记忆、权限中心互斥，使用既有主题变量。无需联网加载字体或图片。
- 能力库按用途浏览，插件与所带 Skill / MCP 可以双向跳转；低频的磁盘路径收进详情折叠区。
- AI 对比矩阵使用文字和颜色双重标记：共享入口、独立入口、配置禁用、范围有差异、多份正文、待核对安装、未发现、未接入盘点。共享判定包括指向同一真实路径的 Claude 入口。
- MCP 详情可跳到现有账号与权限中心。此跳转不是任意 MCP 的自动登录；该中心仍只管理已支持的账号适配器。
- “补齐共享技能”只增加 .agents/skills 与 .claude/skills 的普通技能入口，复用上一版增量脚本；不从插件缓存提取宿主专用组件，不覆盖已有文件。
- Main 生成一次性计划标识，5 分钟有效；执行前重新比对目录和正文，变化则要求重新预览。操作日志写 Hub 数据目录 capability-sharing。Windows 链接临时占用采用异步有界重试，持续失败明确返回已完成数量与失败项。
- 窄窗口只让对比表自身横向滚动，保留名称列；详情转为纵向排列。搜索保留光标和滚动位置。

## 已知限制

本地登记不计算所有原生配置层的最终覆盖优先级；项目范围仅扫描本 Hub 已打开会话的工作目录，不递归全磁盘。GLM 与 DeepSeek ACP 专用客户端的能力发现尚未接入。账号云端连接器、hooks、LSP、子代理等不是当前目录的完整盘点范围。多版本插件缓存仍只是候选，需要原生客户端核对。不同技能依赖与插件授权不能用补齐数量替代验证。

## 审阅与验证入口

审阅追踪 renderer → IPC → service → 目录 worker / 原生回执 / 共享操作，重点看状态夸大、凭据泄露、过期计划、并发响应和导航互斥。JSON 解析失败只报告文件与格式错误，不带原始敏感片段。

`node --test tests/unit-capability-center.test.js` 覆盖组成与禁用、越界路径、凭据不回显、覆盖判定、计划变化与一次性消费、原生回执身份失效。`node tests/e2e-capability-center-cdp.js` 使用隔离数据/home/CDP 运行真实 Hub，操作类型、搜索、详情、覆盖、补齐、记忆/权限导航、关闭回执及主题切换。模型协议使用夹具，不宣称云端模型验证。

首次 GUI 暴露 Windows 同步 junction 创建 EBUSY；异步创建及有界重试后完成，日志保留重试次数。随后脚本在刷新尚未结束、按钮仍禁用时点击，已改为等待可点击状态。首次单测的 Claude 状态断言沿用旧文案，按明确状态映射修正。所有首次失败产物保留，最终闸门以修订后候选提交为准。
