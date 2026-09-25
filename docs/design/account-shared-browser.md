# 账号页与共享浏览器交付 · 2026-09-25

在 P1 的 5 个提交（末尾 `ec4d659`）上接力。实现分支 `feat/account-integration-20260925-codex1`；未经用户同意不合主干，合并脚本统一升版本。

## 用户可见变化

主、副账号各有一张卡，网页登录、独立 CLI 授权和浏览器用途集中展示。未知站点可检查，失效 CLI 可直接打开授权入口。页面刷新不启动浏览器；主动检查最多启动一个共享 Chrome，检查结束且没有业务页面时释放。

状态区分本机登录记录、官网确认、历史确认、凭据已配置。历史确认不能触发圆桌恢复。命令行归属只匹配完整邮箱，不把「同一网站」当作「同一身份」；旧邮箱以历史身份标注。

## 页面归属与并发

`HubChrome.openTab()` 在目标身份的 marker 页面打开唯一随机 URL，再导航到官网。即使多进程同时打开相同网址，也不能拿到彼此的页面。打开页面、切换登录模式和空闲关闭共用跨进程生命周期锁；任何非 marker 页面均阻止整浏览器关闭。

`core/hub-browser-tool.js` 兼容原 Python 工具的 Playwright CLI 调用方式。每个生图车道/中转保存自己的 target ID、浏览器实例标识和身份，重连时再次校验 context。Playwright 断开连接不关闭共享 Chrome；关闭一个车道只关闭自己的页面，最后一个页面关闭后可释放 Chrome。

原工具继续管理任务提交确认、幂等、下载、排队和游标。共享适配器不修改这些协议，也不向共享身份导入旧工具 Cookie。旧授权快照保持原样；新增快照只保存受管标记。

## 可审阅的迁移

`scripts/configure-hub-browser-tools.py` 接受 JSON：`root`、`hub_repo`、`playwright`、`pool_db` 以及显式 `tools` 映射。每项包括 `id`、`tool`、`identity`、`config`、`expected_account`。空账号标签必须显式填写空字符串；这只是并发修改校验，不是身份认证。

1. `python scripts/configure-hub-browser-tools.py <spec.json>`：只读校验并输出计划。
2. 用户同意合并后，通过项目合并入口合入；最终 spec 的 `hub_repo` 必须指向合并后的稳定主目录，不能长期绑定待清理 worktree。
3. 在原工具空闲且 worker 已正常退出时运行同命令加 `--apply`。脚本持有原工具操作锁；不终止生产进程，不取消排队任务，不改队列内容。仍有活动工作时拒绝切换。
4. 脚本只替换原设置的 `cli_entry`，生成逐用途入口及绑定清单。备份位于共享浏览器目录 `tool-backups/<timestamp>`。
5. 回退：`python scripts/configure-hub-browser-tools.py --rollback <backup-directory>`。检查入口未被别人修改、工具仍空闲后，恢复原入口；保留其余设置的新改动和其他迁移的绑定。

生图旧 worker 启动时会读取配置，必须在切换前正常退出，切换后由原工具按需启动。现存旧浏览器仅换配置不会自动消失，本交付不终止它们。因此未部署、未完成旧实例退场前，不能宣称生产内存已经减少。

生产执行顺序：先确认队列没有排队/执行中任务；仅为计划中的车道创建原工具支持的 `stop-<account_id>` 文件，等待其正常退出；通过原 `cli_entry`、原车道 `data_dir` 和原 session 名执行 `close`，只关闭这些工具自己的旧浏览器（中转同理，使用原配置 session）。再应用迁移，删除本次创建的停止标记，让原队列按需启动新 worker。不得关闭未在计划中的浏览器、取消旧任务，或用进程名批量终止 Chrome。原有停止标记必须保留。

## 已执行验证的边界

- `node tests/e2e-account-center-cdp.js`：真实隔离 Electron、鼠标点击、IPC、配置保存、普通模式登录窗口、草稿保留与窄窗口截图；使用测试凭据，不是真实登录认证。
- `node tests/e2e-hub-browser-tools.js`：真实 Chrome 和 Playwright；4 个主身份生图页面、1 个副身份页面、1 个中转页面使用同一浏览器主进程；验证页面不串、Cookie 隔离、关闭不影响其他用途，以及现代 DOM 夹具。未生成图片或收发中转消息。
- `HUB_CHROME_ROOT=<existing-root> node tests/e2e-chatgpt-shared-preflight.js`：真实 ChatGPT 已登录身份中的独立临时页，执行安装版工具原始状态/选图菜单代码，通过新版输入框、账号菜单、工具菜单及选中模式判断。未填或发送提示词，未生成图片，未操作中转消息。
- `node tests/e2e-web-login-recovery-cdp.js`：真实隔离 Hub、MCP/worker、官网响应夹具。未登录不续发，新鲜登录后未提交任务只发一次，已提交任务仅补收，原圆桌继续并生成 HTML。
- `node scripts/run_unit_tests.js --jobs 8`：全量单元测试。此主机的测试子进程须清除继承的 `CODEX_SQLITE_HOME`，并把 `C:/Program Files/Git/bin` 放入 PATH；不能修改用户真实 Codex 配置来让测试通过。

真实图片生成/下载、公司消息收发、长时间驻留内存与生产部署后的容量还需实测。前任转述的「4.5 GB」不是本轮节省量。本轮证明的是 6 个独立任务页面可以共用 1 个 Chrome 主进程，不代表操作系统只存在 1 个 Chrome 子进程。
