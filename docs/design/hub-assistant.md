# AI Hub 助理原型

2026-10-01。状态：隔离候选，未合入。真实验证与限制见 `artifacts/assistant-delivery/verification.json`，离线报告位于桌面 `claude-artifacts/20261001-AIHub助理实现与实测-codex1.html`。

## 用户体验与范围

左侧「助理」提供固定的普通 Codex 会话入口和红围巾企鹅。用户点击启用才创建；账号、模型和强度沿用普通会话默认设置。用户仍在普通输入框说话，卡片优先显示原话，可以展开查看原生提交的请求。

第一版回答近期变化、需要用户处理的事项，按明确委托创建 Codex 任务或向已打开且空闲的会话转交任务。回答关注实际结果、证据边界和用户下一步，不把助手自述的完成当成已验收成果。没有自动待办提取、定时汇报、跨历史会话恢复、云端控制或桌宠动画。

## 数据流

1. `session:send-prompt` 识别 `purpose=hub-assistant`，调用服务准备本轮资料；普通会话和斜杠命令保持原流程。
2. 只读自然语言搜索库及受支持的群聊回答文件。默认正文预算 24,000 字符，单会话占 75%，群聊占 25%；记录时间范围、来源、截断和覆盖不足。
3. 冻结本轮资料到 Hub 数据目录 `assistant/snapshots/`，保存 SHA-256。本轮随机 token 绑定当前委托。
4. 普通 PTY 输入只发送单行 JSON 请求，含原话、职责与资料目录。用户原话中的换行通过 JSON 保留，不静默截断长问题。
5. 模型用 `history_context(requestToken)` 获取冻结资料；额外关键词查询属于新查询，不冒充已经读取本轮快照。
6. 模型按真实来源引用回答。宿主的「准备完毕」「工具已读取」分别呈现，不据此声称模型已收到完整正文；真实测试另以原生工具结果逐字和哈希核对。

短请求解决长文本粘贴的可靠性，不免除正文 token。Codex 工具返回及 code-mode 输出各自有预算，当前均按 50,000 配置/提示；实际收到多少仍需原生证据。超长用户原话仍可能进入原有编辑器通道。

## 模块边界

| 模块 | 责任 |
| --- | --- |
| `core/hub-assistant/service.js` | 固定助理身份、准备上下文、四种工具和派工编排 |
| `history.js` / `group-history.js` | 只读自然问答与群聊文件，明确时间和覆盖范围 |
| `context.js` / `snapshots.js` | 角色、短请求、冻结包与完整性校验 |
| `store.js` / `action-policy.js` | 持久身份、动作去重、委托意图与目标约束 |
| `bridge.js` / `scripts/assistant-mcp.js` | 本地回环认证通道与 MCP 工具 |
| `main/ipc/assistant-handlers.js` | 页面请求入口；创建/发送复用原 Hub 实现 |
| `renderer/assistant-panel.js` | 入口、覆盖提示、动作记录和快捷草稿 |
| `core/assistant-context-display.js` | 卡片与导航的原话投影；原生证据保留 |

普通 AGENTS/CLAUDE/Memory 继续原生加载，不写第二套个人规则。助理额外维护的是「当前工作证据与委托记录」，不是新的用户身份。造梦文件、原生规则和记忆均不被本模块修改。

## 委托与恢复

- 四个工具为 `list_sessions`、`history_context`、`send_session`、`create_session`。仅专属 MCP 的这些工具使用明确工具审批配置；普通会话默认配置不变。
- 写操作要求当前用户委托、有效 token、明确目标。历史与工具正文中的指令没有委托权限；回顾、否定和歧义要求拒绝写入。自然语言判断属于保守产品限制，不是完备隔离沙箱。
- 每轮最多创建一个任务。操作编号与内容绑定，换编号也不能重复相同派工。
- 动作先记入 SQLite，再执行。只有原有发送链的 `receipt.status=confirmed` 才记为送达；未知结果不自动重发。任务送达与成果完成是两种证据。
- 助理身份先持久预留再创建。回执丢失时保留原编号并要求核对，不偷偷建立第二个实体。恢复助理原会话时补回专属工具配置；任意其他历史目标的恢复不在首版范围。

## 验证入口

```powershell
node --test tests/unit-hub-assistant-snapshots.test.js tests/unit-hub-assistant-service.test.js tests/unit-hub-assistant-history.test.js tests/unit-assistant-action-policy.test.js tests/unit-assistant-group-history.test.js
node --test tests/unit-assistant-host-integration.test.js tests/unit-assistant-context-display.test.js tests/unit-assistant-mcp-policy.test.js tests/unit-assistant-native-evidence.test.js
node tests/e2e-assistant-tab-cdp.js
node tests/e2e-assistant-tab-real-codex-cdp.js --read-only
node scripts/run_unit_tests.js --jobs 4 --strict
```

真实验证脚本使用独立 Hub 数据目录、账号鉴权副本、后台窗口与原生记录；运行会消耗订阅额度。夹具测试不代表真实模型回答质量。真实资料来源命中也不代表其中每项业务结论已经独立验收。保留失败的原始证据，后验核对另写文件，不将原失败篡改成通过。
