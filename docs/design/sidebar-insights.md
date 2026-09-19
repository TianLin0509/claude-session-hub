# 侧栏用量与系统状态

2026-09-19 用户确认 mock A「精修原版」，要求占据空间与原版相同，Codex / DeepSeek 同行；整块额度与资源区域可以向下折叠到底。

## 展示

- 保留 Claude、Codex、DeepSeek、Token Plan 及原有刷新和明细入口。严格保留五行：Claude、Codex / DeepSeek、Token Plan、CPU / 内存、网络。展开总高约 173px（额度 111px + 资源 62px，含边框；像素取整可能有亚像素差异）。
- 额度标签 12px、读数 13px，按钮 35px 高；并排的 Codex / DeepSeek 名称和读数仍同行，用内容最小宽度保护长金额，窄侧栏可降至 11px。细进度条和统一字重改善可读性。
- CPU / 内存标签 11px、百分比 12px、同行 4px 进度条；悬停使用轻底色。Top3 浮层维持较大字号，不占侧栏常驻空间。
- VPN 地区、下行 / 上行、国内状态同一行。网速显示箭头与 K/M/G 简写，悬停说明 KB/s、MB/s、GB/s 按 1024 换算及采样口径。过长地区允许省略，完整信息保留在提示中。全机物理网卡采集口径不变。

## 折叠

- `#sidebar-insights` 包住额度和系统资源。展开时，折叠箭头嵌在 Claude 行右侧并为其预留宽度，不新增标题行；收起时变为整行展开入口。支持点击及 Enter / Space。
- 收起时底边固定，上边沿向下移动，最终只剩约 33px 高的展开入口；释放的高度交给会话列表。
- `hub.sidebarInsightsCollapsed` 存入 localStorage；下次打开恢复偏好，默认展开。存储不可用时仍支持当前窗口内的折叠操作。
- 收起内容设为 inert 和 aria-hidden，关闭额度明细及进程浮层，移出隐藏区域中的焦点，避免不可见控件继续接收键盘操作。
- 收起后跳过资源轮询，展开触发一次正式资源刷新；不重建额度按钮、不触碰会话或原生 writer。
- 动画 200ms；系统要求减少动态效果时关闭动画。

## 验证入口与边界

- `node tests/e2e-sidebar-insights-cdp.js`：隔离可见 Hub，真实鼠标/键盘、原版高度、折叠方向、底边不动、空间回收、重新加载恢复偏好、额度刷新、深浅主题与宽度/缩放。通过 CDP 暂停真实 CSS 过渡并检查 100ms 中点，随后恢复；产品动画时长不变。
- `node tests/e2e-resource-telemetry-cdp.js`：真实 Windows 网卡、CPU 和内存进程采样及悬停回归。
- `node tests/e2e-sidebar-quota-amounts-cdp.js`：货币、长金额与未知值的 40 组布局检查，以及真实点击刷新。
- `node tests/e2e-sidebar-resource-strip-cdp.js`：普通 PowerShell 会话中的底部资源区。
- `node tests/unit-sidebar-quota-refresh.test.js`、`node tests/unit-sidebar-strip-resources.test.js`：额度刷新、来源状态和资源文本回归。
- 额度与地理出口可使用协议夹具；这不构成提供方网络或模型输出质量的 E2E 证明。
