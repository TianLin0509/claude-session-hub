# 会议室运行时按需下载（v3.1.3，2026-10-22）

田哥 2026-10-22 的问题：新用户从零装一次要 165MB，而其中 76.8MB 是「抢会议室」才用得到的
秘书终结者。要求把它当组件，第一次用到时再下。

## 改了什么

- 安装包与更新包都不再带 `core/company-assistant/room-component/runtime/MishuTerminator-2.1.0.exe`。
  `target.json` 去掉打包钩子 `beforePack`，并加 `!core/company-assistant/room-component/runtime/**`：
  本机即使手工放了 runtime/ 也不打进包里。公司版 CI 不再单独下载运行时，那份 ci.yml 与社区版一致，
  所以直接删掉，避免两边以后漂。
- 新增 `core/company-assistant/room-runtime-download.js`：多源（GitHub 官方公开 release → 阿里云镜像）
  依次试，按 `baseline.json`（签名清单）里的文件名、字节数、SHA-256 校验，下到
  `<数据目录>/room-runtime/<sha256>/<文件名>`；`.part` 写完核对通过才改名。
- `room-component.prepareRuntime` 的顺序：本机缓存（下载过的）→ 安装目录里的旧副本（3.1.2 及更早装的，
  拷进缓存，老用户不用重下 77MB）→ 现下 → 都没有就报「去设置里点下载」。
  缓存里那份被改坏时先删掉再来，删不掉（正被占用）就照旧报错，不硬来。
- 「助理 → 设置 → 抢会议室」打开时只查本机有没有（`room-status`），没有就显示
  「下载会议室组件（约 77 MB）」按钮和进度，不在一打开就偷偷下 77MB；点按钮走 `room-install`，
  进度每 3 秒刷新一次，失败时把每个源的原因写在页面上，可以重试。
- 下载走 Electron 的 `net.fetch`（跟系统代理），不是 Node 内置 `fetch`：后者不读系统代理，在公司网络里
  直连 GitHub 会 10 秒后失败（2026-09-23 实测过同一条坑）。单测没有 Electron，才回落到全局 `fetch`。
- 顺手修了 `core/app-update/downloader.js` 的两个真问题：① 取消信号原来只接到「拿到响应头」为止，
  正文下载期间点取消不生效（会照样把整个文件收完），现在整段都能取消，且取消后不会把文件转正；
  ② 取消、超时、写盘失败时 `.part` 半截文件原来只在「校验不一致」那条路删，现在所有没走到改名的路径都删，
  没读完的响应体也会显式取消。

## 为什么地址不写进 latest.json

`latest.json` 不是签名的，写进去只会多一个可被替换的入口。期望值全部来自随包的签名清单
`baseline.json`，地址只是取件地点：官方 release 换地址了，下一个版本改常量即可；
地址上的文件被换掉，校验也过不去。运行时真要换版本，必须换签名清单，也就是发新版 Hub。

## 兼容

- 3.1.2 及更早装好的机器：旧副本还在 `resources\app.asar.unpacked\core\company-assistant\room-component\runtime\`
  下（新 asar 里已经没这个目录）。`bundledRuntime` 会同时看 asar 路径与对应的 `app.asar.unpacked` 路径，
  找到就拷进数据目录缓存，不联网。
- 3.1.3 起新装：首次点「抢会议室」时下 77MB；GitHub 在公司实测约 2MB/s，约 40 秒。
- `rooms.useExecutable`（手动指定秘书 exe）的 IPC 还在，但界面一直没有入口，自动准备（缓存 → 旧副本 →
  下载）始终优先，且准备成功后会把这个设置改写成缓存里的 exe——与 3.1.2 行为相同，本轮不改这条路。

## 实测体积（2026-10-22）

待构建后填：安装器、更新包、装完占用的前后对照见 `docs/design/app-update-packages.md` 的表。
