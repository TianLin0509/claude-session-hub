# 圆桌架构统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Hub 圆桌从"两种模式两套 UI"重构为"一套 UI + 场景化 Prompt 注入"的正交架构。

**Architecture:** 新建 `core/roundtable-scenes.js` 作为场景注册表（SCENE_REGISTRY），统一 Base Rules + Scene Preset + Covenant 三层 prompt 拼装。Meeting 对象用 `scene: 'general'|'research'` 替换 `roundtableMode/researchMode` 双 boolean。Orchestrator 接收 scene 对象实现 turn prompt 场景感知。前端删除终端隐藏逻辑，所有场景共享卡片+终端 UI。

**Tech Stack:** Node.js, Electron IPC, xterm.js

**Spec:** `docs/superpowers/specs/2026-04-30-roundtable-unification-design.md`

---

### File Map

| Action | File | Responsibility |
|--------|------|----------------|
| **Create** | `core/roundtable-scenes.js` | SCENE_REGISTRY + BASE_RULES + 场景 preset/covenant + 统一文件管理 |
| **Create** | `tests/unit-roundtable-scenes.test.js` | 场景注册表 + prompt 拼装单测 |
| **Modify** | `core/meeting-room.js:27-175` | `scene` 字段替换 `roundtableMode/researchMode` |
| **Modify** | `core/roundtable-orchestrator.js:27-156` | 构造函数接收 scene，prompt 前缀/hints 场景化 |
| **Modify** | `main.js:21-22,442-530,739,920-958,1167-1180,1425` | IPC handlers 用 scenes API |
| **Modify** | `renderer/index.html:28-29` | 两个入口合并为一个 |
| **Modify** | `renderer/renderer.js:1604-1660` | createMeetingByMode 简化 |
| **Modify** | `renderer/meeting-room.js:22,31-69,112-155,287,415,686-696,865-895,1160-1164,1238-1242,1290-1297` | UI 统一 + scene 化 |
| **Modify** | `tests/unit-roundtable-dispatch-mode.test.js` | 适配 scene 字段 |
| **Delete** | `core/general-roundtable-mode.js` | 内容迁入 roundtable-scenes.js |
| **Delete** | `core/research-mode.js` | 内容迁入 roundtable-scenes.js |

---

### Task 1: 创建 `core/roundtable-scenes.js` — 场景注册表 + prompt 拼装

**Files:**
- Create: `core/roundtable-scenes.js`
- Create: `tests/unit-roundtable-scenes.test.js`

- [ ] **Step 1: Write failing test for BASE_RULES + SCENE_REGISTRY**

