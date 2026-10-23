# DeepSeek DSH CLI / PTY

2026-10-23：DeepSeek 默认运行官方 DSH CLI，加载社区 TUI；Hub 经 node-pty 发送键盘输入、呈现原生终端。不得使用 ACP 或 Martty 的 ACP 包装替代本路径。保留 `deepseek-acp` 等持久化字段仅为旧会话兼容，不代表执行协议。

启动中心保留 Token Plan / API 两个消费通道。默认卡片展示原生事件投影，后台展示真正 TUI。观察扩展只记录原生事件，不代执行工具、不代答用户选择。普通实现问题沿用自主执行提示；真正需要本人决定的事项仍可在后台 TUI 回答。

## 独立运行环境

经用户授权后，在独立真实目录安装（禁止在 Hub 及共享 node_modules 的 worktree 安装）：

```powershell
npm install --prefix D:/AIWork/20261023-dsh-tui-runtime-codex --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.2 @deepseek-harness-tui/dsh-tui@0.16.1
node scripts/register-dsh-cli.js D:/AIWork/20261023-dsh-tui-runtime-codex
```

登记文件为用户目录 `.dsh/hub-cli-runtime.json`，不修改 Hub 生产 config/state。设置页的 CLI 运行环境目录可覆盖登记；测试可用 `AI_HUB_DSH_CLI_ROOT`。升级两个依赖前需重验，旧 `@dsh-tui/dsh-tui@0.1.2` 与旧 DSH 组合不兼容，不使用。

## 防回归

- 启动必须收到官方 CLI 启动完成、当前进程前台 session discovery、已绘制输入框三项证据，再允许首次发送。
- 固定 `DSH_TUI_NO_LAUNCHPAD=1` 直达原生多行聊天框；启动页本身是单行编辑器，会折叠换行。真实测试对首条消息和长消息逐字核验，并要求收到 native user/message 对应的 submission id。
- 输入走分块粘贴、settle、独立回车；原生 user/message 才确认接收。超时报告未知，不自动重发。
- 仅原生 turn/end 确认完成、中断或失败；终端安静或普通 idle 状态不能确认完成。
- /fork 的 detached root 不改变 Hub 当前绑定；/new 和 /resume 按原生前台 discovery 切换。
- 旧 ACP 生成的 DSH 原生历史原位迁移到隔离会话 home，恢复相同 native id；一个会话只能有一个 writer。
- 两通道真实启动、长消息一次接收、停止后继续、重启历史、分支、MCP、模型与 effort 均需保留验证。

自动单测：`node --test tests/unit-dsh-cli.test.js`。
隔离界面：`node tests/e2e-dsh-cli-cdp.js`（`HUB_DSH_ROUTE=api` 验证 API）；`node tests/e2e-dsh-cli-regression-cdp.js deepseek-acp --long --interrupt --fork`。
