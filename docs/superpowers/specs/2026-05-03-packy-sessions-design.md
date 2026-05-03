---
feature_ids:
  - packy-sessions
topics:
  - session-kinds
  - packy-api
  - claude-code-anthropic-endpoint
doc_kind: design
created: 2026-05-03
status: brainstorm-approved
---

# Hub PackyAPI 多模型 Session 设计（GPT 5.5 / Kimi K2.5 / Qwen 3.6 Plus）

## 目标

让 Hub 用户能在原生 Claude Code 交互体验内运行 GPT、Kimi、Qwen 三类外部大脑，使用方式跟现有 DeepSeek / GLM session 完全对称：+ 号菜单点开即创建，设置面板里填 API key 和模型即可。

底层依据：PackyAPI 服务端实测对 `gpt-5.5` / `kimi-k2.5` / `qwen3.6-plus` 都做了 OpenAI ↔ Anthropic 协议翻译（向 `https://www.packyapi.com/v1/messages` 发 Anthropic 格式请求返回 HTTP 200 + 完整 Anthropic content block），因此 spawn `claude` CLI + 设 `ANTHROPIC_BASE_URL` 这一最简模式就能跑通，不需要本地 CCR/LiteLLM 翻译层。

## 范围

In scope：

- 新增 3 个 session kind：`gpt` / `kimi` / `qwen`，及其 resume 变体 `gpt-resume` / `kimi-resume` / `qwen-resume`
- + 号菜单加 3 个入口：`GPT 5.5` / `Kimi K2.5` / `Qwen 3.6 Plus`
- 设置面板加 3 行配置（在现有 GLM 行下方），UI 风格跟 GLM 完全一致：API 标签 + 副标题 + 点击展开后填 base_url / api_key / model
- `core/ai-kinds.js` 集中真理源同步追加 3 个 kind，`KIND_LABELS` / `CLAUDE_FAMILY` / `PASTE_SENSITIVE_KINDS` / `CLAUDE_HOOK_BACKED` 同步追加
- `core/session-manager.js` 加 3 段 env 注入分支（照搬 deepseek/glm 模式）+ 3 段启动命令分支
- `config.json` schema 加 `providers.gpt` / `providers.kimi` / `providers.qwen` 三段
- 数据隔离：`~/.claude-packy-gpt` / `~/.claude-packy-kimi` / `~/.claude-packy-qwen` 三个独立 `CLAUDE_CONFIG_DIR`
- Hub Hook 集成（CLAUDE_HUB_SESSION_ID/PORT/TOKEN/MOBILE_PORT）跟 deepseek/glm 一致
- 防回归 unit test（`unit-ai-kinds-no-hardcode.test.js` 自动覆盖）+ 隔离 Hub 实例 E2E 真实测试

Out of scope（用户明确决定）：

- 不实现 + 号菜单二级菜单（多模型变体选择）。GPT 默认 `gpt-5.5`，要换变体（gpt-5.4-high 等）去设置面板改 model 字段（Q1 决策：A）
- 不在 UI 层把 Kimi 和 Qwen 的 bailian key 字段共享。视觉对称优先，用户每行各填一次 bailian key（Q2 决策：A）
- 不复用 `codex.api_key` 字段。GPT session 独立配置 `providers.gpt.api_key`，与现有 Codex CLI session 解耦（Q4 决策：A）
- 不替换现有 Codex CLI session（保留它跑 OpenAI Responses API 走 `codex` 二进制）
- 不引入 packy 包月端点 `https://codex-api.packycode.com/v1`（包月不支持 Anthropic 格式）
- 不支持 MiniMax-M2.7（实测 packy 没做 anthropic 翻译，HTTP 400）
- 不实现自动模型路由 / cost-aware switching

## 架构

### 层次

