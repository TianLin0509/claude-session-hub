# refactor-guard hook 失效调查

调查时间：2026-05-02
调查对象：commit `2c759ba`（16 文件 / 1913+/1714- 行 / 夹带单实例锁无关改动），未被 refactor-guard 拦截。

---

## 当前实际状态

### settings.json 实际配置（已注册，路径正确）

`C:\Users\lintian\.claude\settings.json` 第 45-56 行：

```json
"PreToolUse": [
  {
    "matcher": "Bash",
    "hooks": [
      {
        "type": "command",
        "command": "python \"C:\\Users\\lintian\\.claude\\scripts\\unified_bash_guard.py\"",
        "timeout": 10,
        "statusMessage": "Checking guards..."
      }
    ]
  },
  ...
]
```

- `settings.json` 修改时间：**2026-05-01**（commit 前一天）
- `unified_bash_guard.py` 修改时间：**2026-04-26**（commit 前 6 天）
- 没有项目级 `.claude/settings.json` 覆盖（`C:\Users\lintian\claude-session-hub\.claude\` 不存在 settings 文件）
- `settings.local.json` 只放权限白名单，无 hook 覆盖

### hook 脚本存在且逻辑正确

`C:\Users\lintian\.claude\scripts\unified_bash_guard.py` 第 61-91 行实现 refactor-guard：

```python
# --- git commit guards (refactor + e2e) ---
if not re.search(r"git\s+commit", cmd):
    sys.exit(0)

try:
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        capture_output=True, text=True, timeout=5,
    )
    staged = [f for f in result.stdout.strip().split("\n") if f]
except Exception:
    sys.exit(0)

if not staged:
    sys.exit(0)

# Refactor guard: ≥3 files need /post-refactor-verify
if len(staged) >= 3:
    marker = os.path.join(tempfile.gettempdir(), ".refactor-verified")
    if not os.path.exists(marker):
        emit(
            f"[refactor-guard] 本次 commit 涉及 {len(staged)} 个文件（≥3），属于大改动。\n"
            ...
            "deny",
        )
```

实测在 hub repo 目录下手工注入 stdin，hook 能正确返回 `permissionDecision: "deny"`。所以**判定逻辑本身没 bug**。

`C:\Users\lintian\.claude\scripts\refactor_guard.py`（独立旧文件）也存在，但 settings.json 没引用它，是 dead code。

### post-refactor-verify skill 定义存在

`C:\Users\lintian\.claude\skills\post-refactor-verify\SKILL.md` 第 122-129 行定义放行标记：

```markdown
### Step 7 — 创建放行标记
**只有在 Step 1-6 全部通过后**才执行：
touch "$TEMP/.refactor-verified"
```

放行标记当前**不存在**于任何 temp 目录，所以不是「标记长期存在被绕过」。

---

## 失效根因（一句话）

**`unified_bash_guard.py` 第 65-72 行的 subprocess 用 hook 进程自身的 cwd 跑 `git diff --cached --name-only`，但 hook 进程的 cwd 跟随 Claude Code session 的启动目录。当用户在 `C:\Users\lintian`（非 hub repo）启动 claude session 后操作 hub 代码并 commit，subprocess 在 home 目录执行 git 命令失败，第 71-72 行的 `except: sys.exit(0)` 静默放行。**

### 三段证据链

**证据 1 — 失效 commit 在 home session 里发生**

Grep `dispatchMode|主驾重构` 关键字命中 10 个 session jsonl，**全部位于 `C:\Users\lintian\.claude\projects\C--Users-lintian\` 下**（home 目录的项目空间），**没有一个落在 `C--Users-lintian-claude-session-hub`**。即用户当时在 home 启动 claude，跨目录改 hub 代码。

**证据 2 — 同 hook 同输入，cwd 不同结果不同**

| 测试 | hook 进程 cwd | stdin command | 结果 |
|-----|---------------|---------------|------|
| A | `C:/Users/lintian/claude-session-hub`（hub 内有 3 staged 文件） | `git commit -m test` | `permissionDecision: deny`（拦下） |
| B | `C:/Users/lintian/AppData/Local/Temp/hook-test-repo`（3 staged） | `git commit -m test` | `permissionDecision: deny`（拦下） |
| C | `C:/Users/lintian`（非 git repo / home） | `git commit -m test`，stdin 还附带 `cwd: ".../hook-test-repo"` 字段 | **EXIT=0 直接放行** |

**证据 3 — subprocess 在 home 跑 git 真的失败**

```python
cd C:\Users\lintian
subprocess.run(["git","diff","--cached","--name-only"]) 
# rc=129, stderr="error: unknown option `cached'..."
```

git for windows 在 home 找不到 `.git`，但不是干净的 not-a-git-repository，而是把 `--cached` 误解析进 `--no-index` 模式 → rc=129 → subprocess.run 不抛异常但返回空 stdout → 第 70 行 `staged=[]` → 第 74-75 行 `if not staged: sys.exit(0)` 放行。

### 缺陷定位（具体到行）

`C:\Users\lintian\.claude\scripts\unified_bash_guard.py`：

| 行号 | 缺陷 |
|-----|-----|
| L9-13 | 解析 stdin 时**只取 `tool_input.command`，丢弃了 `data["cwd"]`** |
| L65-69 | `subprocess.run` 没传 `cwd=` 参数，依赖进程当前 cwd |
| L71-72 | `except Exception: sys.exit(0)` 静默吃掉所有错误，包括「git 命令报错」「不在 git 仓库内」这类应当 fail-loud 的情况 |
| L74-75 | `if not staged: sys.exit(0)` 把「真没 staged」和「git 命令失败导致空输出」混为一谈 |

---

## 修复方案

### 方案 A（最小修复）：使用 stdin 里的 cwd 字段

Claude Code 文档明确：PreToolUse hook 的 stdin payload 含 `cwd` 字段（`session-hub-hook.py` 第 40 行已经这么用过）。

**before**（`C:\Users\lintian\.claude\scripts\unified_bash_guard.py` 第 9-13 行 + 第 65-75 行）：

```python
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

