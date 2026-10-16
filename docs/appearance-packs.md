# AI 头像与侧栏图标

主题菜单的「AI 头像与图标」支持整套切换、逐个 AI 混搭、自定义图片和独立的侧栏图标选择。外观不改会话类型、模型识别、运行状态或提示词管线。保留原有二次元作为默认，整套使用只清除头像混搭，不清除独立图标偏好。

本机源码带 20 套、每套 8 张 PNG 头像；公司导出排除 `renderer/assets/appearance-packs/**`，仅带原有默认头像。公司界面按实际支持范围显示 DeepSeek、千问、智谱、MiniMax。CodeAgent 延续原有模型识别。

## 资源与持久化

- 随包头像：`renderer/assets/appearance-packs/<id>-<version>.json`。
- 已下载资源与偏好：当前 Hub 数据目录下的 `appearance/`。下载与应用分开；安装不改变当前选择。
- 目录和头像包均为 schema 1 的 JSON。目录包含文件名、字节数和 SHA-256；包只含经过验证的 PNG 数据，不执行下载内容。
- JPEG / PNG / WebP 上传经 Chromium 解码、中心裁剪并转 PNG，再由主进程真实解码检查，仅保存在当前数据目录。
- 原有品牌 SVG 保持复用，提供品牌原色、圆形徽章、方形贴纸、黑白极简、深色铭牌、跟随头像六种样式。单 AI 也可指定包内头像或上传图片作为小图标。

## 在线与离线安装

仅用户点击「检查更新」时联网。目录查询逐源记录结果，下载沿用应用更新模块的多源尝试、进度和校验。目录正文有独立超时和大小限制。失败、取消或损坏包不替换现用资源，界面可重试或导入离线 JSON 包。

默认资源入口定义在 `core/appearance-packs.js`，分别为 GitHub `appearance-v1` release 与阿里云 `/hub-update/appearance/`。新增资源必须先上传所有包，最后发布 `catalog.json`。公司资源尚未由这次实现公开发布；不能把本地 HTTP 测试视为外网或公司代理验证。

测试可通过 `AI_HUB_APPEARANCE_SOURCES` 注入目录与文件源，通过 `AI_HUB_APPEARANCE_LIBRARY` 指定隔离图库。产品不需要配置这些变量。

## 验证

```powershell
node tests/unit-appearance-packs.test.js
node tests/e2e-appearance-packs-cdp.js
node scripts/community/export-community.js --target company --ref WORKTREE --out artifacts/20261017-avatar-packs-codex1/company-preview
node tests/e2e-appearance-company-cdp.js
node scripts/run_unit_tests.js
```

公司 E2E 需要先生成上述公司源码目录，并按项目约定接入现有共享依赖，禁止在共享 junction 中安装或打包。两组 GUI 验证都使用隔离 Hub、独立数据与 CDP；不访问生产数据。在线测试使用本地 HTTP 源和真实 Electron 下载路径，实际公司代理和公开资源可用性须在上架后另验。
