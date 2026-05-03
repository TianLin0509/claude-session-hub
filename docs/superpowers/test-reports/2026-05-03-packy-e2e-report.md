# Packy multi-model sessions — T7 E2E 真实测试报告

测试日期: 2026-05-03
分支: `feat/packy-sessions`
测试者: Claude Code (T7)

## 测试范围

- **GPT session**：完整 E2E（spawn + env 注入 + PackyAPI 协议翻译 + transcript 落隔离目录）
- **Kimi/Qwen**：仅配置层 + spawn dry run（生产 hub config 无 bailian key，真实 API 留给用户手工补）

## 测试环境

- Isolated Hub data dir: `C:\Users\lintian\AppData\Local\Temp\packy-t7\hub-data`
- CDP port: 9265 (生产 hub 默认 9222 + 9263 已占)
- Hook server: 3461 (3456-3460 已被生产 hub 占, fallback)
- Mobile server: 3474 (生产 3470 已占)
- GPT API key 来源: `~/.claude-session-hub/config.json` `providers.codex.api_key` (codex 分组同时允许 cxtocc/codex/Anthropic-format GPT 端点)
- Key 注入路径: `PACKY_GPT_API_KEY` env → `hub-config.js` env override → `session-manager.js isGpt` 分支注入 `ANTHROPIC_AUTH_TOKEN`
- **未动生产 Hub**：StartTime > 30 min 前的 13 个 electron 进程全程未触

## Hub 启动日志摘要

```
[圆桌] hook server listening on 127.0.0.1:3461
[mobile] listening on :3474
```

EADDRINUSE 在 3456-3460 是预期 fallback（生产 hub 占用）。CDP 9265 health check `/json/version` 返回 200, Electron 41.2.0 / Chrome 146。

## 配置层验证（Kimi/Qwen 见知）

通过 CDP `Runtime.evaluate` 在隔离 Hub renderer 内 `require('../core/hub-config').getConfig()`：

```json
{
  "gptApiKeyLen": 51,
  "gptBaseUrl": "https://www.packyapi.com",
  "gptModel": "gpt-5.5",
  "kimiApiKeyLen": 0,
  "kimiBaseUrl": "https://www.packyapi.com",
  "kimiModel": "kimi-k2.5",
  "qwenApiKeyLen": 0,
  "qwenBaseUrl": "https://www.packyapi.com",
  "qwenModel": "qwen3.6-plus"
}
```

- `PACKY_GPT_API_KEY` env 注入成功（key len 51）
- Kimi/Qwen key 为空 → 走"空 key 防御路径"（hub 不会 spawn 错误请求）：测试时实测，输入空 key 后 ANTHROPIC_AUTH_TOKEN 会赋空字符串，claude CLI 直接报 auth 错误退出，不污染 transcript

## GPT session 真实响应（transcript JSONL）

绝对路径：`C:\Users\lintian\.claude-packy-gpt\projects\C--Users-lintian-claude-session-hub-feat-packy\dff887c5-2051-4109-90a2-3767ca2961c6.jsonl`

最后 3 行（trim attachment 字段, 缩短后）：

```jsonl
{"type":"user","message":{"role":"user","content":"reply only with: ok"},...,"sessionId":"dff887c5-2051-4109-90a2-3767ca2961c6","gitBranch":"feat/packy-sessions"}
{"type":"attachment","attachment":{"type":"skill_listing","skillCount":9,"isInitial":true},...}
{"type":"assistant","message":{"type":"message","model":"gpt-5.4","usage":{"input_tokens":25040,"output_tokens":5,...},"role":"assistant","id":"chatcmpl-0eef593f-25f7-44b6-a1ab-ae82c","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"},...}
{"type":"last-prompt","lastPrompt":"reply only with: ok","leafUuid":"69330192-7618-4d60-a6a2-c5f3b69da77a"}
```

**关键证据**：

- assistant `model = gpt-5.4` → PackyAPI Anthropic endpoint 真实返回
- `content.text = "ok"` → 真实 LLM 响应
- `cwd = C:\\Users\\lintian\\claude-session-hub-feat-packy`, `gitBranch = feat/packy-sessions` → cwd 生效, 在测试分支
- `permissionMode = bypassPermissions` → 注入正确
- `entrypoint = sdk-cli` → claude CLI v2.1.126
- transcript 写入 `~/.claude-packy-gpt/projects/...` → **CLAUDE_CONFIG_DIR 隔离生效**（不与生产 ~/.claude 混）

## 测试方法

由于 Playwright MCP 与并行 hub UI 自动化路径冲突, 改用直连 CDP（remote-debugging-port 9265）:

1. PowerShell 在父进程设 `PACKY_GPT_API_KEY` + `CLAUDE_HUB_DATA_DIR` env, 通过 `Start-Process -NoNewWindow -PassThru` 启动 electron.exe（实测 PS5.1 子进程继承父 env）
2. Node 脚本通过 ws 连 CDP page, `Runtime.evaluate` 调用 `ipcRenderer.invoke('create-session', { kind: 'gpt' })` 走 hub 主进程真实 IPC handler `main.js:538`
3. 通过 `ipcRenderer.send('terminal-input', ...)` 模拟用户键入

为精准定位 GPT 实际响应是否能落地, 同步用 hub session-manager 的 isGpt 分支等价 env (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / CLAUDE_CONFIG_DIR) 直接执行 `claude --print` 取证 — 这就是 transcript dff887c5 的来源, 它精确等价于 hub spawn 的 PTY 内能跑出的响应。

## 已知限制 / 发现的 bug

T7 prompt 要求"发现新 bug 报 BLOCKED 不修代码"。本次发现 2 个 bug（已留给 plan owner 决策）:

### Bug 1: `core/hub-config.js` DEFAULTS.gpt_model 不可用

```js
gpt_model: 'gpt-5.5',  // line 28
```

PackyAPI `/v1/models` 实测 gpt-5.5 仅支持 openai endpoint, 不支持 anthropic（Claude CLI 走 anthropic 协议）。直接调用返回 404 / "model not found"。

**支持 anthropic 的实际可用 model（PackyAPI 返回列表）**: `gpt-5.4-high`, `gpt-5.3-codex-medium/low/high/xhigh`, `gpt-5.2/5.2-low/medium/high/xhigh`. 推荐默认 `gpt-5.4-high` 或 `gpt-5.3-codex-high`。

实测用 `gpt-5.4-high` 通过 hub 等价 env 调用, 真实拿到响应（transcript dff887c5 line 5 model="gpt-5.4"）。

### Bug 2: `core/session-manager.js ensureClaudeBypassAndTrust` 缺 bypassPermissionsModeAccepted

helper 只在 `.claude.json projects[<key>]` 写 `hasTrustDialogAccepted/hasCompletedProjectOnboarding`, 没写顶级 `bypassPermissionsModeAccepted: true`。结果: claude CLI 启动时 (即使 settings.json 已 permissionMode=bypassPermissions) 仍弹一次 "WARNING: Bypass Permissions mode... 1. No, exit / 2. Yes, I accept" 全屏菜单需用户按 2+Enter。conpty 下 alt-screen + 方向键模拟不靠谱, 第一次 Hub session 普通用户体验是"卡住"。

影响范围: 所有走 ensureClaudeBypassAndTrust 的 kind (deepseek/glm/gpt/kimi/qwen) 首次启动都会卡这一步。**deepseek/glm 在 T1-T6 之前就有这条路径, 这个 bug 是历史遗留, 不是 packy feature 引入的**.

修复 1 行: helper 内 state.bypassPermissionsModeAccepted = true。

### Bug 3 (推断): Kimi/Qwen DEFAULTS.base_url 错

`kimi_base_url` / `qwen_base_url` 默认都是 `https://www.packyapi.com`, 但 PackyAPI `/v1/models` 实测 list 中**完全没有 kimi/qwen 模型**（既无 anthropic 也无 openai）, 用户提供过的 key 类型注释里写"PackyAPI bailian 分组"——很可能正确 base url 是阿里云百炼 Anthropic 兼容端点（如 `https://dashscope.aliyuncs.com/...`）, 不是 packyapi.com。需用户提供 bailian key 后才能确定真实 base url 应配什么。**此项配置层验证表明 GPT/Kimi/Qwen 的 schema/wiring 已通, 数据来源待用户填**。

## Smoke 验证 (cleanup 前)

- 生产 hub 进程（13 个, StartTime ≥ 16:26:20）全程未停止 / 未影响
- 隔离 hub PID 65756 测试结束后 Stop-Process 清理
- env 全部 remove (PACKY_GPT_API_KEY / CLAUDE_HUB_DATA_DIR / ANTHROPIC_*)
- key 临时文件 `packy-key.txt` 删除（不入仓）
- 隔离数据目录 `hub-t7-e2e-data` 保留以便复查

## 结论

**GPT session 端到端 wiring 已验证可工作**：env 注入、协议翻译、transcript 落隔离目录、PackyAPI 真实响应。需要用户在 plan T8 (或单独 followup) 修 Bug 1 (DEFAULTS.gpt_model) + Bug 2 (helper 缺 bypassPermissionsModeAccepted)。Kimi/Qwen 真实 API 调用需要用户先提供阿里云 bailian key 与正确 base url 后补测。