cmd = data.get("tool_input", {}).get("command", "")
if not cmd:
    sys.exit(0)

...

# --- git commit guards (refactor + e2e) ---
if not re.search(r"git\s+commit", cmd):
    sys.exit(0)

try:
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        capture_output=True, text=True, timeout=5,
    )
    staged = [f for f in result.stdout.strip().split("\n") if f]
except Exception:
    sys.exit(0)

if not staged:
    sys.exit(0)
```

**after**：

```python
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

cmd = data.get("tool_input", {}).get("command", "")
if not cmd:
    sys.exit(0)

# Claude Code session cwd（hook 进程自身 cwd 不可靠，必须用 stdin 里的）
session_cwd = data.get("cwd") or os.getcwd()

# 复合命令 `cd X && git commit` 时，提取 cd 目标作为 git 操作目录
m_cd = re.search(r"(?:^|[;&|]\s*)cd\s+([^\s;&|]+)", cmd)
if m_cd:
    cd_target = m_cd.group(1).strip('"\'')
    if not os.path.isabs(cd_target):
        cd_target = os.path.join(session_cwd, cd_target)
    if os.path.isdir(cd_target):
        session_cwd = cd_target

...

# --- git commit guards (refactor + e2e) ---
if not re.search(r"git\s+commit", cmd):
    sys.exit(0)

# 必须在正确的 git repo 下查 staged，否则 fail-loud 而非静默放行
try:
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        capture_output=True, text=True, timeout=5,
        cwd=session_cwd,
    )
except Exception as e:
    emit(f"[refactor-guard] 无法执行 git diff（cwd={session_cwd}）：{e}", "deny")

if result.returncode != 0:
    # 不在 git 仓库 / git 报错 → fail-loud，不允许静默放行
    emit(
        f"[refactor-guard] git diff --cached 失败（cwd={session_cwd}, rc={result.returncode}）。\n"
        f"如果该 commit 不在 git 仓库内，本来也不该执行；如果有特殊场景，请显式 SKIP_REFACTOR_GUARD=1。",
        "deny",
    )

staged = [f for f in result.stdout.strip().split("\n") if f]
if not staged:
    sys.exit(0)
```

### 方案 B（防御加固）：禁止跨目录 commit

如果担心方案 A 的 `cd X && git commit` 解析仍有边界 case，可补充：

```python
# 检测复合命令里同时存在 cd 和 git commit 的情况
if re.search(r"cd\s+\S+", cmd) and re.search(r"git\s+commit", cmd):
    if not os.environ.get("SKIP_REFACTOR_GUARD"):
        emit(
            "[refactor-guard] 检测到 `cd ... && git commit` 复合命令。"
            "请先单独 cd 切换 cwd，再独立执行 git commit，让 hook 准确判定 staged。"
            "跳过：SKIP_REFACTOR_GUARD=1",
            "deny",
        )
```

推荐：**先用方案 A，验证一周稳定后再决定要不要加方案 B 的强约束**。

### 同步修复 e2e_test_guard

unified_bash_guard.py 第 96-122 行的 E2E guard 用同一个 `staged` 列表，方案 A 修了 staged 来源后 e2e guard 也自动修复。无需额外改动。

---

## 验证方法

> 以下为「不修改 hook 文件」的纯验证流程，可在 TDD agent 跑完后执行。

### 验证 1 — 修复前 hook 在错误 cwd 下放行（复现失效）

```bash
# 1. 准备一个 3 staged 文件的临时 repo
mkdir -p "C:/Users/lintian/AppData/Local/Temp/hook-test-fail"
cd "C:/Users/lintian/AppData/Local/Temp/hook-test-fail"
git init -q && touch a.txt b.txt c.txt && git add a.txt b.txt c.txt

# 2. 在 home（非 git repo）下用当前未修复的 hook
cd "C:/Users/lintian"
echo '{"tool_input":{"command":"git commit -m test"},"cwd":"C:/Users/lintian/AppData/Local/Temp/hook-test-fail"}' \
  | python "C:/Users/lintian/.claude/scripts/unified_bash_guard.py"
