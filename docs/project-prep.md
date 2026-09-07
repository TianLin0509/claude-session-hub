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
