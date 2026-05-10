# Hub Toolbar 重构 + 多 AI Resume 入口 · 设计文档

**日期**: 2026-05-01
**作者**: 立花道雪
**状态**: ✅ 已与用户对齐 8 个决策点，待执行

---

## 1. 目标 (Goal)

把 Claude Session Hub 左上角 toolbar 从"以 Claude 为中心"重构为"5 家 AI 平等"的入口体系。

**6 项具体目标**：

1. 把"创建"和"恢复"两类操作彻底分开 —— `+ 新建 ▾` 只做创建，新增 `↻ 恢复 ▾` 独立做恢复
2. Resume 入口支持全部 5 家 AI（Claude/Gemini/Codex/DeepSeek/GLM），极简单层 dropdown
3. 圆桌从 "+" 号里独立成 toolbar 按钮（高频功能给独立入口）
4. 删除 "对话" sidebar-title（无信息量）
5. + 号 dropdown 整理：分组 + 各 AI 官方彩色 logo（参考 AI-Arena 插件做法）
6. 修复 DeepSeek/GLM resume 时模型被错误覆盖成 opus 4.7 的 bug

**非目标**（明确不做）：

- 不做 hub 自己维护的"会话历史 modal"（让 CLI 自带 picker 处理）
- 不做"按 cwd / 时间筛选"等高级 picker
- 不动圆桌内部的 sub-session resume 逻辑（那是另一条路径）
- 不做 Gemini 专属 picker（用 `--resume latest` 极简降级）

---

## 2. 调研结论 (Research)

### 2.1 各 CLI 无参 resume 实测能力（实测 `--help`）

| AI | 命令 | 无参 picker | 备注 |
|---|---|---|---|
| Claude | `claude --resume` | ✅ 弹 picker | 当前已用 |
| Codex | `codex resume` | ✅ "picker by default" | 实测 help 明确（之前 explore agent 误报） |
| Gemini | `gemini --resume <id\|latest\|index>` | ❌ 无交互 picker | 但有 `--list-sessions` 列出后退出 |
| DeepSeek | `claude --resume`（router env） | ✅ 走 Claude 路径 | jsonl 在 `~/.claude-deepseek/projects/` |
| GLM | `claude --resume`（router env） | ✅ 走 Claude 路径 | jsonl 在 `~/.claude-glm/projects/` |

**结论**：4 家可直接 spawn 让 PTY 自带 picker，仅 Gemini 需特殊处理。用户决定 Gemini 用 `--resume latest`（恢复最近 1 个）即可。

### 2.2 GLM/DeepSeek resume 模型覆盖 bug 根因

`session-manager.js:487-496`（GLM）& `:455-456`（DeepSeek）：

```js
// 创建时正常
cmd = ` claude --model ${opts.model || cv.GLM_MODEL} --permission-mode bypassPermissions`;

// resume 时漏 --model
if (opts.resumeCCSessionId) {
  cmd = ` claude --resume ${opts.resumeCCSessionId} --permission-mode bypassPermissions`;
}
```

Claude CLI 看不到 `--model` 时回退到全局默认（opus 4.7），覆盖原模型。

### 2.3 圆桌已有的 Gemini resume 资产

GeminiTap 自动持久化 `geminiChatId` / `geminiProjectHash` / `geminiProjectRoot` 到 state.json，已实现 `gemini --resume <UUID>` + `latest` fallback + Level 3 [CONTEXT] 注入。本期 Gemini latest 路径**直接复用** `session-manager.js:362-396` 现有逻辑，零额外开发。

### 2.4 Hub 现有 toolbar 结构（用户截图 + 调研）

- HTML：`renderer/index.html:17-61`
- JS：`renderer/renderer.js:1552-1570`
- CSS：`renderer/styles.css:189-266` + `:987-1021`
- 按钮顺序：`[对话] [+ 新建] [↻ 恢复] [选项 ▾] [◀]`
- + 号 dropdown 当前 8 项：Claude / Claude Resume / Gemini / Codex / DeepSeek / GLM / PowerShell / 创建圆桌

---

## 3. UI 设计规范

### 3.1 Toolbar 改后布局

```
[+ 新建 ▾] [↻ 恢复 ▾] [🎯 圆桌] [⚙ 选项 ▾] [◀]
```

- 删除 sidebar-title `<h3 class="sidebar-title">对话</h3>`
- 4 个按钮 + 1 个折叠箭头，间距 6px
- 整体高度保持 sidebar-header 现状（约 48px）

### 3.2 + 号 Dropdown（重组）

```
┌──────────────────────────┐
│ AI CLI                   │ ← .menu-group-label
│  [logo] Claude Code      │
│  [logo] Gemini CLI       │
│  [logo] Codex CLI        │
│  [logo] DeepSeek         │
│  [logo] GLM              │
│ ──────────────────────── │ ← .menu-divider
│ 终端                     │
│  [logo] PowerShell       │
└──────────────────────────┘
```