```js
// tests/unit-roundtable-scenes.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const scenes = require('../core/roundtable-scenes');

function tmpDir() {
  const d = path.join(os.tmpdir(), 'scene-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// --- BASE_RULES 内容契约 ---
function testBaseRulesContent() {
  const r = scenes.BASE_RULES;
  assert.ok(r.includes('圆桌讨论规则'), 'base rules should contain title');
  assert.ok(r.includes('@debate'), 'should mention @debate');
  assert.ok(r.includes('@summary'), 'should mention @summary');
  assert.ok(r.includes('私聊'), 'should mention private chat (unified syntax)');
  assert.ok(r.includes('协作礼仪'), 'should mention etiquette');
  assert.ok(!r.includes('LinDangAgent'), 'base rules must NOT contain scene-specific content');
  assert.ok(!r.includes('投研'), 'base rules must NOT contain scene-specific content');
  console.log('  ✓ testBaseRulesContent');
}

// --- SCENE_REGISTRY 结构 ---
function testRegistryStructure() {
  const reg = scenes.SCENE_REGISTRY;
  assert.ok(reg.general, 'must have general scene');
  assert.ok(reg.research, 'must have research scene');
  for (const [key, s] of Object.entries(reg)) {
    assert.ok(s.name, `${key}.name required`);
    assert.ok(s.icon, `${key}.icon required`);
    assert.ok(typeof s.preset === 'string', `${key}.preset must be string`);
    assert.ok(typeof s.defaultCovenant === 'string', `${key}.defaultCovenant must be string`);
    assert.ok(typeof s.summaryHints === 'string', `${key}.summaryHints required`);
    assert.ok(typeof s.summaryTitleTag === 'boolean', `${key}.summaryTitleTag required`);
    assert.ok(typeof s.dataPackEnabled === 'boolean', `${key}.dataPackEnabled required`);
  }
  assert.strictEqual(reg.general.summaryTitleTag, false);
  assert.strictEqual(reg.research.summaryTitleTag, true);
  assert.strictEqual(reg.general.dataPackEnabled, false);
  assert.strictEqual(reg.research.dataPackEnabled, true);
  console.log('  ✓ testRegistryStructure');
}

// --- 投研 preset 包含 LinDangAgent ---
function testResearchPreset() {
  const s = scenes.SCENE_REGISTRY.research;
  assert.ok(s.preset.includes('LinDangAgent'), 'research preset must mention LinDangAgent');
  assert.ok(s.preset.includes('纯读不写'), 'research preset must include read-only rule');
  assert.ok(s.defaultCovenant.includes('投资风格'), 'research default covenant must include investment style');
  console.log('  ✓ testResearchPreset');
}

// --- 通用 preset 不含投研内容 ---
function testGeneralPreset() {
  const s = scenes.SCENE_REGISTRY.general;
  assert.ok(!s.preset.includes('LinDangAgent'), 'general preset must NOT mention LinDangAgent');
  assert.strictEqual(s.defaultCovenant, '', 'general default covenant should be empty');
  console.log('  ✓ testGeneralPreset');
}

// --- buildSystemPrompt 拼装 ---
function testBuildSystemPrompt() {
  const prompt = scenes.buildSystemPrompt('general', '');
  assert.ok(prompt.includes('圆桌讨论规则'), 'has base rules');
  assert.ok(!prompt.includes('---'), 'no separator when covenant empty');

  const prompt2 = scenes.buildSystemPrompt('research', '## 自定义公约\n内容');
  assert.ok(prompt2.includes('圆桌讨论规则'), 'has base rules');
  assert.ok(prompt2.includes('LinDangAgent'), 'has research preset');
  assert.ok(prompt2.includes('---'), 'separator before covenant');
  assert.ok(prompt2.includes('自定义公约'), 'has custom covenant');
  console.log('  ✓ testBuildSystemPrompt');
}

// --- buildSystemPrompt 投研默认 covenant ---
function testBuildSystemPromptDefaultCovenant() {
  const prompt = scenes.buildSystemPrompt('research', null);
  assert.ok(prompt.includes('投资风格'), 'null covenant should fall back to scene default');
  console.log('  ✓ testBuildSystemPromptDefaultCovenant');
}

// --- writePromptFile + readCovenantSnapshot ---
function testFileManagement() {
  const d = tmpDir();
  const mid = 'meeting-test-123';

  const fp = scenes.writePromptFile(d, mid, 'general', '');
  assert.ok(fs.existsSync(fp), 'prompt file should exist');
  assert.ok(fp.endsWith(`${mid}-prompt.md`), 'unified file name');
  const content = fs.readFileSync(fp, 'utf-8');
  assert.ok(content.includes('圆桌讨论规则'), 'prompt file has base rules');

  scenes.writeCovenantSnapshot(d, mid, '测试公约');
  const restored = scenes.readCovenantSnapshot(d, mid);
  assert.strictEqual(restored, '测试公约', 'covenant round-trip');

  scenes.cleanup(d, mid);
  assert.ok(!fs.existsSync(fp), 'cleanup should delete prompt file');
  console.log('  ✓ testFileManagement');
}

// --- getScene helper ---
function testGetScene() {
  assert.ok(scenes.getScene('general'), 'getScene general');
  assert.ok(scenes.getScene('research'), 'getScene research');
  assert.strictEqual(scenes.getScene('nonexistent'), null, 'getScene unknown returns null');
  console.log('  ✓ testGetScene');
}

// --- getResumeReminder ---
function testResumeReminder() {
  const r1 = scenes.getResumeReminder('general');
  assert.ok(r1.includes('圆桌'), 'general resume reminder should mention roundtable');
  const r2 = scenes.getResumeReminder('research');
  assert.ok(r2.includes('投研'), 'research resume reminder should mention research');
  console.log('  ✓ testResumeReminder');
}

console.log('Running roundtable-scenes tests...');
testBaseRulesContent();
testRegistryStructure();
testResearchPreset();
testGeneralPreset();
testBuildSystemPrompt();
testBuildSystemPromptDefaultCovenant();
testFileManagement();
testGetScene();
testResumeReminder();
console.log('All passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/unit-roundtable-scenes.test.js`
Expected: FAIL with `Cannot find module '../core/roundtable-scenes'`

- [ ] **Step 3: Implement `core/roundtable-scenes.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Base Rules — 所有场景共享（角色 + 语法 + 礼仪 + 工具 + 留白）
// ---------------------------------------------------------------------------
const BASE_RULES = `# 圆桌讨论规则

## 你的角色
你和另外两位 AI 同事（共三家：Claude / Gemini / Codex）受邀加入用户的圆桌讨论。
**地位完全平等，本色发挥，不需要扮演角色。** 你怎么思考就怎么回答，不要套模板。

## 圆桌的运作方式
用户用以下语法驱动讨论：

1. **默认提问**：用户发普通文本 → 三家独立回答（互不知情）。这一轮你不会看到另两家在写什么。
2. **@debate 触发**：用户发 \`@debate\` 或 \`@debate <补充信息>\` → 系统会把另两家上一轮的完整观点发给你 → 请你结合他们的视角发表新观点（可继承可反驳，可纳入用户补充的新信息）。
3. **@summary @<你> 触发**：用户发 \`@summary @claude\`（或 @gemini / @codex）→ 系统会把所有历史轮次的三家观点汇总给被点名那位 → 由他给出综合意见。
4. **@<你> 私聊**：用户发 \`@claude <内容>\`（或 @gemini / @codex / 多家但非全员）→ 仅你看到，不入圆桌历史。这是用户与你的私下讨论，专注一对一即可。

⚠ 你看不到另两家观点时，不要假装你看得到。专注本色独立回答。

## 协作礼仪
- @debate 时引用对方观点请明示（"Gemini 提到的 XX..."），便于用户追溯
- 不要因为另两家观点强势就放弃自己的判断；该坚持就坚持，该改就改要说明为什么
- @summary 阶段被点到时，写成可读决策报告（结论先行 + 关键分歧 + 行动建议），不要只复读三家观点
- 私聊时不要假装其他 AI 在场，专注一对一对话

## 工具与资源
你可以使用自己已有的能力辅助回答：联网搜索、读取本地文件、运行代码、调用 MCP 工具。
能查就查，不要假装"凭印象"。但每次工具调用前评估必要性，避免无意义的探查。

## 留白
你是用户的智囊伙伴，不是答题机器。
该坚持时坚持，该改主意时改主意，信息不足时主动说"我需要 X"。
`;