echo "EXIT=$?"
# 预期（修复前）：无输出，EXIT=0（hook 放行）→ 复现 bug
```

### 验证 2 — 修复后 hook 应当拦截

修复 `unified_bash_guard.py` 后，用同一条命令再跑：

```bash
cd "C:/Users/lintian"
echo '{"tool_input":{"command":"git commit -m test"},"cwd":"C:/Users/lintian/AppData/Local/Temp/hook-test-fail"}' \
  | python "C:/Users/lintian/.claude/scripts/unified_bash_guard.py"
# 预期（修复后）：输出含 "[refactor-guard]" + "permissionDecision":"deny"
```

### 验证 3 — 真实 Claude session 端到端

1. 在 `C:\Users\lintian`（home）启动一个新 claude session
2. 让 claude 跑 `cd C:/Users/lintian/AppData/Local/Temp/hook-test-fail && git commit -m test`
3. 预期：Bash 工具被拒绝，提示 `[refactor-guard]`

### 验证 4 — 正常路径回归

确保正常 ≤2 文件 commit 不被误拦：

```bash
cd "C:/Users/lintian/AppData/Local/Temp/hook-test-fail"
git rm --cached b.txt c.txt -q  # 只保留 1 staged
echo '{"tool_input":{"command":"git commit -m test"},"cwd":"C:/Users/lintian/AppData/Local/Temp/hook-test-fail"}' \
  | python "C:/Users/lintian/.claude/scripts/unified_bash_guard.py"
echo "EXIT=$?"
# 预期：无输出，EXIT=0（放行，正常）
```

### 验证 5 — 标记放行路径

```bash
touch "$TEMP/.refactor-verified"
# 重新加 3 文件 staged
cd "C:/Users/lintian/AppData/Local/Temp/hook-test-fail"
git add a.txt b.txt c.txt
echo '{"tool_input":{"command":"git commit -m test"},"cwd":"C:/Users/lintian/AppData/Local/Temp/hook-test-fail"}' \
  | python "C:/Users/lintian/.claude/scripts/unified_bash_guard.py"
echo "EXIT=$?"
ls "$TEMP/.refactor-verified" 2>&1  # 应当已被 hook 删除
# 预期：EXIT=0 放行 + marker 被一次性消费
```

---

## 启用建议

### 启用时机

- **不要现在改**：用户的另一个 Claude session 正在做 TDD commit 工作，启用修复会拦住它
- **TDD agent 跑完之后**：等用户确认 TDD 阶段所有 commit 完成（可让用户主动通知）
- 立即启用风险：当前 TDD agent 在做的 commit 如果 ≥3 文件且未运行 `/post-refactor-verify`，会被立即拦下，需要用户手动放行或等 TDD agent 重试

### 启用步骤（用户 TDD 完成后执行）

```bash
# 1. 备份原 hook
cp "C:/Users/lintian/.claude/scripts/unified_bash_guard.py" \
   "C:/Users/lintian/.claude/scripts/unified_bash_guard.py.bak.20260502"

# 2. 应用方案 A 的 diff（手动 patch 第 9-13 行 + 第 65-75 行，见上面"修复方案"）

# 3. 跑验证 1-5（注意修复前再跑一次验证 1 复现失效，然后再改）

# 4. 真实 commit 测试：
cd C:/Users/lintian/claude-session-hub
# 故意 stage 3 文件试 commit，应被拦下并提示 /post-refactor-verify
```

### 回退步骤

如果修复后出现误伤（正常工作流被卡）：

```bash
cp "C:/Users/lintian/.claude/scripts/unified_bash_guard.py.bak.20260502" \
   "C:/Users/lintian/.claude/scripts/unified_bash_guard.py"
```

或临时禁用：在 hook 第 64 行后插入 `if os.environ.get("SKIP_REFACTOR_GUARD"): sys.exit(0)`，然后用 `SKIP_REFACTOR_GUARD=1 git commit ...`。

### 长期增强建议（可选）

1. **额外看 `data["session_id"]` + 转 home 项目目录的 jsonl 拿真实工作目录**：当用户 hub 操作但 session 在 home 启动时，自动反推 hub repo 路径——已超出 surgical 修复范围，先跑方案 A
2. **PostToolUse 上加补充检查**：commit 成功后用 `git log -1 --stat` 复核文件数，事后告警（不能阻止但能让用户复盘）
3. **CLAUDE.md 加一条铁律**：「操作 hub 代码必须先 cd 到 hub 目录或在 hub 目录启动 claude session」——补 hook 漏检的边角

---

## 附：调查中发现的次要问题（不阻塞修复）

1. `C:\Users\lintian\.claude\scripts\refactor_guard.py` 是旧版独立 hook，settings.json 已不引用它，建议删除避免误导
2. `unified_bash_guard.py` 注释（第 3 行）说"Replaces 4 separate hooks"，但 `refactor_guard.py / e2e_test_guard.py / hub_isolation_guard.py` 三个被替代的文件还留在 scripts 目录，可一起清理
3. e2e_test_guard 用同一个 `staged` 来源，本次 cwd bug 同样会让它在跨目录 commit 时静默放行 UI 文件——方案 A 一并修复
