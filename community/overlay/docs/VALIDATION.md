# 验证记录

## v0.1.0-preview.2 发布验收

- 本机 `npm test`：18 项通过，含无 Git 的源码 ZIP 审计；`tests/test-release-installer.ps1` 验证带空格路径、重复安装、摘要不匹配、未知目录保护、已安装程序被改动、ZIP 路径越界拒绝、父 Hub 环境隔离。
- 合并前最终提交 `1f58742e79c7b62e622cd94076c708f7863d6659` 已通过 [完整 Windows CI](https://github.com/TianLin0509/ai-hub-community/actions/runs/35519896979)，包含官方 Codex 0.155.1 无 Node/Git PATH 握手、源码/打包程序及实际 ZIP 安装后的用户路径；PR #1 已合并。发布 tag 会对版本提交再跑同样验证。
- `node tests/e2e-community-onboarding.js`：8 条真实窗口用户路径通过，新增原生停止确认、提供方失败可见、用户主动再次发送恢复。首次使用、群聊、历史恢复仍全部保留。
- `node tests/smoke-official-codex.js`：本机真实 Codex CLI 0.153.4 的 App Server 初始化、空账号查询通过。使用新的临时 CODEX_HOME，没有调用模型。临时目录下 Codex 提示不创建 PATH 辅助别名；握手仍成功。
- CI 必须独立安装依赖，安装当前官方 Codex 原生 CLI，验证真实握手；随后构建 NSIS 和 ZIP，验证打包版，再用便携安装脚本安装实际 ZIP 并对安装后的 exe 重跑 8 条用户路径。
- `scripts/prepare-release.js` 只有在上述五份 GUI/协议证据报告均 `passed:true` 后生成发布清单，记录源码 SHA 和各资产 SHA256。发布任务再次验证清单，再上传安装器、便携 ZIP、源码 ZIP、安装脚本、机器可读清单及校验文件。
- 可重现终态查看 [GitHub Actions](https://github.com/TianLin0509/ai-hub-community/actions) 中对应 tag 的成功运行；本文件不将尚未结束的任务记作通过。

真实 OAuth、在线模型回复、账号额度、企业网络和企业软件准入需要在实际使用环境验证。本轮未执行 NSIS 图形安装流程；免 Node/Git 的便携安装路线是优先验收路径。

## 上手审查（2026-09-20，修复分支）

- `npm test`：15 项通过，新增缺失 CLI、Claude 原生安装路径/npm 启动器、登录错误和旧版快捷方式保护回归。
- `node tests/e2e-community-onboarding.js`：真实隔离 Electron，清空 AI CLI 的 PATH、临时 HOME/APPDATA、无真实凭据；以 CDP 鼠标/键盘操作创建表单和输入框。验证缺失 CLI 不创建失败会话、登录错误可见、群聊缺少成员依赖时不启动任何成员、安装后刷新、首次发送与回复、重启恢复同一原生身份与历史、默认通用群聊的两位成员回复。
- Claude 使用临时目录内 npm 风格的合成 CLI，经真实路径解析与子进程启动；Codex 使用 App Server 协议夹具。安装路径含空格。以上不代表在线模型质量、真实 OAuth、账号额度或模型权限已验证。
- `node tests/e2e-community-cdp.js`：原有 GUI/账号夹具/真实 PowerShell ConPTY 回归通过。
- `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -CheckOnly`、`node scripts/audit-public.js`、改动 JS 的 `node --check` 通过。
- CI 增加源码和 `--packaged` 的上手流程；具体构建结果以当前 PR 的 GitHub Actions 终态为准。没有在本机执行 NSIS 安装器点击流程，也没有覆盖已发布版本。

修复：缺失 CLI 的创建前检查；检测/Claude 登录/Claude 会话共用安装路径解析；创建群聊前检查全部成员；公开版不接管旧版失效桌面快捷方式。首页缺失项提供官方安装入口；通用群聊默认使用工作目录，开发群聊仍要求选择项目。

基线：AI Hub 1.6.194，公开版 0.1.0-preview.1。日期：2026-09-19。

## 已执行

- 在独立导出目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -NoShortcut`：真实 `npm ci` 安装 399 个包成功，使用独立 node_modules，没有借用生产依赖。
- `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -CheckOnly`：退出码 0。
- `npm test`：公开发行边界、配置默认值、账号过滤、命令发现、记忆保留、空项目库/损坏项目库、辅助数据目录等 10 项通过。
- `node scripts/audit-public.js`：公开文件集检查通过。排除了 19 个个人模块源文件；不带旧 Git 历史、运行数据与个人规则文档。
- `node tests/e2e-community-cdp.js`：真实隔离 Electron 中验证空白首页、安装检测、账号入口、授权按钮 IPC、通用/开发群聊入口、research 请求拒绝、Codex 原生协议夹具消息完整往返、真实 PowerShell/ConPTY 命令输出，以及 hook server 监听。
- 导出源码中的 420 个非 vendor JavaScript 文件使用 `node --check` 检查；首次安装脚本的真实执行同时验证 PowerShell 语法与错误传播。

## 证据边界

账号登录与模型回复使用明确的合成协议夹具。没有用作者真实账号替陌生用户验证登录，也没有自动消费模型额度。每个用户仍需在自己的账号和公司网络下发一次真实测试消息。

本机安装发生在已有 Node/Git 的 Windows 工作站，不是重装的空白 Windows 虚拟机。CI 的 `windows-latest` 干净 runner 用于补充独立安装、GUI 测试和打包验证；以 GitHub Actions 实际完成状态为准。

打包资产只在成功构建后进入 Release。没有配置商业代码签名。没有声称 macOS/Linux 或全部可选 provider 已验收。