// ---------------------------------------------------------------------------
// Scene Presets — 场景专属 prompt 片段
// ---------------------------------------------------------------------------
const SCENE_GENERAL = `## 场景：通用圆桌
自由讨论任意话题，按需使用你的全部能力。不限定主题和数据源。
`;

const SCENE_RESEARCH = `## 场景：投研圆桌（A 股专题）

## 数据获取（重要 · 主动查，不要等用户）

你**必须**主动获取数据，不要等用户贴数据给你。**优先级**严格如下：

### 优先级 1：LinDangAgent（用户的成熟数据层，最权威）
**位置**：\`C:\\LinDangAgent\`（用户长期维护的 A 股投研项目，五层数据兜底已封装）

怎么用（Bash / 沙箱跑代码即可，已自动批准）：
1. 先探查可用入口（最多 2 次 Bash）：
   - \`cd C:\\LinDangAgent && ls services/\` 看有没有现成 CLI
   - \`ls data/\` 看数据获取模块
2. 调用方式（任选）：
   - 找到 \`services/fetch_for_arena.py\` 等 CLI → \`python -m services.fetch_for_arena stock --symbol 603986\`
   - 直接调模块：\`python -c "from data.report_data import build_report_context; import json; print(json.dumps(build_report_context('603986'), default=str))"\`
   - 用 LinDangAgent 内置 tushare_client / fallback 拉单字段

可能的关键模块（自己看实际代码确认）：
- \`data/report_data.py::build_report_context\` — 33 字段全量
- \`data/tushare_client.py\` / \`data/fallback.py\` — 五层兜底
- \`Stock_top10/top10/hot_rank.py\` — 热门股 5 路候选
- \`Stock_top10/top10/signal.py\` — 量化信号 / 形态识别

### 优先级 2：MCP 工具（如可用）
- \`fetch_lindang_stock\` / \`fetch_concept_stocks\` / \`fetch_sector_overview\`
- 其他已批准的全局 MCP 工具

### 优先级 3：自身联网（LinDangAgent + MCP 不够时 fallback）
- WebFetch / WebSearch（Claude）/ Google Search grounding（Gemini）/ web_search（Codex）
- 适合：实时新闻 / 政策动态 / 行业景气 / 突发公告（这些 LinDangAgent 不一定有）

### 沙箱跑代码（任何家都可以）
量化指标 / 形态识别 / 数据校验：可写脚本调 akshare / tushare / 公开 API 兜底。

### 铁律
- **用户问 "怎么看 XX" 时，先按上述优先级查数据再给观点**。不要先要数据后给框架。
- **LinDangAgent 探查上限 2 次 Bash**：找不到合适入口就直接 fallback 联网，不要无限探。
- 数据**真**找不到时再明示"我尝试 LinDangAgent / 联网都失败了，需要你提供..."，但**不要默认伸手**。

⚠ **纯读不写**：不要修改 LinDangAgent 代码 / 不要 git commit / 不要删除文件 / 不要 npm install。本圆桌仅做投研讨论。如果讨论中发现需要改代码或部署，请明示并等用户确认。
`;

// ---------------------------------------------------------------------------
// Default Covenants
// ---------------------------------------------------------------------------
const COVENANT_RESEARCH = `# 立花道雪投研圆桌 · 房间公约 v1

## 我们能讨论什么
任何 A 股投研话题：
- 个股决策："今天能不能买入兆易创新？"
- 概念→选股："最近 DDR5 概念很火，找最正宗的标的"
- 板块研判："半导体板块后续怎么走？"
- 复盘："今天高位股集体回调，怎么看？"
- 宏观："美联储议息对成长股影响？"
- 持仓建议："我现在的持仓结构有什么问题？"

⚠ **问什么样的问题，给什么样的回答**。不要把所有问题都套同一套模板。

## 我的投资风格（参考，不强制套用）
- 基本面强 + 题材正宗（不蹭概念）+ 短期启动趋势已立（放量突破、均线多头）
- 风险偏好：中性偏稳，单股仓位通常 1-3 万

## 我重点关注（看具体问题类型自己取舍）
基本面、预期差、资金面、技术面 — 大致权重 15% / 35% / 30% / 20%
- 单股决策：偏向资金面 / 技术面 / 预期差
- 板块研判：偏向行业景气 / 资金流向 / 政策催化
- 概念选股：强调"正宗度"（核心受益度，不是蹭概念）

## 红线（任何讨论都要避开）
- 非行业龙头硬蹭概念（除非有独家技术 / 议价能力证据）
- 技术明显走坏（破关键支撑、量价背离）
- 监管 / 财务造假风险

## 输出习惯（建议，不强制）
- 关键结论先行（推荐 / 不推荐 / 中性 / 观望）
- 必要时附推理路径，不需要套八股
- 量化指标尽量给具体数字，定性判断尽量给参照系
- 不必非要给"决策" — 有时把问题想清楚就够了

## 留白
你是我的投研伙伴，不是工具。
该坚持时坚持，该改主意时改主意。
信息不足时主动说"我需要 X 数据"，不要硬猜。
`;

// ---------------------------------------------------------------------------
// Scene Registry
// ---------------------------------------------------------------------------
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
    defaultCovenant: COVENANT_RESEARCH,
    mcpConfig: 'research',
    summaryHints: '仓位/止损/加仓/观察指标',
    summaryTitleTag: true,
    dataPackEnabled: true,
  },
};

