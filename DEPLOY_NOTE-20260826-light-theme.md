# 2026-08-26 · 四套浅色皮肤与主题 token 层

Hub 现在有 **5 套主题**：深色（默认）+ claude / codex / hub / slate 四套浅色。
终端走 **T1 深色终端岛**，所有主题下都恒深。选型依据见
`artifacts/ai-hub-light-theme-mocks-20260826.html`，实拍在
`artifacts/theme-20260826-skin-*.png`。

## 为什么几何也必须进 token（第二轮的教训）

第一轮只做了颜色 token 化，交付出来的"B 暖米 + A 密度"实际只有 B 的色板：
`var(--radius-*)` 全仓只被引用 **1 次**、`var(--shadow-*)` **0 次**，530 个写死的
`border-radius` 原封不动，所以形还是 Hub 原来的疏松骨架，气质偏 Claude 不偏 Codex。

**光换配色做不出"纯 Codex"和"纯 Claude"的区别**——这两者的差异主要在形：
Codex 紧而平（圆角 3-10px、阴影近乎没有、发丝线分区、近乎单色），
Claude 圆而软（圆角 5-20px、暖色柔影、陶土强调）。所以第二轮把
`--radius-*` / `--shadow-*` 也收进主题：489 处圆角 + 38 处落影，
深色下最大偏移 3px（255 处 0px、143 处 1px、42 处 2px、3 处 3px）。

codex 皮肤还多守一条**去色**规矩：链接、选中、hover 的蓝色 tint 全部退成中性灰
（`--rgb-info` 一起退），功能入口用单独的 `--rgb-feature` / `--mark-feature`
（这样「初心投研」在 codex 下是中性卡片、在其余皮肤下仍是暖橙），
只有真正的状态语义（危险 / 警告 / 成功）才留颜色。

## 加一套新皮肤的成本

改两处：`core/theme-config.js` 的 `THEMES` 加一条，`base.css` 加一个
`:root[data-theme='<id>']` 块。选项菜单是照清单生成的，controller 不用动。

## 改了什么

**新增**
- `core/theme-config.js` —— 主题常量与归一化的唯一事实源
- `renderer/theme-bootstrap.js` —— 首帧前把 `<html data-theme>` 打上，避免闪深色
  （CSP 是 `script-src 'self'`，内联脚本会被拦，只能走独立文件；必须排在样式表之前）

**主题 token 层：`renderer/styles/base.css`**
四段结构：主题无关 → `:root, [data-theme=dark]` → 四套浅色共享段 → 每套皮肤各自的块。
共享段与皮肤块 specificity 相同，靠**源码顺序**决胜负，皮肤块必须排在共享段之后。
旧名（`--bg-primary` / `--text-primary` / `--ui-purple-*` …）保留为纯转发别名，
历史引用一处没改。**改颜色只该动这个文件。**

**开关**：选项菜单里是一个带色板的主题选择器（`#options-theme-picker`，
由 `theme-controller.js` 照 `THEMES` 清单生成），走 `localStorage['hub.theme']`。
默认仍是深色；属性缺失或值不认识时 `:root` 兜底。

## 三条必须知道的设计决定

1. **终端/代码块/工具结果在所有主题下都恒深**（`--machine-*`）。xterm 里跑的
   Claude Code / Codex TUI 用 dim 灰自绘框线，浅底下几乎看不见；prism-tomorrow 也是
   深色语法主题。浅色下靠 `--machine-island-*` 把这块内缩 + 圆角 + 细环，做成嵌入式
   终端岛（`.terminal-container`），深色下这几个值为 0，与从前逐像素相同。
   要改成浅色 ANSI，必须先对 Claude / Codex / Gemini / Kimi / PowerShell 逐个跑真实
   会话截图验收——`tests/unit-theme-controller-contract.test.js` 里有断言守着这条。

2. **强调色叫 `--brand` 不叫 `--accent`**。仓库里已有 48 处 `var(--accent, <蓝/靛>)`
   在拿"没定义"当默认值走回退（群聊、工作流弹窗）。真定义 `--accent` 会把那些地方
   一夜从蓝变紫——那是另一件事，不该混在换肤里悄悄发生。

