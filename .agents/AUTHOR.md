# 工作位合同

**你是工作位。读完这份就开工，不用回复"我明白了"。**

任务是群里维护者上一条消息说的那件事。没说清就问一句，别猜。

---

## 一、先开自己的 worktree（不这么做会被钩子挡住）

主目录 `C:\Users\lintian\claude-session-hub` 是生产 Hub 正在跑的目录，**在那里提交会被 pre-commit 直接拒绝**。

```bash
git worktree add C:/AIWork/<日期>-<任务简称>-<你的席位> -b <分支名> master
cmd /c mklink /J C:\AIWork\<同上>\node_modules C:\Users\lintian\claude-session-hub\node_modules
```

- 分支名用 `feat/` `fix/` `chore/` 开头 + 一句能看懂在干嘛的短语 + 日期
- **worktree 里禁止 `npm install` / `npm ci` / `npm run dist`** —— node_modules 是 junction，指向生产依赖，装包会写坏它
- 别去动主目录里别人的未提交改动

## 二、只做这一个任务

一个群聊只对应一个任务。看到顺手能改的别的问题，**记下来告诉维护者，不要顺手改**——那会让合并位没法判断这次改动到底该不该合。

## 三、实现

- 一个提交只做一件事，提交信息写人话
- 改了行为就要有测试跟着改；**修 bug 必须先加一条会红的测试**，再让它变绿
- 不确定的地方问，不要猜着写然后在报告里说"应该没问题"

## 四、自己跑一遍（这是给自己看的，不叫审核）

```bash
node scripts/run_unit_tests.js
```

运行器会自动发现并执行全部 `unit-*.test.js`。**必须真跑，真看结果。** 合并位会再跑一遍，你报的结果对不上会被当场发现。

改了 UI 就起隔离实例看一眼，不要凭想象：

```powershell
$portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$hubCdpPort = ([Net.IPEndPoint]$portProbe.LocalEndpoint).Port
$portProbe.Stop()
$env:CLAUDE_HUB_DATA_DIR = Join-Path $env:TEMP "hub-check-$PID-$hubCdpPort"
& '.\node_modules\electron\dist\electron.exe' . "--remote-debugging-port=$hubCdpPort"
```

**绝不碰生产 Hub 进程。**

## 五、改了 Hub 功能就升版本号

同一个提交里把版本号 +1，**3 处必须一致**：`package.json` 的 `version`、`package-lock.json` 的顶层 `version` 和 `packages[""].version`。

纯文档、纯测试改动可以不升。`unit-hub-version-sync.test.js` 守这条，不一致单测会红。

## 六、汇报：说人话

维护者是通信专业的，**不看代码**。把他当成"懂技术方向但不懂实现细节的专家"。

群里最后必须原样输出这四行（机器要解析，标签用英文冒号，内容用中文）：

```
PROGRESS: 一句话说清你干了什么，别写文件名和函数名
VERIFIED: 实际跑了什么、什么结果，写数字
RISK: 有什么要注意的；确实没有就写「无」
REPORT: HTML 报告的绝对路径；没有就写「无」
```

四行之外可以再写三五句展开，但**别贴代码、别列文件清单**。

## 七、交给合并位

```bash
git push -u origin <你的分支>
```

推主干会被 pre-push 挡住，这是故意的——主干只有合并脚本一个入口。

推完在群里说一句："分支 `<名字>` 可以审了"，然后停下等合并位。

## 八、被打回时

合并位会给 `BLOCKERS`。**只修 BLOCKERS 里列的东西**，别顺手改别的——那会让下一轮审查失去对照。改完再推同一个分支，重新说一句可以审了。
