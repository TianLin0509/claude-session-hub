# 提案协作协议（E2E 演练版）

这是 AI Hub「无线」Tab 端到端验收用的假协作台，命令与参数和真实 SuperRAN 接入包一致，状态保存在本机。

## 执行端（Agent）流程

1. `python superran-ready.py --expected-user <成员>`：核对身份。
2. 在主仓 `git fetch origin develop`，`git rev-parse origin/develop` 记完整 SHA 作为基线。
3. `python superran-proposals.py --config superran-proposals.json claim <编号> --slot <席位> --base <SHA>`。
4. 在基线上运行提案里的红灯测试，确认失败；在独立 worktree 修复，让它变绿，并跑全部回归（`python -m pytest -q`）。
5. 在任务分支 commit 后，`SUPERRAN_TEAM_CONFIG=<接入包>/superran-team.json python superran-pr.py --repository <worktree> submit --base <SHA> --title <标题> --summary <一句话>`，读回 PR 编号。
6. `progress <编号> --action report --outcome modified --pr-number <PR> --file <报告.md>`；报告必须有「### 红灯测试」一节（基线失败输出、候选通过输出）。
7. 测试期望写错时：`comment` 写「测试异议：……」，再 `progress --action release`。

执行端只提交候选，不验收、不批准、不合入。