function getScene(sceneKey) {
  return SCENE_REGISTRY[sceneKey] || null;
}

function getSceneKeys() {
  return Object.keys(SCENE_REGISTRY);
}

// ---------------------------------------------------------------------------
// Resume Reminders
// ---------------------------------------------------------------------------
const RESUME_REMINDERS = {
  general: `[系统提醒] 你正在通用圆桌中恢复会话。请继续遵守以下规则：
- 三家平等本色发挥，不扮演角色
- 用户驱动语法：默认提问（独立回答）/ @debate（看对方观点后再发）/ @summary @<你>（综合）/ @<你> 私聊（一对一）
- 善用你的工具（联网/读文件/跑代码/MCP）辅助回答
`,
  research: `[系统提醒] 你正在投研圆桌（Research Roundtable）中恢复会话。请继续遵守以下规则：
- 你和另外两位 AI（Gemini/Codex）地位平等，本色发挥
- 用户驱动语法：默认提问（独立回答）/ @debate（看对方观点后再发）/ @summary @<你>（综合给最终意见）/ @<你> 私聊
- 数据获取：优先用 MCP 工具 fetch_lindang_stock / fetch_concept_stocks / fetch_sector_overview
- 实时信息可用自己的联网能力；量化可用沙箱跑代码（不要乱改本地代码）
`,
};

function getResumeReminder(sceneKey) {
  return RESUME_REMINDERS[sceneKey] || RESUME_REMINDERS.general;
}

