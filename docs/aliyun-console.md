# 阿里云控制台专用浏览器（AI 只读查看）

2026-10-13 新增。用户在 Hub 账号页登录一次阿里云控制台，AI 会话之后就能用这个已登录的浏览器查看百炼 Token Plan 订阅、用量、账单、模型权益等页面。

## 用户怎么登录

1. Hub 左侧「账号」→「API 与服务」→「阿里云控制台」，点「登录 ↗」。会弹出一个只给阿里云用的 Chrome 窗口，打开的是百炼控制台。
2. 点页面右上角「登录」，用阿里云 App 或支付宝扫码，或账号密码登录。
3. 回到账号页点「检查登录」，显示「已登录」就可以了。登录资料保存在 Hub 数据目录 `account-browsers/aliyun-console`，关掉浏览器也还在。

这个浏览器和 Hub 的「AI 浏览器」（网页圆桌、生图用的那个）分开：控制台权限高，不和其他网页工具共用登录。

## AI 怎么用

在 Hub 程序目录运行（任意工作目录都可以用绝对路径）：

```text
node C:/Users/lintian/claude-session-hub/scripts/aliyun-console.js status
node C:/Users/lintian/claude-session-hub/scripts/aliyun-console.js open https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal
node C:/Users/lintian/claude-session-hub/scripts/aliyun-console.js text --max 8000
node C:/Users/lintian/claude-session-hub/scripts/aliyun-console.js screenshot D:/AI-Artifacts/20261013-aliyun-console/token-plan.png
node C:/Users/lintian/claude-session-hub/scripts/aliyun-console.js list
node C:/Users/lintian/claude-session-hub/scripts/aliyun-console.js close
```

- `open [网址]`：默认百炼控制台首页。浏览器没开时在屏幕外启动，不抢焦点；开着时只用 AI 自己的那个标签页（`list` 里标 `[AI]`），不动用户正在看的页面。等页面文字稳定后返回。
- `text [--tab id] [--max N]`：读 AI 标签页（或 `--tab` 指定的阿里云标签页）的可见文字，AccessKey、API Key 等已遮蔽。
- `screenshot [路径.png] [--tab id]`：默认存到产物根目录 `<AI_HUB_ARTIFACTS_ROOT>/YYYYMMDD-aliyun-console/`。页面上出现密钥时拒绝截图。
- `status`：登录状态；`--json` 输出 JSON；`--data-dir` 指定 Hub 数据目录（默认 `CLAUDE_HUB_DATA_DIR` 或 `~/.claude-session-hub`）。
- 百炼控制台未登录时**不跳转登录页**，照样显示页面（例如「您还未订阅 Token Plan」）。`open` 和 `text` 在未登录时会先打印一行「注意」，这时读到的内容不能当作账号数据，请用户去账号页登录。

## 安全底线

- 工具只做导航和读取：只能打开 `https://*.aliyun.com` 与 `https://*.alibabacloud.com`；页面里执行的脚本只读标题、地址和可见文字，不点击、不输入。不要给它加点击、填表或执行任意脚本的命令。
- 下单、付款、续费、改配置、开通或关闭服务、创建或删除资源与 AccessKey，一律不由工具执行，告诉用户去界面上本人操作。
- 不读取、不输出 cookie 值；登录状态只看 cookie 名字（`login_aliyunid_ticket` 等）和页面是否停在登录页。不输出 AccessKey、API Key，不把它们写进文件或回答。

## 实现位置

- `core/aliyun-console.js`：专用浏览器（独立资料目录 + `--remote-debugging-port=0`，经资料目录里的 `DevToolsActivePort` 连 CDP）、登录状态判断、密钥遮蔽。
- `scripts/aliyun-console.js`：上面的命令行。
- 账号页：`core/hub-accounts.js` 的 `aliyunConsole()`，条目定义在 `core/tool-account-catalog.js`，界面在 `renderer/account-workspace-view.js`。
- 测试：`tests/unit-aliyun-console.test.js`，隔离 Hub 真机 `tests/e2e-aliyun-console-cdp.js`。
- 已知限制：登录 cookie 名来自阿里云公开行为，2026-10-13 只验证了未登录路径；首次真实登录后若「检查登录」仍显示未登录，先核对 cookie 名。
