# 一键更新的包结构与体积（v3.1.3，2026-10-22）

田哥 2026-10-22：3.1.1 → 3.1.2 更新要下 86.7MB，而其中 76.8MB 是这一版一个字节都没变的会议室运行时；
「能不能把一些东西当组件，用户实际使用时再增量下载」，并要求「允许用户直接从当前版本下载到最新版，而不是逐次升级」。

## 包的分工

发版时打两个更新包（`scripts/prepare-release.js`，公司版在 CI 里跑）：

- `AIHubHuawei-<ver>-update.gz`（完整更新包，schema 1）：app.asar + app.asar.unpacked 里不属于 node_modules 的全部文件。
  **必须始终是完整的**：3.1.2 及更早的客户端只认这一个，且只认 schema 1。
- `AIHubHuawei-<ver>-update-delta.gz`（增量小包，schema 2）：只装这一版变了的文件；没变的解包文件在目录的
  `unchanged` 里只留路径、字节数和 sha256，不再重复打包字节。3.1.3 起客户端优先用它。

`latest.json` 里两个包各占一项：`incremental` 与 `incrementalDelta`（后者多一个 `requires` = `unchanged` 的列表）。
另有 `filesIndex`：这一版全部打包文件的大小和 sha256，供下一版判断「哪些文件没变」。客户端不读 `filesIndex`。

## 客户端怎么选

`main/app-update-controller.js` 在 `check()` 里：

1. `planUpdate()` 判定能走增量（运行时一致）；
2. 有 `incrementalDelta` 且能核对本机（已打包，或测试里指定了 resources 目录）时，按 `requires` 逐个核对
   安装目录里的文件哈希；
3. 全部对上 → 下小包，`plan.variant='delta'`；
   对不上（老版本缺文件、被杀软删掉、被手工改过）→ 下完整更新包，`plan.variant='complete'`，
   界面写明「本机有些程序文件和这一版对不上，改为下载完整更新包（仍是一步升到最新版）」；
4. 只有小包、又没有完整包时 → 完整安装包。

无论从哪一版过来都只看最新 `latest.json`，一次下载直接到最新版，不需要逐版升级。

## 为什么不会半套替换

解包时（`unpackPayload(gz, dest, { resourcesDir })`）再核一次 `unchanged`：任何一项对不上就抛
`code='stale-local'`，一个文件都不写；界面提示重新检查更新（下一次会改用完整更新包）。
真正替换仍由 `apply.js` 的 PowerShell 脚本在程序退出后做，逐文件核对 sha256，失败全部回滚。

## 兼容与迁移

- 3.1.2 及更早：只看到 `incremental`（schema 1 完整包），行为不变。
- 3.1.3 起：优先小包。第一次发版（3.1.3）时上一版 `latest.json` 里还没有 `filesIndex`，
  `prepare-release.js` 会 Range 取上一版更新包的前 2MB、部分解压出目录来比（`indexFromPackage`）；
  两条路都取不到就只发完整包，不影响发版。
- `AI_HUB_PREVIOUS_INDEX=<json 路径>` 可以让发版脚本用本机现成的索引（离线/自测时用）。

## 体积（2026-10-22 实测）

| 项目 | 3.1.2 | 3.1.3（本版） |
|---|---|---|
| 完整更新包 | 86.74 MiB | 约 85 MiB（去掉了 source map） |
| 增量小包 | — | 约 9 MiB |
| 新装（GitHub 安装器） | 164.9 MiB | 约 165 MiB（体积改动在下一版：会议室运行时改为按需下载） |

## 测试

- `tests/unit-app-update.test.js`：小包只带变化的文件、`requires` 不匹配拒收（stale-local、暂存目录不写）、
  清单里 `incrementalDelta.requires` 的路径与校验值校验、只有小包时仍按增量更新。
- `tests/e2e-app-update-packaged.js`：打包程序上走「复制出来的旧安装目录 → 小包 → 替换脚本重启」的真实路径，
  断言弹窗里的小包体积。