- 移除 `data-kind="claude-resume"` 项（迁去恢复 dropdown）
- 移除 `data-kind="meeting"` 项（独立成圆桌按钮）
- 每项前加 16x16 `.ai-logo`（彩色 SVG）
- 分组标题用 `.menu-group-label` 类（11px、#8b949e、uppercase、letter-spacing 0.6px）

### 3.3 ↻ 恢复 Dropdown（新增）

```
┌──────────────────────────┐
│  [logo] Claude    PTY picker  │
│  [logo] Gemini    最近一次     │
│  [logo] Codex     PTY picker  │
│  [logo] DeepSeek  PTY picker  │
│  [logo] GLM       PTY picker  │
└──────────────────────────┘
```

- 5 项均带彩色 logo
- 每项右侧浮 `.hint` 灰字标注体验类型（PTY picker / 最近一次）
- 点击直接 invoke `create-session` IPC 传对应 kind，**不弹中间 modal**

### 3.4 🎯 圆桌按钮（新增）

- class: `.btn-roundtable`
- 视觉：橙金色 accent（`rgba(187,128,9,0.15)` 背景 + `#d29922` 文字 + 0.5 opacity 描边）
- hover 加深背景透明度
- 点击：`createMeetingByMode('general')`（无 dropdown）

### 3.5 .ai-logo 通用样式

```css
.ai-logo {
  display: inline-block;
  width: 16px; height: 16px;
  border-radius: 3px;
  vertical-align: middle;
  margin-right: 8px;
  background-size: contain;
  background-position: center;
  background-repeat: no-repeat;
}
```

每家 AI 一个具名 class（`.logo-claude` / `.logo-gemini` / `.logo-codex` / `.logo-deepseek` / `.logo-glm` / `.logo-powershell`），背景图引用 `renderer/assets/ai-logos/<kind>.svg`。

---

## 4. 数据契约

### 4.1 IPC 通道

| Channel | Payload | 备注 |
|---|---|---|
| `create-session`（已有） | kind ∈ `{claude, gemini, codex, deepseek, glm, claude-resume, gemini-resume, codex-resume, deepseek-resume, glm-resume, powershell}` | 新增 4 个 resume kind |
| `create-meeting`（已有） | mode | 圆桌按钮直接调 |

### 4.2 state.json schema 新增 / 验证

| 字段 | 类型 | 来源 | 用途 |
|---|---|---|---|
| `sessions[].model` | string | session 创建时 currentModel.id | resume 时回填 `--model` 参数 |

**注意**：该字段可能已存在；若存在则不动，若不存在则在 session bind 时记录。

### 4.3 新增 session kind 列表

| kind | 描述 |
|---|---|
| `gemini-resume` | spawn `gemini --resume latest` |
| `codex-resume` | spawn `codex resume`（无参 picker） |
| `deepseek-resume` | spawn `claude --resume --model <m>` + DS router env |
| `glm-resume` | spawn `claude --resume --model <m>` + GLM router env |

---

## 5. 后端改造

### 5.1 session-manager.js 新增 4 个 resume 分支

| kind | spawn 命令模板 | env |
|---|---|---|
| `claude-resume`（保留） | `claude --resume` | 默认 |
| `codex-resume`（**新**） | `codex resume --dangerously-bypass-approvals-and-sandbox` | 代理 |
| `gemini-resume`（**新**） | `gemini --approval-mode yolo --model ${model} --resume latest` | 代理 + GEMINI_SYSTEM_MD |
| `deepseek-resume`（**新**） | `claude --resume --model ${opts.model \|\| cv.DEEPSEEK_MODEL} --permission-mode bypassPermissions` | DS router |
| `glm-resume`（**新**） | `claude --resume --model ${opts.model \|\| cv.GLM_MODEL} --permission-mode bypassPermissions` | GLM router |

### 5.2 GLM/DeepSeek resume 模型 bug 修复

3 层修复：

1. **main.js:2155-2169**（resume IPC handler）：从 `meta.model` 读出原模型，传 `opts.model` 给 createSession
2. **session-manager.js**：GLM 分支（487-496）+ DeepSeek 分支（455-456）resume 命令补 `--model ${opts.model || cv.<KIND>_MODEL}`
3. **保险**（Level 2 fallback）：在 `ensureClaudeBypassAndTrust` 顺手往 `~/.claude-glm/settings.json` & `~/.claude-deepseek/settings.json` 写默认 model 字段

### 5.3 状态字段透传链路

```
state.json sessions[].model
  ↓
main.js IPC handler 读 meta.model
  ↓
createSession(kind, { model, ... })
  ↓
session-manager.js: opts.model 拼进 cmd
  ↓
PTY: claude --model <m> --resume
```

---

## 6. 兼容性 / 降级

| 维度 | 保证 |
|---|---|
| 创建会话 | + 号 dropdown 仅移除 `claude-resume` / `meeting` 两项，其他创建路径完全不动 |
| Claude resume | 命令模板完全不变，仅入口位置从 + 号 dropdown 移到 ↻ 恢复 dropdown |
| 圆桌创建 | `createMeetingByMode('general')` 调用链不变，只换触发按钮 |
| 圆桌打开旧 meeting | 完全不动（圆桌内部的 Gemini/Codex resume 是另一条路径） |
| state.json schema | 仅可能新增 `sessions[].model` 字段（已存在则复用），不破坏现有数据 |
| 子 session resume | 老 `claude-resume` kind 命令模板继续支持，新 4 个 resume kind 是并列 kind |
| 数据迁移 | 不需要迁移（旧数据若缺 model，fallback 到 cv.\<KIND\>_MODEL） |

