# Codex CLI 视觉与输入一致性（2026-09-27）

用户要求 Hub 尽可能保留原生 Codex CLI 的观感与交互。PTY 运行真实 CLI，但终端的颜色能力、字体、颜色表、输出改写和提交等待仍由宿主决定。

## 本次边界

- Windows 的 Codex PTY 声明真彩色：`COLORTERM=truecolor`；没有显式 `FORCE_COLOR` / `NO_COLOR` 时使用 `FORCE_COLOR=3`。Codex 0.153.4 / 0.157.1 的原生 diff 深绿为 `#213a2b`；256 色回退为索引 22（`#005f00`）。不修改 CLI 自身主题与 RGB 输出。
- Windows 的 Codex 终端只读 Windows Terminal 默认 profile 的字体、字号和颜色配置（defaults + defaultProfile）。原生 point 换算为 CSS pixel；Hub 的字号调整继续作为相对缩放。配置不存在时采用 Campbell + Cascadia Mono；无法读取、解析失败或未知内置配色均有诊断。自定义 scheme 支持 Windows Terminal 的 `purple` / `brightPurple` 字段。
- Hub 切换外壳主题不会覆盖 Codex 的原生终端颜色。其它 provider 保留原来的字体、主题和颜色环境策略。
- 不再按正文正则删除 `Improve documentation in @...`，实时输出和恢复期间的待处理输出都原样传给 xterm。不再向每个 Codex 输出块追加隐藏光标与延时显示光标。
- 保留历史滚屏修复、窗口尺寸同步、手动滚动意图和原生会话归属。它们解决宿主终端差异，不生成替代 CLI 的文本界面。
- Windows Codex 提交沿用已有 End 键粘贴结束边界，后续 Enter 按原队列顺序送达，省去重复的 500–3000 ms 猜测等待。分块与 Unicode 边界保护、原生开始回执、有条件补发、显式测试等待覆盖均保留。Claude 等其它 CLI 的等待策略不变。
- 旁路画面观察器使用合并写入队列；同一时刻只有一次 xterm 解析，后续碎片合并而不丢弃。探测按调用时的序号等待，连续输出不会无限拖延探测；错误不能成为有效画面，关闭会话会释放等待。

## 验证入口

- `node scripts/run_unit_tests.js --jobs 4 --strict`
- `node tests/e2e-codex-cli-fidelity-cdp.js`：真实 CLI、隔离 home / workspace / Hub；通过实际输入框发送中文、emoji、长短消息、文件修改和 `/status`，核对原生转录中的完整内容与唯一用户轮次，读取真实 diff 颜色。
- 旧版 CLI：设置 `FIDELITY_CODEX_EXE` 和 `FIDELITY_LEGACY_CLI=1`，使用相同测试。
- 基线对照：`FIDELITY_HUB_ROOT` 指向独立基线 worktree，`FIDELITY_BASELINE=1` 不要求候选版视觉断言；消息完整性断言仍执行。
- `node tests/e2e-codex-manual-scroll-cdp.js` 与 `node tests/e2e-codex-scrollback-preservation-cdp.js`：真实 Hub + CLI 协议夹具，验证手动上滚、恢复、持续输出和滚动历史；不冒充云端 E2E。

0.157.1 的隔离测试启动器使用 `--no-daemon`，避免临时目录下 Unix socket 路径长度限制；生产 CLI 启动方式未因此改变。测试复制鉴权文件仅用于本机隔离验证，退出时删除副本，不将凭据写进证据。

## 证据边界

对齐基准是本机 Windows Terminal 配置、对应版本官方 CLI 源码和真实 CLI 输出。截图来自隔离 Hub，不是 Windows Terminal 原窗口的逐像素截图。内部碎片队列基准不是用户提交耗时；消息确认耗时不包含模型完成回答的时间，也不代表稳定吞吐基准。长文本在 Windows 原生控制台链路中仍有接收与绘制成本。

2026-09-27 实测样本（修改前 → 修改后，点击发送至原生转录确认）：

| CLI | 56 字符 | 1160 字符 | 5560 字符 |
| --- | --- | --- | --- |
| 0.153.4 | 1362 → 567 ms | 1312 → 1172 ms | 2239 → 3170 ms |
| 0.157.1 | 1736 → 881 ms | 1666 → 1580 ms | 3976 → 4845 ms |

短消息减少了等待；长消息没有稳定提速，本轮样本甚至更慢。不得将该候选描述成彻底修复长文本逐字推送，也不得将内部解析队列基准等同于用户输入延时。字体/列宽、原生 Windows 输入处理和当时负载尚未分离测量。
