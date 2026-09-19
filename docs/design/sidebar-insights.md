# 侧栏用量与系统状态

2026-09-19 用户反馈：底部字号偏小、网速与出口挤在一行，希望整块额度与资源区域可以向下折叠到底。

## 展示

- 保留 Claude、Codex、DeepSeek、Token Plan 及原有刷新和明细入口。字号调整为 12px，额度读数 13px；并排的 Codex / DeepSeek 改为名称、读数上下排列，给长金额留出空间。
- CPU / 内存标签 13px、百分比 16px、下方 5px 进度条；悬停用中性色表面和细边框，不再整块填充紫色。Top3 进程浮层同步放大。
- 网络分两行：第一行为 VPN 地区与国内状态；第二行为下行、上行及各自的 KB/s、MB/s、GB/s，按 1024 换算。全机物理网卡采集口径不变。

## 折叠

- `#sidebar-insights` 包住额度和系统资源，顶部整行按钮可以点击或用 Enter / Space 操作。
- 收起时底边固定，上边沿向下移动，最终只剩约 33px 高的展开入口；释放的高度交给会话列表。
- `hub.sidebarInsightsCollapsed` 存入 localStorage；下次打开恢复偏好，默认展开。存储不可用时仍支持当前窗口内的折叠操作。
- 收起内容设为 inert 和 aria-hidden，关闭额度明细及进程浮层，移出隐藏区域中的焦点，避免不可见控件继续接收键盘操作。
- 收起后跳过资源轮询，展开触发一次正式资源刷新；不重建额度按钮、不触碰会话或原生 writer。
- 动画 200ms；系统要求减少动态效果时关闭动画。

## 验证入口与边界

- `node tests/e2e-sidebar-insights-cdp.js`：隔离可见 Hub，真实鼠标/键盘、折叠方向、底边不动、空间回收、重新加载恢复偏好、额度刷新、深浅主题与宽度/缩放。动画帧采样使用 CDP 0.2 倍播放速度，产品动画时长不变。
- `node tests/e2e-resource-telemetry-cdp.js`：真实 Windows 网卡、CPU 和内存进程采样及悬停回归。
- `node tests/e2e-sidebar-quota-amounts-cdp.js`：货币、长金额与未知值的 40 组布局检查，以及真实点击刷新。
- `node tests/e2e-sidebar-resource-strip-cdp.js`：普通 PowerShell 会话中的底部资源区。
- `node tests/unit-sidebar-quota-refresh.test.js`、`node tests/unit-sidebar-strip-resources.test.js`：额度刷新、来源状态和资源文本回归。
- 额度与地理出口可使用协议夹具；这不构成提供方网络或模型输出质量的 E2E 证明。
