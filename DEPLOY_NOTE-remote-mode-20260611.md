# DEPLOY NOTE · 远程 Hub 模式（2026-06-11 16:50）

**未提交原因**：工作区存在另一会话的大量未提交 WIP（main.js ~17 个非本功能 hunk：Meridian relay /
usage / codex 系列；android-app/ 整目录），按并发会话收敛协议不混合提交。
本功能已全部 E2E 实测通过（见 `docs/superpowers/plans/2026-06-11-hub-remote-mode.md` 状态栏）。

## 本功能（远程 Hub 模式）改动清单

**新增文件（全部归本功能）**：
- `mobile/remote-client/remote-hub-client.js` — 公司侧 WSS 客户端（配对/重连/hubId 定向路由）
- `mobile/remote-client/index.js` — IPC 接线（remote-pair / remote-send-input / remote-event 等）
- `renderer/remote-mode.js` — 远程面板 UI（配对表单 / 会话列表 / 消息时间线）
- `renderer/styles/remote-mode.css`
- `mobile/tests/e2e-remote-cdp-lib.js` / `e2e-remote-step1-pair.js` / `e2e-remote-step2-converse.js`
  / `probe-pwa-connect-readonly.js` / `probe-agent-lifetime-ab.js` / `probe-read-buffer.js`
  / `probe-send-keys.js` / `e2e-remote-send-again.js` — E2E 与诊断脚本
- `docs/superpowers/plans/2026-06-11-hub-remote-mode.md` — 实施计划（含状态与血泪）

**修改文件（本功能 hunk 标注）**：
- `main.js`：仅 2 处 —— ① mobile-bridge 隔离实例 opt-in 跳过（`_mobileBlockedByIsolation`，约 L1515）；
  ② Remote Hub Client 启动块（`startRemoteClient`，约 L1535）。其余 hunk 非本功能。
- `core/session-manager.js`：仅 1 处 —— claude fast settings 注入加 `CLAUDE_HUB_NO_FAST` 开关（约 L1010）。
- `mobile/hub-bridge/outbound-client.js`：心跳 30s→15s + `directIp` 直连选项（绕 Cloudflare，SNI/证书校验不降级）。
- `mobile/hub-bridge/index.js`：`MOBILE_VPS_DIRECT_IP` env 传入 OutboundClient。
- `renderer/index.html`：侧栏"远程"按钮 + `#remote-panel` 容器 + `remote-mode.js` script 标签 + 版本号 v1.3.0。
- `renderer/styles.css`：@import remote-mode.css。
- `package.json`：version 1.2.0(他人未提交的 bump)→1.3.0。
- `CLAUDE.md`：并行测试硬性规则 0（spawn 测试 Hub 必须剥离 CLAUDECODE 嵌套 env，血泪）。

**环境变更（已生效，非代码）**：
- User env 新增 `MOBILE_VPS_DIRECT_IP=138.128.192.245`（生产 Hub 下次重启自动直连，消除 CF 1006 抖动）
- 生产 `~/.claude-session-hub/mobile-devices.json` 新增 2 个设备 token（公司浏览器 15:28 + 公司 Hub E2E 16:00）

**测试残留（可随手清理）**：
- `C:\temp\hub-company-e2e\` / `C:\temp\hub-home-e2e\`（隔离测试 dataDir，进程已全部退出）
- 测试期间产生的 mobile session 元数据在上述隔离目录内，不影响生产

提交建议：等另一会话的 WIP 收口后，按上述清单分两个 commit（远程模式 feature + CLAUDE.md 规则）。

## 追加（同日 19:00-20:00）：一键自更新

**新增**：`core/self-update.js`（manifest 检查/sha256/解压覆盖/relaunch）、`tools/publish-hub-update.ps1`
（源码包发布到 VPS /opt/hub-mobile/pwa/hub-update/）、`mobile/tests/e2e-update-step.js`。
**修改**：`main.js`（hub-update-check/apply IPC）、`renderer/remote-mode.js`（⟳ 检查更新按钮）、
`renderer/styles/remote-mode.css`、版本 1.3.0→1.4.0。
E2E 实测：v1.3.0 装机 UI 一键升级 → 1.4MB 增量包 → 自动重启 → v1.4.0 ✓

## 追加 2（同日 22:00-24:00）：v1.4.1 桌面会话直通

**新增能力**：远程面板左侧列表分两组——"🖥 桌面会话"（家里 Hub 真实 session/meeting 卡片，
HUB_SNAPSHOT/HUB_COMMAND/HUB_DELTA 通道）+ "📱 远程会话"（原移动通道独立会话）。
选桌面卡片发消息 = 直接进入家里那个会话（家里屏幕同步可见），回复经 HUB_DELTA 实时回流。
**改动**：`mobile/remote-client/remote-hub-client.js`（snapshot/command/delta）、`index.js`（IPC）、
`renderer/remote-mode.js`（双分组重写）、`remote-mode.css`、版本 1.4.1。
**VPS 网关已重新部署**（旧版 Jun 8 协议缺 hub-snapshot-req 静默丢包；已同步
shared/protocol.js + vps-gateway/* 并 systemctl restart，手机 PWA 中继瞬断数秒自动重连）。
E2E：公司 UI → 桌面卡片 → "桌面直通"回复回流 ✓；生产 Hub 实测回 95 张真实卡片 ✓（无需重启生产）。

## 追加 3（2026-06-12 上午）：v1.5.0 终端镜像（B 形态终极目标达成）

**新增**：`mobile/hub-bridge/pty-mirror-binder.js`（昨夜兄弟会话已起草，今接线）、协议 PTY_* 帧、
`remote-mode.js` openMirror/closeMirror + xterm 实例。桌面会话卡选中后多一个"⌨ 终端镜像"按钮，
点开 = 公司屏幕完整渲染家里那台会话的真实 claude TUI，按键直通（可打断/方向键/全屏重绘），
关闭即退订不影响家里端（attach 语义）。**VPS 网关已重部署**（含 PTY_SUBSCRIBE/DATA 白名单）。
E2E：镜像同步家里 claude 全屏界面 + 按键直通发 prompt + Claude 回复镜像回流，全 PASS
（截图 Desktop\claude-artifacts\e2e-mirror-success.png）。版本 1.5.0。
**E2E 检测坑**：xterm buffer 读法——全屏 TUI 内容散布在各行，不能只读 buffer 尾部 N 行
（claude 界面在上半屏，尾部是空白输入区），必须扫全 buffer 或截图验证。功能本身一次成型，
是检测逻辑误判了 40 分钟。

**⚠ 给并发会话的重要提示**：`renderer/index.html` 在 19:01 被 PS5.1 `Set-Content`（无 BOM UTF-8
按 GBK 误读）双重编码损坏，已 `git checkout` 还原并重放所有未提交 hunk——包括 **PPT 模式的两个
hunk（🎨 PPT 按钮 + ppt-mode.js script 标签）也已原样补回**。若发现 index.html 与你的预期不符，
以此说明为准；其余文件未受影响（package.json 已去 BOM 重写，版本 1.4.0）。
