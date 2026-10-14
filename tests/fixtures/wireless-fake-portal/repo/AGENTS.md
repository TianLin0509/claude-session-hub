# 演练仓库规则

- 这是 AI Hub「无线」Tab 端到端验收用的迷你无线仿真仓库，结构仿 SuperRAN：代码在 `src/radio/`，测试在 `tests/`。
- 物理 bug 的红灯测试并入 `tests/test_physics_invariants.py`（没有就新建）。
- 改动在独立 worktree 的任务分支上进行，`python -m pytest -q` 全部通过后 commit。
- 不放宽既有断言来迁就实现。
