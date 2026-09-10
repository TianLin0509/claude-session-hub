# AI HUB · 合并补充

先读 `AGENTS.md`、`.agents/project.json`。通用独立审查、返工和任务文件交接由群聊提示词提供。

## 项目验证

- 主干是 `master`。亲验完整候选 SHA 和最新主干的集成结果。
- 全量检查：`node scripts/run_unit_tests.js`。GUI 需真实隔离 Hub 证据，使用 `tests/helpers/hub-launcher.js`。
- `node_modules` 为共享 junction 时禁止安装、裁剪或打包。生产保护、prompt 提交规则见 `AGENTS.md`。
- 版本由合并脚本统一更新，不能因实现分支未升版本而打回。

## 当前合并入口

```text
python scripts/merge_task.py 任务分支 --dry-run
python scripts/merge_task.py 任务分支
```

本项目目前使用既有脚本，参数不同于 project-prep 新发行版；不要照搬 `--expected-head` 等未支持参数。
脚本会同步主干、试合并、升版本并跑测试；正式合并还会推送主干。`--dry-run` 也会临时改写执行目录。

- dry-run 必须在隔离的完整仓库副本验证，不能用正在运行生产服务的目录试合并。
- 正式合并须满足 `AGENTS.md` 的授权条件，记录审查时和执行前的完整 SHA；分支变化必须重验。
- 保护主目录已有脏文件；不得 stash、reset、顺手提交他人改动来满足前提。
- 失败后先检查 Git 和脚本输出；已合并但推送/后置步骤失败时，保留真实结果，只处理尚未完成的步骤，不重复升版本或合并。
- `afterMerge` 当前为空；脚本是项目入口，精简 prompt 不改变它的测试、版本和推送行为。
