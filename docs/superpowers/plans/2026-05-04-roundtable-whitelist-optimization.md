# Plan: 圆桌白名单优化

**Goal:** 解除圆桌中误杀的用户基本操作（/model、/compact 等）+ 开放 memory 写入白名单，让每个 AI 在圆桌中也能积累独立记忆。

**Origin:** 2026-05-04 圆桌讨论（Opus 4.6 / DeepSeek V4 / GLM 5.1，12 轮），完整记录见 `C:\Users\lintian\.arena\timeline-ab9afb5e-af6a-473e-bf7e-6d0b77bd3b58.md`

**Version:** v2 修订（2026-05-04 道雪）—— 调研代码现状后修补 6 个漏洞，详见末尾「v2 修订记录」段。

**Architecture:** 圆桌隔离通过三层实现：
1. `--disable-slash-commands`（CLI 参数）→ 禁用所有斜杠命令 **← 本次要删**
2. `--settings <roundtable-settings.json>`（CLI 参数）→ `enabledPlugins` 把 superpowers/codex/code-review 等 23 个 plugin 设为 false **← 保留，但有盲区**
3. BASE_RULES（prompt 软约束）→ 禁止 Edit/Write/Agent **← 本次要精细化**

⚠ **`--settings` 兜底有盲区**（v2 调研发现）：`enabledPlugins` **仅对 plugin 内的 skill 有效**。用户自定义 skill（位于 `~/.claude/skills/`，如 `cli-caller / init / loop / schedule / design-review`）**不属于任何 plugin → settings 完全禁不掉**。这部分必须由 BASE_RULES 软约束兜底（详见 Task 3）。

**Tech Stack:** Node.js, Electron, Claude Code CLI (PowerShell 5.1 / git bash 环境)

**Risk:**
- **用户主动调 `/model` `/compact` `/help` `/clear` `/config`** → 期望行为（plan 目标），**零风险** ✓
- **AI 主动调 `/agents` `/init` `/clear`** → 中风险（违反 CLAUDE.md "禁派 sub-agent / 禁圆桌内写文件" 铁律），CLI 层无法精细禁止，**必须靠 BASE_RULES 软约束**（详见 Task 3）
- **Memory 写入白名单** → 低风险，仅 prompt 措辞改动；但需先建 DS/GLM memory 目录骨架（Task 4），否则 AI 写时无 MEMORY.md 索引会写错位置
- **当前进行中的 PTY sub session 不会立即生效** → 操作风险：所有 task 改动都属于 system prompt 注入层，PTY 启动后无法热更新，**E2E 验证必须新开圆桌会议或重启 sub session**（详见 Task 5）

---

## Task 1: 去掉 `--disable-slash-commands`（P0）

**Files:**
- `C:\Users\lintian\claude-session-hub\core\session-manager.js` —— `buildRoundtableIsolationFlags()` 函数 **L151-157**（v2 调研确认行号）

**What:**
当前实现：
```js
function buildRoundtableIsolationFlags(meetingId) {
  if (!meetingId) return '';
  const settingsPath = ensureRoundtableSettings(getHubDataDir());
  const escaped = settingsPath.replace(/\\/g, '\\\\');
  return ` --disable-slash-commands --settings "${escaped}"`;  // ← 删 `--disable-slash-commands `
}
```
改后只保留 `--settings`：
```js
return ` --settings "${escaped}"`;
```

**Why:**
当前一刀切禁用所有斜杠命令，误杀了 `/model`（切换模型）、`/compact`（上下文压缩）、`/help`、`/clear`、`/config` 等用户基本操作。真正需要禁的工作流 skills 一部分被 `--settings` 的 plugin 禁用覆盖（superpowers 全家），剩余自定义 skill 由 Task 3 的 BASE_RULES 软约束兜底。

**Verify:**
- 启动**新**圆桌 session（旧 session PTY 已启动后改 CLI 参数无效），验证 `/model` 命令可用
- 验证 `/compact` 命令可用
- 验证 superpowers plugin 内 skill（如 `/plan`、`/brainstorming`）仍然被禁用（被 settings `enabledPlugins.superpowers=false` 兜住）
- ⚠ **不要在此 task 单独验证 cli-caller / init 等用户自定义 skill** —— 它们不归 settings 管，验证留给 Task 3

---

## Task 2: 验证 `--settings` 兜底完整性 + 标注盲区（P0）

**Files:**
- `C:\Users\lintian\claude-session-hub\core\session-manager.js` → `ensureRoundtableSettings()` **L135-149** + `_ROUNDTABLE_DISABLE_PLUGINS` **L109-133**

