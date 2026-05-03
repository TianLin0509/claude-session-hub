# Hub UI Redesign · Spec 1 — 主区 + 主题

**日期**: 2026-05-04
**版本号目标**: v0.8.5 → v0.9.0
**作者**: 立花道雪 + Claude Opus 4.7
**前置脑暴**: 终端会话(2026-05-04 brainstorming session)

## 1. 目标与范围

### 在范围(spec 1)

只动**主区聊天渲染**(D)和**整体主题**(G subset)两层,且全部是"看"的层 —— 不动 PTY/watcher/orchestrator/IPC 等"算"的层。

| 区域 | 动什么 |
| --- | --- |
| **G 主题** | 引入呼吸卡片视觉风格 + 紫色基调 + 自定义滚动条 |
| **D 主区** | turn 卡片化 + 工具调用智能折叠 + 时间戳 + 代码块强化 + 精灵/品牌 logo 头像 + hover 操作按钮 |

### 不在范围(留 spec 2)

- A 顶部工具栏(标题/4 按钮/A-A+X 重排)
- B 侧栏 session 列表(信息密度/分组/状态可见性)
- E 输入框(快捷 prompt/@文件/@AI/历史)
- F 圆桌专属视图(分屏/合并视图)
- D3 长回答(回答正文很长)的"展开更多"
- D6 图片渲染策略
- 用户自定义头像上传
- 字号配置面板(A-/A+ 升级)

### 不破坏的契约

1. **xterm PTY 渲染层不动** — 终端输出仍由 xterm.js 渲染。新卡片只是 PTY 之外的"消息层"装饰
2. **圆桌 slot 体系不动** — 圆桌的 Pikachu/Charmander/Squirtle slot 分配、分屏布局、turn watcher 全部保留
3. **hook server / IPC 协议不动** — 不新增/不修改任何 IPC channel
4. **session 持久化结构不动** — state.json schema 不变
5. **现有 minimap + nav 按钮不动** — 仅 CSS 重绘对齐紫色基调,行为/接口不变
6. **statusline-cache.json / usage-cache.json 不动** — 数据源原样
7. **现有 ai-logos/*.svg 复用** — 不新增 logo 文件

## 2. 视觉决策(G)

### 2.1 视觉方向: B 呼吸卡片

| 项目 | 值 |
| --- | --- |
| 字体栈 | `"Inter", -apple-system, "Segoe UI", sans-serif` |
| 默认字号 | 13px(主区) / 12.5px(meta) / 11px(标签) |
| 行高 | 1.65(消息正文) / 1.45(代码块) |
| 卡片圆角 | 8px |
| 卡片间距 | 8px(turn 间) / 12px(主区上下边距) |
| 卡片内边距 | `10px 14px` |

### 2.2 颜色基调: P 紫色

定义在 `:root` 的 CSS 变量(扩展现有 `--accent-*` 体系):

```css
--ui-purple-1: #8b5cf6;          /* 主紫,user 消息 left border */
--ui-purple-2: #a78bfa;           /* 浅紫,assistant 标题/链接/选中 */
--ui-purple-3: #c4b5fd;           /* 更浅,user 标题文字 */
--ui-purple-tint-bg: #2a2335;     /* user 消息底色,深紫调 */
--ui-purple-glow: rgba(139, 92, 246, 0.5); /* 滚动条 hover */

--turn-bg-assistant: #1c1d23;     /* assistant 卡片底色 */
--turn-bg-user: var(--ui-purple-tint-bg);
--turn-meta-fg: #71717a;          /* 时间戳/元数据 */
--turn-body-fg: #d4d4d8;          /* 消息正文 */

