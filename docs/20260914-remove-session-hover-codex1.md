# 删除侧栏会话悬停摘要卡

需求：移除鼠标经过左侧 session 时弹出、遮挡正文的摘要卡。基线为 `de695c30db7222e21771b7e07a58c4c8e4d37b36`。

## 改动

- 删除 `renderer/session-hover-card.js`、列表中的挂载与刷新调用，以及全部专属 CSS；鼠标悬停和键盘聚焦均不会创建摘要卡。
- 普通会话、群聊及成员行不再设置整行/标题的原生 tooltip；状态、上下文和未读信息保留在无障碍标签中。
- 会话选择、右键菜单、群聊成员展开和独立控件的帮助提示沿用原行为。
- 更新两套既有 CDP 用例的悬停预期；移除已删除组件的单测，补齐五个旧 DOM mock 的属性接口，并将原 tooltip 信息断言改为无障碍标签断言。

## 验证

- 改生产代码前，`node tests/e2e-session-details-cdp.js` 在新增的群聊悬停断言失败，实际摘要卡仍存在，完成隔离复现。
- 修改后同一命令通过：9 项侧栏/群聊检查，包括普通会话、群聊和成员无悬停卡、无整行/标题 tooltip、点击导航、持续 transcript 更新及重启后的持久化。
- `node tests/e2e-ui-polish-ab-cdp.js`：30 项通过；真实隔离 Hub、CDP 鼠标/焦点交互、两个主题、普通会话和群聊。Codex 回复来自仓库协议 fixture，不代表真实供应商调用。
- `node scripts/run_unit_tests.js`，`HUB_UNIT_JOBS=4`：最终 502/502 文件通过，执行 202.2 秒。初轮 5 个文件失败，定位为旧 DOM mock 缺少 `setAttribute`；补齐后另有两处旧 tooltip 断言需同步到无障碍标签，修正后聚焦和完整入口均通过。没有跳过或放宽闸门。
- `node --check` 检查列表模块和两个修改的 CDP 脚本；`git diff --check` 通过。
- 已人工查看深色、浅色悬停截图，正文无摘要卡遮挡。

证据位于本工作树 `artifacts/remove-session-hover-*.log`、`artifacts/session-details/1789371846898-53132-evidence.json` 和 `artifacts/ui-polish/gui/result.json`。截图为 `artifacts/ui-polish/gui/dark-no-hover-card.png`、`codex-no-hover-card.png`。

本候选未修改生产窗口、数据及版本号；合入主干时由项目入口统一升版本。
