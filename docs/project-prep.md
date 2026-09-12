# project-prep：给开发群聊准备项目

[project-prep](https://github.com/TianLin0509/project-prep) 是独立维护的通用 skill。
推荐版本：[v0.1.0](https://github.com/TianLin0509/project-prep/releases/tag/v0.1.0)。
它整理的是业务仓库：一个项目准备一次，之后每个开发群聊承接一项任务。

## 安装与准备

将以下 prompt 发给用于准备项目的 Claude Code 或 Codex：

```text
请从 https://github.com/TianLin0509/project-prep 的 v0.1.0 发布版安装 project-prep skill。
先读 README，按当前客户端选择安装方式。已有同名 skill 时先比较，不要覆盖。
安装后报告 SKILL.md 的真实路径与版本，暂不修改业务项目。
```

随后进入要开发的仓库，发出“用 project-prep 整理当前仓库，供独立 Author/Merger 开发”的需求。
Agent 应保留项目现有知识、测试、审批和发布规则，核实依赖路径与完整测试入口，
完成真实验证后才报告准备完成。安装 skill 本身不会改变业务仓库或升级 Hub。

## 完成准备后登记到 Hub

Hub 的项目库只读取 Hub 数据目录下的 `prepared-projects.json`。仓库中存在
`.agents/project.json` 是必要条件，但不自动入库；clone、worktree、最近工作目录和同级目录扫描均不授予项目身份。

本机现有 project-prep v0.1.0 仅生成项目合同与配置，没有 Hub 登记钩子。
因此登记是准备交付的最后一步。Hub 的「项目准备」提示词会附带本机脚本和数据目录；
独立使用 skill 时，在准备验证通过后执行以下命令，将 `$projectRoot` 替换为真实正式主目录：

```powershell
$projectRoot = 'C:\你的项目主目录'
node C:\Users\lintian\claude-session-hub\scripts\prepared-projects.js register $projectRoot
node C:\Users\lintian\claude-session-hub\scripts\prepared-projects.js list
```

其他安装位置使用该 Hub 安装目录下的同名脚本。默认数据目录遵循 `CLAUDE_HUB_DATA_DIR`，
未设置时为用户 home 下 `.claude-session-hub`；测试必须显式加 `--data-dir <隔离Hub数据目录>`。
命令返回 JSON，失败非零退出；重复登记同一真实目录不会新增条目。准备项目与登记均成功才称完成 Hub 接入。
这里提供 Hub 适配步骤，不修改或冒充升级远端 skill。需要将独立 clone 作为另一个正式项目时，须明确准备并登记它。

登记后重新打开建群、新建会话、历史搜索，或聚焦侧栏项目筛选即可刷新。
开发派工会重新读取正式库，旧提示词中的项目快照不再是名单来源。
“全部/随机”和最近工作目录不是正式项目实体，仍保留各自功能。

## 旧项目迁移及恢复

旧项目没有可靠的登记凭据，升级不会把所有扫描候选自动加入正式库。
先用 `inventory <候选绝对路径...>` 生成 JSON 草案（只读），核对准备记录与主目录，
将每项 `decision` 改为 `retain`、`exclude` 或 `pending`，填写证据 `reason`，保留生成的 `configHash`。
计划包含 `schemaVersion: 1`、唯一 `id` 和 `entries`。未确认项保留在计划中，不进入筛选。

```powershell
node C:\Users\lintian\claude-session-hub\scripts\prepared-projects.js migrate C:\交付目录\migration-plan.json
node C:\Users\lintian\claude-session-hub\scripts\prepared-projects.js migrate C:\交付目录\migration-plan.json --apply
```

第一条仅预览，第二条校验配置摘要后原子应用，重复执行幂等；计划同名但内容变化会拒绝。
迁移只追加经确认的正式条目，不删除其他已登记项目、历史会话或磁盘目录。
合并位需核实迁移计划并完成应用及 `list` 检查，再报告本机交付完成；作者使用隔离数据目录演练。
尚未建立登记库或登记文件损坏时，各入口明确提示错误，不偷偷回到目录扫描。

每次实际修改保留原登记库备份。恢复命令为 `restore <备份绝对路径> --expected-hash <当前登记文件SHA256>`，
同样可指定 `--data-dir`。先比对差异，只有确认不会覆盖后续合法登记时才传入当前摘要；
并发变化会导致恢复拒绝。文件锁超时会报错，不绕过锁写入；异常退出遗留锁需核实锁内 PID 已退出后只移除该锁文件再重试。

## Hub 使用哪些文件

| 项目文件 | 用途 |
|---|---|
| `.agents/project.json` | 项目库识别与显示配置 |
| `.agents/AUTHOR.md` | 工作位实现、自测与交接合同 |
| `.agents/MERGER.md` | 合并位独立验证与合并合同 |

创建“开发”群聊时选择业务仓库主目录；Author 再按合同创建独立 worktree。
不要将 linked worktree 作为另一个项目加入项目库。
Author 交付 `PROGRESS / VERIFIED / RISK / REPORT`，
Merger 交付 `RESULT / BLOCKERS / VERIFIED / NEXT`，由项目合同解释具体内容。

新版 skill 的合并入口要求候选与主干完整 SHA，默认只进行本地合并，
不会自动 fetch/push/rebase。遇到未知文件变化或冲突会保留现场并非零退出。
dry-run 仍会试合并和运行项目命令，生产目录操作、人工审批和远端同步沿用项目约定。
记录测试实测耗时，为 dry-run 和正式合并的两次验证留足群聊步骤预算。

## 维护和升级

本仓库只提供入口和接入说明，skill 源码、安装器、测试、清单与版本记录统一维护在独立仓库。
安装器校验 SHA-256 清单，遇到已有目录拒绝覆盖；升级前比较并保留公司的定制内容。
新版 skill 不会自动替换已经准备好的项目文件，旧项目按其
[迁移说明](https://github.com/TianLin0509/project-prep/blob/v0.1.0/skills/project-prep/references/configuration.md)
逐个审查后更新。