**What:**
v2 调研确认当前 `_ROUNDTABLE_DISABLE_PLUGINS` 已包含 23 个 plugin（`superpowers / codex / feature-dev / skill-creator / code-review / security-guidance / hookify / commit-commands / pyright-lsp / claude-md-management / frontend-design / harness / context7 / ui-ux-pro-max / trailofbits-skills 全家 9 个`），settings 写入 `<hubDataDir>/roundtable-claude-settings.json`。

**两类 skill 的兜底真相**（v2 修订核心发现）：

| Skill 类别 | 示例 | settings 是否兜得住 | 兜底机制 |
|---|---|---|---|
| **plugin 内 skill** | `plan / brainstorming / TDD / debugging / SDD / post-refactor-verify / simplify / review / security-review` (全在 superpowers plugin 内) | ✅ 是 | `enabledPlugins["superpowers@..."]=false` 整体禁用 |
| **用户自定义 skill** | `cli-caller / init / loop / schedule / design-review` (位于 `~/.claude/skills/`) | ❌ **否** | **不属于任何 plugin → settings 完全禁不掉**，必须靠 Task 3 BASE_RULES 软约束 |

⚠ **本 task 不新增代码**，仅做契约确认 + 写入文档明示盲区。如需在代码层补强（如新增 `--disabled-skills <list>` CLI 参数），属于 Task 6（暂未列入本 plan，留给 P2）。

**Why:**
去掉 `--disable-slash-commands` 后，必须区分两类 skill 的兜底归属，否则会误以为"settings 全兜得住"，把 cli-caller 等用户自定义 skill 的禁用责任甩给 settings，结果实际上没禁。

**Verify:**
1. 读取 `<hubDataDir>/roundtable-claude-settings.json`，确认 23 个 plugin 均为 false（已是当前状态，仅做回归检查）
2. **新开**圆桌会议，分别测试两类 skill：
   - **plugin 内**：输入 `/plan` → 应被 settings 拒绝（"unknown command" 或类似）
   - **用户自定义**：输入 `/init` → 在 Task 3 完成前，**预期可以触发**（暴露盲区）；Task 3 完成后，应被 BASE_RULES 软约束在 prompt 层拒绝（AI 看到指令后明示拒绝执行而非调用 skill）
3. 在 session-manager.js 的 `_ROUNDTABLE_DISABLE_PLUGINS` 上方加注释，明示"settings 仅对 plugin 内 skill 生效，用户自定义 skill 由 BASE_RULES 兜底"

---

## Task 3: BASE_RULES 措辞精细化（P1）—— v2 提升优先级到 P0（兜底盲区填补，是 Task 1 的安全前提）

**Files:**
- `C:\Users\lintian\claude-session-hub\core\roundtable-scenes.js` —— `BASE_RULES` 常量 **L75-104**（v2 调研确认行号）

**What:**
当前 L77-87 措辞（实际文本，非"大意"）：
```
## ⚠️ 铁律：圆桌讨论 ≠ 独立任务执行
本轮只输出**观点**（≤ 1500 字）。这不是独立任务——不要展开多步骤工作流。

**禁止**：
- 触发 plan / brainstorming / TDD / debugging 等 skill；派生 Task / sub-agent
- Edit / Write 文件；跑长命令（构建、部署、大型脚本）
- 主动自检 / verify / 多方审查；套用 CLAUDE.md 或记忆里的工作流

**可用**（单次、必要时）：Read 文件 / Grep 关键字 / WebSearch / WebFetch / 浏览 timeline.md
```

改为（区分"用户主动 vs AI 主动" + 显式 memory 白名单 + 用户自定义 skill 软禁）：
```
## ⚠️ 铁律：圆桌讨论 ≠ 独立任务执行
本轮只输出**观点**（≤ 1500 字）。这不是独立任务——不要展开多步骤工作流。

**AI 禁止主动调用**（用户主动用斜杠命令例外）：
- 任何工作流 skill：plan / brainstorming / TDD / debugging / SDD / post-refactor-verify /
  simplify / review / security-review / cli-caller / init / loop / schedule / design-review
- 派生 Task / sub-agent
- 斜杠命令 `/agents`（派 sub-agent）/ `/init`（写 CLAUDE.md）/ `/clear`（清历史会断 timeline）
- Edit / Write **项目文件**（main.js / *.py / *.md 等代码或文档）
- 跑长命令（构建、部署、大型脚本）
- 主动自检 / verify / 多方审查；套用 CLAUDE.md 或记忆里的工作流

**允许**（必要时单次使用）：
- Read / Grep / Glob / WebSearch / WebFetch / 浏览 timeline.md
- **Auto-memory 写入**（每个 AI 写入自身 memory 目录的记忆文件，路径见用户级 CLAUDE.md
  memory 段；圆桌 memory 应在 frontmatter 含 `source: roundtable` 标记）
- MCP 数据查询工具（如 `fetch_lindang_stock` 等）

**用户主动调用斜杠命令时**：放行（`/model` `/compact` `/help` `/clear` `/config` 都是用户基本操作）。
```

