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

## v1.6.55 补：按步超时，以及一条断掉的链

先更正一个误判：`5 + 8 = 13 分钟`**不是全局上限**。
`disableHardTimeout: !(Number(turnTimeoutMs) > 0)` —— 普通群聊根本不启用硬超时，
那套只在编排器传了 `turnTimeoutMs` 时才生效，防的是 paste-trapped 死等，不是限制干活时长。

真正管工作流的是 loop-engine：

```js
timeoutMs = clamp(60s, 30min, stepConfigs[i].timeoutMs || 10min)
```

**但这条链是断的**：`normalizeStepConfigs()` 只保留 `name` 和 `prompt`，
模板填的 `timeoutMs` 在归一化时被吃掉，引擎永远读到默认的 10 分钟。

本次修好并配上：

| 步骤 | timeoutMs |
|---|---|
| RAN 实现 | 30 分钟（引擎允许的上限） |
| RAN 收口 · 改 | 25 分钟 |
| RAN 收口 · 审 | 25 分钟（它要真跑测试，pytest 3 分钟起） |

非法值（NaN / 负数 / 0）不写进结果，免得污染引擎的 clamp。两条测试守着。

## 涉及文件

- `renderer/workflow-templates.js`：两个预设 + 联动配置
- `tests/unit-workflow-templates.test.js`：预设数 5 → 7，新增 3 条断言
- 版本 1.6.53 → 1.6.54


## v1.6.56 补：真实 Hub E2E

`tests/ran-workflow-cdp-e2e.js`：起一个隔离 Hub（独立 data dir + 9356 端口，
与 loop e2e 的 9355 错开可并行），连 CDP 在**真实 renderer** 里验证 18 项：

预设存在与最小成员数、联动出的 steps/prompt/loop、两步落到不同成员、
超时穿过归一化后引擎 clamp 出 25/25 分钟（不是默认 10）、
四行 RESULT 契约的 PASS/FAIL/不合规三种解析、以及真实打开配置弹窗后
能看到「RAN 收口」按钮。

**不覆盖真实多 AI 循环** —— 那需要登录态 + 半小时，而且会在真仓库产生改动，
不适合放进自动化测试。那部分只能靠第一次手动跑一个绿档小任务验证。

用法：`node tests/ran-workflow-cdp-e2e.js`
