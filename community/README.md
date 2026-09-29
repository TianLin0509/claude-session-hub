# 社区版导出（仅主仓库）

公开库 `TianLin0509/ai-hub-community` 由这里导出。本目录和 `scripts/community/` 不会进入公开库。

## 一次同步的步骤

```powershell
# 1. 从已提交的主干导出到一个空目录（不读工作区里未提交的文件）
node scripts/community/export-community.js --ref HEAD --out C:\AIWork\<日期>-ai-hub-community\export
# 2. 在导出目录里自带依赖验证（不要用主目录 node_modules 的 junction）
cd C:\AIWork\<日期>-ai-hub-community\export
npm ci; npm test; node scripts/audit-public.js; node tests/e2e-community-cdp.js
# 3. 把导出树同步进公开库的 clone（保留它的 .git），提交、打 tag，推送后由 CI 构建发布
```

导出报告 `ok:true` 才算过闸：剥离标记全部处理、语法、相对引用、泄露规则（`scripts/community/leak-rules.js`）与公开审计都通过。`residue` 只是已删模块在通用代码里留下的死分支和注释，不含个人数据，只统计不拦截。

## 给主仓库开发者的约定

- 私人模块（投研、学习、投委会、联赛、公司中转、本机专用工具）的新接线点，用成对注释包起来：`// @community-strip <原因>` … `// @community-end`；社区版需要替代实现时，在中间加 `// @community-else`，其后每行都写成注释。HTML 用 `<!-- -->`，CSS 用 `/* */`；写在模板字符串里时只能用 HTML 注释形式。
- 整个文件都是私人模块时，把它加进 `manifest.json` 的 `drop`；需要保留接口的，在 `overlay/` 放同名同接口的替代文件。
- 注释里的名字、本机目录、私人项目名由 `manifest.json` 的 `scrub` 统一替换；新的私人服务地址或关键词加进 `leak-rules.js`。
- `tests/unit-community-export.test.js` 在合并闸门里对当前树做一次完整导出，上述约定漏了会直接红。
- 社区版的 CLI hook 走 `scripts/session-hub-hook.ps1` + `core/hook-payload.js`；改 `scripts/session-hub-hook.py` 的字段时，同步改 `core/hook-payload.js`，`tests/unit-hook-payload-parity.test.js` 会逐字段比对。
