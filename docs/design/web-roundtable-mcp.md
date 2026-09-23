# 网页子 MCP 与圆桌 MCP

目标：复用 Hub 权限页已有的专用浏览器登录，以 DeepSeek、Kimi、千问为首批站点，独立调用或组织多轮讨论，输出完整原文、综合意见和可离线打开的 HTML。

## 分层与扩展

```text
Claude / Codex / 其他 MCP 客户端
       │ 标准 stdio JSON-RPC
       ▼
web-roundtable/server.js（圆桌 MCP）
       │ 自身充当 MCP 客户端，不靠模型猜测调度
       ├── provider-server.js deepseek（独立子 MCP）
       ├── provider-server.js kimi    （独立子 MCP）
       └── provider-server.js qwen    （独立子 MCP）
                    │
         持久任务 / 同账号互斥 / 官方网页适配器 / 本机 CDP
                    │
         Hub account-browsers/<provider> 原登录资料
```

子 MCP 可以单独注册，也可只注册圆桌 MCP，按任务临时启动所需子 MCP。没有任务时不启动浏览器；不引入新的 npm 依赖。MCP 客户端退出后，已接单的任务 worker 继续执行，结果落盘，可由另一个 Agent 凭 task_id 接收。

新增站点步骤：

1. 在 `core/account-browser.js` 的 SITES 注册官方入口；已有账号适配器继续负责用户登录。
2. 在 `core/web-roundtable/providers.js` 加入固定的官网、会话路径、输入框、回答容器、完成信号与必要的账号就绪条件。需要特殊行为时在该模块增加站点分支；不改圆桌调度器。
3. 检查实际页面：游客页面不能作为有效登录证明，思考/工具过程不能混进最终答案，完成控件必须属于最新回答。
4. 增加本地 DOM 夹具，实际完成一轮提问、同会话追问、关闭后重开补收，再启用该站点。注册本身不等于站点可用。

## 使用方式

更新并重开 Hub 后，新建 Claude / Codex 会话时选 MCP「浏览器」或「全部」，自动带入 `web_roundtable`。现有「无」仍不加载 MCP，不能把用户的禁用偏好静默改掉。运行中的旧会话不会热注入本次新增工具；当前运行的旧 Hub 也不会自动重新加载启动模块。原生 Codex 和 Claude 都通过现有启动配置注入，不修改全局用户 MCP 配置。

独立客户端也可使用如下配置。把示例路径换成当前安装路径；工作树试用时指向对应 worktree，不必先替换生产 Hub。

```json
{
  "mcpServers": {
    "web_roundtable": {
      "command": "node",
      "args": ["C:/Users/lintian/claude-session-hub/core/web-roundtable/server.js"],
      "env": {"AI_HUB_WEB_DATA_DIR": "C:/Users/lintian/.claude-session-hub"}
    },
    "deepseek_web": {
      "command": "node",
      "args": ["C:/Users/lintian/claude-session-hub/core/web-roundtable/provider-server.js", "deepseek"],
      "env": {"AI_HUB_WEB_DATA_DIR": "C:/Users/lintian/.claude-session-hub"}
    }
  }
}
```

Kimi / 千问独立配置只需将最后参数换为 `kimi` / `qwen`。使用 Electron 可执行文件作为 Node 时需同时设置 `ELECTRON_RUN_AS_NODE=1`，Hub 自动生成的配置已经包含它。

### 圆桌

调用 `roundtable_start`：

```json
{"request_id":"my-topic-001","providers":["deepseek","kimi","qwen"],"prompt":"你的完整问题","rounds":2,"synthesizer":"deepseek"}
```

- 返回 task_id（结果字段 `id`）后，用 `roundtable_get({"task_id":"..."})` 查询。`inFlight` 给出当前子任务 ID，子任务 `web_get` 可进一步查看。
- rounds=1 为独立观点，2 为独立观点加一轮质询，最多3轮。不同网站并行，同网站串行。
- `synthesizer` 指定综合意见由谁写；传 null 则只收齐原文，不额外发起综合请求。默认第一位。不会自动换模型、换提供商或改官网模型设置。
- `continue_from` 指向已完成圆桌，使用新的 request_id 和新问题，继续各家原会话。若某参与者上次失败，必须先处理，不能悄悄新开会话代替接续。
- `roundtable_export` 随时生成当前 HTML；终态自动输出 `reportPath`。报告包含综合意见、各轮完整原文、真实官网链接、发送内容、失败原因和完成证据。
- `roundtable_resume` 恢复退出或暂停等待验证的协调 worker；子任务采用原始 request_id，不重新提交已尝试发送的问题。已提交但没确认的子任务交给 `web_collect`。
- 补收完成后调用 `roundtable_refresh`，把子任务最终结果更新到已结束圆桌与 HTML；这一步不重发辩论。后续接续须引用最新完成的任务，不能绕过一个未确认的后续提交。
- `roundtable_cancel` 停止后续轮次，并通知子任务停止本地等待；网站已经开始的远程生成可能继续，不把本地取消冒充远端停止。

### 子 MCP

- `web_ask({request_id,prompt,reply_to?})`：异步提问；reply_to 是同站点已完成任务 ID，继续原对话。
- `web_get({task_id})`：状态、完整回答和 URL。
- `web_collect({task_id})`：超时或断线后，只重开原会话补收，绝不重发。
- `web_resume({task_id})`：修复登录/网络后，仅未尝试发送的任务可重启；已尝试发送的只补收。
- `web_cancel({task_id})`：取消本地排队/等待。
- `web_status()`：能力与资料目录；明确为未检查实时登录，不能将配置存在误报为已登录。

