# 家里远程让公司 Hub 更新 / 重启（2026-10-17，v2.1.8）

田哥：「允许我在家里用 claude 远程让公司的 AI HUB 自己重启更新——这样我就不用为了更新 AI HUB 专门到公司一趟了」。

## 链路

家里会话（MCP `company_hub_update` / `company-ask.js --hub-update|--hub-restart|--hub-status` / 无线页「公司联动」按钮）
→ `core/company-bridge/home.js` `hubAdmin()` 经加密通道发 `{ type:'hub-admin', op, id, gen, force }`
→ 公司 `core/company-bridge/hub-admin.js` → 现有一键更新控制器 `main/app-update-controller.js`（check → download → apply）
→ 公司发 `{ type:'hub-admin-status', id, phase, note, current, latest, at, lastResult? }` → 家里存最近 20 条、发通知、面板显示。

## 公司一端状态机

| 阶段 | 含义 |
|---|---|
| checking / downloading | 查版本、多源下载与 sha256 校验（控制器负责） |
| waiting | 已下载，等「通道里没有在作答的轮次、没有在忙的 CodeAgent 会话」；最长 30 分钟，`force` 不等；等待期间新任务只排队不派发 |
| applying / restarting | 已报「即将重启」并等这条消息送出（`link.flush`），调用 `apply()` 或 `app.relaunch()+quit()` |
| 结束态 | up-to-date、failed、refused（设置里关了）、busy（已有一条在跑）、unsupported（不是安装版）、updated、rolled-back、restarted |

- 只认当前配对代次；同一编号只处理一次；同一时间只跑一条。
- 不接受来自通道的文件或网址；版本只取发行源清单，`planUpdate` 保证不降级。只走增量包：完整安装包的安装向导要人点（oneClick:false），远程退出后没人点 Hub 就一直关着，所以回 failed 说明原因。
- 重启后：通道接通时读 `takeLastResult()` 的结果，报 updated（已更新到 vX）/ rolled-back（原因 + 已回滚到 vY）；没读到结果报 failed。
  中途重启（停在下载或等待）报 failed，可以再发。版本变化时公司也主动报一次 online（不发通知），家里面板据此显示公司版本。
- 设置 `allowRemoteAdmin`（默认 true），在公司「AI特战队专用功能」设置的「同时处理」下方。

## 测试

- 单测：`tests/unit-company-hub-admin.test.js`（控制器替身 + 内存通道两端）。
- 真实端到端：`tests/e2e-company-hub-remote-update.js`（两台隔离 Electron + relay_server.py + 本机更新源 + 真实替换脚本与重启）。
  差距：开发运行替换的是临时 resources 目录里的 app.asar，重启后显示的版本号不变；真包换版本由 `tests/e2e-app-update-packaged.js` 覆盖。
