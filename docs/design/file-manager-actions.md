# 文件管理：浏览、整理与交付

2026-09-19。用户授权实现并合入主干。默认继续使用右侧目录树，不改变原有预览路由。

## 用户行为

- 窄面板展示名称及第二行大小/修改时间；拖宽后按列排列，可点击列头排序。扩展名保留。
- 复选框、Ctrl、Shift 多选；右键、行尾省略号和批量操作按钮共用菜单。
- 支持绝对/相对路径、文件名、UTF-8 文本、图片和 Windows 原生文件剪贴板；文件复制能在资源管理器中粘贴。
- 新建目录、重命名、复制到、移动到、移至回收站、按需计算大小。同名不覆盖；部分失败逐项显示。跨盘移动由用户选择复制后回收。
- 默认四秒刷新当前根及已展开目录，保留选择、展开、滚动和焦点。面板关闭即停止轮询。
- 项目文件名/相对路径搜索可发现未展开目录的文件；最近修改展示当前扫描结果，绝不称为“当前会话生成”。默认跳过依赖目录与链接，结果明确显示跳过及截断。
- 收藏文件/目录、常用 artifacts/output 入口、导航历史、类型过滤和按需图片缩略图。
- 添加到当前/指定已打开会话，以及拖入输入框，均写入绝对路径草稿，不自动提交 prompt；群聊走已有草稿接口。

## 交付语义

公司：复用 Company Drop Python CLI，多路径由 CLI 打包。仅 JSON ok 且公网 HEAD 状态 200、长度匹配时完成。显示跳过文件和下载入口。

ChatGPT：现有外部 bridge 只支持文字 push。本项目新增适配脚本，导入本机 bridge，复用独占锁与会话；不修改外部工具或认证。附件进入固定中转会话草稿，用户在显示的 ChatGPT 窗口确认发送。状态为 prepared / sent=false；绝不把附件准备称为消息已发送。每次最多 10 文件，每个 20 MiB；目录需先压缩。网页 UI 改变或登录状态不满足时明确失败/待核实，不切换到文字推送。

交付任务保存在 Hub 数据目录 file-transfers/，逐任务原子落盘；进程内串行队列。取消仅适用于排队任务。超时/缺少回执保留 unknown；重启和其他 Hub 看到未结束记录时不会续发。以目标、规范路径、大小、修改时间建立持久锁，阻止相同文件重复交付；用户在目标端核实后才能解除已准备/待核实/已完成记录的拦截。任务状态为 queued/running/completed/prepared/failed/unknown/cancelled/resolved。

## 范围与性能

- 单目录沿用 3000 项上限；元数据读取最多 16 并发。达到上限明确显示。
- 项目扫描最多检查 50000 项、返回 10000 文件；目录大小统计也有上限，并标注不完整。
- 不递归跟随 symlink/junction；路径操作逐级核对，拒绝修改当前根。文件夹大小不在列表加载时计算。
- 图片缩略图只针对不超过 5 MiB 的文件，浏览器按需加载。
- 本次 GUI 证据使用真实隔离 Electron Hub 和原生会话协议夹具；公司传输测试用本地子进程协议夹具，不能等同真实公网交付。ChatGPT 网页附件上传仍需要登录网页实测，不宣称已验证网络端。

## 验证入口

```text
node --test tests/unit-file-manager-directory.test.js tests/unit-file-manager-actions.test.js tests/unit-path-company-sync.test.js
node tests/unit-file-manager-ui-contract.test.js
node tests/e2e-file-manager-actions-cdp.js
node scripts/run_unit_tests.js
```

旧 tests/e2e-file-manager-layout-cdp.js 依赖早期终端 header 与旧 Codex PTY 夹具，在当前原生会话界面无法等待到 session header。本功能 GUI 以新脚本验证，不把旧脚本失败计为通过。