--tool-call-bg: #14151a;          /* 工具调用块底 */
--tool-call-border: #2a2b32;
--tool-call-name: #fbbf24;        /* 工具名(琥珀色,与紫互补) */
--tool-call-toggle: var(--ui-purple-2);
```

### 2.3 G3 自定义滚动条

主区内的所有 `overflow: auto/scroll` 容器统一应用:

```css
*::-webkit-scrollbar { width: 6px; height: 6px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 3px;
  transition: background 0.2s;
}
*::-webkit-scrollbar-thumb:hover { background: var(--ui-purple-glow); }
*:hover::-webkit-scrollbar-thumb { background: rgba(139, 92, 246, 0.25); }
```

不覆盖 xterm.js 内部滚动条(它有自己的 viewport,会冲突 — 用 `.xterm *` selector 排除)。

## 3. 功能决策(D)

### 3.1 D · 工具调用智能折叠

| 项目 | 行为 |
| --- | --- |
| 阈值 | 默认 15 行(stdout 实际渲染行数,不含 ANSI escape 后的逻辑行) |
| ≤ 阈值 | 直接展开,显示完整 stdout |
| > 阈值 | 折叠成单行 toggle: `▸ 展开 187 行` |
| 标题元数据 | `⚙ Bash grep -n "packy" main.js   ✓ 8 lines · 0.3s` |
| 失败 case | 标题用 `✗` 红色,exit code 显示在右侧;stdout 始终展开(失败需要看清) |
| 阈值配置 | `cfg.uiToolFoldThreshold`(hub-config.js,默认 15;写入 config.json `ui.tool_fold_threshold`) |

### 3.2 D1 · 绝对时间戳

显示在 turn 标题旁:

| 时间差 | 显示格式 |
| --- | --- |
| 同一天 | `14:22` |
| 跨日 | `5月3日 14:22`(月日中文,与 Hub 整体中文一致) |
| 跨年 | `2025年12月3日 14:22` |

格式化函数复用现有 `formatRelativeTime` 旁的新函数 `formatAbsoluteTime(ts)`,放在 `renderer/renderer.js` 工具函数区。

### 3.3 D2 · 代码块强化

主区内 markdown 代码块(用户消息中三反引号 / Claude 回答中代码片段):

| 项目 | 实现 |
| --- | --- |
| 语法高亮 | 引入 `prismjs` 新依赖(当前 package.json 未装),主题 `prism-tomorrow` 作为基底,自定义 CSS override 调成紫调匹配 P 基调。markdown 解析复用现有 `marked` + `dompurify`(已在 deps) |
| 复制按钮 | 代码块右上角浮 `📋 Copy`(hover 出现,点后短暂变 `✓ Copied`) |
| Long block 折叠 | > 30 行时折叠成单行 `▸ 展开 / 30 of 180 行 · python`,与工具折叠同样的 UX 模式 |
| 行号 | 默认不显示(避免视觉嘈杂);可在配置开 `ui.code_line_numbers: true` |

### 3.4 D4 · 头像策略

**单 session 模式**(占 Hub 大多数场景):

| 角色 | 头像 |
| --- | --- |
| 用户(`你`) | 训练师 emoji 占位 `👤`(circle bg `#2a2335`),后续 spec 2 可让用户上传 |
| Claude | `renderer/assets/ai-logos/claude.svg`(已有,~24px 圆形 mask) |
| Codex | `renderer/assets/ai-logos/codex.svg`(已有) |
| Gemini | `renderer/assets/ai-logos/gemini.svg`(若无,本 spec 不补,fallback 字母 `G`) |
| DeepSeek/GLM/GPT/Kimi/Qwen | 按 `ai-logos/<kind>.svg` 查找,缺失 fallback 字母圆形(背景按现有 `--badge-color-<kind>`) |

**圆桌模式**:

完全沿用现有 slot 体系(commit `d6ac327` 引入)。Pikachu/Charmander/Squirtle 三只精灵保持原样,本 spec 只对**圆桌主区聊天卡片**应用 D 的卡片化(让圆桌内的多 AI turn 也享受卡片化视觉),slot 头像用各自精灵 PNG 而非 ai-logos。

判断分支:`if (meeting && meeting.kind === 'roundtable') useSlotAvatar() else useAILogoAvatar()`。

### 3.5 D5 · 消息操作按钮

`hover` 在 turn 卡片右上角出现操作行(默认透明,卡片 hover 时 fade-in 0.15s):

| 按钮 | 出现条件 | 行为 |
| --- | --- | --- |
| `📋 复制` | 总是 | 把 turn 正文 + 工具调用 stdout 拼成 markdown 复制 |
| `↻ 重发` | 仅 user 消息 | 把同样的 prompt 再发一次(等同重新输入) |
| `✏ 编辑重发` | 仅 user 消息 | 把内容写回输入框,光标定位末尾,删除原 turn(让用户改后重发) |
| `⏪ 重新生成` | 仅 assistant 消息且其前一条是 user | 从该 user prompt 重新触发 `claude --continue` 或重发 prompt |

实现注意: `重发` 和 `重新生成` 的"重发 prompt"动作复用 commit `0058b98` 的 `resendCurrentPrompt`(`renderer/roundtable-watcher.js` 已有路径);单 session 路径需要新增 `terminal-input` IPC 调用 + `\r`,但**不新增 IPC channel**,沿用现有 `terminal-input`。

`编辑重发` 删除原 turn 的方式: 由于单 session 模式下消息卡片是叠加在 xterm 之上的"消息层",删除卡片不会影响 PTY 实际历史。这里"删除"只是 UI 层面隐藏,符合本 spec"不动算"的原则。

## 4. 架构与实现路径

### 4.1 涉及文件(按改动量大→小)

| 文件 | 改动 |
| --- | --- |
| `renderer/styles.css` | **+200~300 行**: 新增 `.turn-card / .tc-* / .code-block / .msg-actions` 等;紫色 CSS 变量;滚动条覆盖 |
| `renderer/renderer.js` | **+100~150 行**: turn 渲染器(包装现有 turn 数据为卡片 HTML);折叠状态管理;复制/重发/编辑/重新生成 handler;时间格式化函数 |
| `renderer/index.html` | **+10~20 行**: terminal panel 容器加一层 `<div class="msg-overlay">` 用于消息卡片层 |
| `core/hub-config.js` | **+3 行**: 加 `ui.tool_fold_threshold` 默认 15 / `ui.code_line_numbers` 默认 false |
| `package.json` | **+1 dep**: `prismjs`(已确认未装,需新增) |

