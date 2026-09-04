# 2026-09-04 · v1.6.52 · 顶栏加 RAN 工作台面板

## 改了什么

顶栏「学习」右边加一个 **RAN** 按钮，点开是 Hub 第五主区视图，
与 terminal / meeting-room / chuxin / study 平级互斥。

面板内容是一个 iframe，加载本机生成的静态页
`C:\VibeData\Artifacts\Reports\SuperRAN\tasks.html`——
SuperRAN 仓库的 `scripts/superran_tasks.py` 产出的任务泳道看板。

## 刻意不做的事

**Hub 不解析任务数据，也不复制任何业务逻辑。** 只负责显示和触发重新生成。
数据口径只有 SuperRAN 那一份，Hub 这边再写一份迟早会和它对不上。

## 打开面板时的行为

1. 先显示上一次生成的页面（不让人对着空白等）
2. 后台 `spawn python scripts/superran_tasks.py --no-open` 取最新
3. 跑完自动刷新 iframe，顶部显示更新时间

带 `--no-open` 是刻意的：数据在 iframe 里看，不要再弹一个外部浏览器。
iframe 的 src 带时间戳，否则重跑之后看到的还是缓存里的旧页面。

## 涉及文件

- 新增 `renderer/ran.js`
- `renderer/index.html`：按钮、`#ran-panel`、脚本引入
- `renderer/renderer.js`（5 处）、`chuxin.js`、`study.js`：面板互斥
- 版本 1.6.51 → 1.6.52（package.json + package-lock.json 两处）

## 依赖

需要本机有 `C:\Vibe\Wireless\SuperRAN` 与可用的 `python`。
找不到脚本时面板顶部显示提示，不会崩。