---

## 7. 测试

### 7.1 单元测试

- 验证 5 个 resume kind 在 session-manager.js 的命令拼接结果（含 GLM/DeepSeek `--model` 透传）
- 验证 main.js resume IPC 从 meta.model 读取并下发 opts.model

### 7.2 E2E 验证（9 步 · CDP 真测）

详见 plan.md Task 8。隔离 Hub `CLAUDE_HUB_DATA_DIR=C:\temp\hub-resume`：

1. 启动 → 截图新 toolbar
2. 点 + 新建 ▾ → assert dropdown 6 项 + 彩色 logo + "AI CLI / 终端" 分组
3. 点 ↻ 恢复 ▾ → assert dropdown 5 项 + 彩色 logo + Gemini 行附 "最近" 灰字
4. 选 Claude resume → PTY 内 picker
5. 选 Codex resume → PTY 内 codex picker
6. 选 Gemini resume → PTY 命令含 `--resume latest`
7. **GLM resume bug 回归**：前置 state 含 1 个 GLM 会话 meta.model='glm-4.6'，resume 后 `/model` 显示 glm-4.6 而非 opus
8. 点 🎯 圆桌 → 弹圆桌创建 modal
9. 截图归档 `tests/screenshots/resume-toolbar/`

---

## 8. 风险与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | AI 官方 logo 版权 / 资源缺失 | 中 | 优先复用 AI-Arena 已有；找不到则简化几何 SVG 兜底 |
| R2 | Gemini latest 没有会话时 spawn 失败 | 中 | 先调 `gemini --list-sessions` 探测，无则提示"先创建一次 Gemini 会话" |
| R3 | GLM bug 修复影响 router 其他 env | 中 | 严格只改 `--model` 拼接，不动 BASE_URL/TOKEN/CONFIG_DIR |
| R4 | 旧 state.json 缺 sessions[].model | 中 | resume 时 fallback 链：opts.model → meta.model → cv.\<KIND\>_MODEL → 报错 |
| R5 | 圆桌按钮独立后老用户找不到 | 低 | 醒目 🎯 emoji + 橙金 accent 区分 |
| R6 | + 号 dropdown 移除 meeting 项后老用户习惯打破 | 低 | "🎯 圆桌" 紧邻 "+ 新建"，视觉上仍是创建系列 |

---

## 9. 版本

- 改造涉及前端 toolbar + 后端 session 拼接 + state schema 微调
- version +0.1（package.json）
- 不需要 schema migration

---

## 10. 文件改造一览

| 文件 | 类型 | 主要改动 |
|---|---|---|
| `renderer/index.html` | 修改 | 删 sidebar-title；toolbar 4 按钮重构；+ 号 dropdown 重组；新增 ↻ 恢复 dropdown；新增 🎯 圆桌 按钮 |
| `renderer/renderer.js` | 修改 | 5 个 resume kind 事件绑定；🎯 圆桌 click；移除旧 meeting/claude-resume 分支 |
| `renderer/styles.css` | 修改 | sidebar-header 间距；新 dropdown / 按钮样式；`.ai-logo` 通用类；分组标题样式 |
| `renderer/assets/ai-logos/{claude,gemini,codex,deepseek,glm,powershell}.svg` | 新增 | 6 个 AI/工具的官方彩色 logo |
| `core/session-manager.js` | 修改 | 4 个新 resume kind 分支；GLM/DeepSeek resume 补 `--model` 修 bug |
| `main.js` | 修改 | resume IPC handler 从 meta.model 透传到 opts.model |
| `package.json` | 修改 | version +0.1 |
| `tests/_e2e-resume-toolbar-verify.js` | 新增 | E2E 9 步流程 |

---

## 11. Open Questions（已逐项决策，无待定）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | Resume 入口形式 | 极简单层 dropdown（不弹列表 modal） |
| D2 | Resume 按钮外观 | `↻ 恢复 ▾`（保留现按钮 + 加下拉箭头） |
| D3 | + 号 dropdown 视觉 | 分组 + 各 AI 官方彩色 logo |
| D4 | 圆桌位置 | 独立 toolbar 按钮（从 + 号移出） |
| D5 | "对话" sidebar-title | 删除（无信息量） |
| D6 | Gemini resume 处理 | `--resume latest`（不做 hub micro-picker） |
| D7 | 5 家覆盖范围 | Claude / Gemini / Codex / DeepSeek / GLM 全做 |
| D8 | GLM 模型 bug 修 | 必修（resume 时显式传 `--model`） |

---

## 配套交付物

- HTML mockup: `docs/hub-resume-toolbar-2026-05-01.html`
- 实施计划: `docs/superpowers/plans/2026-05-01-hub-resume-toolbar.md`
