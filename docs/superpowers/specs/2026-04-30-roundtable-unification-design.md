# 圆桌架构统一设计 — UI 正交 + Prompt 场景化

**日期**: 2026-04-30
**状态**: 已确认
**可视化参考**:
- UI 对比: `docs/roundtable-unification-proposal.html`
- Prompt 架构: `docs/roundtable-prompt-architecture.html`

---

## 目标

将 Hub 圆桌从"两种模式两套 UI"重构为"一套 UI + 场景化 Prompt 注入"的正交架构。

**核心等式**: `统一 UI（卡片+终端）` + `场景切换（header toggle）` = `正交架构`

## 当前问题

1. 通用圆桌隐藏终端（`mr-terminals-hidden`），出错无法排查
2. `+` 号菜单有两个圆桌入口，用户选择成本
3. 两份 Rules 模板 80% 重复（`general-roundtable-mode.js` / `research-mode.js`）
4. Orchestrator turn prompt 硬编码 `[投研圆桌]`，通用场景也收到投研前缀
5. Summary 输出格式绑死投研（仓位/止损/`<<TITLE>>`），通用场景不适用
6. 两套平行的文件管理函数（write/read/cleanup）

## 设计

### 1. UI 统一

所有场景共享投研模式的完整 UI：卡片面板 + xterm 终端。

**删除**:
- `applyModeContainerVisibility` 中 `roundtableMode → mr-terminals-hidden` 分支 (`renderer/meeting-room.js:865-874`)
- `renderTerminals` 中 roundtable early return (`renderer/meeting-room.js:886-891`)

**结果**: 无论通用还是投研，始终渲染 `renderFocusMode`（三列终端 + 卡片面板）。

### 2. 创建入口合并

`+` 号菜单从两项合并为一项。

**文件**: `renderer/index.html:28-29`
```html
<!-- Before -->
<button data-kind="meeting" data-meeting-mode="general">🌐 通用圆桌</button>
<button data-kind="meeting" data-meeting-mode="research">📊 投研圆桌</button>

<!-- After -->
<button data-kind="meeting" data-meeting-mode="general">🎯 创建圆桌</button>
```

默认以"通用"场景创建，进入后通过 header toggle 切换场景。

**文件**: `renderer/renderer.js:1604-1660` — `createMeetingByMode` 简化为统一路径，不再 if/else 分支。

### 3. 场景切换 = 纯 Prompt 热替换

Header toggle 点击后只重新注入 prompt 文件 + 通知子进程，不触发 UI 重建（不重建终端 DOM）。

**文件**: `renderer/meeting-room.js:124-155` — mode toggle handler 简化，不再调 `renderTerminals`。

### 4. Prompt 三层拼装

```
System Prompt = BASE_RULES + Scene Preset + Covenant
```

#### 4.1 BASE_ROUNDTABLE_RULES（共享，~35行）

从两份模板提取公共部分：
- 角色定义（三家平等、本色发挥）
- 语法说明（默认提问 / @debate / @summary / @\<who\> 私聊）
- 协作礼仪
- 工具通用指引
- 留白

**关键统一**: `@<who>` 私聊语法纳入 Base Rules，投研场景也获得此能力。

#### 4.2 Scene Preset（场景专属片段）

| 场景 | 内容 | 行数 |
|------|------|------|
| 通用 | "自由讨论任意话题，按需使用全部能力" | ~5行 |
| 投研 | LinDangAgent 数据优先级 + 调用方式 + 铁律（纯读不写、探查上限2次） | ~40行 |

#### 4.3 Covenant（用户可编辑公约）

| 场景 | 默认值 |
|------|--------|
| 通用 | 空字符串 |
| 投研 | 立花道雪投研公约 v1（投资风格/红线/输出习惯） |

### 5. 场景注册表

新增 `core/roundtable-scenes.js`，用数据结构驱动：

```js
const SCENE_REGISTRY = {
  general: {
    name: '通用圆桌',
    icon: '🎯',
    preset: SCENE_GENERAL,
    defaultCovenant: '',
    mcpConfig: null,
    summaryHints: '按讨论话题自适应',
    summaryTitleTag: false,
    dataPackEnabled: false,
  },
  research: {
    name: '投研圆桌',
    icon: '📊',
    preset: SCENE_RESEARCH,
    defaultCovenant: COVENANT_TEMPLATE,
    mcpConfig: buildResearchMcpConfig,
    summaryHints: '仓位/止损/加仓/观察指标',
    summaryTitleTag: true,
    dataPackEnabled: true,
  },
};
```

新增场景只需加一条记录 + 写 preset 文本，零 UI 改动。

### 6. Orchestrator 场景感知

`RoundtableOrchestrator` 构造函数接收 `scene` 对象：

- `buildFanoutPrompt`: 前缀 `[{scene.name} · 第N轮 · 默认提问]`，`dataPackEnabled=false` 时不拼数据接入段
- `buildDebatePrompt`: 前缀 `[{scene.name} · 第N轮 · @debate]`
- `buildSummaryPrompt`: 输出建议第 3 项用 `scene.summaryHints`，`<<TITLE>>` 仅在 `scene.summaryTitleTag === true` 时拼入

### 7. 文件整合

| Before | After |
|--------|-------|
| `general-roundtable-mode.js` | 删除（内容迁入 `roundtable-scenes.js`） |
| `research-mode.js` | 删除（内容迁入 `roundtable-scenes.js`） |
| 文件管理函数 ×2 套 | `roundtable-scenes.js` 内统一一套 |
| `{id}-roundtable.md` / `{id}-research.md` | `{id}-prompt.md`（统一命名） |
| `{id}-roundtable-covenant.md` / `{id}-covenant.md` | `{id}-covenant.md`（统一命名） |

### 8. Meeting 对象简化

当前 meeting 有两个互斥 boolean（`roundtableMode` / `researchMode`），改为单一字段：

```js
// Before
{ roundtableMode: true, researchMode: false }
{ roundtableMode: false, researchMode: true }

// After
{ scene: 'general' }  // or 'research'
```

所有读 `meeting.roundtableMode` / `meeting.researchMode` 的代码改为读 `meeting.scene`。

## 不在本轮范围

- 新增其他场景（代码审查、PPT 讨论等）— 架构就绪后按需加
- summary 归档目录结构调整
- Orchestrator state 文件按场景分目录（上一轮已标记为后续）

## 验证清单

- [ ] `node --check main.js` + `node --check renderer/meeting-room.js`
- [ ] 现有单测通过：`node tests/unit-general-roundtable-mode.test.js` + `node tests/unit-roundtable-dispatch-mode.test.js`
- [ ] 新增单测：场景注册表驱动的 prompt 拼装
- [ ] E2E：隔离 Hub 实例，创建圆桌 → 通用场景有终端 → 切投研场景有终端 → 回切通用仍有终端