```
+ 号菜单 (renderer)
   ├─ Claude Code           ─┐
   ├─ Gemini CLI             │
   ├─ Codex CLI              │  ← 不动
   ├─ DeepSeek               │
   ├─ GLM                   ─┘
   ├─ GPT 5.5            ─┐
   ├─ Kimi K2.5           │  ← 新增（统一走 spawn `claude` CLI）
   └─ Qwen 3.6 Plus      ─┘
   └─ ─────── 终端分隔线 ───────
   └─ PowerShell

设置面板 (renderer)
   ├─ Claude          [订阅]
   ├─ Gemini          [订阅]
   ├─ Codex           [API · gpt-5.5 · Packy]   ← 不动（仍走 codex CLI）
   ├─ DeepSeek        [API · deepseek-v4-pro]
   ├─ GLM             [API · glm-5.1]
   ├─ GPT             [API · gpt-5.5 · Packy]            ← 新增
   ├─ Kimi            [API · kimi-k2.5 · Packy]          ← 新增
   └─ Qwen            [API · qwen3.6-plus · Packy]       ← 新增
```

### 单 session 启动数据流

```
用户点 + 号 → 选 "GPT 5.5"
   ↓
renderer 调 IPC: createSession({ kind: 'gpt', cwd })
   ↓
SessionManager.createSession('gpt')
   ↓ 注入 env：
     ANTHROPIC_BASE_URL  = providers.gpt.base_url   (默认 https://www.packyapi.com)
     ANTHROPIC_AUTH_TOKEN = providers.gpt.api_key
     CLAUDE_CONFIG_DIR    = ~/.claude-packy-gpt
     CLAUDE_HUB_SESSION_ID/PORT/TOKEN/MOBILE_PORT (Hub Hook 一组)
     [删除]               HTTP_PROXY / HTTPS_PROXY / NO_PROXY (packy 国内直连)
                          ANTHROPIC_API_KEY / ANTHROPIC_API_BASE_URL (避免污染)
   ↓
pty.spawn('powershell.exe', { env: sessionEnv, cwd })
   ↓ 写入 stdin：
     " claude --model gpt-5.5 --permission-mode bypassPermissions\r\n"
   ↓
Claude CLI 启动 → 走 ANTHROPIC_BASE_URL 发 /v1/messages 请求
   ↓
PackyAPI 服务端协议翻译：Anthropic Messages → OpenAI Responses
   ↓
后端 GPT-5.5 推理 → 反向翻译响应 → Claude CLI 接收
   ↓
hook server / OSC title 等所有现有机制照常工作（CLAUDE_FAMILY 集合判定生效）
```

Kimi 和 Qwen 流程完全一致，只换 `kind`、`model`、`api_key` 来源、`CLAUDE_CONFIG_DIR` 路径。

## 文件改动清单

| 文件 | 改动量 | 说明 |
|------|--------|------|
| `core/ai-kinds.js` | +6 行 / 改 4 个数组 | 追加 `'gpt', 'kimi', 'qwen'` 到 `ALL_AI_KINDS` / `KIND_LABELS` / `CLAUDE_FAMILY` / `PASTE_SENSITIVE_KINDS`（顺带补加 `deepseek-resume`/`glm-resume` 到 `CLAUDE_FAMILY` 与 `PASTE_SENSITIVE_KINDS`，如 plan 阶段确认现状是 bug） |
| `core/session-manager.js` | +3 段 ~30 行 / +3 段 ~40 行 | 第 ~325 行 env 注入分支 + 第 ~660 行启动命令分支，照搬 deepseek 模板 |
| `core/config.js` 或对应配置层 | +3 段 default + getter | `providers.gpt` / `providers.kimi` / `providers.qwen` 默认值与读取 helper |
| `renderer/` 设置面板 React 组件 | +3 行 model 卡片 | 风格跟 GLM 项一致；`base_url` / `api_key` / `model` 三字段 |
| `renderer/` + 号菜单 React 组件 | +3 个菜单项 | 跟 DeepSeek/GLM 同位置同样式 |
| `renderer/` 图标资源 / IconRegistry | +3 个 SVG | OpenAI（黑底白圈，区别于 Codex CLI 的绿）/ Moonshot（月亮黄）/ 通义千问（紫） |
| 测试 | +unit + +e2e | unit grep 防回归 + 隔离 Hub 实测 |

