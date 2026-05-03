# PackyAPI 多模型 Session 实施计划（GPT 5.5 / Kimi K2.5 / Qwen 3.6 Plus）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Hub 里新增 3 个 session kind（gpt / kimi / qwen），通过 PackyAPI 的 Anthropic 协议翻译让 Claude Code 直接跑这些非 Claude 模型，体验跟现有 DeepSeek / GLM session 完全对称。

**Architecture:** 照搬 deepseek/glm 模式：spawn `claude` CLI + 注入 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CONFIG_DIR` env + 启动命令带 `--model`。3 个新 kind 在 `core/ai-kinds.js` 集中真理源里追加，`core/session-manager.js` 加 3 段并列分支，`core/hub-config.js` 加 3 段 providers 配置，`renderer/index.html` + `renderer/renderer.js` 加 3 套 UI（菜单项 + 配置卡片）。

**Tech Stack:** Node.js / Electron / vanilla JS DOM (renderer) / 既有 CLI: `claude`（Anthropic SDK 客户端） / PackyAPI 服务端协议翻译

**Spec:** `docs/superpowers/specs/2026-05-03-packy-sessions-design.md`

**Worktree:** `C:\Users\lintian\claude-session-hub-feat-packy` 分支 `feat/packy-sessions`

---

## Task 1: 扩展 `core/ai-kinds.js` 集中真理源

**Files:**
- Modify: `core/ai-kinds.js:23-35`（追加 3 个 kind）
- Modify: `core/ai-kinds.js:45,53`（追加家族成员）
- Modify: `tests/unit-ai-kinds-no-hardcode.test.js:131-148`（断言 3 个新 kind 在）

- [ ] **Step 1: 先改 unit 测试加 3 个新 kind 的断言（让测试先红）**

修改 `tests/unit-ai-kinds-no-hardcode.test.js` 的 `testAiKindsModuleExportsContract` 函数（第 128-171 行）：

```js
function testAiKindsModuleExportsContract() {
  const m = require('../core/ai-kinds');

  assert.ok(Array.isArray(m.ALL_AI_KINDS), 'ALL_AI_KINDS 必须是数组');
  // 当前应包含 8 家
  for (const k of ['claude', 'gemini', 'codex', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen']) {
    assert.ok(m.ALL_AI_KINDS.includes(k), `ALL_AI_KINDS 必须包含 ${k}`);
  }

  assert.ok(Array.isArray(m.CLAUDE_FAMILY), 'CLAUDE_FAMILY 必须是数组');
  for (const k of ['claude', 'claude-resume', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen']) {
    assert.ok(m.CLAUDE_FAMILY.includes(k), `CLAUDE_FAMILY 必须包含 ${k}`);
  }
  assert.ok(!m.CLAUDE_FAMILY.includes('gemini'), 'CLAUDE_FAMILY 不应包含 gemini');
  assert.ok(!m.CLAUDE_FAMILY.includes('codex'), 'CLAUDE_FAMILY 不应包含 codex');

  assert.ok(Array.isArray(m.PASTE_SENSITIVE_KINDS), 'PASTE_SENSITIVE_KINDS 必须是数组');
  // 8 家 AI 都是 TUI alt-screen，全在列表
  for (const k of ['claude', 'gemini', 'codex', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen']) {
    assert.ok(m.PASTE_SENSITIVE_KINDS.includes(k), `PASTE_SENSITIVE_KINDS 必须含 ${k}`);
  }
  // powershell 等普通 shell 不应在列表
  assert.ok(!m.PASTE_SENSITIVE_KINDS.includes('powershell'), 'PASTE_SENSITIVE_KINDS 不应含 powershell');

  assert.strictEqual(m.isClaudeFamily('deepseek'), true);
  assert.strictEqual(m.isClaudeFamily('glm'), true);
  assert.strictEqual(m.isClaudeFamily('gpt'), true);
  assert.strictEqual(m.isClaudeFamily('kimi'), true);
  assert.strictEqual(m.isClaudeFamily('qwen'), true);
  assert.strictEqual(m.isClaudeFamily('claude'), true);
  assert.strictEqual(m.isClaudeFamily('gemini'), false);
  assert.strictEqual(m.isClaudeFamily('codex'), false);

  assert.strictEqual(m.isPasteSensitive('deepseek'), true);
  assert.strictEqual(m.isPasteSensitive('claude'), true);
  assert.strictEqual(m.isPasteSensitive('gpt'), true);
  assert.strictEqual(m.isPasteSensitive('kimi'), true);
  assert.strictEqual(m.isPasteSensitive('qwen'), true);
  assert.strictEqual(m.isPasteSensitive('powershell'), false);

  assert.strictEqual(typeof m.listKindsForPrompt(), 'string');
  assert.ok(m.listKindsForPrompt().includes('DeepSeek'));
  assert.ok(m.listKindsForPrompt().includes('GLM'));
  assert.ok(m.listKindsForPrompt().includes('GPT'));
  assert.ok(m.listKindsForPrompt().includes('Kimi'));
  assert.ok(m.listKindsForPrompt().includes('Qwen'));

  assert.strictEqual(typeof m.kindRegexAlternation(), 'string');
  assert.ok(m.kindRegexAlternation().includes('deepseek'));
  assert.ok(m.kindRegexAlternation().includes('glm'));
  assert.ok(m.kindRegexAlternation().includes('gpt'));
  assert.ok(m.kindRegexAlternation().includes('kimi'));
  assert.ok(m.kindRegexAlternation().includes('qwen'));

  console.log('  ✓ testAiKindsModuleExportsContract');
}
```

- [ ] **Step 2: 运行测试看它失败**

```bash
cd /c/Users/lintian/claude-session-hub-feat-packy && node tests/unit-ai-kinds-no-hardcode.test.js
```

期望：`testAiKindsModuleExportsContract` 失败，因为 ALL_AI_KINDS 还不含 gpt/kimi/qwen。

- [ ] **Step 3: 修改 `core/ai-kinds.js` 让测试通过**

替换第 23 行：

```js
const ALL_AI_KINDS = ['claude', 'gemini', 'codex', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen'];
```

替换第 29-35 行的 `KIND_LABELS` 对象：

```js
const KIND_LABELS = {
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  gpt: 'GPT',
  kimi: 'Kimi',
  qwen: 'Qwen',
};
```

替换第 45 行的 `CLAUDE_FAMILY`：

```js
const CLAUDE_FAMILY = ['claude', 'claude-resume', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen'];
```

替换第 53 行的 `PASTE_SENSITIVE_KINDS`：

```js
const PASTE_SENSITIVE_KINDS = ['claude', 'claude-resume', 'gemini', 'codex', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen'];
```

更新第 38-44 行的家族注释（追加新 kind 的隔离目录）：

```js
// ---------------------------------------------------------------------------
// Claude 家族（共享 Claude Code CLI 引擎）：
//   - claude         主 Claude（~/.claude）
//   - claude-resume  resume 路径（同主）
//   - deepseek       走 ~/.claude-deepseek 隔离配置
//   - glm            走 ~/.claude-glm 隔离配置
//   - gpt            走 ~/.claude-packy-gpt 隔离配置（PackyAPI 协议翻译，跑 GPT-5.5 等）
//   - kimi           走 ~/.claude-packy-kimi 隔离配置（PackyAPI bailian 分组，跑 kimi-k2.5）
//   - qwen           走 ~/.claude-packy-qwen 隔离配置（PackyAPI bailian 分组，跑 qwen3.6-plus）
// 共享：transcript JSONL shape / Stop hook / OSC title 协议 / system prompt 注入参数 (--append-system-prompt)
// ---------------------------------------------------------------------------
```

- [ ] **Step 4: 运行测试看它通过**

```bash
cd /c/Users/lintian/claude-session-hub-feat-packy && node tests/unit-ai-kinds-no-hardcode.test.js
```

期望：3 passed, 0 failed。但 `testKeyCallsitesUseAiKindsHelpers` 不会被触发（它只检查现有调用点，对新 kind 透明），`testNoHardcodedAiArrays` 也不会增加新违规。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/lintian/claude-session-hub-feat-packy
git add core/ai-kinds.js tests/unit-ai-kinds-no-hardcode.test.js
git commit -m "feat(ai-kinds): 注册 gpt/kimi/qwen 三种 PackyAPI session kind

加入 ALL_AI_KINDS / KIND_LABELS / CLAUDE_FAMILY / PASTE_SENSITIVE_KINDS
（都跑在 Claude CLI 上、TUI alt-screen），unit 测试同步扩展为 8 家断言。"
```

---

## Task 2: 扩展 `core/hub-config.js` 配置 schema

**Files:**
- Modify: `core/hub-config.js:18-26`（DEFAULTS 加 9 个值）
- Modify: `core/hub-config.js:96-119`（getConfig 加 9 个 getter）
- Modify: `core/hub-config.js:124-180+`（saveConfig 加 9 个字段写入）

- [ ] **Step 1: 加 DEFAULTS 9 个新值**

替换第 18-26 行：

```js
// 默认值
const DEFAULTS = {
  proxy: 'http://127.0.0.1:7890',
  glm_base_url: 'https://mydamoxing.cn',
  glm_model: 'glm-5.1',
  codex_backend: 'subscription',
  codex_api_base_url: 'https://www.packyapi.com/v1',
  codex_api_model: 'gpt-5.5',
  codex_api_provider: 'packycode',
  // PackyAPI multi-model sessions (Anthropic-format endpoint)
  gpt_base_url: 'https://www.packyapi.com',
  gpt_model: 'gpt-5.5',
  kimi_base_url: 'https://www.packyapi.com',
  kimi_model: 'kimi-k2.5',
  qwen_base_url: 'https://www.packyapi.com',
  qwen_model: 'qwen3.6-plus',
};
```

- [ ] **Step 2: 加 getConfig 的 9 个 getter**

在第 101 行（`glmModel` 那行）之后、第 102 行（`codexBackend`）之前，插入：

```js
    // PackyAPI multi-model sessions
    gptApiKey: getConfigValue('gptApiKey', 'PACKY_GPT_API_KEY', 'providers.gpt.api_key', ''),
    gptBaseUrl: normalizeBaseUrl(getConfigValue('gptBaseUrl', 'PACKY_GPT_BASE_URL', 'providers.gpt.base_url', DEFAULTS.gpt_base_url)),
    gptModel: getConfigValue('gptModel', 'PACKY_GPT_MODEL', 'providers.gpt.model', DEFAULTS.gpt_model),
    kimiApiKey: getConfigValue('kimiApiKey', 'PACKY_KIMI_API_KEY', 'providers.kimi.api_key', ''),
    kimiBaseUrl: normalizeBaseUrl(getConfigValue('kimiBaseUrl', 'PACKY_KIMI_BASE_URL', 'providers.kimi.base_url', DEFAULTS.kimi_base_url)),
    kimiModel: getConfigValue('kimiModel', 'PACKY_KIMI_MODEL', 'providers.kimi.model', DEFAULTS.kimi_model),
    qwenApiKey: getConfigValue('qwenApiKey', 'PACKY_QWEN_API_KEY', 'providers.qwen.api_key', ''),
    qwenBaseUrl: normalizeBaseUrl(getConfigValue('qwenBaseUrl', 'PACKY_QWEN_BASE_URL', 'providers.qwen.base_url', DEFAULTS.qwen_base_url)),
    qwenModel: getConfigValue('qwenModel', 'PACKY_QWEN_MODEL', 'providers.qwen.model', DEFAULTS.qwen_model),
```

- [ ] **Step 3: 找到 saveConfig 函数（第 130 行附近开始）并加新字段写入**

```bash
cd /c/Users/lintian/claude-session-hub-feat-packy && grep -n "function saveConfig\|providers\.glm\.api_key\s*=" core/hub-config.js
```

期望看到：在 `providers.glm.api_key = ...` 那块附近，需要把 `providers.gpt/kimi/qwen` 的写入加进去。读 `core/hub-config.js` 第 130-200 行确认 saveConfig 的实际格式（DeepSeek/GLM 已有写入逻辑），照搬模式加 3 段：

```js
// 在现有 providers.glm.{api_key, base_url, model} 写入之后追加：
providers.gpt = providers.gpt || {};
if (cfg.gptApiKey !== undefined) providers.gpt.api_key = cfg.gptApiKey;
if (cfg.gptBaseUrl !== undefined) providers.gpt.base_url = cfg.gptBaseUrl;
if (cfg.gptModel !== undefined) providers.gpt.model = cfg.gptModel;
providers.kimi = providers.kimi || {};
if (cfg.kimiApiKey !== undefined) providers.kimi.api_key = cfg.kimiApiKey;
if (cfg.kimiBaseUrl !== undefined) providers.kimi.base_url = cfg.kimiBaseUrl;
if (cfg.kimiModel !== undefined) providers.kimi.model = cfg.kimiModel;
providers.qwen = providers.qwen || {};
if (cfg.qwenApiKey !== undefined) providers.qwen.api_key = cfg.qwenApiKey;
if (cfg.qwenBaseUrl !== undefined) providers.qwen.base_url = cfg.qwenBaseUrl;
if (cfg.qwenModel !== undefined) providers.qwen.model = cfg.qwenModel;
```

注：精确格式以 saveConfig 现有 deepseek/glm 写入风格为准——照抄即可。

- [ ] **Step 4: 验证配置层加载**

写一个临时验证脚本（不入仓）：

```bash
cd /c/Users/lintian/claude-session-hub-feat-packy && node -e "
const c = require('./core/hub-config').getConfig();
console.log('gpt:', { url: c.gptBaseUrl, model: c.gptModel, hasKey: !!c.gptApiKey });
console.log('kimi:', { url: c.kimiBaseUrl, model: c.kimiModel, hasKey: !!c.kimiApiKey });
console.log('qwen:', { url: c.qwenBaseUrl, model: c.qwenModel, hasKey: !!c.qwenApiKey });
"
```

期望输出：3 行，url 都是 `https://www.packyapi.com`，model 各自默认（gpt-5.5/kimi-k2.5/qwen3.6-plus），hasKey 为 false（还没填 key）。

- [ ] **Step 5: Commit**

```bash
git add core/hub-config.js
git commit -m "feat(hub-config): 加 providers.gpt/kimi/qwen 三段 PackyAPI 配置 schema

DEFAULTS 加 9 个默认值，getConfig 加 9 个 getter，saveConfig 同步写入。
环境变量 PACKY_{GPT|KIMI|QWEN}_{API_KEY|BASE_URL|MODEL} 优先级最高。"
```

---

## Task 3: `core/session-manager.js` env 注入 + 启动命令分支

**Files:**
- Modify: `core/session-manager.js:236-254`（kind 类型判定 + title 计数器）
- Modify: `core/session-manager.js:286-325`（env 注入分支扩展）
- Modify: `core/session-manager.js:555`（known 数组补全 — 如果存在）
- Modify: `core/session-manager.js:581-663`（启动命令分支扩展）

- [ ] **Step 1: 加 isGpt / isKimi / isQwen 类型判定**

读 `core/session-manager.js:236-254` 确认现状。在第 240 行（`isGlm` 那行）之后加：

```js
    const isGpt = kind === 'gpt' || kind === 'gpt-resume';
    const isKimi = kind === 'kimi' || kind === 'kimi-resume';
    const isQwen = kind === 'qwen' || kind === 'qwen-resume';
```

修改第 241 行 `isAgent` 计算：

```js
    const isAgent = isClaude || isGemini || isCodex || isDeepSeek || isGlm || isGpt || isKimi || isQwen;
```

修改 title 默认值（第 244-253 行附近）。在 `glm-resume` title 之后追加：

```js
    else if (kind === 'gpt') { this.gptCounter = (this.gptCounter || 0) + 1; title = `GPT ${this.gptCounter}`; }
    else if (kind === 'gpt-resume') title = `GPT Resume ${++this.resumeCounter}`;
    else if (kind === 'kimi') { this.kimiCounter = (this.kimiCounter || 0) + 1; title = `Kimi ${this.kimiCounter}`; }
    else if (kind === 'kimi-resume') title = `Kimi Resume ${++this.resumeCounter}`;
    else if (kind === 'qwen') { this.qwenCounter = (this.qwenCounter || 0) + 1; title = `Qwen ${this.qwenCounter}`; }
    else if (kind === 'qwen-resume') title = `Qwen Resume ${++this.resumeCounter}`;
```

- [ ] **Step 2: 加 env 注入分支（在 isGlm 分支之后）**

在 `core/session-manager.js:325` 之后（即 `} else if (isGlm)` 块结束的 `}` 之后），插入 3 段并列分支：

```js
    } else if (isGpt) {
      const cv = getConfigValues();
      // packy 国内直连，不走代理
      delete sessionEnv.HTTP_PROXY;
      delete sessionEnv.HTTPS_PROXY;
      delete sessionEnv.NO_PROXY;
      // 让 Claude Code CLI 连接 PackyAPI 的 Anthropic 兼容端点（gpt-5.5 等通过协议翻译）
      sessionEnv.ANTHROPIC_BASE_URL = cv.GPT_BASE_URL;
      sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.GPT_API_KEY;
      // 清除可能继承的 Anthropic 认证，防止冲突
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      // 隔离 transcript / settings / history，防止与 Claude / DeepSeek / GLM 互相污染
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(
        process.env.USERPROFILE || process.env.HOME || os.homedir(),
        '.claude-packy-gpt'
      );
      // Hub hook 集成
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      sessionEnv.CLAUDE_HUB_MOBILE_PORT = String((global.__mobileSrv && global.__mobileSrv.port) || 3470);
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isKimi) {
      const cv = getConfigValues();
      delete sessionEnv.HTTP_PROXY;
      delete sessionEnv.HTTPS_PROXY;
      delete sessionEnv.NO_PROXY;
      sessionEnv.ANTHROPIC_BASE_URL = cv.KIMI_BASE_URL;
      sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.KIMI_API_KEY;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(
        process.env.USERPROFILE || process.env.HOME || os.homedir(),
        '.claude-packy-kimi'
      );
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      sessionEnv.CLAUDE_HUB_MOBILE_PORT = String((global.__mobileSrv && global.__mobileSrv.port) || 3470);
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    } else if (isQwen) {
      const cv = getConfigValues();
      delete sessionEnv.HTTP_PROXY;
      delete sessionEnv.HTTPS_PROXY;
      delete sessionEnv.NO_PROXY;
      sessionEnv.ANTHROPIC_BASE_URL = cv.QWEN_BASE_URL;
      sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.QWEN_API_KEY;
      delete sessionEnv.ANTHROPIC_API_KEY;
      delete sessionEnv.ANTHROPIC_API_BASE_URL;
      sessionEnv.CLAUDE_CONFIG_DIR = path.join(
        process.env.USERPROFILE || process.env.HOME || os.homedir(),
        '.claude-packy-qwen'
      );
      sessionEnv.CLAUDE_HUB_SESSION_ID = id;
      if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
      if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
      sessionEnv.CLAUDE_HUB_MOBILE_PORT = String((global.__mobileSrv && global.__mobileSrv.port) || 3470);
      if (process.env.CLAUDE_HUB_DATA_DIR) {
        sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
      }
    }
```

注意：`getConfigValues()` 是 session-manager.js 已用的函数（参见现有 deepseek/glm 块），来自 `./hub-config`。它返回的 flat key 是大写（GPT_BASE_URL 等）—— 对照 Task 2 加的 getter 命名（gptBaseUrl 是 camelCase），需要确认 session-manager 这边映射逻辑。

读 `core/session-manager.js` 顶部 `getConfigValues` 引用（grep `getConfigValues` 在文件里出现位置），确认它把 `cfg.gptBaseUrl` 映射到 `cv.GPT_BASE_URL` 还是直接用 `cv.gptBaseUrl`。**deepseek 和 glm 那边用的是大写**（看 `cv.DEEPSEEK_API_KEY` / `cv.GLM_BASE_URL`），所以需要在 session-manager.js 内部的 `getConfigValues` 包装层加 6 个映射键，或在 hub-config.js 里同步导出大写别名。**Plan 阶段实际操作时执行者需先 grep 看清是哪种**：

```bash
cd /c/Users/lintian/claude-session-hub-feat-packy && grep -n "getConfigValues\|DEEPSEEK_API_KEY\|GLM_BASE_URL" core/session-manager.js | head -20
```

发现是哪种就照搬模式补 GPT_/KIMI_/QWEN_ 三组 6 个常量。

- [ ] **Step 3: 加 ensureClaudeBypassAndTrust 调用（与 deepseek/glm 对称）**

在 `session-manager.js:348-350` 附近原有：

```js
    if (isDeepSeek || isGlm) {
      ensureClaudeBypassAndTrust(sessionEnv.CLAUDE_CONFIG_DIR, spawnCwd);
    }
```

改成：

```js
    if (isDeepSeek || isGlm || isGpt || isKimi || isQwen) {
      ensureClaudeBypassAndTrust(sessionEnv.CLAUDE_CONFIG_DIR, spawnCwd);
    }
```

- [ ] **Step 4: 加启动命令分支**

读 `core/session-manager.js:581-663` 区段，找到现有 deepseek 启动命令（写入 ` claude --model deepseek-v4-pro --permission-mode bypassPermissions\r\n` 那段），在 GLM 分支之后追加 3 段：

```js
    } else if (isGpt) {
      const cv = getConfigValues();
      const model = cv.GPT_MODEL || 'gpt-5.5';
      const command = ` claude --model ${model} --permission-mode bypassPermissions\r\n`;
      ptyProcess.write(command);
    } else if (isKimi) {
      const cv = getConfigValues();
      const model = cv.KIMI_MODEL || 'kimi-k2.5';
      const command = ` claude --model ${model} --permission-mode bypassPermissions\r\n`;
      ptyProcess.write(command);
    } else if (isQwen) {
      const cv = getConfigValues();
      const model = cv.QWEN_MODEL || 'qwen3.6-plus';
      const command = ` claude --model ${model} --permission-mode bypassPermissions\r\n`;
      ptyProcess.write(command);
    }
```

精确格式照搬 deepseek 现有写法（前导空格让 PowerShell 不记录到历史，结尾 `\r\n`）。如果 deepseek/glm 走 resume 路径有不同分支，3 个新 kind 也要对称加 resume 分支（`useResume` 或 `resumeCCSessionId` flag 处理 — 找到 deepseek-resume 现有处理处照搬）。

- [ ] **Step 5: 修补硬编码 known 数组（如果有）**

检查 `core/session-manager.js:555` 附近有没有：

```js
const known = ['claude', 'gemini', 'codex', 'deepseek', 'glm', 'powershell'];
```

如果有，改成：

```js
const { ALL_AI_KINDS } = require('./ai-kinds');
const known = [...ALL_AI_KINDS, 'powershell'];
```

或者就地补：

```js
const known = ['claude', 'gemini', 'codex', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen', 'powershell'];
```

前者更好（防回归），但要确认 `ai-kinds` 已在文件顶部 require。

- [ ] **Step 6: 启动 Hub 隔离实例做 smoke test**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-packy-smoke-1"
& "C:\Users\lintian\claude-session-hub-feat-packy\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub-feat-packy" --remote-debugging-port=9261
```

后台运行，看 Hub 启动日志：
- 必须看到 `[hub] hook server listening on 127.0.0.1:...` 才算启动成功
- 不能看到 `Cannot find module` 等错误

确认无报错后用 Ctrl+C 关闭。后续在 Task 8 再正式做 E2E。

- [ ] **Step 7: Commit**

```bash
git add core/session-manager.js
git commit -m "feat(session-manager): 加 gpt/kimi/qwen 三段 env 注入 + 启动命令分支

照搬 deepseek/glm 模式：spawn claude CLI + ANTHROPIC_BASE_URL 指向 PackyAPI
+ ANTHROPIC_AUTH_TOKEN 各自独立 + CLAUDE_CONFIG_DIR 隔离到
~/.claude-packy-{gpt,kimi,qwen}。ensureClaudeBypassAndTrust 同步覆盖。"
```

---

## Task 4: `renderer/index.html` + 号菜单 + 配置面板 HTML

**Files:**
- Modify: `renderer/index.html:23-36`（新建会话菜单 + resume 菜单加 3 项）
- Modify: `renderer/index.html:176`（hint 文案补 GPT/Kimi/Qwen）
- Modify: `renderer/index.html:202-225`（config-ai-list 加 3 行）
- Modify: `renderer/index.html:274-302`（config-ai-detail 加 3 块）

- [ ] **Step 1: 加 + 号菜单 3 项**

读 `renderer/index.html:23` 区段。在第 23 行 deepseek 按钮之后、glm 按钮之前/之后，找到合适位置加：

```html
<button class="new-session-option" data-kind="gpt"><span class="ai-logo logo-gpt"></span>GPT 5.5</button>
<button class="new-session-option" data-kind="kimi"><span class="ai-logo logo-kimi"></span>Kimi K2.5</button>
<button class="new-session-option" data-kind="qwen"><span class="ai-logo logo-qwen"></span>Qwen 3.6 Plus</button>
```

在第 36 行 deepseek-resume 按钮之后/glm-resume 附近加 resume 菜单 3 项：

```html
<button class="resume-option" data-kind="gpt-resume"><span class="ai-logo logo-gpt"></span>GPT 5.5<span class="hint">PTY picker</span></button>
<button class="resume-option" data-kind="kimi-resume"><span class="ai-logo logo-kimi"></span>Kimi K2.5<span class="hint">PTY picker</span></button>
<button class="resume-option" data-kind="qwen-resume"><span class="ai-logo logo-qwen"></span>Qwen 3.6 Plus<span class="hint">PTY picker</span></button>
```

实际位置以 GLM 项的同级、紧挨为准（让菜单视觉上 DeepSeek → GLM → GPT → Kimi → Qwen 顺序）。

- [ ] **Step 2: 改 hint 文案**

替换第 176 行：

```html
<p class="config-hint">配置全局代理和各 AI 的接入方式。Codex / DeepSeek / GLM / GPT / Kimi / Qwen 的变更会在新建会话时生效。</p>
```

- [ ] **Step 3: 加配置卡片 3 行**

读 `renderer/index.html:202-225` 找到 deepseek 那行（约 210-217 行）和 glm 那行的 HTML 结构。在 GLM 那行之后插入 3 行：

```html
<button class="config-ai-row" type="button" data-ai="gpt">
  <span class="config-ai-mark gpt">GP</span>
  <span class="config-ai-copy">
    <strong>GPT</strong>
    <small id="cfg-summary-gpt">API · gpt-5.5 · Packy</small>
  </span>
  <span class="config-ai-status api" id="cfg-status-gpt">API</span>
</button>
<button class="config-ai-row" type="button" data-ai="kimi">
  <span class="config-ai-mark kimi">KI</span>
  <span class="config-ai-copy">
    <strong>Kimi</strong>
    <small id="cfg-summary-kimi">API · kimi-k2.5 · Packy</small>
  </span>
  <span class="config-ai-status api" id="cfg-status-kimi">API</span>
</button>
<button class="config-ai-row" type="button" data-ai="qwen">
  <span class="config-ai-mark qwen">QW</span>
  <span class="config-ai-copy">
    <strong>Qwen</strong>
    <small id="cfg-summary-qwen">API · qwen3.6-plus · Packy</small>
  </span>
  <span class="config-ai-status api" id="cfg-status-qwen">API</span>
</button>
```

- [ ] **Step 4: 加配置详情面板 3 块**

读 `renderer/index.html:274-302` 看 deepseek 详情块的完整结构（含 cfg-deepseek-key input + 隔离 Claude 配置目录说明）。读完后在 GLM 详情块之后插入 3 段。GPT 段格式：

```html
<div class="config-ai-detail" id="cfg-detail-gpt">
  <div class="config-detail-header">
    <strong>GPT 设置</strong>
    <span>GPT 5.5 通过 PackyAPI 的 Anthropic 兼容端点接入（服务端做 OpenAI ↔ Anthropic 协议翻译），使用隔离 Claude 配置目录。</span>
  </div>
  <div class="config-field">
    <label>GPT API Key（PackyAPI codex 分组）</label>
    <input type="password" id="cfg-gpt-key" placeholder="sk-..." spellcheck="false">
  </div>
  <div class="config-field">
    <label>Base URL</label>
    <input type="text" id="cfg-gpt-url" placeholder="https://www.packyapi.com" spellcheck="false">
  </div>
  <div class="config-field">
    <label>模型</label>
    <input type="text" id="cfg-gpt-model" placeholder="gpt-5.5" spellcheck="false">
  </div>
</div>
```

Kimi / Qwen 同款结构，把 `gpt` 替换成 `kimi`/`qwen`，文本换成对应模型，placeholder 换成 `kimi-k2.5` / `qwen3.6-plus`，说明改成 "Kimi K2.5 通过 PackyAPI bailian 分组的 Anthropic 兼容端点接入..."（Qwen 同样改 bailian 分组说明）。

- [ ] **Step 5: 加 CSS 颜色（renderer/styles.css）**

在 `renderer/styles.css:1505` 之后追加：

```css
.config-ai-mark.gpt { color: #c1c5d4; }    /* OpenAI 中性灰，区别于 Codex 绿 */
.config-ai-mark.kimi { color: #ffd966; }   /* Moonshot 月亮黄 */
.config-ai-mark.qwen { color: #b794f4; }   /* 通义千问紫 */
```

在 `renderer/styles.css:2203` 之后追加：

```css
.logo-gpt       { background-image: url('assets/ai-logos/gpt.svg'); }
.logo-kimi      { background-image: url('assets/ai-logos/kimi.svg'); }
.logo-qwen      { background-image: url('assets/ai-logos/qwen.svg'); }
```

- [ ] **Step 6: 创建 3 个图标 SVG**

在 `renderer/assets/ai-logos/` 下创建：

`renderer/assets/ai-logos/gpt.svg`（OpenAI 极简标志）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <circle cx="12" cy="12" r="11" fill="#10a37f"/>
  <text x="12" y="16" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="9" font-weight="700" fill="#fff">GPT</text>
</svg>
```

`renderer/assets/ai-logos/kimi.svg`（月亮）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <circle cx="12" cy="12" r="11" fill="#ffd966"/>
  <path d="M14 6a8 8 0 1 0 4 4 6 6 0 0 1-4-4z" fill="#7a5a00"/>
</svg>
```

`renderer/assets/ai-logos/qwen.svg`（通义紫）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <circle cx="12" cy="12" r="11" fill="#b794f4"/>
  <text x="12" y="16" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="9" font-weight="700" fill="#fff">通义</text>
</svg>
```

（用户后续可换成各家官方 SVG，这里给最小占位实现先把链路打通。）

- [ ] **Step 7: Commit**

```bash
git add renderer/index.html renderer/styles.css renderer/assets/ai-logos/gpt.svg renderer/assets/ai-logos/kimi.svg renderer/assets/ai-logos/qwen.svg
git commit -m "feat(renderer): 加 GPT/Kimi/Qwen 菜单项 + 配置面板 HTML + 图标

+号菜单和resume菜单各加3项, 配置面板列表加3行 + 详情块加3块,
CSS颜色和ai-logo class同步, 图标SVG先用最小占位实现."
```

---

## Task 5: `renderer/renderer.js` 配置 save/load + 状态摘要 + 选中分支

**Files:**
- Modify: `renderer/renderer.js:2503-2504`（kind → 'api' 状态映射）
- Modify: `renderer/renderer.js:2630-2631`（s.includes 启发式分类）
- Modify: `renderer/renderer.js:2647-2648`（id 缩写映射）
- Modify: `renderer/renderer.js:2847-2848`（buildLine 列表渲染）
- Modify: `renderer/renderer.js:3440-3450`（CONFIG_DEFS 加 3 项）
- Modify: `renderer/renderer.js:3470-3492`（saveConfigSummary 加 3 段）
- Modify: `renderer/renderer.js:3500-3505`（activeConfigAi 分支）
- Modify: `renderer/renderer.js:3539-3546`（loadConfigToForm 加 3 段）
- Modify: `renderer/renderer.js:3574`（input id 数组）
- Modify: `renderer/renderer.js:3590-3597`（saveConfig payload）
- Modify: `renderer/renderer.js:3604`（保存提示文本）
- Modify: `renderer/renderer.js:3722`（kind 排除链 — 改用 isClaudeFamily）

- [ ] **Step 1: kind → 'api' 状态映射加 3 项（第 2503 行附近）**

读 `renderer/renderer.js:2500-2510` 看上下文，把：

```js
deepseek: 'api',
glm: 'api',
```

后追加：

```js
gpt: 'api',
kimi: 'api',
qwen: 'api',
```

- [ ] **Step 2: s.includes 启发式分类（第 2630 行附近）**

```js
if (s.includes('deepseek')) return 'deepseek';
if (s.includes('glm')) return 'glm';
```

后追加：

```js
if (s.includes('gpt')) return 'gpt';
if (s.includes('kimi')) return 'kimi';
if (s.includes('qwen')) return 'qwen';
```

- [ ] **Step 3: id 缩写映射（第 2647 行附近）**

```js
if (id.includes('deepseek')) return 'DS';
if (id.includes('glm')) return 'GLM';
```

后追加：

```js
if (id.includes('gpt')) return 'GP';
if (id.includes('kimi')) return 'KI';
if (id.includes('qwen')) return 'QW';
```

- [ ] **Step 4: buildLine 列表渲染（第 2847-2848 行）**

```js
buildLine('deepseek', 'deepseek', 'DeepSeek', null, null, 0, false) +
buildLine('glm', 'glm', 'GLM', null, null, 0, false);
```

改成：

```js
buildLine('deepseek', 'deepseek', 'DeepSeek', null, null, 0, false) +
buildLine('glm', 'glm', 'GLM', null, null, 0, false) +
buildLine('gpt', 'gpt', 'GPT 5.5', null, null, 0, false) +
buildLine('kimi', 'kimi', 'Kimi K2.5', null, null, 0, false) +
buildLine('qwen', 'qwen', 'Qwen 3.6 Plus', null, null, 0, false);
```

- [ ] **Step 5: CONFIG_DEFS 加 3 项（第 3440-3450 行）**

读 `renderer/renderer.js:3440-3460` 看 CONFIG_DEFS（变量名可能不同，找到 `deepseek: { title, hint }` 那个对象）。在 GLM 项后追加：

```js
gpt: {
  title: 'GPT 设置',
  hint: 'GPT 当前通过 PackyAPI codex 分组的 Anthropic 兼容端点接入，新建 GPT 会话生效。',
},
kimi: {
  title: 'Kimi 设置',
  hint: 'Kimi 当前通过 PackyAPI bailian 分组的 Anthropic 兼容端点接入，新建 Kimi 会话生效。',
},
qwen: {
  title: 'Qwen 设置',
  hint: 'Qwen 当前通过 PackyAPI bailian 分组的 Anthropic 兼容端点接入，新建 Qwen 会话生效。',
},
```

- [ ] **Step 6: saveConfigSummary 摘要状态（第 3470-3492 行）**

读 `renderer/renderer.js:3460-3500` 看 saveConfigSummary 函数（或类似命名）。在 deepseek/glm 摘要更新之后追加：

```js
const gptKey = configEl('cfg-gpt-key') ? configEl('cfg-gpt-key').value.trim() : '';
const gptModel = configEl('cfg-gpt-model') ? (configEl('cfg-gpt-model').value.trim() || 'gpt-5.5') : 'gpt-5.5';
const kimiKey = configEl('cfg-kimi-key') ? configEl('cfg-kimi-key').value.trim() : '';
const kimiModel = configEl('cfg-kimi-model') ? (configEl('cfg-kimi-model').value.trim() || 'kimi-k2.5') : 'kimi-k2.5';
const qwenKey = configEl('cfg-qwen-key') ? configEl('cfg-qwen-key').value.trim() : '';
const qwenModel = configEl('cfg-qwen-model') ? (configEl('cfg-qwen-model').value.trim() || 'qwen3.6-plus') : 'qwen3.6-plus';

const gptSummary = configEl('cfg-summary-gpt');
if (gptSummary) gptSummary.textContent = gptKey ? `API · ${gptModel} · Packy` : 'API · 未配置 Key';
setConfigStatus(configEl('cfg-status-gpt'), gptKey ? 'API' : '缺 Key', gptKey ? 'api' : 'missing');

const kimiSummary = configEl('cfg-summary-kimi');
if (kimiSummary) kimiSummary.textContent = kimiKey ? `API · ${kimiModel} · Packy` : 'API · 未配置 Key';
setConfigStatus(configEl('cfg-status-kimi'), kimiKey ? 'API' : '缺 Key', kimiKey ? 'api' : 'missing');

const qwenSummary = configEl('cfg-summary-qwen');
if (qwenSummary) qwenSummary.textContent = qwenKey ? `API · ${qwenModel} · Packy` : 'API · 未配置 Key';
setConfigStatus(configEl('cfg-status-qwen'), qwenKey ? 'API' : '缺 Key', qwenKey ? 'api' : 'missing');
```

- [ ] **Step 7: activeConfigAi 分支（第 3500-3505 行）**

在现有：

```js
} else if (activeConfigAi === 'glm') {
  setConfigStatus(configEl('cfg-detail-status'), glmKey ? 'API' : '缺 Key', glmKey ? 'api' : 'missing');
}
```

之前的 `else if` 链末尾追加（**注意先把 `else if` 改成不结束，然后在最后一个 `}` 之前插**）：

```js
} else if (activeConfigAi === 'gpt') {
  setConfigStatus(configEl('cfg-detail-status'), gptKey ? 'API' : '缺 Key', gptKey ? 'api' : 'missing');
} else if (activeConfigAi === 'kimi') {
  setConfigStatus(configEl('cfg-detail-status'), kimiKey ? 'API' : '缺 Key', kimiKey ? 'api' : 'missing');
} else if (activeConfigAi === 'qwen') {
  setConfigStatus(configEl('cfg-detail-status'), qwenKey ? 'API' : '缺 Key', qwenKey ? 'api' : 'missing');
}
```

- [ ] **Step 8: loadConfigToForm 加 3 段（第 3539-3546 行）**

在现有 deepseek/glm 字段加载之后追加：

```js
document.getElementById('cfg-gpt-key').value = cfg.gptApiKey || '';
document.getElementById('cfg-gpt-url').value = cfg.gptBaseUrl || '';
document.getElementById('cfg-gpt-model').value = cfg.gptModel || '';
document.getElementById('cfg-kimi-key').value = cfg.kimiApiKey || '';
document.getElementById('cfg-kimi-url').value = cfg.kimiBaseUrl || '';
document.getElementById('cfg-kimi-model').value = cfg.kimiModel || '';
document.getElementById('cfg-qwen-key').value = cfg.qwenApiKey || '';
document.getElementById('cfg-qwen-url').value = cfg.qwenBaseUrl || '';
document.getElementById('cfg-qwen-model').value = cfg.qwenModel || '';
```

- [ ] **Step 9: 输入框 id 数组扩展（第 3574 行）**

```js
['cfg-codex-backend', 'cfg-codex-key', 'cfg-codex-url', 'cfg-codex-model', 'cfg-deepseek-key', 'cfg-glm-key', 'cfg-glm-url', 'cfg-glm-model'].forEach(id => {
```

改成：

```js
['cfg-codex-backend', 'cfg-codex-key', 'cfg-codex-url', 'cfg-codex-model', 'cfg-deepseek-key', 'cfg-glm-key', 'cfg-glm-url', 'cfg-glm-model', 'cfg-gpt-key', 'cfg-gpt-url', 'cfg-gpt-model', 'cfg-kimi-key', 'cfg-kimi-url', 'cfg-kimi-model', 'cfg-qwen-key', 'cfg-qwen-url', 'cfg-qwen-model'].forEach(id => {
```

- [ ] **Step 10: saveConfig payload 加 9 字段（第 3590-3597 行附近）**

读 `renderer/renderer.js:3585-3605` 看 saveConfig 调用 IPC 的地方。在 glmModel 之后追加：

```js
gptApiKey: document.getElementById('cfg-gpt-key').value.trim() || undefined,
gptBaseUrl: document.getElementById('cfg-gpt-url').value.trim() || undefined,
gptModel: document.getElementById('cfg-gpt-model').value.trim() || undefined,
kimiApiKey: document.getElementById('cfg-kimi-key').value.trim() || undefined,
kimiBaseUrl: document.getElementById('cfg-kimi-url').value.trim() || undefined,
kimiModel: document.getElementById('cfg-kimi-model').value.trim() || undefined,
qwenApiKey: document.getElementById('cfg-qwen-key').value.trim() || undefined,
qwenBaseUrl: document.getElementById('cfg-qwen-url').value.trim() || undefined,
qwenModel: document.getElementById('cfg-qwen-model').value.trim() || undefined,
```

- [ ] **Step 11: 保存成功提示文本（第 3604 行）**

```js
msg.textContent = '配置已保存。新创建的 Codex / GLM / DeepSeek 会话将立即生效。';
```

改成：

```js
msg.textContent = '配置已保存。新创建的 Codex / GLM / DeepSeek / GPT / Kimi / Qwen 会话将立即生效。';
```

- [ ] **Step 12: 修补硬编码 kind 排除链（第 3722 行）**

```js
if (!s.meetingId && s.kind !== 'claude' && s.kind !== 'claude-resume' && s.kind !== 'gemini' && s.kind !== 'codex' && s.kind !== 'deepseek' && s.kind !== 'glm') continue;
```

改成（用 ai-kinds.js 的 `isAiKind` helper —— 文件顶部应已 require ai-kinds）：

```js
if (!s.meetingId && !isAiKind(s.kind) && s.kind !== 'claude-resume' && !s.kind?.endsWith('-resume')) continue;
```

或者更保守（直接列举 8 家 + resume 变体）：

```js
const AI_KIND_SET = new Set([...ALL_AI_KINDS, 'claude-resume', 'gemini-resume', 'codex-resume', 'deepseek-resume', 'glm-resume', 'gpt-resume', 'kimi-resume', 'qwen-resume']);
if (!s.meetingId && !AI_KIND_SET.has(s.kind)) continue;
```

实际选哪种以 renderer.js 顶部既有 import 风格为准（看 `require('./...ai-kinds...')` 已 import 哪些 helper）。

- [ ] **Step 13: 启动 Hub 隔离实例 smoke + 手工 UI 验证**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-packy-smoke-2"
& "C:\Users\lintian\claude-session-hub-feat-packy\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub-feat-packy" --remote-debugging-port=9262
```

验证：
1. `[hub] hook server listening` 必须出现
2. UI 上点 + 号，应看到 3 个新菜单项（GPT 5.5 / Kimi K2.5 / Qwen 3.6 Plus）含图标
3. 点设置图标，配置面板列表底部应有 3 行新条目，状态都是"缺 Key"
4. 点 GPT 行展开详情，应有 3 个 input 字段（API Key / Base URL / 模型）

只验证 UI 显示正确，先不填 key。Ctrl+C 关闭。

- [ ] **Step 14: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(renderer): GPT/Kimi/Qwen 配置面板 save/load + 列表渲染 + 状态摘要

加 CONFIG_DEFS 三项, saveConfigSummary 三段, loadConfigToForm 三段,
saveConfig payload 九字段, buildLine 列表三行, kind→api 映射,
启发式分类, id 缩写, 顺手把硬编码 kind 排除链改用 ai-kinds helper."
```

---

## Task 6: 修补 renderer-mobile 与其他硬编码 kind 漏点

**Files:**
- Search: 全代码库（grep）
- Modify: 任何漏掉的 `kind === 'claude' || kind === 'gemini' || ...` 链

- [ ] **Step 1: grep 找出所有可能漏的硬编码 kind chain**

```bash
cd /c/Users/lintian/claude-session-hub-feat-packy
grep -rn "kind === 'deepseek'" --include="*.js" core renderer renderer-mobile main.js | grep -v "deepseek-resume"
grep -rn "'deepseek', 'glm'" --include="*.js" core renderer renderer-mobile main.js
grep -rn "'deepseek'\s*,\s*'glm'" --include="*.js" core renderer renderer-mobile main.js
```

期望输出：列出所有可能需要补 gpt/kimi/qwen 的位置。

- [ ] **Step 2: 逐个文件评估并修复**

对每个 grep 命中点：
- 如果是"判断是否 AI kind 之一" → 用 `isAiKind(kind)` 替代
- 如果是"判断是否 Claude 家族" → 用 `isClaudeFamily(kind)` 替代
- 如果是"列出所有 AI 名" → 用 `ALL_AI_KINDS` 或 `KIND_LABELS` 替代
- 如果是"特定 deepseek/glm 行为而 GPT/Kimi/Qwen 也要" → 把判断改成`isClaudeFamily` 或显式列举 8 家

每次修改后跑一次 unit 测试确认无回归：

```bash
cd /c/Users/lintian/claude-session-hub-feat-packy && node tests/unit-ai-kinds-no-hardcode.test.js
```

期望：3 passed, 0 failed。

- [ ] **Step 3: 跑全套 unit 测试**

```bash
cd /c/Users/lintian/claude-session-hub-feat-packy && ls tests/*.test.js 2>&1 | head -20
```

逐个跑（如果是 node 直接执行风格）：

```bash
for f in tests/*.test.js; do node "$f"; done
```

期望：全部通过，无新增失败。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix(ai-kinds): 补全 renderer-mobile / 其他文件硬编码 kind chain

grep 扫出所有 kind === 'deepseek' || ... 链, 改用 isAiKind /
isClaudeFamily helper, 让 gpt/kimi/qwen 三个新 kind 自动覆盖."
```

如果 Step 2 没发现需要修复的点，跳过 commit（不留空 commit）。

---

## Task 7: 隔离 Hub 实例 E2E 真实测试

**Files:**
- Create: `tests/e2e/test-packy-sessions.test.js`（可选，做成自动化）
- Or: 手工 E2E 流程文档

按 CLAUDE.md 铁律，所有 E2E 测试用 `CLAUDE_HUB_DATA_DIR` 隔离启动 Hub 实例，**绝不动生产 Hub**。

**前置条件**：用户提供两个真实 PackyAPI key（不入仓，运行测试前手工 set 到 env）：

- **codex 分组 key**（GPT session 用）—— PackyAPI 后台"令牌管理"创建 codex / cxtocc 分组的 token
- **bailian 分组 key**（Kimi 和 Qwen session 共用）—— PackyAPI 后台创建 bailian 分组的 token

执行者向用户索取这两个 key（或从 Hub 主仓库 `~/.claude-session-hub/config.json` 的 `providers.codex.api_key` 复用 codex key）。**绝对不要把 API key 写入 plan 文档、test 文件、或 commit 内容。**

- [ ] **Step 1: 启动隔离 Hub 实例**

先在当前 PS 会话设置（不入仓、不入 commit）：

```powershell
# ⚠ 这里两行 key 由人填入，不要持久化到任何文件
$env:PACKY_GPT_API_KEY = "<codex 分组 key>"
$env:PACKY_KIMI_API_KEY = "<bailian 分组 key>"
$env:PACKY_QWEN_API_KEY = $env:PACKY_KIMI_API_KEY  # bailian 共享

# 隔离启动
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-packy-e2e-1"
& "C:\Users\lintian\claude-session-hub-feat-packy\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub-feat-packy" --remote-debugging-port=9263

# 测完后清 env, 防泄漏:
# Remove-Item Env:PACKY_GPT_API_KEY, Env:PACKY_KIMI_API_KEY, Env:PACKY_QWEN_API_KEY
```

期望：Hub 启动，菜单显示 GPT/Kimi/Qwen 项，配置面板状态显示 "API"（因为 env 注入了 key）。

- [ ] **Step 2: 创建 GPT session 并发简单 prompt**

UI 操作：点 + 号 → 选 GPT 5.5 → 在 session 里输入 `reply only: ok` → 回车

期望：session 收到 GPT-5.5 的响应"ok"。

或者通过 Playwright CDP 自动化（remote-debugging-port=9263）：

```js
// 伪代码：playwright 连 9263 → click '[data-kind="gpt"]' → 等 session 启动
//        → type "reply only: ok" → 等响应 → 断言 transcript 含 "ok"
```

- [ ] **Step 3: 验证 transcript 落点**

```bash
ls "C:/Users/lintian/.claude-packy-gpt/projects/" 2>&1 | head -5
```

期望：看到一个项目子目录，里面有 .jsonl transcript 文件含本轮对话。

- [ ] **Step 4: Kimi session 同样测一遍**

UI 点 + 号 → 选 Kimi K2.5 → 输入 `reply only: hi` → 验证响应

```bash
ls "C:/Users/lintian/.claude-packy-kimi/projects/" 2>&1 | head -5
```

期望：看到 Kimi 的 transcript jsonl。

- [ ] **Step 5: Qwen session 同样测一遍**

UI 点 + 号 → 选 Qwen 3.6 Plus → 输入 `reply only: hi` → 验证响应

```bash
ls "C:/Users/lintian/.claude-packy-qwen/projects/" 2>&1 | head -5
```

期望：看到 Qwen 的 transcript jsonl。

- [ ] **Step 6: resume 测试（每个 kind 各一次）**

关闭刚才创建的 GPT session（点 X 关闭），然后从 Resume 菜单选 GPT 5.5。预期能列出刚才那个 session 并恢复历史。Kimi / Qwen 同样测。

- [ ] **Step 7: 多 session 并发**

依次创建 GPT、Kimi、Qwen 三个 session，每个发不同 prompt，验证：
- 三个 session 互不干扰，title 和图标正确
- 每个 session 响应来自正确的模型（让模型回答自己是谁，对照模型名）
- 三个 transcript 各自落到自己的 .claude-packy-* 目录

- [ ] **Step 8: 空 key 防御测试**

关闭 Hub。重启不带 PACKY_*_API_KEY env：

```powershell
Remove-Item Env:PACKY_GPT_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:PACKY_KIMI_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:PACKY_QWEN_API_KEY -ErrorAction SilentlyContinue
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-packy-e2e-empty"
& "C:\Users\lintian\claude-session-hub-feat-packy\node_modules\electron\dist\electron.exe" "C:\Users\lintian\claude-session-hub-feat-packy" --remote-debugging-port=9264
```

期望：
- 配置面板 GPT/Kimi/Qwen 行状态显示"缺 Key"
- 创建 GPT session 时（或保持菜单可点击但创建后立即弹错），CLI 内部因 ANTHROPIC_AUTH_TOKEN 为空报 401，transcript 显示错误（与 deepseek/glm 空 key 行为对称）

具体行为以 deepseek/glm 现有空 key 表现为基准（如果 deepseek 空 key 是菜单 disabled，新 kind 也应 disabled；如果是创建后 CLI 报错，新 kind 也应如此）。

- [ ] **Step 9: 回归 — 现有 session 行为不变**

重启 Hub 实例（再次 set env），创建 Claude / DeepSeek / GLM / Codex CLI session 各一个，发简单 prompt，验证：
- 都能正常响应
- transcript 落点不变（`~/.claude/projects` `~/.claude-deepseek/projects` `~/.claude-glm/projects`）
- + 号菜单 / 设置面板原有项目位置和样式不变

- [ ] **Step 10: 关闭隔离 Hub + 清理**

```powershell
# 关闭 Hub 窗口（点 X 或 Ctrl+C）
# 不要删 ~/.claude-packy-* 目录, 留作下次测试 resume 数据
# 但临时的 hub data dir 可清理:
Remove-Item -Recurse -Force "C:\temp\hub-packy-e2e-1" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "C:\temp\hub-packy-e2e-empty" -ErrorAction SilentlyContinue
```

- [ ] **Step 11: 测试报告 + Commit**

如果做了自动化测试脚本：

```bash
git add tests/e2e/test-packy-sessions.test.js
git commit -m "test(e2e): PackyAPI 三个 session kind E2E 真实测试

隔离 Hub 实例 + 真 packy key, 创建/对话/transcript 落点/resume/
并发/空 key/回归 7 类验证."
```

如果是纯手工测试：写一份 `docs/superpowers/test-reports/2026-05-03-packy-e2e-report.md` 记录步骤和结果，commit。

---

## Task 8: Final 提交 PR / merge 准备

- [ ] **Step 1: 用 superpowers:requesting-code-review 自审**

```bash
cd /c/Users/lintian/claude-session-hub-feat-packy
git log --oneline master..feat/packy-sessions
```

期望看到 6-8 个提交（每个 task 各 1 个）。

- [ ] **Step 2: 跑 Hub 主仓库 CLAUDE.md 要求的 smoke test**

```powershell
# 必做：node_modules 健康度
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath "C:\Users\lintian\claude-session-hub-feat-packy\node_modules\electron\dist\electron.exe" -ArgumentList "C:\Users\lintian\claude-session-hub-feat-packy" -PassThru -RedirectStandardOutput "C:\temp\hub-final-smoke.log" -RedirectStandardError "C:\temp\hub-final-smoke.err"
Start-Sleep -Seconds 6
Stop-Process -Id $proc.Id -Force
Get-Content "C:\temp\hub-final-smoke.log" | Select-String "hook server listening"
```

必须看到 `[hub] hook server listening on 127.0.0.1:...`。否则 node_modules 可能损坏，立即调查。

- [ ] **Step 3: refactor-guard / post-refactor-verify**

按 CLAUDE.md 铁律：commit ≥ 3 文件时 refactor-guard Hook 拦截。本特性涉及 ai-kinds.js / hub-config.js / session-manager.js / renderer/index.html / renderer/renderer.js / renderer/styles.css / 6 文件 + 测试，**必须**在 merge 前执行 `/post-refactor-verify`。

- [ ] **Step 4: 用户验收**

向用户呈现：
- `git log feat/packy-sessions` 提交序列
- `~/.claude-packy-{gpt,kimi,qwen}` 三个目录的 transcript 实证
- 多 session 并发截图
- 空 key 防御截图
- 回归测试结果

用户验收后才进入合并/PR 流程（按 superpowers:finishing-a-development-branch 引导）。

---

## Self-Review

### Spec coverage

| Spec 节 | 实现 task | 覆盖 |
|---------|-----------|------|
| § 1 架构层次 | T3 + T4 + T5 | ✅ |
| § 2 文件改动清单 | T1-T6 全覆盖 | ✅ |
| § 3 配置 schema | T2 | ✅ |
| § 4 session-manager 代码骨架 | T3 | ✅ |
| § 5 resume 实现 | T3 (kind-resume 对称) + T7 验证 | ✅ |
| § 6 数据隔离 | T3 (CLAUDE_CONFIG_DIR) + T7 验证 | ✅ |
| § 7 错误处理 | T5 (空 key 状态摘要) + T7 (空 key 防御测试) | ✅ |
| § 8 测试计划 | T1 unit + T6 grep + T7 E2E | ✅ |
| § 9 已知约束第 5 条（deepseek-resume 是否在 CLAUDE_FAMILY） | T1 已在 CLAUDE_FAMILY 加 7 个，但 deepseek-resume/glm-resume 仍未加（保持现状，spec 已注明这是已有行为） | ✅ 维持现状 |

### Placeholder scan

- 唯一一个非"完全 explicit code"的位置是 T2 Step 3（saveConfig 写入逻辑），因为现有 hub-config.js saveConfig 函数没读完，给的是"照搬 deepseek/glm 模式"指引 —— 这是 OK 的，执行时一查就清楚。
- T6 Step 2 的"逐个文件评估并修复"是动态的，不是 placeholder，是 grep 驱动的修复。
- 所有 code blocks 都有完整代码。

### Type / 命名一致性

- Config getter 名：`gptApiKey` / `gptBaseUrl` / `gptModel`（camelCase，Task 2）
- session-manager.js 使用：`cv.GPT_API_KEY` / `cv.GPT_BASE_URL` / `cv.GPT_MODEL`（大写常量风格，Task 3）
- ⚠ 这两套命名**不直接对应**！需要 session-manager.js 的 `getConfigValues` 包装层做映射（如现有 `cv.DEEPSEEK_API_KEY` 映射到 `cfg.deepseekApiKey`）。Task 3 Step 2 已注明执行时 grep 现有映射风格照搬。
- IPC payload key：`gptApiKey` / `gptBaseUrl` / `gptModel`（与 hub-config.js getConfig 对齐，Task 5 Step 10）—— 一致。
- HTML id：`cfg-gpt-key` / `cfg-gpt-url` / `cfg-gpt-model`（与 deepseek/glm 命名风格一致，Task 4 Step 4）—— 一致。

### 范围

单一聚焦 feature（加 3 个对称 session kind），可以一个 plan 实现。✅

---

## 执行选择

Plan complete and saved to `docs/superpowers/plans/2026-05-03-packy-sessions.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 每个 task 派一个新 subagent 执行，task 之间审查，迭代快、上下文独立

**2. Inline Execution** - 在当前 session 里直接执行 tasks，批量执行 + checkpoint 复审

哪种？