3. **换主题后必须强制整树重算样式**（`forceStyleRecalc`）。Chromium 不会把 `:root`
   上 `data-theme` 的变化完整传播给引用 `var()` 的后代：隔离实例实测 419 个可见元素里
   有 15 个停在旧主题的颜色上，等多久都不恢复。**冷启动时每套皮肤都正确，只有运行时
   切换会踩到**，所以极易漏测。workaround 是短暂 `display:none` + 读 `offsetHeight`
   强制 flush 再还原，代价一帧。有回归测试守着，别当成没用的代码删掉。

## 收编硬编码色的做法

分五轮，每轮都有可审计的输出，纪律是**能证明深色不变的先做，做不到的再逐条判断**：

| 轮次 | 做法 | 规模 |
|---|---|---|
| 1 | 逐字等值替换（`#0d1117`→`--surface-canvas` 等） | 101 处，深色可证明不变 |
| 2 | alpha 叠色重定基（`rgba(88,166,255,.08)`→`rgba(var(--rgb-info),.08)`）+ `var()` 回退位 | 905 处声明 |
| 3 | 感知色距收敛：近似色按 CIE76 dE 归到同角色 token（文字 ≤16 / 底色 ≤7 / 描边 ≤9） | 775 处 |
| 4 | 结构性隐患强制归位：浅色文字 L>58、深色底 L<26 无条件映射 | 135 处 |
| 5 | 彩色按钮上的前景色 `--fg-strong`→`--fg-inverse`（浅色下会翻成深字） | 18 处 |

结果：颜色 `var()` 引用 1354 → 3403，token 定义 85 → 241。
`renderer/*.css` 里剩的 620 个字面色值中有 105 个是 `base.css` 的 token 定义本身。

**`renderer/committee-ui.css`** 原来是浅色优先 + `@media (prefers-color-scheme: dark)`，
会跟着操作系统翻色而与 Hub 主题脱节（深色 Hub 里那块会随系统变浅）。三个 media 块
已改挂 `:root[data-theme='dark']`。
**`renderer/keyboard-shortcuts.js`** 的命令面板原本写死深色 + 一组从来没有代码启用过的
`.light` 死分支，已改成直接吃 token。
**`renderer/loop-workflow.js`** 不动：它生成的是独立 HTML 报告文档，看不到 Hub 的
`data-theme`，那里用 `prefers-color-scheme` 是对的。

## 验证（隔离实例，生产 Hub 全程未触碰）

隔离启动：`CLAUDE_HUB_DATA_DIR=<临时目录>` + `--remote-debugging-port=9344`，
启动后 `get-meetings` 返回 `[]` 自检通过；关闭时只按 StartTime 精确停自己的
`electron.exe`，生产 `AIGroupChatHub.exe` 进程全程在。

- 全部 **276 个 unit 测试通过**
- **深色回归量化**（同一屏、同一实例，改动前后各 dump 一次计算样式，417 元素 /
  1667 个颜色属性）：完全相同 71.4%、不可辨 6.6%、勉强可见 12.4%、可察觉 5.7%、
  明显 3.9%。明显那档是有意的近似色归并（暖绿/暖橙统一到调色板）。
  **不是逐像素相同**，是"同一套设计，近似重复色被统一"。
- **对比度审计**（同一屏、AA 4.5:1 阈值，五套逐个跑）：
  dark 10 项 / 最差 2.09 · claude 14 / 3.47 · codex 11 / 3.31 ·
  hub 13 / 3.20 · slate 14 / 3.11。
  四套浅色的**下限都明显高于现有深色**，不是对比度回归。

## 回滚

主题层集中在 `base.css` + `theme-controller.js` + `theme-bootstrap.js` + `index.html`
两行。想只关浅色而保留 token 重构：把 `core/theme-config.js` 的 `THEMES` 砍到只剩
`dark` 即可（菜单照清单生成，会自动只剩一项），`data-theme` 缺失时也自动走深色。

---

# 2026-08-27 追加：启动中心遮罩修复 + 工作台取舍落地

## 一、启动中心整片发灰（浅色主题下的真 bug）

