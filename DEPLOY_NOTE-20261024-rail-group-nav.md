# 2026-10-24 · 左侧栏收成两组入口（悬停向右展开）

## 改了什么

左侧栏 12 个入口收成 6 个，两组各用一个入口 + 悬停展开：

| 入口 | 悬停展开（从左到右） |
| --- | --- |
| **规则**（第 2 行） | 规则 · 资源 · 账号 · 回顾 |
| **助理** | 不变，独立一行 |
| **投研**（第 4 行） | 投研 · 学习 · 写作 · 无线 |
| 主页 / 开发 / 云端 | 不变，仍是一级入口 |

- 悬停（或键盘 Tab 到入口、按 →）时，从 rail 右缘**水平滑出一条 dock**：
  4 格 × 54px，图标在上、短标签在下，和 rail 上的入口同构；点谁进谁，dock 随即收起。
- 组内有当前页时，入口给同款底色，并在图标右下角点一个小圆点；
  tooltip / aria-label 写成「规则 · 资源、账号、回顾；当前：资源」。
- **入口图标跟着当前页走**（同日追加）：在账号页时，「规则」入口显示的是账号图标，
  字始终是「规则 / 投研」。只重写图标节点的 innerHTML（160ms 落一下），离开这一组换回本来的图标。
- 成员按钮是**原节点搬家**：`id`、`data-*`、`aria-controls`、可访问名一字未改，
  只是父节点从 `.rail-navigation` 变成 `.rail-group-menu`。
  `rules.js` / `hub-workspaces.js` / `chuxin.js` / `study.js` / `writing.js` / `wireless-page.js`
  里的 `getElementById` 拿到的还是同一个节点，接线一行没动。
- 社区版导出：应用组整段包在 `@community-strip` 里，剥完只剩「规则」组，不留空 dock。

## 为什么这么定位

展开条写在 `.rail-navigation` 里，而它是 `overflow-y:auto` 的滚动容器、`#scene-rail`
自己也常常 `overflow:hidden`——**绝对定位一定会被裁**。所以 dock 用 `position:fixed`，
`left/top` 在每次展开时按入口的 rect 现算，rail 滚动 / 窗口 resize 时重算，
再夹在「工具栏底部 ~ 底栏顶部」之间。rail 与 dock 之间留 4px，并用伪元素把这段空隙
也算进 dock 的命中区，鼠标扫过去不会把它关掉。

## 交互细节（都是真实点出来的，不是推断）

- 鼠标离开 180ms 后收起；从入口移到 dock 上不收起。
- 点组里的成员后，面板一开（该成员变成 `aria-current=page`）dock 立刻收起。
  不能只靠点击冒泡收起：**资源 / 回顾 由 `hub-workspaces.js` 在捕获阶段
  `stopImmediatePropagation`**，冒泡到 dock 的 click 根本不会发生。
- 键盘：入口上 → 展开并聚焦第一个成员；←/→ 在成员间移动；Esc 收回并把焦点还给入口。
  还焦点时会短暂压住「focus 即展开」，否则 Esc 一按就又被展开回去。
- 导航处于「取消固定」的悬停预览态时，dock 开着就不让 rail 自己收掉，
  dock 关了再重新计时。
- 长按排序仍可用，但只排一级入口：分组整组搬，成员不会被 `list.append` 拽出 dock。
  旧顺序里存的是已被收进去的 8 个 id，读出来会对不上 → 自动回落到新的默认顺序。

## 账号序号（本次确认已生效）

会话 logo 右下角的 1 / 2 与底栏额度里的 1 / 2 是 2026-10-24 09:47 那笔
`5bff60b5` 做的（`#session-list .sl-kind[data-account]::after`、底栏
`.sidebar-quota-account` 绝对定位到 logo 右下角）。本次改动没有回退它，
`tests/e2e-account-footer-single-line-cdp.js` 在这条分支上实测通过：
两个 Claude / 两个 Codex 账号分别标 1 / 2，单账号的 AI 不标。

## 验证

- `node scripts/run_unit_tests.js`：全量单元测试（含新增
  `tests/unit-rail-groups-contract.test.js`）。
- `node tests/e2e-rail-group-nav-cdp.js`（新增，隔离数据目录 + 独立 CDP 端口）：
  rail 收成 6 个入口、dock 位置/尺寸/命中区、成员顺序、点选后面板打开与入口提示、
  键盘展开/收起、鼠标离开自动收、长按拖动整组搬、深色主题、1100×700 窄窗、悬停预览态。
- `node tests/e2e-account-footer-single-line-cdp.js`：账号序号（右下角）通过。
- 已知**与本改动无关**的既有失败：`e2e-compact-status-shell-cdp.js`（启动即等不到
  4 条额度行）、`e2e-editor-navigation-cdp.js`（第 22 行会话时间页签数量）——
  在 HEAD 基线 worktree 上跑同样的命令，失败点完全一致。

## 已知取舍

- **开发 / 云端 没有并进两组**：你点名的两组各 4 个，这两个不在名单里，先维持一级入口。
  如果想把「开发」并进投研组、「云端」并进规则组（各变 5 格），改 `index.html` 里的成员位置即可。
- dock 展开时覆盖在会话侧栏上方（约 234px 宽），鼠标一离开就收，不占布局。
