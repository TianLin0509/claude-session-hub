# 技能与工具

## 需求与页面

在左侧功能栏的记忆入口之后增加拼图图标「技能」。页面不依赖打开会话，提供能力目录与当前加载两个视图。

- 目录：Skill / MCP / 插件总览、AI 筛选、名称或描述搜索、公共技能 / 同名差异 / 禁用与待核对筛选、来源详情。
- 当前加载：选择已经打开的会话，查询该原生连接。没有会话或没有确认接口时明确未知，不新建进程，不恢复历史，不发送 prompt。
- 支持记忆页与技能页互斥、Escape 返回、宽窄窗口和主题变量。目录输入不执行，全部转义后渲染。

## 证据契约

1. `capability-catalog.js` worker 仅读已知用户目录和本 Hub 已打开会话的工作目录。目录登记不是加载成功。`sources` 保留 provider、scope、实际路径、开关和正文哈希；哈希不同仅提示差异，不断言版本过期。
2. 公共层为 `.agents/skills`，Codex / Kimi Code / Gemini / DeepSeek Codex runtime 按已知加载规则列为可发现。Claude 通过逐技能链接接入自己的目录。Qwen 仅盘点其自身目录；GLM / DeepSeek ACP 的专用 Harness 缺少已验证的通用发现根，保持未知。
3. JSON 配置只输出白名单元数据。TOML 是表名与 `enabled` 的窄投影，不执行启动命令，不输出 env、headers、token 或认证文件。未声明的内联 TOML 配置可能不被此静态投影识别；原生查询为更强证据。
4. Codex 使用当前实例的 `skills/list`、`mcpServerStatus/list`、`plugin/list`。接口以本机 Codex 0.153.4 生成的 JSON schema 核对。插件查询限定 local，不强制远程刷新；仅展示 `installed` 插件。技能已发现、插件配置启用、MCP runtimeStatus 分开表述。缺失 runtimeStatus 不从工具数量推断连接成功。
5. Claude 保存原生 `system/init` 报告的 tools、slash_commands、skills、plugins、mcp_servers，以及当前 sessionId / epoch / 接收时间。只有同一连接代次和身份可用于页面。命令不能当作技能。
6. 原生查询前后核对连接对象 / 身份 / epoch。部分查询失败保留成功类别并展示失败；断开、切换或关闭丢弃旧结果。IPC 不把异常变成空成功。
7. 目录 30 秒缓存、并发合并、15 秒扫描上限。仅页内显式刷新重新读取，不后台全盘扫描。UI 用请求序号丢弃旧 tab / session 的响应。

## 普通技能补齐

`node scripts/share-agent-skills.js` 生成计划；`--apply --out <manifest.json>` 执行新增 junction。

仅汇总 `.agents/skills`、`.claude/skills`、`.codex/skills` 的普通技能，排除点目录（系统、归档）和插件缓存。已有入口不覆盖。整个技能目录链接，脚本和 references 一起保留。Cat Café 宿主技能不推广至所有客户端。专属 MCP / 宿主 API 不因链接而自动安装。

本次用户已授权尽可能补齐 skill；本机执行新增 71 个链接，公共目录与 Claude 目录各 47 项，再次计划为 0 项。记录在工作树 `artifacts/capability-center/skill-sharing-applied.json`。同名既有变体保留。若需撤回，只可校验后删除清单内本次创建的 junction 本身，不递归删除目标目录。

## 验证

- `node --test tests/unit-capability-center.test.js`：目录、凭据边界、缓存、同名差异、原生状态、身份失效、错误传播、链接幂等性。
- `node tests/e2e-capability-center-cdp.js`：真实隔离 Hub / IPC / 原生协议子进程；真实鼠标键盘搜索、过滤、详情、会话查询、导航、窄窗口、刷新和 Escape，附截图。协议夹具不等于云端模型任务质量。
- `node scripts/run_unit_tests.js --strict`：仓库完整闸门。Windows 测试需 Git 的 `sh.exe` 在当前进程 PATH。不要修改系统 PATH，也不要更改生产实例。

## 边界

本页只读，不提供一键删除、启用 MCP、变更插件开关或自动合并同名技能。内置平台工具、未在本机配置登记的账户连接器，以及其它 Hub 未打开的项目不宣称完整发现。Codex 多版本缓存不能代替精确安装回执；需要通过原生查询核实。