**Why（v2 增补）:**
1. "Edit / Write 文件" → "Edit / Write **项目文件**"：明示 memory 文件不在禁令范围
2. **AI 主动 vs 用户主动 区分**：Task 1 解锁所有斜杠命令后，**用户调 `/model` `/compact` 是 plan 目标**，但 **AI 主动调 `/agents` `/init` `/clear` 会违反 CLAUDE.md 铁律**（派 sub-agent / 写文件 / 断 timeline），CLI 层无法精细禁止 → 必须 BASE_RULES 软约束兜底
3. **显式列出 plugin 内 + 用户自定义两类 skill** —— 填补 Task 2 的"用户自定义 skill 不被 settings 兜住"盲区
4. **memory 白名单显式化** —— 避免 AI 因"禁 Write 文件"误判而不敢写 memory；附 `source: roundtable` frontmatter 建议（来自圆桌讨论 P2-4）

**Verify:**
- **新开**圆桌会议（必要前提，PTY 已启动改 prompt 无效）
- 测 4 项：
  1. AI 尝试保存 memory → ✅ 应该成功（memory 白名单生效）
  2. AI 尝试 Edit `main.js` → ❌ 应被 BASE_RULES 拒绝（"项目文件"禁令生效）
  3. 用户输入 `/compact` → ✅ 应该执行（用户主动放行）
  4. 让 AI 输出观点中说 "我打算 /init 写一份 CLAUDE.md" 然后调用 → ❌ AI 应明示拒绝（自定义 skill 软禁生效）

**Note**: 单测层加一条契约（`tests/unit-roundtable-scenes.test.js`）：BASE_RULES 必须含 "AI 禁止主动调用" 段、必须明示 "项目文件"、必须列出 cli-caller / init / loop / schedule。防止以后无意识回退。

---

## Task 4: 初始化 DS/GLM memory 目录骨架（P1）

**v2 调研确认现状（2026-05-04）:**
- `C:\Users\lintian\.claude-deepseek\` 根目录 ✅ 存在（plugins/projects/sessions 等齐全）
- `C:\Users\lintian\.claude-glm\` 根目录 ✅ 存在（plugins/projects/sessions 等齐全）
- 两者 `projects/C--Users-lintian/` 都存在（一堆 jsonl 历史会话证明 DS/GLM 圆桌使用频繁）
- **`projects/C--Users-lintian/memory/` 子目录都不存在** ❌ → 必须建

**memory 路径推导（v2 新增，避免未来 cwd 改了静默失效）**:
- main.js sub session 默认 `cwd = USERPROFILE = C:\Users\lintian`（line 584-598 注释）
- Claude CLI 把 cwd 哈希为目录名：`C:\Users\lintian` → `C--Users-lintian`
- 因此 memory 目录 = `~/.claude-{kind}/projects/C--Users-lintian/memory/`
- ⚠ **如果未来改 sub session cwd（如改成 `<HUB_DATA_DIR>/workspaces/<meetingId>/`），memory 路径会变**，需要同步更新建目录脚本

**What:**

⚠ PowerShell 5.1 编码陷阱：`Set-Content -Encoding utf8` 实际写 **UTF-16 LE BOM**（PowerShell tool 系统提示明示，PS 7+ 才修），后续 Claude CLI 读取会乱码。必须改用以下安全写法之一：

**写法 A（推荐：New-Item 仅创空目录 + 空 MEMORY.md，让 AI 首次写时自然填）**：
```powershell
foreach ($kind in @('deepseek', 'glm')) {
  $memDir = "$env:USERPROFILE\.claude-$kind\projects\C--Users-lintian\memory"
  New-Item -ItemType Directory -Path $memDir -Force | Out-Null
  $memIndex = "$memDir\MEMORY.md"
  if (-not (Test-Path $memIndex)) {
    # 用 .NET API 强制写 UTF-8 无 BOM (避开 PS 5.1 默认 UTF-16 LE BOM 陷阱)
    [System.IO.File]::WriteAllText($memIndex, "# Memory Index`r`n", [System.Text.UTF8Encoding]::new($false))
  }
  Write-Output "ready: $memIndex"
}
```

**写法 B（若用户偏好 .ps1 脚本入仓）**：在 `scripts/init-roundtable-memory-dirs.ps1` 落上述脚本，README 注明用途。本 plan 默认走 A（一次性命令）。

**验证字节序**：
```powershell
# 应输出 # Memory Index 头部 23 23 20 4D 65 6D 6F 72 79 20 49 6E 64 65 78 (UTF-8 无 BOM)
# 若开头有 FF FE 即 UTF-16 LE BOM, 写错了
Get-Content "$env:USERPROFILE\.claude-deepseek\projects\C--Users-lintian\memory\MEMORY.md" -Encoding Byte -TotalCount 16 |
  ForEach-Object { '{0:X2}' -f $_ } | Join-String -Separator ' '
