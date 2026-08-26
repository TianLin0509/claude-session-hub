# 初心 Agent 投资联赛 v1 实现交接

日期：2026-08-26

## 当前状态

代码实现完成，生产 Hub 未被关闭或重启，因此当前正在运行的生产进程尚未加载新代码。

生产数据根已初始化为空目录：

```text
C:\Users\lintian\chuxin-research\vault\agent-league
```

当前：

- Agent 数量：0；
- 自动赛程：关闭；
- 自动运行时间默认值：北京时间 18:30；
- 最大并发默认值：2；
- 没有创建生产 Session；
- 没有调用模型；
- 没有模拟成交；
- 没有连接券商。

## 已实现

### UI

- 初心投研新增原生 `Agent 联赛` Tab；
- 排行榜一行一个 Agent；
- 桌面真实 Hub 一屏显示 8 行，更多内部滚动；
- 默认按累计收益率排序，可切换当前资产；
- 行内展示 Session 状态、资产、累计/今日收益、最大回撤、仓位和最近决策；
- 点击一行打开右侧详情；
- 可从详情打开绑定 Session 的卡片或 PTY；
- 新建 Agent 表单支持 Provider、模型、理念和初始资金；
- 窄窗口时隐藏全局 Session 侧栏，排行榜不横向溢出。

### 普通 Session 绑定

- Agent Session 使用 `purpose='agent-league'`；
- `hiddenFromSidebar=false`，正常出现在 Hub 左侧栏；
- 活跃时直接打开现有 Session；
- dormant 时走 Hub 普通 resume；
- 每日赛程运行中的 Session 被自动休眠器保护；
- native ID 写入各 Agent 的 `SESSION.md`；
- 不可恢复时拒绝静默新建，要求显式建立新代次。

### Markdown 数据

- `AGENT.md`：冻结理念；
- `STRATEGY.md`：版本化策略；
- `PORTFOLIO.md`：模拟组合；
- `TRADES.md`：模拟成交；
- `STATS.md`：排行榜统计；
- `MEMORY.md`：待验证与已晋升经验；
- `EVOLUTION.md`：策略提案；
- `daily/YYYY-MM-DD.md`：每日原始回复、目标组合和反思；
- `snapshots/YYYY-MM-DD.md`：统一冻结输入。

Markdown 内使用 HTML comment 包含机器可读 JSON；文件本身仍可直接阅读和版本化，不依赖 SQLite。

### 模拟交易与统计

- T 日决策、T+1 或更晚完整收盘快照执行；
- 同一冻结快照、统一价格和费用规则；
- A 股整手；
- 单票、现金、数量和候选池校验；
- 卖出后买入；
- 现金不足时确定性缩量；
- 佣金、卖出税、过户费、滑点；
- 当前资产、累计收益、日收益、最大回撤；
- 仓位、现金、成交次数、换手率、卖出胜率；
- pending 订单和净值历史。

### 每日进化

每个成功决策强制填写：

- 保留的纪律；
- 上一轮错误（没有时明确写“无”）；
- 一个待验证经验；
- 支持证据和反例。

系统自动进入 `MEMORY.md` 的待验证区。策略变更只能进入 `EVOLUTION.md` 提案，不自动覆盖核心理念。

### 调度与恢复

- 手动运行；
- 可选自动运行；
- 同一快照幂等；
- 失败 Agent 可在同一快照单独重试；
- 已成功 Agent 不重复消耗模型；
- Hub 中断后 `running` 转 `interrupted`；
- 跨 Hub 全局写入租约；
- 运行中续租，正常结束/退出释放，陈旧租约回收；
- 行情缺失时显式失败，不猜价格。

## 验证证据

### 单元与合同测试

```powershell
node --test tests\unit-agent-league-accounting.test.js tests\unit-agent-league-store.test.js tests\unit-agent-league-philosophies.test.js tests\unit-agent-league-handlers.test.js tests\unit-agent-league-ui.test.js tests\unit-session-auto-suspend.test.js tests\unit-session-capabilities.test.js tests\unit-home-workbench.test.js tests\unit-sidebar-strip-resources.test.js tests\unit-main-navigation-guard.test.js tests\unit-package-build-files-contract.test.js tests\unit-hub-launcher-isolation.test.js
node tests\unit-chuxin-cli-visibility.test.js
node tests\unit-session-ipc-contract.test.js
node tests\unit-resume-session-ipc-contract.test.js
```

结果：39 个 Node test 通过，Chuxin/Session/Resume 合同测试全部通过。

### 隔离真实 Hub E2E

```powershell
node tests\e2e-agent-league-cdp.js
node tests\e2e-chuxin-single-nav-cdp.js
```

结果：

- 10 行排行榜；
- 桌面 1004px 主视图、8 行可视；
- 390px 窄窗口无页面横向溢出；
- 新建 Agent 表单创建真实普通 Codex Session；
- Agent Session 正常出现在左侧栏；
- 排行榜可跳入普通卡片界面；
- 旧初心 7 个数据 Tab 继续共用一个 iframe；
- 从原生联赛切回实时行情后，分时/K 线重新可见。

### 真实行情快照

使用临时目录读取生产初心 API，结果：

- `asOf=2026-08-25`；
- 80 个冻结候选；
- 81 个价格；
- 成功补齐非候选 `600519.SH` 的 2026-08-25 收盘价 `1304.00`；
- 临时文件结束后清理；
- 未调用模型。

## 建议启用步骤

1. 在合适窗口重启生产 Hub，使新代码生效；
2. 先创建 4 个 Agent，不要一次开满；
3. 自动赛程保持关闭；
4. 连续 3 个交易日人工点击运行；
5. 每天检查快照、目标组合、pending、成交、费用、净值和 Session 历史；
6. 通过后扩展到 6–8 个 Agent；
7. 再启用北京时间 18:30 自动赛程；
8. 满 20 个交易日后再启用 Sharpe 等样本敏感指标。

## 尚未启用/下一阶段

- 首批生产 Agent 名单尚未创建；
- 自动赛程尚未开启；
- 尚未进行真实模型的第一轮正式赛程；
- 基准指数、超额收益、Sharpe、Calmar 和风格暴露未进入 v1；
- 策略提案的批准/回滚 UI 未实现；
- 短视频自动脚本未实现，只冻结了可用数据结构。