## 配置 Schema

`~/.claude-session-hub/config.json`（或 `CLAUDE_HUB_DATA_DIR/config.json`）追加：

```json
{
  "providers": {
    "gpt": {
      "base_url": "https://www.packyapi.com",
      "api_key": "",
      "model": "gpt-5.5"
    },
    "kimi": {
      "base_url": "https://www.packyapi.com",
      "api_key": "",
      "model": "kimi-k2.5"
    },
    "qwen": {
      "base_url": "https://www.packyapi.com",
      "api_key": "",
      "model": "qwen3.6-plus"
    }
  }
}
```

字段说明：

- `base_url`：暴露给用户编辑（设置面板里出现该字段）。默认 `https://www.packyapi.com`（**不带 `/v1`**，Anthropic SDK 会自动拼 `/v1/messages`）。换中转或自建代理时改这里
- `api_key`：必填。GPT 用 packy `codex` 分组 key（`/api/pricing` 显示 cxtocc/codex 共享同一 key 池），Kimi 和 Qwen 用 packy `bailian` 分组 key
- `model`：暴露给用户编辑。默认 `gpt-5.5` / `kimi-k2.5` / `qwen3.6-plus`。GPT 用户可改成 `gpt-5.4-high` / `gpt-5.3-codex-xhigh` 等任意 cxtocc 分组允许的变体（pricing JSON 里 `enable_groups` 含 `cxtocc` 且 `supported_endpoint_types` 含 `anthropic` 的模型均可）

读取 helper 通过 `getConfigValues()` 暴露 flat key（参考 deepseek/glm 现有 pattern）：`GPT_BASE_URL` / `GPT_API_KEY` / `GPT_MODEL` 同理 KIMI_* / QWEN_*。

## session-manager.js 关键代码骨架

每个新 kind 一段，三段并列结构相同。以 GPT 为例：

```js
} else if (isGpt) {
  const cv = getConfigValues();
  // packy 国内直连，不走代理
  delete sessionEnv.HTTP_PROXY;
  delete sessionEnv.HTTPS_PROXY;
  delete sessionEnv.NO_PROXY;
  // 让 Claude Code CLI 连接 PackyAPI 的 Anthropic 兼容端点
  sessionEnv.ANTHROPIC_BASE_URL = cv.GPT_BASE_URL;
  sessionEnv.ANTHROPIC_AUTH_TOKEN = cv.GPT_API_KEY;
  // 清除可能继承的 Anthropic 认证，防止冲突
  delete sessionEnv.ANTHROPIC_API_KEY;
  delete sessionEnv.ANTHROPIC_API_BASE_URL;
  // 隔离 transcript / settings / history
  sessionEnv.CLAUDE_CONFIG_DIR = path.join(
    process.env.USERPROFILE || process.env.HOME || os.homedir(),
    '.claude-packy-gpt'
  );
  // Hub hook 集成
  sessionEnv.CLAUDE_HUB_SESSION_ID = id;
  if (this.hookPort) sessionEnv.CLAUDE_HUB_PORT = String(this.hookPort);
  if (this.hookToken) sessionEnv.CLAUDE_HUB_TOKEN = this.hookToken;
  sessionEnv.CLAUDE_HUB_MOBILE_PORT = String(
    (global.__mobileSrv && global.__mobileSrv.port) || 3470
  );
  if (process.env.CLAUDE_HUB_DATA_DIR) {
    sessionEnv.CLAUDE_HUB_DATA_DIR = process.env.CLAUDE_HUB_DATA_DIR;
  }
}
```

启动命令分支（写入 PowerShell stdin 的字符串），照搬 deepseek 第 ~600 行模式：

