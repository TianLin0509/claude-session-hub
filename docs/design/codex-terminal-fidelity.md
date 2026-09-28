# Codex CLI 视觉与输入一致性（2026-09-27）

用户要求 Hub 尽可能保留原生 Codex CLI 的观感与交互，并在 2026-09-27 明确：字体、字号比例、行距和宿主主题向 Hub 的 Claude session 对齐。PTY 运行真实 CLI；不重画一套仿制 Codex 界面。

## 本次边界

- Windows 的 Codex PTY 声明真彩色：`COLORTERM=truecolor`；没有显式 `FORCE_COLOR` / `NO_COLOR` 时使用 `FORCE_COLOR=3`。Codex 0.153.4 / 0.157.1 的原生 diff 深绿为 `#213a2b`；256 色回退为索引 22（`#005f00`）。不修改 CLI 自身主题与 RGB 输出。
- Claude/Codex PTY 共用 `currentFontSize`、Cascadia Code/Consolas 字体栈、1 倍行高和 Hub 主题。删除之前专门读取 Windows Terminal 配置及 point/CSS 换算的模块；不再出现同一个 Hub 字号下 Codex 大一圈的问题。CLI 显式输出的真彩色仍按原字节显示。
- 原生全屏模式的历史、菜单、滚轮由 Codex 管理。浮动输入区向 xterm 转发滚轮时，坐标必须落在正文区域：缺坐标会被映射到标题区，新版 CLI 因此忽略上滚。普通终端 scrollback 保留现有滚动锁定逻辑。
- 2026-09-28：不能把「屏幕中点」当作正文。真实 0.157.1 在 17 行窗口里执行工具时，中点第 9 行属于 Working 状态区，正文与 Hub 输入区的上滚均可无效。`renderer/codex-transcript-wheel.js` 仅在普通空输入框及快捷键页脚均被识别时，把标题/状态/页脚上的滚轮转给正文第 2 行；正文自身坐标、菜单、确认框、非空原生草稿及组合键保持原生行为。仍由 xterm 编码鼠标事件、Codex 执行滚动。
- 全屏模式下 ▲▼ 改为原生 PageUp/PageDown 并更新提示；回到最新、Ctrl+Home/End 转给原生历史。旧版普通 buffer 保留问题定位。不得扫描当前屏幕的提示符冒充整个历史索引，或重复发送已经被 xterm 处理的按键。
- `PtyOutputDelivery` 独立管理输出提交与关闭刷新。未完成的兼容帧最多保留 16ms，后续输出不能无限续期；全屏模式立即透传，旧 inline 模式保留必要的滚屏兼容。适配器异常记录错误，并原样发出尚未提交的片段，不静默丢字。
- 模型显示名与请求 ID 分开。原生页脚的 `GPT-6-Astra` 只作显示，状态、重新启动和恢复参数统一为 `gpt-6-astra`。旧保存记录在恢复边界归一化，保持原会话 ID 和转录路径。
- 任务请求失败与 PTY 断线分开：400 等拒绝显示“上一轮执行失败，可继续发送”；只有进程丢失、休眠或传输断开才提示重连。原生完成回执不被滞后的屏幕活动标志改回运行中。
- 0.157 的全屏 Working 行没有旧版圆点；识别时要求真实计时器和中断提示，不能按普通正文中的 Working 判断运行。Codex 工作时也保留输入框，回看历史时还会隐藏状态行，因此 input-ready 画面永远不能结束 PTY Codex 的原生轮次；已确认的运行状态也不能被屏幕观察降级、丢掉 turnId。
- `core/codex-pty-runtime.js` 在主进程保存 Codex 的开工、等待、完成、中断和失败证据，界面重载从该快照恢复。初始化期间的新生命周期快照优先于旧列表回复；不把这些运行态持久化成下次启动时仍活跃的历史。正常实时界面沿用 hook/rollout 事件，Claude 的屏幕收尾路径不变。
- xterm 的颜色、设备属性、光标位置回复继续发回 PTY，但不算用户输入，不消除待回答状态或污染草稿跟踪。
- “到终端处理”提示只在卡片视图显示；PTY 原生问答直接展示 CLI 选项，避免浮层遮挡。分屏分别遵循自身视图模式。
- 不再按正文正则删除 `Improve documentation in @...`，实时输出和恢复期间的待处理输出都原样传给 xterm。不再向每个 Codex 输出块追加隐藏光标与延时显示光标。
- 保留历史滚屏修复、窗口尺寸同步、手动滚动意图和原生会话归属。它们解决宿主终端差异，不生成替代 CLI 的文本界面。
- Windows Codex 提交沿用已有 End 键粘贴结束边界，后续 Enter 按原队列顺序送达，省去重复的 500–3000 ms 猜测等待。分块与 Unicode 边界保护、原生开始回执、有条件补发、显式测试等待覆盖均保留。Claude 等其它 CLI 的等待策略不变。
- 旁路画面观察器使用合并写入队列；同一时刻只有一次 xterm 解析，后续碎片合并而不丢弃。探测按调用时的序号等待，连续输出不会无限拖延探测；错误不能成为有效画面，关闭会话会释放等待。

## 验证入口

