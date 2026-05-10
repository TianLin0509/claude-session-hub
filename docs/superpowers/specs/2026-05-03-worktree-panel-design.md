# Hub 工作树面板（Worktree Panel）设计

**日期**：2026-05-03
**作者**：立花道雪 + Claude（Brainstorming）
**状态**：设计已确认，待 writing-plans 产出实现计划

---

## 1. 背景与动机

立花道雪在多 Claude Code session 同时工作于一个仓库时，反复遇到/担心以下问题：

- 两个 session 在同一 cwd 同一分支并行操作，互相覆盖未提交改动
- 多 worktree 设计上隔离，但仍可能改到同一文件而不自知
- 共享 `node_modules` junction 被 npm 操作踩坏（Hub 项目自身血泪案例）
- session 不知道自己身处主仓库还是 worktree，操作前缺乏边界感

现状：Hub 没有任何 cross-session 工作树/git 状态可视化，cwd 信息散落在 statusline，无法纵览。

目标：在 Hub 主窗口右侧增加一个**可开关的"工作树面板"**，当前选中 session 切换到面板时，能一眼看清：
- 当前 cwd / 分支 / 未提交改动
- 同仓库中其它 session 的状态
- 是否存在物理或文件级冲突（红/黄/绿三档）

明确**不**做：让面板替用户做 git 操作。它是只读信息面板，所有 git 动作仍由 AI 在 session 内执行。

---

## 2. 已确认的设计决策

| 维度 | 决策 | 说明 |
|------|------|------|
| 保护范围 | 全部冲突类型，三档颜色总览 | 不细分 UI section |
| 作用域 | 跟随当前选中 session（per-session 开关，类似备忘录） | 选 A 见 B 时自动切视角 |
| 信息密度 | Dashboard 仪表盘，360px 宽 | 顶部 health bar + 拓扑 + commit graph + 文件 diff bar |
| 与备忘录共存 | 独立槽位，可同时打开 | 备忘录在最右、工作树紧贴其左 |
| 颜色规则 | "B"：cwd 重叠+文件级冲突双因子 | 见 §4 |
| 刷新策略 | "D'"：事件驱动 + 节点触发 + 30s polling 兜底 | 见 §5 |
| 可点击 | ↗ Explorer / cwd 复制 / peer 跳 session / 文件名 diff 预览 | 其余只读 |

---

## 3. 架构

### 3.1 模块划分（强制独立成模块，便于未来分支合并）

```
core/
  worktree/
    git-probe.js          ── 跑 git 命令、解析 porcelain、缓存
    conflict-detector.js  ── 跨 session 冲突分类
    index.js              ── 对 main.js 暴露的统一入口
    README.md             ── 模块自述（输入/输出/缓存策略）

renderer/
  worktree/
    worktree-panel.js     ── 面板渲染、刷新驱动、IPC 交互
    worktree-panel.css    ── 样式（@import 进 styles.css）

main.js
  ── 仅注册 IPC handler，转发到 core/worktree。**不直接放业务逻辑。**

index.html
  ── 新增 <div id="worktree-panel"> 占位（与 #memo-panel 平级）
  ── 新增 <button id="btn-worktree-toggle"> 在 terminal header 备忘录按钮旁
```

**模块边界硬约束**：
- `core/worktree/*` 不依赖 Hub 任何业务模块（除 Node 标准库 + electron `shell`）
- `renderer/worktree/*` 通过 IPC 与 main 通信，不直接读 Hub 全局 state
- 删除 `core/worktree/` 与 `renderer/worktree/` 两个目录 + 删 index.html / styles.css 中本面板相关 hunk = 完整回滚

### 3.2 数据流

```
[UI 触发事件]                                [Renderer]                          [Main]
                                              │
打开面板 / selectSession ────────────────────▶│
window 'focus' ──────────────────────────────▶│ debounced 500ms (单 cwd)
statusline tick (现有 IPC) ──────────────────▶│      │
点 ⟳ 按钮 ───────────────────────────────────▶│ force=true
setInterval 30s (面板可见时) ────────────────▶│      │
                                              ▼      ▼
                              ipcRenderer.invoke('worktree:probe', {sessionId, force})
                                              │
                                              └────────────────────────────────▶│
                                                                                 │
                                                                core/worktree/index.js
                                                                  ├ 找 active session 的 cwd + peers (同 repoRoot 或同 cwd)
                                                                  ├ git-probe.probeRepo(cwd) × N (并行)
                                                                  │   ├ 30s TTL 缓存命中 → 秒回
                                                                  │   └ 否则 spawn git status/log/rev-list
                                                                  ├ git-probe.listWorktrees(activeCwd) (拓扑)
                                                                  └ conflict-detector.classify(active, peers)
                                              │◀─────────────────────────── { panel data }
                                              ▼
                              重渲染 worktree-panel
```

---

## 4. 颜色规则（B 方案落地）

