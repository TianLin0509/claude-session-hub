# 公司版「助理」页（2026-10-16）

田哥选定设计 B（简报 + 对话），提醒 6 条全做。设计稿：`D:\AI-Artifacts\20261016-助理页优化版-claude1.html`。

## 边界（田哥 10-16 定）

- 只读：Hub 和助理会话只调 welink-cli 的查询类子命令，白名单在 `core/company-assistant/welink.js`（`READ_ONLY`）。
  扫码登录（`auth login`）和日历初始化（`mail autodiscover`）只在用户点按钮时放行（`SETUP`）。
- 发消息、回邮件、建会议、建日程不做，也不写进说明；要发的内容助理写成草稿，本人去发。
- 数据只留在公司电脑：`<Hub 数据目录>/company-assistant/`，不经家里通道；助理会话不挂「问家里」和 Hub 自己的 MCP。
- 只在公司版启用：`target=company` 且 `features.companyAssistant` 没关（`gate.js`）；隔离测试用 `CLAUDE_HUB_COMPANY_ASSISTANT=1`。

## 结构

| 文件 | 作用 |
| --- | --- |
| `core/company-assistant/welink.js` | 白名单、找 welink-cli、执行（参数数组，不经 shell）、JSON 容错、登录/日历状态、二维码识别 |
| `core/company-assistant/welink-ro.js` | 助理会话用的只读包装（工作目录里的 `welink-ro.cmd` 调它） |
| `core/company-assistant/data.js` | 回执 → 统一结构，每条编出处编号 `sourceId` |
| `core/company-assistant/brief.js` | 清单简报、给 CodeAgent 的整理请求、核对出处、首屏 10 条、处理过的不再出现、承诺清单 |
| `core/company-assistant/reminders.js` | 6 条提醒何时该发、每小时限额 |
| `core/company-assistant/service.js` | 定时取数、简报、对话队列、提醒发布、扫码登录、日历初始化 |
| `main/ipc/company-assistant-handlers.js` | 页面用的 IPC（`company-assistant:*`） |
| `renderer/company-assistant-page.js` | 页面；左侧按钮插在「规则」下面 |

## 简报流程

1. 工作日到简报时间（默认 08:20），或打开页面时当天还没有：先取数（`auth status` → 会议 → 日程 → 最近会话 → 关注的群和最近 12 个单聊的历史 → 未读邮件），任何一步失败都记下原因、继续往下。
2. 立刻出一份按规则排的清单（不耗额度）。
3. 把原始数据（每条带出处编号）发给固定的助理会话，要求只输出 JSON；回答里出处对不上原始数据的条目删掉并注明条数。
4. 发一条「今日简报」提醒。AI 没答上（12 分钟）或答案读不出来：保留清单版并注明原因。

## 提醒

会前准备（默认会前 15 分钟）、会议排太满（重叠或连续 3 小时）、答应的事（前一天 17:00 后、当天 09:00 后）、等你回复太久（默认 4 小时，09–20 点）、关注词（只看启用后的新消息）、下班前小结（默认 18:00）。
同一件事只提醒一次（id 固定，存在 `state.json`）；每小时最多 3 条，超出的下一分钟重新算、顺延发出。提醒经 `notice-bus.js` 发布，主进程转成桌面通知（点开回到助理页）。

## 待公司真机核对

- `auth login` 输出的二维码形式（图片路径 / data URI / 网址 / 终端字符画都做了显示）。
- `mail autodiscover` 后 `calendar list` 是否能出数据；日程回执字段。
- `im query-history-message`、`mail list` 回执字段（按常见写法多认了几种）；`mail list` 不带日期参数是否可用。
- 各命令不带 `--format json` 时是否输出 JSON（取不到 JSON 会自动加 `--format json` 再试一次）。
