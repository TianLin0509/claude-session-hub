# AI Hub 助理：A 方案与工作档案

2026-10-01。用户已选择 A，并授权真实隔离测试、独立审核通过后合入。实际候选/合并状态以交付报告和提交记录为准。真实业务证据在 `artifacts/assistant-business-live/`，机制研究在 `artifacts/context-deep-research/`。

## 用户体验与范围

左侧「助理」直接选择固定普通 Codex 实体，复用主会话的卡片、输入框、语音、附件、模型与强度控件，以及后台终端切换。没有第二个聊天页面或输入框，首次点击只连接原会话，不发送模型请求。白色风格和红围巾企鹅仅改变外观；普通会话保持原样。旧助理独立输入框的草稿迁入普通会话草稿，派工不抢走正在看的助理会话。

回答近期变化、需要用户处理的事项；明确委托可创建任务或向唯一匹配的原会话转交任务。关闭的 Codex/Claude 原目标可按持久身份走共享恢复入口，身份/账号/独占校验失败不创建替身。提醒由 Hub 持久关注原生新最终回复，原文与来源显示在普通工具栏的折叠入口；不自动执行后续任务。没有自动语义摘要/待办提取、云端控制或桌宠动画。

## 数据流

1. `session:send-prompt` 同时核对持久助理编号、实际会话编号与 `purpose=hub-assistant`，调用服务准备本轮资料；普通会话和斜杠命令保持原流程。
2. 当前已打开会话逐个纳入完整清单，不受全局 24,000 字符预算限制。精确读取绑定原生最终回复；历史检索与群聊文件是补充，单独标时间和覆盖。不能因为某会话已有新最终回复，就删除其时间窗口内的历史材料。
3. 冻结本轮资料到 Hub 数据目录 `assistant/snapshots/`，保存 SHA-256。本轮随机 token 绑定当前委托。
4. 普通 PTY 输入只发送单行 JSON 请求，含原话、职责与资料目录。用户原话中的换行通过 JSON 保留，不静默截断长问题。
5. 模型用 `history_context(requestToken)` 获取完整当前目录与差量正文。每项最新答复的较长正文先给约 1,800 字符预览并显式标记节选，全文保存在版本 Markdown，也能用 `session_evidence(sessionId)` 读取。这个长度限制不移除会话身份或原文入口。额外关键词查询属于新查询。
6. 模型按真实来源引用回答。宿主的「准备完毕」「工具已读取」分别呈现，不据此声称模型已收到完整正文；真实测试另以原生工具结果逐字和哈希核对。

短请求解决长文本粘贴的可靠性，不免除正文 token。Codex 工具返回及 code-mode 输出各自有预算，当前均按 50,000 配置/提示；实际收到多少仍需原生证据。超长用户原话仍可能进入原有编辑器通道。

## 模块边界

| 模块 | 责任 |
| --- | --- |
| `core/hub-assistant/service.js` | 固定助理身份、准备上下文、六种工具和派工编排 |
| `history.js` / `group-history.js` | 只读自然问答与群聊文件，明确时间和覆盖范围 |
| `context.js` / `snapshots.js` | 角色、短请求、冻结包与完整性校验 |
| `dossier.js` | 完整目录、差量基线、版本化 Markdown 工作档案 |
| `live-history.js` / `watches.js` | 精确原生最终答复、持久游标与通知去重 |
| `permissions.js` / `store.js` / `action-policy.js` | 固定助理权限、持久身份、动作去重、旧内部入口保守兼容 |
| `bridge.js` / `scripts/assistant-mcp.js` | 本地回环认证通道与 MCP 工具 |
| `main/ipc/assistant-handlers.js` | 页面请求入口；创建/发送复用原 Hub 实现 |
| `renderer/assistant-panel.js` | 固定会话导航、外观标记与折叠提醒入口；不拥有聊天、输入或终端实现 |
| `core/assistant-context-display.js` | 卡片与导航的原话投影；原生证据保留 |

普通 AGENTS/CLAUDE/Memory 继续原生加载，不写第二套个人规则。助理额外维护的是「当前工作证据与委托记录」，不是新的用户身份。造梦文件、原生规则和记忆均不被本模块修改。

## Markdown 与增量的证据边界

`assistant/workbench/CURRENT.md` 列出当前已打开会话；`ALL-SESSIONS.md` 是完整已知目录；`sessions/<id哈希>/<版本>.md` 保存当时完整最终答复。状态仍由真实运行时和原生记录决定，模型不能通过改 Markdown 就把任务变成完成。原生记录暂缺时保留最后档案，并明确标“最新未核实”。

