# 2026-09-04 · v1.6.54 · 串行工作流加两个 RAN 预设

## 为什么是两个不是一个

SuperRAN 的流程被内网评审天然切成两半：内网那一趟约 20 分钟且必须人工操作，
工作流引擎没法在中间等。所以不做成一条 5 步流水线，而是两个预设**在同一个群聊里切着用**：

```
选「RAN 实现」→ Claude 干完停下  →  人拿 zip 走内网  →  选「RAN 收口」→ Claude↔Codex 自动迭代
```

同一个群聊、同两个成员，不用建两个群。

## 两个预设

| 预设 | 步骤 | loop |
|---|---|---|
| `ran-implement` | 单步：实现 + 打审核包，然后停 | 关 |
| `ran-converge` | 两步：按内网意见改 → 审 PR 并合并 | **开**，maxRounds 3 |

`ran-converge` 正好落在 loop-engine 现成的「builder ↔ reviewer + verdict gate」上：
审的那步输出 `RESULT: PASS/FAIL`，FAIL 自动回修，PASS 结束。

## prompt 只指向合同，不在 Hub 里复制规则

每步 prompt 就一句「请根据 `C:\Vibe\Wireless\SuperRAN\.agents\XXX.md` 展开工作」。

**改流程只改仓库里那几个 .md，不用回来动 Hub。** 有测试守着这条
（`RAN 预设只指向合同文件，不在 Hub 里复制流程规则`）。

## 两件要注意的

1. **两步必须落到不同成员。** `ran-converge` 的 steps 是 `[[ids[0]], [ids[1]]]`，
   测试断言了这一点——同一个成员既写又审，等于自审自合，`MERGER.md` 的第一条硬闸就破了。
2. **PASS 即合并。** 按 `MERGER.md` 的规定，审的那步 PASS 会直接执行 squash 合并。
   也就是说从你发一句话到代码进主线，中间可以没有人。有 CI 与三条硬闸兜底，
   不想要就把第二步 prompt 里「PASS 就由你执行合并」改成「PASS 就给出合并口令等我确认」——
   模板从不锁表单，随时可改。

## 未验证

**步骤超时够不够没有实测。** dispatcher 的硬超时是 5 分钟，活跃时可延长
（`HARD_TIMEOUT_ACTIVE_MAX_EXTRA_MS` 8 分钟）。红档实现动辄 30 分钟以上，
第一次跑请拿绿档小任务试，确认长任务不会被判超时。

## 涉及文件

- `renderer/workflow-templates.js`：两个预设 + 联动配置
- `tests/unit-workflow-templates.test.js`：预设数 5 → 7，新增 3 条断言
- 版本 1.6.53 → 1.6.54