```js
} else if (isGpt) {
  const cv = getConfigValues();
  const model = cv.GPT_MODEL || 'gpt-5.5';
  ptyProcess.write(` claude --model ${model} --permission-mode bypassPermissions\r\n`);
}
```

`ensureClaudeBypassAndTrust(sessionEnv.CLAUDE_CONFIG_DIR, spawnCwd)` 同 deepseek/glm 调用。

## resume 实现

每个新 kind 注册 resume 变体 `<kind>-resume`，跟 `deepseek-resume` / `glm-resume` 处理逻辑完全一致：

- 在 `createSession()` 顶部 `isGpt = kind === 'gpt' || kind === 'gpt-resume'` 这种 OR 判定（参考第 239 行 deepseek 的写法）
- env 注入分支无差别
- 启动命令在 `useResume` 或 `resumeCCSessionId` 等 flag 下走 `claude --resume <id>` 路径，由 session-manager 现有 dispatch 逻辑统一处理（参考 deepseek-resume 现有实现，不需要额外分支）

resume session id 来源：从 `~/.claude-packy-{gpt,kimi,qwen}/projects/...` 目录下的 `<id>.jsonl` 列表里读（与 deepseek/glm 完全对称）。

renderer 侧 resume 列表 UI / 入口跟 deepseek/glm 行为一致，扩展现有的"AI 类型筛选"控件即可。

## 数据隔离

```
~/.claude/                       ← 主 Claude session
~/.claude-deepseek/              ← DeepSeek（已有）
~/.claude-glm/                   ← GLM（已有）
~/.claude-packy-gpt/             ← 新增
~/.claude-packy-kimi/            ← 新增
~/.claude-packy-qwen/            ← 新增
```

每个目录是 Claude CLI 的独立配置 root，互不污染：

- transcript JSONL 落在自家 `projects/<cwd-encoded>/<sessionId>.jsonl`
- `settings.json` 自家维护（permission-mode 等）
- 跟 deepseek/glm 一样调用 `ensureClaudeBypassAndTrust(dir, cwd)` 预置 bypass 模式 + trust 当前 cwd

测试 Hub 实例（`CLAUDE_HUB_DATA_DIR=<temp>`）下，这些目录仍走 `~/.claude-packy-*`（用户级），不被 Hub 数据目录的隔离覆盖——这与 deepseek/glm 当前行为对齐。

## 错误处理

| 错误源 | 表现 | Hub 行为 |
|--------|------|---------|
| `api_key` 为空 | 创建 session 时 env token 为空字符串 | + 号菜单对应项灰显（disabled），鼠标悬停 tooltip 提示"请在设置中填写 API key"；点击仍可弹设置面板（参考 DeepSeek/GLM 当前同样行为） |
| HTTP 401/403（key 无效或过期） | Claude CLI 自身把错误打到 transcript | Hub 不额外拦截，跟 deepseek/glm 一致 |
| HTTP 503（packy 限流 / 跨分组拒绝） | CLI 显示重试提示 | Hub 不额外处理 |
| `model` 字段错误（packy 不支持的模型名） | CLI 收到 4xx | Hub 不额外拦截 |
| packy 端宕机 | CLI 超时 | 用户判断重试 |
| 不带 `/v1` 的 base_url 写错（用户改成带 `/v1`） | Anthropic SDK 重复拼接 → 404 | 不主动校验。文档里说明 base_url 不带 `/v1` |

不主动检测、不主动重试是有意设计：跟 deepseek/glm 行为对称，hub 始终保持"启动 + 透传"的轻角色，错误反馈在 transcript 里由用户处理。

## 测试计划

按 CLAUDE.md 铁律，所有 E2E 测试都在隔离 Hub 实例（`CLAUDE_HUB_DATA_DIR`）里跑，绝不动生产 Hub。

### Unit 层

