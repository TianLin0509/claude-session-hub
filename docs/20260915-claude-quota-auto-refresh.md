# Claude 账号余量自动刷新

## 根因

2026-09-15 用户截图中的 Claude 5h/7d 余量来自账号额度，不是会话 context tokens。
原有 `refreshClaudeAccountUsageLive()` 已通过原生连接的 `get_usage` 读取服务器额度，但只接在手动 IPC 上。
`startAgentScanner()` 周期刷新了 Codex、Kimi、DeepSeek，遗漏 Claude；原生 stream-json 不执行 TUI statusline，旧快照因此长期不变。

## 网上实现调研

- [Claude 官方 statusline 文档](https://code.claude.com/docs/en/statusline)：订阅用户收到 API 响应后可取得 `rate_limits.five_hour/seven_day`，字段为 `used_percentage` 和 Unix 秒数 `resets_at`。这是终端状态栏输入，不应假定 Hub 的 stream-json 会执行状态栏脚本。
- [CodexBar 的 Claude 数据源](https://github.com/steipete/CodexBar/blob/main/docs/claude.md)：支持 OAuth `/api/oauth/usage`、CLI 和 Web 来源；凭据权限与账号归属需要处理，失败时保留历史额度。
- [CodexBar 刷新循环](https://github.com/steipete/CodexBar/blob/main/docs/refresh-loop.md)：定时刷新、按活动调整频率、合并同时发生的请求。其自适应策略为 2–30 分钟，并非固定逐秒查询。

本次复用 Hub 已验证的 Claude 原生 `get_usage`，由 CLI 自己管理认证和接口；不另存或续期 OAuth token、不抓网页、不为刷新发模型消息。真实 CLI 验证覆盖自动取得服务器额度，fixture 验证变化、失败恢复与群聊 UI。

## 行为

- 复用 Main 现有 5 秒扫描节拍，工作中的已连接 Claude 每 60 秒读取账号额度，空闲连接每 300 秒读取。
- 新连接、epoch/回合/执行状态变化、窗口重新聚焦以及额度重置时间到达会提前检查；自动查询最短间隔 30 秒。
- 上述数字集中在 `CLAUDE_USAGE_REFRESH_POLICY`，属于刷新频率策略，不是 AI 工作期限，不中断生成。
- 手动和自动刷新共用一个在途请求；失败按 60、120、240、300 秒退避，保留数值与真实观测时间，不把缓存重读伪装成新数据。
- 只查询当前 Hub 已打开且已连接的 Claude writer，普通和群聊成员共用账号余量；没有连接时不唤醒历史会话，只展示/接收共享账号缓存的更新。
- Main 推送账号余量至现有侧栏渲染链。晚到的旧观测不能覆盖新值，恢复成功会清除旧失败标记；缺失或空白字段不能变成 0%。

## 验证入口

```text
node --test tests/unit-claude-usage-refresh.test.js tests/unit-claude-native-usage.test.js tests/unit-sidebar-quota-refresh.test.js tests/unit-account-usage-controller-contract.test.js tests/unit-usage-ipc-contract.test.js
node tests/e2e-claude-usage-auto-cdp.js
node tests/diag-claude-native-usage.js
python scripts/merge_task.py <完整候选 SHA> --dry-run
```

GUI 验证使用独立数据目录和 CDP 端口；不改变刷新周期、不向 renderer 注入额度。真实 CLI 验证不发送模型问题，只在隔离配置中读取额度。