```js
function classify(active, peers) {
  if (!active.isGitRepo) return { color: 'green', reasons: ['非 git 目录'] };

  const reasons = [];
  let level = 'green';

  for (const p of peers) {
    if (p.cwd === active.cwd) {
      reasons.push(`同 cwd：${p.sessionId}`);
      level = 'red';
    } else if (p.repoRoot === active.repoRoot) {
      const overlap = intersect(p.dirtyFiles, active.dirtyFiles);
      if (overlap.length > 0) {
        reasons.push(`改同文件 ${overlap.join(', ')}：${p.sessionId}`);
        level = 'red';
      } else if (level !== 'red') {
        reasons.push(`同 repo 邻居 worktree：${p.sessionId}`);
        level = 'yellow';
      }
    }
  }

  return { color: level, reasons };
}
```

- **同 cwd** = 物理目录字符串完全相等（绝对路径标准化后）
- **同 repoRoot** = `git rev-parse --show-toplevel` 解析结果相等
- **dirtyFiles** = `git status --porcelain=2` 解析出的相对路径集合
- 文件名比较前归一化为"相对 repoRoot 的 POSIX 路径"，避免 `\` vs `/` 差异

---

## 5. 刷新策略（D' 方案落地）

| 触发源 | 行为 | 缓存 |
|--------|------|------|
| 打开面板 / 切 session 进面板 | 立即 invoke `worktree:probe` | 命中 |
| `statusline-tick` IPC（现有） | debounced 500ms → invoke | 命中 |
| BrowserWindow `focus` 事件 | invoke | 命中 |
| 点 ⟳ 按钮 | invoke `{force:true}` | **跳过缓存** |
| `setInterval(30000)` 仅面板可见时 | invoke | 命中 |

**git-probe 缓存语义**：
- key = 绝对 cwd（标准化后），value = `{ result, ts }`
- TTL = 30 秒；force=true 时直接 spawn
- 同 cwd 的 in-flight Promise 复用（避免并发触发同一 cwd 多次 spawn）

**git 调用超时**：
- 单条 git 命令 > 5s：UI 显示 spinner
- > 15s：abort 子进程，UI 显示 "git 响应超时，⟳ 重试"

**事件 debounce**：单 cwd 500ms 滑动窗口，多次触发合并成一次实际 spawn。

---

## 6. UI 规格

**位置**：右侧栏，紧贴 `#memo-panel` 左侧。两个面板独立 toggle，可同时显示。
**宽度**：360px 固定（v1 不做拖拽；如反馈需要再 v2 加）。
**入口按钮**：在 terminal header 的 `headerActions` 区，备忘录按钮旁，新加 `#btn-worktree-toggle`。
**per-session 显隐状态**：`localStorage.setItem('worktree-panel-open-' + sessionId, 'true'|'false')`，与备忘录的 per-session 模式保持一致。

**面板结构（自上而下）**：

1. **Header**
   - 仓库名（active session 的 repo basename）
   - "N sessions" 副标题
   - ⟳ 刷新 / ✕ 关闭

2. **Health bar + 汇总徽章**
   - 横条：红/黄/绿按 peer 数比例分段
   - 徽章 pill：`⚠ N 撞车` / `M 未提交` / `K sessions`

3. **工作树拓扑**
   - 每条 = `分支 chip → cwd → 该 cwd 的 session 名列表`
   - 根据 `git worktree list` 的 porcelain 解析得到
   - 当前 session 所在条目用左侧色条标记

4. **当前 session block**
   - cwd（点击复制） + ↗（Explorer）
   - 分支 chip / ahead-behind / 未提交数
   - mini commit graph（最近 3 条 commit + origin 标记）
   - 文件 diff bar 列表（M/A/D/U 字母徽章 + 文件名 + +N -N + 色块条）

5. **Peer section**
   - 撞车的 peer：渐变红卡，含 reasons 文字
   - 安全的 peer：单行折叠
   - 全部 peer 卡可点击 → `selectSession(peer.sessionId)`

**配色与现有 Hub 暗色主题对齐**（`var(--bg-secondary)` / `var(--border)` / 等）。

---

## 7. 错误与边界

| 情况 | 行为 |
|------|------|
| cwd 不是 git 仓库 | 面板显示 cwd + "📁 非 git 目录"，灰底，无 peers，🟢 |
| cwd 已被删/不可访问 | 顶部红条 "目录丢失：&lt;path&gt;"，"重试" 按钮 |
| `git` 不在 PATH | 顶部红条 "git 未安装"，整面板降级（只显 cwd + ↗） |
| git status 卡 >5s | 当前 session 区显示 spinner，peers 区可正常显示 |
| git status 卡 >15s | 中止子进程，"git 响应超时，重试 ⟳"；不污染缓存 |
| Hub 启动时无 active session | 面板隐藏 toggle 按钮 |
| 唯一 session 在 git repo | "同仓库 peer · 0 个" 区折叠，🟢 |
| 同 cwd ≥5 peers | 撞车卡显示前 3 个，"还有 N 个 ⌄" 折叠展开 |
| Windows 路径大小写 | 标准化时统一 `path.resolve` + `toLowerCase`（仅 Windows） |
| repoRoot 解析失败 | 视为 `isRepo=false` |

---

## 8. 测试策略

**统一原则**：按 Hub CLAUDE.md 的"测试必须真实执行"铁律，禁止 mock 冒充 E2E。