```

**Why:**
Claude Code 的 auto-memory 系统需要 MEMORY.md 索引文件作为起点（系统 prompt 里 memory 段动态扫描该文件并把内容拼进上下文）。当前 DS/GLM 的 memory 目录不存在，即使放开写入白名单也无法工作 —— AI 找不到索引会"无中生有"地写到错误位置或拒绝写。

**Verify:**
- 确认两个目录 + 两个 MEMORY.md 已创建
- **字节验证**：用上面的 Get-Content 命令确认无 FF FE BOM 头
- **新开**圆桌会议（启 DeepSeek session），人工检查其 system prompt 注入段是否包含 `~/.claude-deepseek/projects/C--Users-lintian/memory/` 路径
- 让 DeepSeek 写一条 memory 测试 → 检查实际落盘到 `MEMORY.md` 同目录

---

## Task 5: 端到端验证（P0+P1 合并验证）

**前置铁律（v2 新增）:**

⚠ **必须新开圆桌会议** —— 不能在现有会议测。原因：本 plan 改动全部属于 system prompt 注入层（`--disable-slash-commands` CLI 参数 / settings 文件 / BASE_RULES prompt 文本），PTY 已启动后 system prompt 不可热更新。在旧会议测会**看到旧行为**，误判修复失效。

具体操作：
- Hub UI 点"新建" → 选"通用"或"投研"场景 → 加 ≥ 2 个 AI sub
- 推荐参与者：1 个 Claude（验 superpowers plugin 兜底）+ 1 个 DeepSeek 或 GLM（验 memory 目录）

**What & Verify（5 项）:**

| # | 操作 | 预期 | 兜底机制 |
|---|---|---|---|
| 1 | 用户在 sub session 输入 `/model` | ✅ 切换模型成功 | Task 1 删 `--disable-slash-commands` |
| 2 | 用户输入 `/compact` | ✅ 压缩上下文成功 | Task 1 删 `--disable-slash-commands` |
| 3 | AI 主动尝试写一条 memory | ✅ 成功落盘到 `~/.claude-{kind}/projects/.../memory/` | Task 3 BASE_RULES 白名单 + Task 4 目录骨架 |
| 4 | AI 主动尝试 Edit `main.js` | ❌ AI 应明示拒绝（"圆桌不写项目文件"） | Task 3 BASE_RULES "项目文件"禁令 |
| 5a | AI 主动触发 `/plan`（plugin 内 skill） | ❌ "unknown command" 或类似 | Task 2 settings `enabledPlugins.superpowers=false` |
| 5b | AI 主动触发 `/init`（用户自定义 skill） | ❌ AI 应明示拒绝（不调用 skill 而是说"圆桌不写 CLAUDE.md"） | Task 3 BASE_RULES 软约束（settings 兜不住） |

**全 6 项通过即可。** 任一失败：
- 1/2 失败 → Task 1 没改干净，回查 buildRoundtableIsolationFlags
- 3 失败 → Task 4 目录没建 / 编码错（BOM）/ Task 3 白名单没生效
- 4 失败 → Task 3 措辞 "项目文件" 没说清
- 5a 失败 → Task 2 settings 没读到（检查 `<hubDataDir>/roundtable-claude-settings.json` 存在 + 路径转义对）
- 5b 失败 → Task 3 自定义 skill 列表漏写

---

## 不在本次范围内（P2，后续按需排期）

| 编号 | 改动 | 说明 |
|------|------|------|
| P2-1 | 跨 AI 记忆摘要注入 | 每轮启动时注入同伴 MEMORY.md 索引，需评估 token 开销和同质化风险 |
| P2-2 | Per-model CLAUDE.md | 在 `.claude-deepseek/CLAUDE.md` 等加差异化指令，当前无明确需求 |
| P2-3 | 跨轮注入信息密度优化 | 当前只注入上一轮片段，更早跨 AI 发言靠 Read timeline |
| P2-4 | Memory 写入质量标记 | 圆桌 memory 加 `source: roundtable` frontmatter，区分观点态和经验态（Task 3 已先在 BASE_RULES 提示，但未硬约束） |
| P2-5 | Explore Agent 白名单 | 允许只读 Explore agent 查代码支撑观点 |
| P2-6（v2 新增） | `--disabled-skills <list>` CLI 参数 | 若 Anthropic Claude CLI 后续支持按 skill 名禁用，可彻底替代 Task 3 的软约束（用户自定义 skill 也能硬禁），现阶段不可行 |
| P2-7（v2 新增） | sub session cwd 改为 `<HUB_DATA_DIR>/workspaces/<meetingId>/` | 当前生产 Hub sub cwd = USERPROFILE（让 Claude CLI 读用户级 CLAUDE.md），如未来强化隔离把 cwd 改了，**Task 4 memory 目录路径会失效**，需同步调整 |

---

## v2 修订记录（2026-05-04 道雪）

v1 plan 由圆桌讨论产出后，调研代码现状发现 6 个漏洞，本次修订全部修补：

| # | 漏洞 | 修补位置 | 措施 |
|---|---|---|---|
| 1 | Task 2 verify 把 plan/brainstorming/cli-caller 都当 plugin —— 但 plan/brainstorming 是 superpowers plugin 内的 sub-skill（settings 兜得住），cli-caller / init / loop / schedule / design-review 是用户自定义 skill 在 `~/.claude/skills/` 下，**不归任何 plugin → settings 完全禁不掉** | Architecture 段加 ⚠ + Task 2 重写 verify 区分两类 skill | 标注盲区，把自定义 skill 软禁责任明确转交 Task 3 |
| 2 | Task 3 BASE_RULES 改动可能漏了禁 AI 主动调用 `/agents`（派 sub-agent）/ `/init`（写 CLAUDE.md）/ `/clear`（断 timeline）—— Task 1 解锁所有斜杠命令后，CLI 层无法精细禁 AI 主动调用，必须靠 BASE_RULES | Task 3 措辞细化：区分 "AI 禁止主动调用" vs "用户主动放行"，显式列出自定义 skill 名单 + 危险斜杠命令 | 提升 Task 3 优先级 P1 → P0（变成 Task 1 的安全前提） |
| 3 | Task 4 PowerShell 命令在 PS 5.1 下 `Set-Content -Encoding utf8` 实际写 UTF-16 LE BOM —— Claude CLI 读 MEMORY.md 会乱码 | Task 4 重写命令：用 `[System.IO.File]::WriteAllText` 配 `UTF8Encoding(false)` 强制无 BOM；加字节序验证步骤 | 避坑 PS 5.1 编码默认 |
| 4 | Task 5 E2E 验证没明示"必须新开会议或重启 sub" —— PTY 已启动后 system prompt 改不动，与 Bash escape 修复同样的限制 | Task 5 加前置铁律段 + 操作步骤明示新建会议 | 防止误判修复失效 |
| 5 | Risk 评估笼统说"低" —— 但 /clear /compact /agents /init 解锁后若 AI 自主调用会违反 CLAUDE.md 铁律（断 timeline / 派 sub-agent / 写 CLAUDE.md） | Risk 段重写：拆分"用户主动 vs AI 主动"，明示哪些靠 BASE_RULES 软禁 | 风险表达完整 |
| 6 | Task 4 假设 DS/GLM memory 路径已知但未推导 —— 路径取决于 sub session cwd hash，未来 cwd 改了会静默失效 | Task 4 加"memory 路径推导"段，明示 main.js sub cwd = USERPROFILE → C--Users-lintian；同时把"sub cwd 改造"列入 P2-7 标注关联性 | 抗未来回归 |

**未做的事（仍然按 v1 范围）**：
- 不引入新 CLI 参数（`--disabled-skills` 不存在，且本 plan 范围内不发明新参数）
- 不动 settings JSON 内容（23 个 plugin 名单认为已正确，仅契约确认）
- 不做 P2-1~P2-7 任何项