根因不是配色没适配，是**遮罩层的画法**：`.new-session-menu::before` / `.options-menu::before`
用 `background: rgba(scrim,.55)` + `z-index: -1`。`z-index:-1` 的子元素画在
**父元素自己的背景之上、内容之下**，于是那层 55% 的遮罩把面板底色一起压暗了。
深色主题下遮罩和面板同色，完全看不出来；一换浅色，启动中心的标题栏和右侧面板
就成了一片灰（有自己背景的子元素——左侧导航、白卡片、页脚——反而正常，灰得很没道理）。

修法是把两件事拆开：`::before` 只留**透明**命中区（配合 backdrop-filter 做背景虚化），
变暗改用超大 spread 的 `box-shadow` —— 它永远画在元素**之外**，天然不覆盖面板。
`launch-center.css` 里那条带 `!important` 的阴影也要同步带上遮罩层，否则会盖掉。

全仓只有这一处用了 `z-index:-1` 伪元素遮罩，其余弹窗都是独立遮罩层元素，没这个问题。

## 二、新增 `tools/theme-adaptation-scan.js`

上面那个 bug 靠截图一张张找太慢，固化成扫描器：对隔离实例跑，报两类问题——
有效背景仍是深色的大面（dark-surface）、与背景对比度 < 3:1 的文字（ghost-text）。
终端/代码块/工具结果是有意恒深的，整棵子树跳过。

    node tools/theme-adaptation-scan.js --theme codex --click btn-new

输出里的 `onScreen` 一定要看：**面板没打开时报「0 问题」是假干净**。
实测覆盖：启动中心、选项菜单、设置弹窗、群聊创建、恢复会话、全局搜索、记忆面板、
初心投研、会话页、右键菜单 —— 修完后五套皮肤全部 0/0。

## 三、工作台按取舍单重构

**撤下**：改动审阅收件箱（含四小格与驾驶舱入口）、异常收件箱、夜间任务摘要。
**改造**：上下文风险从整张卡收成指标条上的第 5 个数字；页面副标题去掉；
侧栏「路径预览」按钮撤掉（Ctrl+O 仍在）；顶栏配额 ticker 去 Kimi、加 DeepSeek 余额并重新排版。
**新增**：「今天该续哪个」（休眠会话按未读 + 最近活跃排序取 4 条）、
「常用搜索 · 最近命中」（`core/search-recent.js` 记录跑出过结果的查询，零命中不记）。
**布局**：三栏改单栏卡片流（`#home-card-stack`），每张卡可折叠、可拖动换位，
内容为空自动收成一行；折叠状态与顺序存 localStorage（`renderer/home-card-layout.js`）。

**顺带修掉的浪费**：审阅收件箱撤下后，工作台仍每 30 秒调一次 `loadOperations`，
对每个工作区做 Git 扫描（实测一次上万文件）喂给一张已经不存在的卡；手动「刷新」
也会连带触发。两处都已去掉——审阅驾驶舱在 `open()` 里自己按需加载。

**留下的悬案**：审阅驾驶舱弹窗（`#operations-review-modal`）代码还在、功能完好，
但工作台上唯一的入口按钮已删，现在**没有任何地方能打开它**。要么补一个入口
（命令面板？），要么连同 `workbench-operations-controller.js` 一起删掉，需要拍板。

## 验证

- **277 个 unit 测试全绿**（新增 `tests/unit-home-card-layout.test.js` 覆盖卡片折叠/排序
  落盘与最近搜索的记录规则）
- 结构契约写进 `tests/unit-home-workbench.test.js`：卡片顺序、折叠把手数量、单栏、
  被撤三块确实不在、副标题与路径预览已删、**不再定时 Git 扫描**
- `tests/e2e-home-workbench-cdp.js` 同步改到新结构（含顶栏只剩三段的断言）
- `tools/theme-adaptation-scan.js` 五套皮肤全部 0 深色面 / 0 幽灵文字

注：`tests/unit-claude-memory-link.test.js` 偶发失败一次，是它真的在建 junction
而当时仓库里并发跑着 `git stash`；连跑三次均通过，不是回归。