### 4.2 数据流

PTY 已有的 turn 数据(`session.turns[]`,从 hook server / transcript 读取)作为单一数据源。新增一个"消息层"渲染器:

```
session.turns[] → renderTurnCard(turn) → DOM 卡片
                                          ↓
                                   挂载到 .msg-overlay
                                          ↓
                              叠在 xterm 之上(z-index)
```

xterm 仍保留 PTY raw 输出的渲染(用户切到"PTY 视图"时显示)。提供一个切换按钮 `卡片 / PTY` 在主区右上角(本 spec 内 default = 卡片,PTY 是 fallback)。

### 4.3 折叠状态持久化

工具调用块的折叠/展开状态写入 `session.uiState.foldedTools[]`(turn.id + tool.idx),持久化到 state.json。这样切回 session 时折叠状态保留。

代码块同理: `session.uiState.foldedCodes[]`。

### 4.4 性能注意

- 长 session(>500 turns)的卡片化渲染要走虚拟滚动(`react-window` 风格,但 vanilla JS 实现)。**本 spec 内不做完整虚拟滚动**,先 pageSize=100 + 滚到顶/底 lazy load 上下页(够用)
- Prism.js 高亮只在卡片可见时触发(IntersectionObserver)
- 滚动条 CSS 用 `* { scrollbar-* }` 不会有性能成本

## 5. 测试策略

### 5.1 必须的真实 E2E

按 Hub 项目 CLAUDE.md 「测试必须真实执行」铁律,启动隔离 Hub(`CLAUDE_HUB_DATA_DIR`),用 CDP 验证:

| 场景 | 预期 |
| --- | --- |
| 启动隔离 Hub + 创建一个 Claude session + 让它跑 `Bash ls`(短) | 显示展开的工具调用块,`✓` 绿色 |
| 让它跑 `Bash ls -la node_modules`(>15 行) | 显示折叠 toggle `▸ 展开 187 行`,点击展开 |
| 让它跑代码块 markdown 回答(>30 行) | 代码块带 Copy 按钮 + 长 block 折叠 + tokyo-night 高亮 |
| user 消息 hover | 出现 `复制 / 重发 / 编辑重发` 三按钮 |
| Claude 消息 hover | 出现 `复制 / 重新生成` 两按钮 |
| 滚动到底部按钮 | 仍然工作(已有逻辑) |
| minimap 上下条按钮 | 仍然工作 |
| 跨日时间戳 | 显示 `5月3日 14:22` 而非 `14:22` |
| 圆桌窗口 | 卡片化生效;slot 精灵头像保留;不破坏 split layout |

### 5.2 不需要的

- 单元测试: 几乎全是视觉/CSS,unit test 收益低
- 自动化截图回归: 留 spec 3 引入 Playwright + 视觉 diff(本 spec 只做手动 CDP 截图核对)

## 6. 验收清单(implementation 完成时勾)

- [ ] 隔离 Hub `CLAUDE_HUB_DATA_DIR` 启动通过 + 桌面快捷方式生产 Hub 不受影响
- [ ] G:卡片化 + 紫色基调 + 紫色滚动条全部生效
- [ ] D 工具折叠:>15 折叠 + ≤15 直接展示
- [ ] D1 时间戳:绝对时间显示,跨日格式正确
- [ ] D2 代码块:Copy 按钮 + 高亮 + 长 block 折叠
- [ ] D4 头像:单 session 用 ai-logos / 圆桌用 slot 精灵
- [ ] D5 操作按钮:hover 出现 / 各按钮行为正确
- [ ] 圆桌(F)布局未破坏
- [ ] xterm PTY 渲染未破坏(切换"卡片/PTY"两边都正常)
- [ ] state.json 折叠状态持久化
- [ ] package.json 版本号 v0.9.0 + index.html / 标题栏同步
- [ ] CDP E2E 9 场景全过

## 7. 风险与回退

| 风险 | 缓解 |
| --- | --- |
| Prism.js 引入打破 bundle 体积 | core minified ~6KB + 常用语言 component ~2KB/each;按需 lazy import 语言包;若仍嫌重,fallback 到 plain text(只显示等宽字体不上色) |
| 卡片层叠在 xterm 之上 z-index 冲突 | 提供 PTY 切换 fallback;卡片层 z-index ≤ 999,xterm 内部 ≥ 1000 |
| 长 session 渲染慢 | pageSize=100 + lazy load 上下页;若仍慢,本 spec 实施时降级关闭卡片化 |
| 用户不喜欢卡片化 | 设置面板加 `ui.layout: 'card' | 'classic'` 开关,classic = 现有 PTY-only |

## 8. 后续 spec 队列(供参考,本 spec 不实施)

- **spec 2**: A 顶部工具栏 + B 侧栏 session 列表 + E 输入框
- **spec 3**: 视觉回归测试基础设施(Playwright + percy/argos)
- **spec 4**: 用户自定义头像 / 字号 / 主题切换面板
- **spec 5**: D6 图片渲染 / D3 长回答展开 / 多模态消息
