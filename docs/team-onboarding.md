# AI Hub · 组员上手（5 分钟）

给第一次装 AI Hub 的同事。全程 Windows，装完就能用。

Hub 是个本地工作台：把 Claude Code、Codex CLI 这些命令行 AI 装进一个窗口，
还能让几个 AI 在同一个群聊里分工干活。它本身不含 AI，用的是你机器上的 CLI。

---

## 一、装

三条路，挑一条，结果一样。**Token 是可选的** —— 没有 Token 也能装完，用你自己的
Claude / Codex 账号就行。

### 路线 1（推荐）· 把这段话发给你的 Agent

复制下面整段，发给你的 Claude Code / Codex：

> 帮我装一个工具。仓库 https://github.com/TianLin0509/claude-session-hub ，
> 按它 `README.md` 的「团队成员一键安装」章节操作，跑到打印 `SETUP COMPLETE` 为止。
> 用方式 C 的命令，不要点任何 GUI。中途弹 UAC 窗我会点「是」。
> 看到红色 `FAIL: <原因>` 就停下，把那一行原样发给我，不要自己瞎试。

（如果管理员给了你 64 位 Token，在这段话后面补一句：我的 Token 是 `<粘在这里>`。）

### 路线 2 · 双击装

1. **只下载 `install-hub.bat` 这一个文件**就行（它会自己把需要的 `install-hub.ps1`、
   `setup.ps1` 拉下来）。当然，clone 整个仓库再双击也一样
2. 双击 `install-hub.bat`
3. 弹出输入框：有 Token 就粘进去；**没有就直接留空点确定**，再点「是」继续
4. 看到绿色 `安装结束：成功` 就好了。中途可能弹 1-2 次 UAC 窗，点「是」

### 路线 3 · 一条命令

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$dst = "$env:TEMP\hub-setup.ps1"
iwr -useb https://raw.githubusercontent.com/TianLin0509/claude-session-hub/master/setup.ps1 -OutFile $dst
powershell -ExecutionPolicy Bypass -File $dst
```

有 Token 就在最后加 `-Token <你的64位Token>`。

装的东西：Git、Node.js（已有就跳过）→ Hub 源码 → 依赖 → Claude Code CLI →
桌面快捷方式「AI Hub」→ 自动启动。首次 `npm install` 要 2-15 分钟，别急。

> **公司网连不上 GitHub 怎么办**：浏览器打开仓库页 → Code → Download ZIP →
> 解压到一个你会长期保留的文件夹 → 在里面双击 `install-hub.bat`。
> 脚本会认出自己就在源码里，跳过联网下载。

---

## 二、第一次打开

窗口顶部中间会写 **`AI Hub  v1.6.x  PID: 12345`**。这个版本号很重要，报问题时先报它。

左边一列是功能区：工作台、投研、学习、开发看板、备忘录、记忆、工具、账号。
**「投研」和「学习」是作者自己用的**，依赖没开源的数据后端，你们点进去是空的，跳过就行。

### 登录 AI 账号

安装脚本跑完时会打印一段 **Accounts**，那是**从配置文件读回来的真实状态**，照它做就行：

```
Accounts (read back from ...\.claude-session-hub\config.json):
  Claude  -> team gateway https://...      # 走团队网关，不用自己登录
  Claude  -> your own account              # 需要你自己登录
```

**要自己登录时**：点左边 **「账号」** 看各个 CLI 的登录状态。没登录的，
在 Hub 里新建一个该 CLI 的会话，按它自己的提示登录一次即可
（Claude Code 是在会话里输入 `/login`；Codex CLI 是 `codex login`）。
登录信息存在 CLI 自己的配置里，Hub 不碰。

**装的时候填了 Token，但网关连不上怎么办**：安装会照常完成，但配置里
Claude / Codex 仍然指着网关，这时候光去登录自己的账号是不够的 —— 得先把开关扳回来：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\claude-session-hub\setup.ps1" -UseOwnAccount
```

这条只改「走网关还是走自己账号」这一个开关，网关地址和 Token 还留在配置里，
以后网关修好了，重跑一次带 `-Token` 的安装命令就能切回去。

---

## 三、5 分钟上手：让两个 AI 一起干一件活

Hub 比直接开命令行强的地方就在群聊。别只发个「你好」就关了，跑一遍这个：

**1. 先试单聊（30 秒）**

首页点 **「新建普通会话」** → 选 **Claude Code**（或你登录好的任意一个）→
选工作目录（想试水就选「临时目录」，它会随机建一个一次性目录，跟你别的项目完全隔离）
→ 创建会话 → 输入任意一句话 → 看到流式回复 = 通了。

**2. 再试群聊（3 分钟，这才是重点）**

首页点 **「新建 AI 群聊」** → 勾上两个你登录好的 AI（比如 Claude + Codex）→
选场景（先用「通用」；要让它们改代码就选「开发」）→ 工作目录同上 → 创建。

然后给它们一个**真问题**，比如：

> 我们要给 XX 做个小工具，先各自说说你会怎么设计，看法不一致就直接辩。

两个 AI 会各自发言、看到对方的内容并回应。你随时可以插话、追问、点名某一个。

**3. 用「开发」场景干真活（可选）**

想让它们动你自己的代码库，选「开发」场景并把工作目录指向你的项目。
建议先在一个不重要的分支上试。

---

## 四、日常

| 事情 | 怎么做 |
|---|---|
| 启动 | 双击桌面「AI Hub」图标 |
| 更新到最新版 | 重跑安装时那条命令（幂等，不会弄坏配置，也不会动你自己放在目录里的文件） |
| 确认自己是不是最新版 | 看窗口顶部的 `v1.6.x`，和管理员对一下 |
| 换成自己的账号 / 换回团队网关 | `setup.ps1 -UseOwnAccount` / 重跑带 `-Token` 的命令 |

> **只有 git 装的才能靠重跑更新。** 路线 1、2、3 装出来的都是 git clone，重跑就会
> `git pull` 到最新，脚本会打印 `updated <旧> -> <新>`。
> 但如果你是**下载 ZIP 解压**装的（下面那条离线路线），那个目录没有 git，重跑只会原地
> 重装同一份代码 —— 脚本会黄字提醒你这一点。想以后能一键更新，就重新用 git 装一次：
>
> ```powershell
> git clone https://github.com/TianLin0509/claude-session-hub.git "$env:USERPROFILE\claude-session-hub"
> ```

---

## 五、出问题了怎么报

**报这三样，就够定位了：**

1. 窗口顶部的版本号 `v1.6.x`（没装起来就跳过）
2. 红色 `FAIL:` 那一整行（原样复制，别转述）
3. 你当时在干什么（哪一步、点了什么）

几个常见的，可以先自己处理：

| 现象 | 原因 | 处理 |
|---|---|---|
| `npm install failed` 带 EBUSY | 有 Hub 窗口还开着锁住了文件 | 关掉所有 Hub 窗口再重跑 |
| 启动白屏 / `Cannot find module` | 依赖没装全（node-pty 编译失败居多） | 重跑一次安装命令；还不行就报给管理员 |
| `git clone failed` | 公司网封了 git | 走第一节的「下载 ZIP」离线路线 |
| `cannot reach ...` 黄字警告 | 团队网关不通 | **不影响安装**，用自己的账号登录即可 |
| 防火墙弹窗 | Hub 在本地起了 hook 端口（3456/3470 等） | 允许「专用网络」就行，不用勾「公用网络」 |

**Token 是借用团队订阅的钥匙**：别截图、别转发、别提交进 git。怀疑泄露立刻找管理员吊销。