- `node scripts/run_unit_tests.js --jobs 4 --strict`
- `node tests/e2e-codex-pty-lifecycle-cdp.js`：真实 CLI/provider，70 行历史的正文/浮动输入区滚轮、运行中上滚、同 ID 恢复、切会话后滚动、原生菜单、尺寸变化、Claude 字体主题对照、真实请求拒绝状态。测试从原生 assistant 转录确认回答，动画只比较 Working 字母颜色，不把秒表变化当动画。
- `node --test tests/unit-codex-transcript-wheel.test.js` 与 `node tests/e2e-codex-short-viewport-wheel-cdp.js`：17 行小窗口、真实工具运行时，在正文/屏幕中点/Hub 输入区上滚；只以带编号历史正文的变化证明滚动，Working 秒数变化不能算通过。
- 设置 `ACTIVITY_AUDIT=1` 增加 70 秒真实工具等待，连续核对回看历史、失焦与界面重载后的活跃状态；`ACTIVITY_INTERACTION_AUDIT=1` 增加原生 Esc 中断和 request_user_input 回答闭环。修复前实测捕获 `completed:pty-codex-input-ready`，工具仍在执行。
- 设置 `BOOTSTRAP_AUDIT_ONLY=1` 验证真实任务在重载初始化期间完成，新完成回执不能被较早的运行中列表回复覆盖。
- `node tests/e2e-pty-attention-cdp.js`：隔离 GUI 夹具验证主窗口和分屏的卡片/终端提示可见性，不调用 provider。
- `node tests/e2e-codex-cli-fidelity-cdp.js`：真实 CLI、隔离 home / workspace / Hub；通过实际输入框发送中文、emoji、长短消息、文件修改和 `/status`，核对原生转录中的完整内容与唯一用户轮次，读取真实 diff 颜色。
- 旧版 CLI：设置 `FIDELITY_CODEX_EXE` 和 `FIDELITY_LEGACY_CLI=1`，使用相同测试。
- 基线对照：`FIDELITY_HUB_ROOT` 指向独立基线 worktree，`FIDELITY_BASELINE=1` 不要求候选版视觉断言；消息完整性断言仍执行。
- `node tests/e2e-codex-manual-scroll-cdp.js` 与 `node tests/e2e-codex-scrollback-preservation-cdp.js`：真实 Hub + CLI 协议夹具，验证手动上滚、恢复、持续输出和滚动历史；不冒充云端 E2E。

0.157.1 的隔离测试启动器使用 `--no-daemon`，避免临时目录下 Unix socket 路径长度限制；生产 CLI 启动方式未因此改变。测试复制鉴权文件仅用于本机隔离验证，退出时删除副本，不将凭据写进证据。

## 证据边界

对齐基准是 Hub 的 Claude 字体主题、对应版本官方 CLI 源码和真实 CLI 输出。截图来自隔离 Hub，不是 Windows Terminal 原窗口的逐像素截图。内部碎片队列基准不是用户提交耗时；消息确认耗时不包含模型完成回答的时间，也不代表稳定吞吐基准。长文本在 Windows 原生控制台链路中仍有接收与绘制成本。

## Working 动画与 Windows 宿主边界

核对官方 `rust-v0.157.1`：`tui.animations` 默认开启，但 `system_motion.rs` 读取 Windows `SPI_GETCLIENTAREAANIMATION` 后可以强制减少动画。本机只读探针返回关闭；因此当前原生 CLI 显示静态 Working 符合其自身行为。Hub 不改系统动画偏好、不添加假动画。

`summary_shimmer.rs` 的渐变还需要真彩色及前景/背景色查询。实测本机系统 ConPTY 不转发 OSC 10/11，node-pty 附带 DLL 可以转发；但该 DLL 在真实 Codex 输入验证中丢失 emoji，并出现提交延迟，因此没有切换生产后端。继续使用与 Claude 相同的系统 ConPTY，避免以视觉效果换输入损坏。该宿主能力限制需在系统动画开启后另测，不能声称所有 Windows 版本动画均已恢复。

一手资料：

- [Codex 0.157.1](https://github.com/openai/codex/releases/tag/rust-v0.157.1)
- [Windows 系统动画探测](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/system_motion.rs)
- [原生 Working 渐变条件](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/summary_shimmer.rs)
- [本地设置合成](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/local_settings.rs)
- [node-pty 后端选项](https://github.com/microsoft/node-pty/blob/main/typings/node-pty.d.ts)

较早一轮 2026-09-27 视觉适配实测样本（不代表本次重构性能；当时修改前 → 修改后，点击发送至原生转录确认）：

| CLI | 56 字符 | 1160 字符 | 5560 字符 |
| --- | --- | --- | --- |
| 0.153.4 | 1362 → 567 ms | 1312 → 1172 ms | 2239 → 3170 ms |
| 0.157.1 | 1736 → 881 ms | 1666 → 1580 ms | 3976 → 4845 ms |

短消息减少了等待；长消息没有稳定提速，本轮样本甚至更慢。不得将该候选描述成彻底修复长文本逐字推送，也不得将内部解析队列基准等同于用户输入延时。字体/列宽、原生 Windows 输入处理和当时负载尚未分离测量。