- `tests/unit/unit-ai-kinds-no-hardcode.test.js` 已有的 grep 防回归会自动覆盖新增 kind（如发现某处 `['claude', 'gemini', 'codex', 'deepseek', 'glm']` 字面量没改成动态查 `ALL_AI_KINDS`，会失败）
- 新增 unit：`config-providers.test.js` 验证 `providers.gpt/kimi/qwen` 默认值 + getter helper 行为

### 集成层

- 启动隔离 Hub 实例（`CLAUDE_HUB_DATA_DIR=C:/temp/hub-packy-test`），通过 IPC 触发 `createSession({kind: 'gpt'})`，检查：
  - 子进程 env 含 `ANTHROPIC_BASE_URL=https://www.packyapi.com` 和 `CLAUDE_CONFIG_DIR=~/.claude-packy-gpt`
  - 写入 stdin 的命令含 `--model gpt-5.5`
- 三类 kind 各跑一遍

### E2E 真实测试（需真实 packy key）

1. **基础响应**：每个 kind 创建 session，发 "reply only: ok"，验证收到 200 + content 含 "ok"
2. **transcript 落点**：发完一轮后检查 `~/.claude-packy-{gpt,kimi,qwen}/projects/<cwd>/<id>.jsonl` 文件确实存在且包含本轮对话
3. **resume**：关闭 session 后从 + 号 / Resume UI 重开，验证历史消息可见
4. **多 session 并发**：同时开 GPT + Kimi + Qwen 三个 session，互发不同 prompt，互不干扰
5. **空 key 防御**：清空某项 api_key 后看 + 号菜单对应项是否禁用
6. **回归**：现有 Claude / DeepSeek / GLM / Codex CLI 创建 session、resume、Stop hook、OSC title、统计卡片所有行为不变

E2E 用真实 PackyAPI 网络请求，不 mock（用户铁律：测试必须真实执行；且 packy 翻译行为是 packy 服务端的，mock 没意义）。

### 不做

- 不做 packy 服务端协议翻译质量测试（tool use / prompt cache 命中率）。这是 packy 黑盒，用户实际使用中观察并反馈即可
- 不做长会话成本分析

## 已知约束（用户已认可）

- **每次请求 packy 注入约 4K token 系统提示**做协议转换（OpenAI ↔ Anthropic）。短对话单价被这个底噪拉高；长对话/代码任务影响小
- **Kimi 和 Qwen UI 上各自独立填 bailian key**（同一个 key 填两遍）。Q2 选 A 决策
- **GPT-5.5 翻译质量上限**取决于 packy 服务端翻译实现质量（tool use 参数完整性、prompt cache 命中率），可能比原生 Claude / deepseek-anthropic 稍差，使用中观察
- **MiniMax-M2.7 不能用此通路**（实测 packy 没翻译适配）。如果未来需要 MiniMax，必须本地起 LiteLLM/CCR 翻译代理，作为后续独立设计
- **`-resume` 变体可能要补 `CLAUDE_FAMILY` / `PASTE_SENSITIVE_KINDS`**：当前 deepseek-resume / glm-resume 是否完全在这两个集合里，plan 阶段需 grep 确认。如缺失则顺手补上（这是已有 bug 不是本特性引入的，但与本特性同动；用户铁律允许在改的范围内带上必要修正）

## 非目标（YAGNI 列表）

- 不实现 + 号菜单二级展开（多模型变体快捷选择）
- 不引入 PackyAPI 包月端点（`codex-api.packycode.com/v1`，包月不支持 Anthropic 端点）
- 不替换 / 弃用现有 Codex CLI session（保留它走 codex 二进制 + OpenAI Responses API）
- 不实现成本可见化、模型路由、自动降级
- 不为 MiniMax 起本地翻译代理
- 不在配置层把 PackyAPI 抽成独立 provider（Q4 选 A 决策）
- 不实现 PackyAPI key 余额查询展示
- 不为新 session 加专属 system prompt 注入（跟 deepseek/glm 一样不注入）