每轮均有完整当前目录；原生正文仅变化时附入。差量以本进程上次工具返回的版本为基线，不声称模型仍记得。重启或原生助理身份变化后重建检查点。自动识别原生压缩事件并重送语义摘要尚未实现；压缩后仍有当前目录与可追读全文。长期个人规则和用户记忆继续原生加载，工作档案不冒充个人记忆。

当前全表覆盖“已打开会话”，不等于自动整理所有关闭的未完成业务。关闭会话可以通过全目录定位；目标关闭或归属其他 Hub 时暂停实时关注，保留游标，在本 Hub 恢复后续接。只持有助理实体的 Hub 执行后台监视与档案刷新。

## 委托与恢复

- 六个工具为 `list_sessions`、`history_context`、`session_evidence`、`watch_session`、`send_session`、`create_session`。仅专属 MCP 的这些工具使用明确工具审批配置；普通会话默认配置不变。
- 用户已授权固定助理使用 Hub 会话管理工具。MCP 调用方编号由宿主环境进入 HTTP 头，不取模型参数；它必须与持久助理编号及本轮宿主请求编号一致。缺失或错误身份、过期或错误 token 拒绝操作，普通会话不能因同名或 `purpose` 标记取得权限。
- 可信助理的创建、派工和关注不再依靠本地关键词或词距正则。用户的本轮意图、只读提问、否定、资料中的旧指令和目标歧义由助理模型判断，提示词要求按当前委托行动。历史与工具正文只是证据。应用层固定身份校验不等于同一 Windows 账号下的系统安全沙箱；Codex 的系统权限和普通会话默认权限不变。旧的无调用方内部兼容路径仍执行保守语言规则，网络调用不能进入该路径。
- 每轮最多创建一个任务。操作编号与内容绑定，换编号也不能重复相同派工。
- 动作先记入 SQLite，再执行。只有原有发送链的 `receipt.status=confirmed` 才记为送达；晚到回执只能更新相同提交编号及目标。未知结果不自动重发。任务送达与成果完成是两种证据。
- 派工确认后助理先回复已交办、目标与关注状态并结束本轮；业务结果随后通过 Hub 通知，追问时再读最新证据。派工正文只包含业务要求，提醒责任留在 Hub。未确认回执只报告待核对。
- 助理身份先持久预留再创建。回执丢失时保留原编号并要求核对，不偷偷建立第二个实体。恢复助理原会话时校验持久编号并刷新专属 MCP 身份配置。业务简称由助理根据真实目录定位准确编号，多个候选则请用户明确。忙碌、独占、原生身份和送达校验继续由 Hub 强制执行。
- 用户明确请求新回复提醒时，先保存目标基线再派发；只对基线之后的原生最终正文通知，工具输出、部分答复或单独完成事件均不作为通知正文。通知以会话和原生轮次去重；重启保留已读状态和游标。
- 即时原文适配目前为 Codex/Claude；其余提供方仍列入目录，使用历史索引，即时原文不足如实标未知。Codex 有真实模型验证，Claude 为原生结构夹具验证。跨提供方更换助理后端属于后续能力，Markdown 产物本身可携带。

## 验证入口

```powershell
node --test tests/unit-hub-assistant-snapshots.test.js tests/unit-hub-assistant-service.test.js tests/unit-hub-assistant-history.test.js tests/unit-assistant-action-policy.test.js tests/unit-assistant-group-history.test.js
node --test tests/unit-assistant-host-integration.test.js tests/unit-assistant-context-display.test.js tests/unit-assistant-mcp-policy.test.js tests/unit-assistant-native-evidence.test.js
node tests/e2e-assistant-tab-cdp.js
node tests/e2e-assistant-business-live.js
node tests/e2e-assistant-business-live.js --manager-permissions
node --test tests/unit-assistant-manager-permissions.test.js
node --test tests/unit-assistant-dossier.test.js tests/unit-hub-assistant-live-watch.test.js
node scripts/run_unit_tests.js --jobs 4 --strict
```

真实验证脚本使用独立 Hub 数据目录、账号鉴权副本、后台窗口与原生记录；运行会消耗订阅额度。夹具测试不代表真实模型回答质量。真实资料来源命中也不代表其中每项业务结论已经独立验收。保留失败的原始证据，后验核对另写文件，不将原失败篡改成通过。