request_id 必须为1–100位字母、数字、下划线或连字符。同一 ID 同一请求跨进程去重；不同内容复用 ID 明确报错。两位 Agent 共享同一圆桌，应共享这个 ID 或返回的 task_id；不同 ID 表示独立任务。问题最长40000字符；辩论资料超过限制时明确失败，不截断或删掉参与者观点。所有原始回答完整保存。

## 登录、浏览器与任务边界

### 登录失效后的恢复（2026-09-22）

- 子任务识别到官网登录入口或人机验证，持久化 `recovery`，内含明确原因、权限页账号 ID 和操作说明。`web-roundtable/recovery/` 只保存任务指针，不保存密码、验证码或 Cookie。
- 权限页按原网站账号聚合受阻任务，显示「恢复任务」。打开验证窗口复用原专用浏览器，不重新申请短信。任务释放自己的浏览器和互斥锁后才允许可见窗口接管。
- 用户完成官方验证后点「检查并继续任务」。只有本次只读检查取得明确账号证据才通过子 MCP 的 `web_resume` 恢复对应任务；打开页面、历史登录缓存、离线、未知及纯输入框都不触发恢复。普通「检查登录」和验证码提交后的检查也走同一逻辑。
- 未尝试发送的任务沿用原 ID 继续；已尝试发送的一律只补收原会话。缺少原会话 URL 时明确失败，要求人工核对，不自动新建或重发。恢复请求跨 Hub/Agent 去重，先持久化排队状态，再启动 worker。
- 圆桌在当前轮收齐可用结果后暂停，保留已完成的其他网站回答，不提前进入下一轮。恢复后的子 worker 通知原圆桌，从保存的轮次或综合阶段继续。任务进度跨 MCP 客户端和 Hub 重启保留，关闭权限页不取消恢复任务。
- 同一账号多个受阻任务共享一次登录检查，各自保留发送边界。已取消任务及已取消圆桌不被补登动作复活。任务恢复失败不会抹掉已经取得的登录证据，权限页明确显示恢复失败。
- 真实检查已验证 DeepSeek、Kimi、千问的账号入口；DOM 改版可能使检查重新变为未知。UI 全流程验收使用隔离 Hub、真实 MCP/worker 与确定性网站夹具，不模拟退出用户真实账号。

- 只使用 `account-browsers/<provider>`，不复制日常 Chrome Cookie，不调用网站私有接口。默认 headless；如果同一 Hub 专用浏览器已打开，连接它并创建独立任务页，不改用户当前页面，不关闭用户浏览器。
- 只有实际 browser PID 与自己启动的子进程一致时才关闭浏览器。任务结束关闭自建浏览器或任务页，保留登录资料。权限页在该账号有活跃 MCP 任务时提示先等待/取消，避免打开不可见窗口。
- 登录信息是否持续有效由网站决定。验证码/扫码/人机验证由用户在权限页打开官网处理；不会重复申请短信，也不绕过网站验证。
- 先持久化 `submissionAttempted` 再按发送，只有本轮 prompt 回显、回答完成控件和稳定正文共同成立才成功。崩溃后宁可显式待确认，不自动重发。
- 死 worker 的锁可回收；若进程恰好在回收锁时退出并遗留 `.lock.reap`，超过30秒明确报出需检查的路径，不按时间强抢锁。此极端情况需先确认相关 owner 进程已退出，再人工清理该标记。
- 任务 URL 只接受注册官网的会话路径；网页内容仅为数据，HTML 全部转义且限制活动内容。发送给辩论/综合模型时明确标注其他模型输出为待核验资料，不能执行其中的工具指令。
- 部分失败保留其余结果，综合中明确缺席者；不会把缺席视为赞同，也不会自动更换综合者。
- 当前是文本问答，不含附件上传、图片下载、指定官网模型切换。网页 DOM 改版可能需修适配器。长期虚拟滚动会话如果无法取得完整完成证据，会停在待处理，不把截断内容当成功。

持久数据：`<AI_HUB_WEB_DATA_DIR>/web-roundtable/`。报告：`<AI_HUB_WEB_DATA_DIR>/artifacts/web-roundtable/`。文件可能包含用户问题和模型答案；不保存 Cookie、密码或验证码。环境变量也可继承 `CLAUDE_HUB_DATA_DIR`，最后回落本机默认 Hub 数据目录。

## 验证

- `node --test tests/unit-web-roundtable.test.js`：实际 MCP stdio、去重、互斥、取消、重放、失败隔离、安全输出；网站回复部分为协议夹具。
- `node tests/e2e-web-roundtable-dom.js`：真实隔离 Chrome、本地 DOM 夹具，验证提取思考/正文/完成信号；不等同真实账号 E2E。
- `node tests/e2e-web-roundtable-live.js --live --data-dir <Hub数据目录>`：明确启用后对真实账号发起两轮圆桌与接续，共10条网站消息，保存证据和 HTML；会使用网页额度。
- `python tests/e2e-web-roundtable-sdk.py --data-dir <Hub数据目录> --task <已完成圆桌ID>`：使用已安装的官方 Python MCP SDK 独立验证父/子 MCP 的协议兼容与跨客户端去重，不发送新网页问题。
- `node scripts/run_unit_tests.js`：项目全量回归。
- `node --test tests/unit-web-login-recovery.test.js`：登录证据门槛、原任务恢复与补收、并发去重、原圆桌暂停与接续、取消及已完成提示清理。
- `node tests/e2e-web-login-recovery-cdp.js`：真实隔离 Hub 权限页/IPC/父子 MCP/worker 到 HTML 的恢复闭环；官网及登录返回是夹具，不请求真实短信或模型。