### 8.1 单元测试（`tests/worktree/`）

- `git-probe.parsePorcelain()`：喂典型 porcelain v2 输出（含 modified / untracked / renamed / submodule），断言结构
- `git-probe` 缓存：连续 2 次同 cwd 调用，断言只 spawn 一次；force=true 跳过缓存
- `conflict-detector.classify()`：合成 session 列表覆盖 7 种组合
  1. 单飞 git repo → green
  2. 非 repo → green
  3. 同 cwd peer → red
  4. 同 repo 不同 cwd 撞文件 → red
  5. 同 repo 不同 cwd 不撞 → yellow
  6. 多 peer 混合：1 红 1 黄 → red
  7. peer 同 cwd + 同 repo 邻居 → red

### 8.2 集成测试（真 git fixture）

- `tests/fixtures/multi-worktree/` 起一个临时 git repo + 一个 `git worktree add` 的工作树
- 模拟改文件、跑 `git-probe.probeRepo()`，断言 dirty 文件、ahead/behind、worktree list 解析正确

### 8.3 E2E（隔离 Hub 实例 + Playwright CDP + DeepSeek session）

按 Hub CLAUDE.md 的隔离铁律：
- **`CLAUDE_HUB_DATA_DIR` 隔离启动**，绝不动生产 Hub
- `node_modules` 用 junction 复用主目录，不 `npm install`
- **测试用 DeepSeek session 替代 Claude**（Hub 已原生支持）
- E2E 前置：确认 `~/.deepseek/credentials` 或环境变量已配；E2E fixture 起 session 时优先用 DeepSeek，启动失败时自动 skip 并标红（不静默 fallback 到 Claude，避免真实烧 Claude 配额）

测试用例：
1. 起隔离 Hub → 创建 2 个 DeepSeek session 在同 cwd（指向 fixture repo）→ 打开面板 → 断言渲染红色撞车卡
2. 起 1 个 session 在主 repo + 1 个在 worktree（不同 cwd 同 repo） → 都改不同文件 → 断言 yellow
3. 让两个 session 改同名文件 → 断言变 red 且 reasons 含文件名
4. 触发 statusline tick（DeepSeek 工作完成回调）→ 等 600ms → 断言面板自动 refresh
5. 点 peer 卡 → 断言 active session 切换
6. 点 ↗ → 用 spy 记录 `shell.openPath` 调用并短路（避免 CI 里真开资源管理器窗口）；断言 path 正确
7. 关掉 git binary（PATH 临时摘除）→ 断言降级 UI 出现

---

## 9. 实现路径

### 9.1 worktree 隔离开发（用户硬性要求）

```bash
# 在主 claude-session-hub 之外开 worktree
git worktree add C:\Users\lintian\hub-feat-worktree-panel HEAD
# 用 junction 复用 node_modules（按 Hub CLAUDE.md 铁律）
cmd /c mklink /J "C:\Users\lintian\hub-feat-worktree-panel\node_modules" "C:\Users\lintian\claude-session-hub\node_modules"
# 后续开发全部在新 worktree 进行
```

完成后通过 PR 或直接 merge 回主分支，主目录的 UI 改动不受干扰。

### 9.2 串行实施 1→5

1. **后端基线**：`core/worktree/git-probe.js` + `conflict-detector.js` + `index.js` + IPC handler 注册；附单元测试
2. **UI 静态**：`renderer/worktree/` 模块 + index.html / styles.css 改动；先用 stub 数据渲染
3. **接通**：IPC 联调，事件触发链路接 statusline tick / focus / interval；缓存 + debounce
4. **交互 1-4**：Explorer / 复制 cwd / 跳 session / 文件 diff 预览
5. **打磨**：边界态、错误态、E2E（DeepSeek session）

每个阶段结束都按 Hub 项目铁律 smoke test 启动一次（隔离实例），看到 hook server listening 才算过。

---

## 10. 非目标 / v2 候选

- 面板宽度可拖拽（v1 固定 360px）
- 全局视图（`B` 方案：跨 repo 总览）
- session 在左侧栏的 ambient 红/黄/绿小圆点（v1 信息只在面板内）
- 撞车警告条点击展开"为什么红"详细 modal（v1 文字直接列在 reasons 里）
- 文件 diff 在面板内嵌显示（v1 走主区 preview-body，复用现有通道）
- 共享 node_modules junction 检测专项（v1 通过 cwd/file overlap 间接覆盖足够，专项检测进 v2）

---

## 11. 风险

- **Windows 路径标准化**坑多（短路径 8.3、symlink、junction、UNC）。预案：用 `fs.realpathSync` 在 probe 阶段解析一次。
- **大仓库 git status 慢**（Hub 自身、L2_RRM_Sim 等）。15s 超时 + 30s 缓存基本能扛住。
- **statusline tick 频率不可控**（DeepSeek/Claude 实际触发频率未知）。debounce 500ms 兜底。
- **多 worktree 共享 node_modules 时的 junction 路径解析**：probe 用 realpath，避免 dirtyFiles 路径出现 junction 别名。
