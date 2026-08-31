# DEPLOY NOTE 2026-08-31 · 平铺工作根（v1.6.27）

## 一句话

新会话（含群聊）默认直接开在工作根 `C:\AIWork`，不再每个任务建 `_scratch\inbox-*`。
临时目录和手选路径两档都保留，老会话一字不受影响。

## 为什么改

「每任务一个目录」原本有两条理由，这轮把两条都实测了，都没撑住：

| 原理由 | 实测 |
| --- | --- |
| 产物隔离 | 207 个目录合并模拟：真冲突 **29 条路径 / 12 个会话 / 四个月** |
| 可整体删 | 四个月**一次没用过**（208 个目录、151 个超 7 天、删了 0 个） |
| （附带担心）大 cwd 拖慢 agent | 只影响 **0.5%~1%** 的工具调用 —— Grep **98.4%** 自带 `path` 限定，17,288 次 shell 调用里只有 **87 次**列 cwd 根，目录清单**不会**自动进上下文 |

而平铺的收益是实测的：**61.3% 的会话需要引用别的会话目录（13,931 次，平均跨 12.6 个）**，
平铺后这些全变成同一 cwd 下的相对路径。

## 怎么实现的

### 标记文件区分两种根

没有无条件拆掉 `classifyWorkspace()` 的根守卫 —— 那条是为 `C:\Vibe` 写的，那里确实不该干活。

```
<root>\.aiwork-root 存在 → 专用工作根，允许直接开会话，默认落在根上
标记不存在              → 旧行为原样保留，根仍硬拦，默认落 _scratch\inbox-*
```

标记是文件不是配置项：把 `AI_HUB_WORKSPACE_ROOT` 指回 `C:\Vibe` 时守卫自动恢复，
不需要记得改任何开关。

### 三档工作目录

单会话与群聊都是同一套（群聊天然跟随，因为共用 `resolveForSession()`）：

| 档位 | 落点 |
| --- | --- |
| **默认工作目录**（默认选中） | 工作根本身 |
| 临时目录 | `<root>\_scratch\inbox-<时间戳>-<随机>` |
| 选择已有路径 | 用户指定 |

### 根上不 seed AGENTS.md

平铺下 cwd 就是根，根上那份 AGENTS.md 本来就是源文件，自我播种没有意义
（`seedUngovernedAgentsFile` 对根本来也返回 false，因为 `isPathInside(root, root)` 为假）。
**存量 198 份副本 + 193 个 `.vibe-root` → 各只需 1 份。**

但 `.vibe-root` 仍然必写：Codex 从「最近的带标记祖先」向下收集，
根上没标记会一路走到 `C:\`。

## 审阅时抓到并修掉的两个 bug

1. **工作根被改名**：`renderer` 传 `label:'未命名任务'`、`session-handlers` 传 `opts.workspaceLabel`，
   而 `touchWorkspace` 见非空 label 就覆盖 —— 每开一个新会话，工作根在注册表里就被改名成
   「未命名任务」。修法：`ensureDefaultWorkspace()` **故意忽略** `meta.label`，只认目录名。
2. **UI 把默认落点标成「组织根·不可用」**：`WORKSPACE_TIER_LABELS.root` 的老文案与新行为直接矛盾。
   修法：`workspaceTierLabel()` 在平铺模式下返回「工作根」，并在 `init()` 预热 `flatWorkRoot`
   以免首次渲染闪错标签。

## 记忆面板同步调整

- 「工作区规则（seed 源 · 改动自动播种到未来临时工作区）」→ 平铺下改为
  **「工作根规则（<root> · 所有新会话共享，改完立即生效）」**，文件标签改成「Codex / Kimi 直接读」。
  这是实质变化：以前改 seed 只影响未来新建的工作区，现在改完立刻对所有会话生效。
- 规范库标题原先写 `files.length`，而 `listMdFiles` 有 **50 条硬上限** —— 实测规范库有
  **206 篇**，标题一直显示「50 个文件」。新增 `canonical.totalFiles` 取真实总数，
  子列表注明「共 N 个，仅列最近修改的 50 个」。
- 「seed 副本」区在没有存量副本时**整区隐藏**（平铺后不再新增），避免留一块永远空着的面板。

## 知识资产处理

切根前核对了 `C:\Vibe\_scratch` 下 191 份 seed 副本（Hub 自己的 `seedCopyStatus` 判定）：

```
synced 183 · own 6 · modified 2
```

两份 modified 的实际内容：

- `inbox-20260815-054812-831821` → 「AI Hub 本机路径交付格式」5 条通用规则，
  **已并入** `C:\AIWork\CLAUDE.md` / `AGENTS.md` 第六节。
- `inbox-20260817-035219-4cf943` → Round2 BS0/BS1 赛题专属规则，属于该项目而非工作根；
  已存在于 `C:\Vibe\AGENTS.md` 梦境区与记忆规范库，**随老目录原样保留**。

Claude memory **孤岛 0**，无未收记忆。

## 验证

- **单测**：全量 `tests/*.test.js` → **865 个，861 pass / 0 fail / 4 skip**
- **新增单测** `tests/unit-workspace-flat-root.test.js` → 8/8，覆盖旧行为兜底、平铺落点、
  临时档唯一性、`.vibe-root` 写入、根名不被覆盖、归档提示哑火
- **新增 E2E** `tests/e2e-flat-workspace-cdp.js`（隔离实例 + 随机 CDP 端口）→ **18/18 全绿**，
  含真实 Electron 里的三档按钮状态与 `memory:get-overview` 返回
- **既有 E2E** `tests/e2e-launch-center-cdp.js` → `success: true`，errors 为空
- **真实环境对照**：老会话 cwd 的注入仍是 **10,893 B**（迁移前实测同值，逐字节一致），
  记忆桶 `LINKED` / 206 篇 / `sharesCanonical: true`；
  新 cwd `C:\AIWork` 的 `ensureMemoryLink` 实跑成功，注入 **12,094 B**，
  Codex 与 Kimi 都读到 `C:\AIWork\AGENTS.md`

## 迁移动作（已完成）

```
C:\AIWork\.aiwork-root   381 B   工作根标记
C:\AIWork\.vibe-root     279 B   Codex project root 标记（由 Hub 自动写入）
C:\AIWork\CLAUDE.md    5,454 B   八节防坑规则
C:\AIWork\AGENTS.md    5,444 B   与 CLAUDE.md 正文逐字一致
C:\AIWork\_scratch\             临时目录档的落点（空）

用户级环境变量 AI_HUB_WORKSPACE_ROOT = C:\AIWork（Hub 重启后生效）
```

老工作区 `C:\Vibe\_scratch\*` 200+ 个目录**原样保留、不迁移**。

## 回滚

1. 删掉 `C:\AIWork\.aiwork-root` → Hub 立刻恢复旧行为（根硬拦、默认落 `_scratch`），无需改代码
2. 把 `AI_HUB_WORKSPACE_ROOT` 改回 `C:\Vibe` → 完全回到迁移前
3. 代码层回滚：`git revert` 本次两个提交
