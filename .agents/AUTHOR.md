# AI HUB · 实现补充

先读 `AGENTS.md` 与 `.agents/project.json`。通用阶段职责、任务文件和交接方式由群聊提示词提供。

## 工作环境

- 主工作目录 `C:\Users\lintian\claude-session-hub` 正在运行生产 Hub，禁止在其中实现或提交功能改动。
- worktree 放在 `C:/AIWork/日期-任务-席位`；分支用 `feat/`、`fix/` 或 `chore/` 前缀。
- 用 junction 复用主目录 `node_modules`；创建后确认成功。禁止在共享依赖的 worktree 中运行 `npm install`、`npm ci`、`npm prune`、`npm run dist`。
- 版本由 `scripts/merge_task.py` 自动抬升；实现分支不提前修改版本号。

```text
git worktree add C:/AIWork/日期-任务-席位 -b feat/任务-日期 master
cmd /c mklink /J C:\AIWork\日期-任务-席位\node_modules C:\Users\lintian\claude-session-hub\node_modules
node scripts/run_unit_tests.js
```

## 验证入口

- 全量入口是 `.agents/project.json` 的 `test`；修 Bug 先复现或添加能失败的行为断言，再验证修复。
- GUI 使用 `tests/helpers/hub-launcher.js` 起隔离实例，配独立 CDP、数据目录、home 和转录目录；证据要来自真实 Hub。
- 不关闭、重启生产 Hub，不改生产 state/config。CLI prompt 必须走现有提交管线，详见 `AGENTS.md`。
- 不清理其他任务的 worktree、分支或未提交内容；交付保留候选完整 SHA 和实际验证证据。
- 远端分支推送沿用任务已有授权；主干推送由合并入口处理。