// ---------------------------------------------------------------------------
// Prompt Assembly — System Prompt = BASE_RULES + Scene Preset + Covenant
// ---------------------------------------------------------------------------
function buildSystemPrompt(sceneKey, covenantText) {
  const scene = getScene(sceneKey);
  if (!scene) return BASE_RULES;
  const covenant = (typeof covenantText === 'string' && covenantText.trim().length > 0)
    ? covenantText
    : (scene.defaultCovenant || '');
  const parts = [BASE_RULES, scene.preset];
  if (covenant.trim().length > 0) {
    parts.push('---\n\n' + covenant);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Prompt File Management (unified)
// ---------------------------------------------------------------------------
function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writePromptFile(hubDataDir, meetingId, sceneKey, covenantText) {
  const dir = arenaPromptsDir(hubDataDir);
  _ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-prompt.md`);
  const content = buildSystemPrompt(sceneKey, covenantText);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeCovenantSnapshot(hubDataDir, meetingId, covenantText) {
  const dir = arenaPromptsDir(hubDataDir);
  _ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-covenant.md`);
  fs.writeFileSync(filePath, covenantText || '', 'utf-8');
  return filePath;
}

function readCovenantSnapshot(hubDataDir, meetingId) {
  const filePath = path.join(arenaPromptsDir(hubDataDir), `${meetingId}-covenant.md`);
  if (!fs.existsSync(filePath)) return null;
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function cleanup(hubDataDir, meetingId) {
  const dir = arenaPromptsDir(hubDataDir);
  if (!fs.existsSync(dir)) return;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${meetingId}-`)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// MCP Config (research scene only — delegated from old research-mode.js)
// ---------------------------------------------------------------------------
function writeResearchMcpConfig(hubDataDir, meetingId, hookPort, hookToken, aiKind) {
  const dir = arenaPromptsDir(hubDataDir);
  _ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-research-mcp.json`);
  const mcpServerPath = path.resolve(__dirname, 'research-mcp-server.js');
  const config = {
    mcpServers: {
      'arena-research': {
        command: process.execPath,
        args: [mcpServerPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          ARENA_MEETING_ID: meetingId,
          ARENA_HUB_PORT: String(hookPort),
          ARENA_HOOK_TOKEN: hookToken,
          ARENA_AI_KIND: aiKind || 'unknown',
        },
      },
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  return filePath;
}

function buildResearchMcpEntryForCodex(meetingId, hookPort, hookToken) {
  const mcpServerPath = path.resolve(__dirname, 'research-mcp-server.js');
  return {
    name: 'arena_research',
    command: process.execPath,
    args: [mcpServerPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ARENA_MEETING_ID: meetingId,
      ARENA_HUB_PORT: String(hookPort),
      ARENA_HOOK_TOKEN: hookToken,
      ARENA_AI_KIND: 'codex',
    },
  };
}

module.exports = {
  BASE_RULES,
  SCENE_REGISTRY,
  COVENANT_RESEARCH,
  getScene,
  getSceneKeys,
  getResumeReminder,
  buildSystemPrompt,
  writePromptFile,
  writeCovenantSnapshot,
  readCovenantSnapshot,
  cleanup,
  writeResearchMcpConfig,
  buildResearchMcpEntryForCodex,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/unit-roundtable-scenes.test.js`
Expected: All 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/roundtable-scenes.js tests/unit-roundtable-scenes.test.js
git commit -m "feat: add roundtable-scenes.js — scene registry + unified prompt assembly"
```

---

### Task 2: 更新 `core/meeting-room.js` — `scene` 字段替换双 boolean

**Files:**
- Modify: `core/meeting-room.js:27-175`
- Modify: `tests/unit-roundtable-dispatch-mode.test.js`
- Modify: `tests/unit-general-roundtable-mode.test.js:131-155`

- [ ] **Step 1: Update `core/meeting-room.js`**

Key changes to `createMeeting` (line 37-42):
```js
// Before:
//   researchMode: mode === 'research',
//   roundtableMode: mode === 'general',
//   generalRoundtableCovenant: '',
// After:
      scene: MEETING_MODES.includes(mode) ? mode : 'general',
      covenantText: '',
```

Add near top of file:
```js
const MEETING_MODES = ['general', 'research'];
```

Update `updateMeeting` (line 101-130):
```js
// Replace the roundtableMode/researchMode mutex logic with:
const allowed = [
  'title', 'layout', 'focusedSub', 'syncContext', 'sendTarget', 'pinned',
  'lastMessageTime', 'status', 'lastScene', 'scene', 'covenantText',
];
for (const key of allowed) {
  if (key in fields) m[key] = fields[key];
}
if (fields.scene && !MEETING_MODES.includes(fields.scene)) {
  throw new Error(`Invalid scene: ${fields.scene}`);
}
```

Update `restoreMeeting` (line 145-175):
```js
// Convert legacy roundtableMode/researchMode → scene
let scene = meetingData.scene;
if (!scene) {
  if (meetingData.researchMode) scene = 'research';
  else scene = 'general'; // fallback covers old driverMode too
}
// ... assign scene to meeting object
```

Update `isRoundtableCapableMeeting` (line 273):
```js
function isRoundtableCapableMeeting(meeting) {
  return !!(meeting && meeting.scene);
}
```

Export `MEETING_MODES`.

- [ ] **Step 2: Update tests**

Update `tests/unit-roundtable-dispatch-mode.test.js`:
- Change all `roundtableMode/researchMode` checks to `scene` checks
- `testRealCreatedMeetingIsCapable`: assert `m.scene === 'general'`
- `testCreateMeetingMenuContract`: change to check for single `data-meeting-mode="general"` entry, remove check for `data-meeting-mode="research"` (will be a toggle now)
- `testRendererCreateMeetingByMode`: adapt to simplified flow

Update `tests/unit-general-roundtable-mode.test.js`:
- Mode mutex test: `updateMeeting(m.id, { scene: 'research' })` → check `m.scene === 'research'`
- Remove `roundtableMode`/`researchMode` assertions, replace with `scene` assertions

- [ ] **Step 3: Run tests**

Run: `node tests/unit-roundtable-dispatch-mode.test.js && node tests/unit-general-roundtable-mode.test.js`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add core/meeting-room.js tests/unit-roundtable-dispatch-mode.test.js tests/unit-general-roundtable-mode.test.js
git commit -m "refactor: meeting-room.js uses scene field instead of roundtableMode/researchMode"
```

---

### Task 3: 更新 `core/roundtable-orchestrator.js` — 场景感知 prompt

**Files:**
- Modify: `core/roundtable-orchestrator.js:27-156`

- [ ] **Step 1: Add scene parameter to constructor and prompt methods**

```js
class RoundtableOrchestrator {
  constructor(hubDataDir, meetingId, scene) {
    this.hubDataDir = hubDataDir;
    this.meetingId = meetingId;
    this.scene = scene || { name: '圆桌', summaryHints: '', summaryTitleTag: false, dataPackEnabled: false };
    // ... rest unchanged
  }

  buildFanoutPrompt(turnNum, userInput, dataPack) {
    const parts = [`[${this.scene.name} · 第 ${turnNum} 轮 · 默认提问]`];
    if (this.scene.dataPackEnabled && dataPack && typeof dataPack === 'string' && dataPack.trim().length > 0) {
      parts.push('', '## 数据接入（Hub 自动从 LinDangAgent 拉取）', dataPack);
    }
    // ... rest unchanged
  }

  buildDebatePrompt(turnNum, userInput, lastTurn, targetSid, sidLabelFn) {
    const parts = [`[${this.scene.name} · 第 ${turnNum} 轮 · @debate]`, ''];
    // ... rest unchanged
  }

  buildSummaryPrompt(turnNum, summarizerSid, sidLabelFn) {
    // ... change prefix
    const parts = [`[${this.scene.name} · 第 ${turnNum} 轮 · @summary @${summarizerLabel}]`, ''];
    // ... change output hints
    parts.push(`  3) 具体行动建议（${this.scene.summaryHints}）`);
    if (this.scene.summaryTitleTag) {
      parts.push('  4) 在末尾用 `<<TITLE: xxx>>` 标记本次会话简短标题（用于决策档案命名）');
    }
    // ... rest unchanged
  }
}
```

Update `getOrchestrator` to accept scene:
```js
function getOrchestrator(hubDataDir, meetingId, scene) {
  const key = `${hubDataDir}::${meetingId}`;
  if (!_pool.has(key)) _pool.set(key, new RoundtableOrchestrator(hubDataDir, meetingId, scene));
  const orch = _pool.get(key);
  if (scene) orch.scene = scene; // update scene on re-get (user may have switched)
  return orch;
}
```

- [ ] **Step 2: Run syntax check**

Run: `node --check core/roundtable-orchestrator.js`
Expected: No error.

- [ ] **Step 3: Commit**

```bash
git add core/roundtable-orchestrator.js
git commit -m "refactor: orchestrator accepts scene for prompt prefix + summaryHints"
```

---

### Task 4: 更新 `main.js` — IPC handlers 用 scenes API

**Files:**
- Modify: `main.js:21-22,442-530,739,920-958,1167-1180,1425`

- [ ] **Step 1: Update imports (line 21-22)**

```js
// Before:
// const researchMode = require('./core/research-mode.js');
// const generalRoundtableMode = require('./core/general-roundtable-mode.js');
// After:
const scenes = require('./core/roundtable-scenes.js');
```

- [ ] **Step 2: Update `add-meeting-sub` handler (line 442-499)**

Replace the entire `if (meeting.researchMode) { ... } else if (meeting.roundtableMode) { ... }` block:

```js
if (meeting && meeting.scene) {
  const hubDataDir = getHubDataDir();
  const sceneObj = scenes.getScene(meeting.scene);
  const covenantText = (typeof meeting.covenantText === 'string')
    ? meeting.covenantText
    : scenes.readCovenantSnapshot(hubDataDir, meetingId);
  if (covenantText && covenantText.trim().length > 0) {
    scenes.writeCovenantSnapshot(hubDataDir, meetingId, covenantText);
  }
  const promptFile = scenes.writePromptFile(hubDataDir, meetingId, meeting.scene, covenantText);
  if (kind === 'claude') {
    sessionOpts.appendSystemPromptFile = promptFile;
    if (sceneObj && sceneObj.mcpConfig === 'research' && hookPort) {
      sessionOpts.mcpConfigFile = scenes.writeResearchMcpConfig(hubDataDir, meetingId, hookPort, HOOK_TOKEN, 'claude');
    }
  } else if (kind === 'gemini') {
    sessionOpts.extraEnv = { GEMINI_SYSTEM_MD: promptFile };
  } else if (kind === 'codex') {
    sessionOpts.codexInstructionFile = promptFile;
    sessionOpts.codexBypassApprovals = true;
    if (sceneObj && sceneObj.mcpConfig === 'research' && hookPort) {
      sessionOpts.codexMcpEntries = [scenes.buildResearchMcpEntryForCodex(meetingId, hookPort, HOOK_TOKEN)];
    }
  }
}
```

- [ ] **Step 3: Update `close-meeting` handler (line 523-533)**

```js
// Before:
// researchMode.cleanupResearchFiles(getHubDataDir(), meetingId);
// generalRoundtableMode.cleanupGeneralRoundtableFiles(getHubDataDir(), meetingId);
// After:
scenes.cleanup(getHubDataDir(), meetingId);
```

- [ ] **Step 4: Update archive title (line 739)**

```js
// Before:
// const archiveTitle = meeting.researchMode ? '# 投研圆桌决策档案' : '# 圆桌讨论决策档案';
// After:
const sceneObj = scenes.getScene(meeting.scene);
const archiveTitle = meeting.scene === 'research' ? '# 投研圆桌决策档案' : '# 圆桌讨论决策档案';
```

- [ ] **Step 5: Update `get-research-covenant-template` IPC (line 922)**

```js
// Before:
// ipcMain.handle('get-research-covenant-template', () => researchMode.COVENANT_TEMPLATE);
// After:
ipcMain.handle('get-scene-covenant', (_e, sceneKey) => {
  const s = scenes.getScene(sceneKey || 'research');
  return s ? s.defaultCovenant : '';
});
```

- [ ] **Step 6: Update `toggle-roundtable-mode` → `switch-scene` IPC (line 930-958)**

```js
// Rename handler, keep old name as alias for backward compat during transition
ipcMain.handle('switch-scene', (_e, { meetingId, scene, covenant } = {}) => {
  if (!_isValidMeetingId(meetingId)) return { ok: false, error: 'invalid meetingId' };
  if (!scenes.getScene(scene)) return { ok: false, error: `invalid scene: ${scene}` };
  const m = meetingManager.getMeeting(meetingId);
  if (!m) return { ok: false, error: 'meeting not found' };
  const fields = { scene };
  if (typeof covenant === 'string') fields.covenantText = covenant;
  let updated;
  try { updated = meetingManager.updateMeeting(meetingId, fields); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!updated) return { ok: false, error: 'update failed' };
  const text = typeof covenant === 'string' ? covenant : (updated.covenantText || '');
  try {
    scenes.writeCovenantSnapshot(getHubDataDir(), meetingId, text);
    scenes.writePromptFile(getHubDataDir(), meetingId, scene, text);
  } catch (e) {
    console.warn(`[switch-scene] write prompt files failed: ${e.message}`);
  }
  sendToRenderer('meeting-updated', { meeting: updated });
  return { ok: true, meeting: updated };
});
```

- [ ] **Step 7: Update resume handler (line 1167-1180)**

```js
// Before: if (meeting.researchMode) { ... } else if (meeting.roundtableMode) { ... }
// After:
if (meeting && meeting.scene) {
  const hubDataDir = getHubDataDir();
  const covenantText = (typeof meeting.covenantText === 'string' && meeting.covenantText.length > 0)
    ? meeting.covenantText
    : scenes.readCovenantSnapshot(hubDataDir, meta.meetingId);
  promptFile = scenes.writePromptFile(hubDataDir, meta.meetingId, meeting.scene, covenantText);
}
```

- [ ] **Step 8: Update `isResearchFetch` guard (line 1425)**

```js
// Before: if (!meeting || !meeting.researchMode)
// After:
if (!meeting || meeting.scene !== 'research')
```

- [ ] **Step 9: Update orchestrator call sites**

Wherever `getOrchestrator(hubDataDir, meetingId)` is called, pass the scene:
```js
const sceneObj = scenes.getScene(meeting.scene);
const orch = roundtable.getOrchestrator(getHubDataDir(), meetingId, sceneObj);
```

- [ ] **Step 10: Run syntax check**

Run: `node --check main.js`
Expected: No error.

- [ ] **Step 11: Commit**

```bash
git add main.js
git commit -m "refactor: main.js IPC handlers use scenes API, drop old mode modules"
```

---

### Task 5: 更新前端 — 入口合并 + 创建流程简化

**Files:**
- Modify: `renderer/index.html:28-29`
- Modify: `renderer/renderer.js:1604-1660`

- [ ] **Step 1: Merge menu entries in `renderer/index.html`**

```html
<!-- Before (line 28-29): -->
<!-- <button class="new-session-option" data-kind="meeting" data-meeting-mode="general">🌐 通用圆桌</button> -->
<!-- <button class="new-session-option" data-kind="meeting" data-meeting-mode="research">📊 投研圆桌</button> -->

<!-- After: -->
<button class="new-session-option" data-kind="meeting" data-meeting-mode="general">🎯 创建圆桌</button>
```

- [ ] **Step 2: Simplify `createMeetingByMode` in `renderer/renderer.js`**

```js
async function createMeetingByMode(mode) {
  let meeting;
  try {
    meeting = await ipcRenderer.invoke('create-meeting', { mode: mode || 'general' });
  } catch (e) {
    console.error('[create-meeting] failed:', e.message);
    return;
  }
  if (!meeting) return;

  // 统一：通过 switch-scene 写 prompt/covenant 文件
  try {
    const res = await ipcRenderer.invoke('switch-scene', {
      meetingId: meeting.id,
      scene: meeting.scene || 'general',
    });
    if (res && res.meeting) Object.assign(meeting, res.meeting);
  } catch (e) {
    console.error('[create-meeting] switch-scene failed:', e.message);
  }

  meetings[meeting.id] = meeting;
  for (const kind of ['claude', 'gemini', 'codex']) {
    try {
      const result = await ipcRenderer.invoke('add-meeting-sub', { meetingId: meeting.id, kind });
      if (result && result.meeting) meetings[meeting.id] = result.meeting;
    } catch (e) {
      console.error(`[create-meeting] add-sub ${kind} failed:`, e.message);
    }
  }
  selectMeeting(meeting.id);
  renderSessionList();
  schedulePersist();
}
```

- [ ] **Step 3: Update `get-research-covenant-template` call if it exists**

Search renderer for `get-research-covenant-template` and change to `get-scene-covenant`.

- [ ] **Step 4: Run syntax check**

Run: `node --check renderer/renderer.js`
Expected: No error.

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html renderer/renderer.js
git commit -m "refactor: single roundtable entry + simplified createMeetingByMode"
```

---

### Task 6: 更新 `renderer/meeting-room.js` — UI 统一 + scene 化

**Files:**
- Modify: `renderer/meeting-room.js` (multiple sections)

This is the largest single task. Changes by section:

- [ ] **Step 1: Update `_isPanelCapableMeeting` (line 22)**

```js
// Before: return !!(m && (m.researchMode || m.roundtableMode));
// After:
function _isPanelCapableMeeting(m) {
  return !!(m && m.scene);
}
```

- [ ] **Step 2: Unify `parseRoundtableCommand` (line 27-69)**

The two branches (researchMode / roundtableMode) are nearly identical — unify:

```js
function parseRoundtableCommand(text, meeting) {
  if (!meeting || !meeting.scene) return { type: 'normal', text, targets: null };
  let rest = text.trim();
  const summaryRe = /^@summary\s+@(claude|gemini|codex)\b\s*/i;
  const debateRe = /^@debate\b\s*/i;
  let m;
  if ((m = rest.match(summaryRe))) {
    return { type: 'rt-summary', summarizerKind: m[1].toLowerCase(), text: rest.slice(m[0].length) };
  }
  if ((m = rest.match(debateRe))) {
    return { type: 'rt-debate', text: rest.slice(m[0].length) };
  }
  const allRe = /^@all\b\s*/i;
  if ((m = rest.match(allRe))) {
    return { type: 'rt-fanout', text: rest.slice(m[0].length) };
  }
  // @<who> 单家或多家但非全员 → 私聊
  const targets = [];
  const tokenRe = /^@(claude|gemini|codex)\b\s*/i;
  while (true) {
    const t = rest.match(tokenRe);
    if (!t) break;
    targets.push(t[1].toLowerCase());
    rest = rest.slice(t[0].length);
  }
  if (targets.length > 0 && targets.length < 3) {
    return { type: 'rt-private', targets, text: rest };
  }
  return { type: 'rt-fanout', text: rest };
}
```

- [ ] **Step 3: Update mode toggle `_renderModeToggle` (line 112-155)**

```js
function _renderModeToggle(meeting) {
  if (!meeting) return '';
  const current = meeting.scene || 'general';
  // 动态生成 toggle 按钮（从场景注册表读取 — 但前端无法 require node 模块，
  // 所以硬编码两个已知场景，扩展时同步）
  return `
    <div class="mr-mode-toggle" role="radiogroup" aria-label="会议场景">
      <button type="button" class="mr-mode-btn ${current === 'general' ? 'active' : ''}" data-scene="general" title="通用圆桌：三家平等讨论">圆桌</button>
      <button type="button" class="mr-mode-btn ${current === 'research' ? 'active' : ''}" data-scene="research" title="投研圆桌：A 股专题">投研</button>
    </div>
  `;
}

function _bindModeToggle(rootEl, meeting) {
  if (!rootEl || !meeting) return;
  rootEl.querySelectorAll('.mr-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const scene = btn.getAttribute('data-scene');
      if (!scene || scene === meeting.scene) return;
      try {
        const res = await ipcRenderer.invoke('switch-scene', { meetingId: meeting.id, scene });
        if (res && !res.ok) console.warn('[mode-toggle] switch-scene failed:', res.error);
      } catch (e) {
        console.warn('[mode-toggle] click failed:', e.message);
      }
    });
  });
}
```

- [ ] **Step 4: Update panel title (line 287)**

```js
// Before: const titleText = meeting && meeting.researchMode ? '投研圆桌' : '圆桌讨论';
// After:
const titleText = meeting && meeting.scene === 'research' ? '投研圆桌' : '圆桌讨论';
```

- [ ] **Step 5: Update private tab visibility (line 413-415)**

```js
// Before: const showsPrivate = !!(meeting && meeting.roundtableMode);
// After: all scenes support private chat now
const showsPrivate = !!(meeting && meeting.scene);
```

- [ ] **Step 6: Update meeting-updated handler (line 686-696)**

```js
// Before: checks roundtableMode/researchMode changes for DOM rebuild
// After: check scene change
const modeChanged = prev && (prev.scene !== updated.scene);
if (prevSubs !== newSubs || modeChanged) {
  renderTerminals(updated);
  setupInput(updated);
}
```

- [ ] **Step 7: Remove terminal hiding logic (line 865-895)**

```js
function applyModeContainerVisibility(meeting, container) {
  if (!container) return;
  // 统一 UI：所有场景都显示终端
  container.classList.remove('mr-terminals-hidden');
}

function renderTerminals(meeting) {
  const container = terminalsEl();
  if (!container) return;
  for (const cached of Object.values(subTerminals)) {
    if (cached && cached.container && cached.container.parentElement) {
      cached.container.parentElement.removeChild(cached.container);
    }
  }
  container.innerHTML = '';
  applyModeContainerVisibility(meeting, container);
  // 所有场景统一走 renderFocusMode
  container.className = 'mr-terminals focus-mode';
  subTerminals = {};
  renderFocusMode(meeting, container);
}
```

- [ ] **Step 8: Update layout toggle (line 1160-1164)**

```js
// Before: if (meeting.roundtableMode) { return; }
// After: all scenes use same layout, remove the block entirely
// (or keep it but never block):
function setLayout(meetingId, layout) {
  const meeting = meetingData[meetingId];
  if (!meeting) return;
  meeting.layout = layout;
  // ... rest unchanged
}
```

- [ ] **Step 9: Update input placeholder (line 1238-1242)**

```js
// Before: meeting.researchMode ? ... : (meeting.roundtableMode ? ... : ...)
// After:
inputBox.dataset.placeholder = meeting.scene
  ? '圆桌讨论：发普通文本启动一轮 / @debate / @summary @<who> / @<who> 单聊'
  : '输入消息...';
```

- [ ] **Step 10: Update sendTarget logic (line 1290-1297)**

```js
// Before: if (!m.researchMode && !m.roundtableMode)
// After:
if (!m.scene) {
  const sel = document.getElementById('mr-input-target');
  if (sel) m.sendTarget = sel.value;
} else {
  m.sendTarget = 'all';
}
```

- [ ] **Step 11: Run syntax check**

Run: `node --check renderer/meeting-room.js`
Expected: No error.

- [ ] **Step 12: Commit**

```bash
git add renderer/meeting-room.js
git commit -m "refactor: meeting-room.js unified UI — all scenes show terminals + cards"
```

---

### Task 7: 删除旧文件 + 最终测试

**Files:**
- Delete: `core/general-roundtable-mode.js`
- Delete: `core/research-mode.js`
- Modify: `tests/unit-general-roundtable-mode.test.js` (rewrite imports)

- [ ] **Step 1: Delete old mode files**

```bash
git rm core/general-roundtable-mode.js core/research-mode.js
```

- [ ] **Step 2: Update `tests/unit-general-roundtable-mode.test.js`**

This test file tests meeting-room.js CRUD + `general-roundtable-private-store.js`.

Remove the `require('../core/general-roundtable-mode')` import and all tests that tested the old module's exports. Keep the meeting-room CRUD tests but update them to use `scene` field:

```js
// Replace: const grm = require('../core/general-roundtable-mode');
// With:
const scenes = require('../core/roundtable-scenes');
```

Update all assertions: `roundtableMode`→`scene === 'general'`, `researchMode`→`scene === 'research'`.

- [ ] **Step 3: Run ALL tests**

```bash
node tests/unit-roundtable-scenes.test.js
node tests/unit-roundtable-dispatch-mode.test.js
node tests/unit-general-roundtable-mode.test.js
node --check main.js
node --check renderer/meeting-room.js
node --check renderer/renderer.js
```

Expected: All pass, no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete old mode modules, finalize roundtable unification"
```

---

### Task 8: E2E 验证（隔离 Hub 实例）

**Files:** None (verification only)

- [ ] **Step 1: 启动隔离实例**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\Users\lintian\.tmp-hub-roundtable-unify"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9226
```

- [ ] **Step 2: 验证清单**

1. `+` 号菜单只有一个"创建圆桌"入口
2. 创建圆桌 → 默认通用场景 → 卡片面板+终端都显示
3. Header toggle 切换到"投研" → 终端仍然显示，prompt 文件名变更
4. 切回"圆桌" → 终端仍然显示
5. 普通文本输入触发 fanout → 三家回答出现在卡片面板 + 终端同步输出
6. `@<who>` 私聊在两个场景都可用

- [ ] **Step 3: 截图保存 + 汇报**

截图保存到 `C:\Users\lintian\.claude-session-hub\images\` 并输出绝对路径。

- [ ] **Step 4: 关闭隔离实例**
