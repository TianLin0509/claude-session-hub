# CodeAgent 号池（一期）

2026-10-16 用户要求：AI 特战队成员新建 CodeAgent 会话时，可在「个人账号」和「号池账号」之间选；号池由 Hub 自动挑号。同一个账号有分钟级额度，号池用来分散拥塞。普通同事看到的界面不变。

## 依据（公司真机实测，Q-1016-03/04/09）

- 登录凭证是配置目录里的 `.credentials.json`，`CODEAGENT3_CONFIG_DIR` 换目录就换号；一台电脑可同时登多个号，互不挤掉。
- 当前目录下的 `.cac/.credentials.json` 优先于配置目录：用户目录本身就是这种情况，在那里启动总会登成个人账号。
- 凭证由 Windows DPAPI 加密，只能在本机本用户下解开；`codeagent auth login --method idaas` 在命令行里输入 W3 用户名和密码，不弹浏览器。
- `auth logout` 会注销服务器上的这次登录，所有用这份凭证的地方一起掉线，CLI 收到 401 后还会删掉本地凭证。

## 行为

- 每个号一个配置目录：`<Hub 数据目录>/codeagent-pool/accounts/<id>`，登记在 `codeagent-pool/pool.json`（只有编号、备注、上次分配时间，不存凭证和密码）。
- 「AI特战队专用功能」弹窗里管理号池（入口需本机解锁，与是否配对无关）：添加（开一个命令行窗口跑 CodeAgent 的账号密码登录，号主本人输入；Hub 每 3 秒看凭证是否出现）、重新登录、移出号池。移出只删本机凭证，不执行 logout；还有进行中的会话时拒绝移出。
- 导入本机已登录的号（v2.1.4 补，用户 2026-10-16 要求）：弹窗列出用户目录下有凭证的 `.cac*` 目录，点「导入号池」复制凭证、账号清单（`.cac.json`）和这个号自己的默认模型进号池目录，不用重新登录（同一台电脑同一 Windows 用户下 DPAPI 凭证换目录可用）。原目录不动；个人账号、已在号池、已过期的不能导入。导入后不要在原目录执行退出登录，否则两边一起掉线。
- 状态只读凭证里的明文字段（工号、到期时间、登录方式）。账号密码登录的凭证不能自己续期，过了到期时间标「登录已过期」；浏览器登录的由 CodeAgent 自己续期。和个人账号同号、或号池里重复的号不参与挑号。
- 「AI特战队专用功能」分两个页签（v2.1.5）：「通道」是原来的配对与任务；「账号与号池」是一张表，个人账号与号池各号一行：状态、模型权限、本机进行中会话数（休眠不算）。「刷新会话数」即时重算；「一键获取全部模型权限」逐个在后台起该号的 CodeAgent（`core/codeagent-model-probe.js`），等出现输入框后打开它自己的 `/model` 菜单读出模型，Esc 关闭并结束进程，不发消息、不耗额度；结果存在号目录的 `hub-models.json`（个人账号存在 `codeagent-pool/personal-models.json`），之后的模型菜单与挑号以它为准。
- 自动获取模型权限（v2.1.6）：号主在登录窗口里登录完成（每 3 秒查凭证、最多 10 分钟）、导入本机已登录的号、以及表里从没获取过的号（含个人账号，打开账号页签时）都自动在后台获取一次；每个号每次运行 Hub 只自动试一次，失败时提示并可手动点「获取」。
- 启动中心「用量账号」三选一（v2.1.5）：个人账号 / 号池 · 自动路由 / 号池 · 手动选择；手动选择时旁边多一个「号池账号」下拉（脱敏工号、备注、模型、进行中会话数），模型菜单只列这个号的模型。
- 启动中心：号池里有可用的号时，CodeAgent 的启动配置多一个「用量账号」（个人账号 / 号池），选择记在本机。2026-10-20 起一个号固定一个模型：启动中心不再有 CodeAgent 模型菜单，手动选号时号的选项和配置摘要写它的模型（此前选号池时模型菜单是号池各号模型清单的合集）。
- 挑号：只在可用的号里挑；指定了模型时优先挑清单里明确有这个模型的号；然后没有进行中会话的优先，其次会话最少的，最后按上次分配时间轮转。会话整段固定用这个号。
- 启动前：工作目录里有 `.cac/.credentials.json` 时拒绝启动并说明原因；把个人账号的 `settings.json`（去掉 hooks 和 model）、`AGENTS.md`、`CLAUDE.md`、`skills/` 同步进号的目录，号自己的默认模型保留（没有时取它账号清单的第一个）；按个人账号目录同样的方式部署 Hub 的 hook。
- AI特战队通道按家里指定的模型开会话（2026-10-18，`docs/design/tezhan-model-route.md`）：号的默认模型不是指定模型、且号上没有进行中的会话时，同步配置把它切过去，切之前的模型记在号目录的 `hub-route-model.json`；之后不指定模型、号空闲时换回。个人账号不切。
- 同步时个人目录和号的目录相同或互相包含（先 realpath，Windows 上不分大小写和分隔符）就一个字都不写，只在日志里记一笔。
- 会话记下 `codeagentPoolAccount`（号的编号）和 `codeagentPoolLabel`（脱敏工号与备注）。休眠唤醒、恢复、原地重启、分支都回到同一个号的目录（会话记录在那里）；号已移出或需要重登时明确报错，不换到别的号。
- 会话栏标题前一个账号字母（2026-10-20 起取代「池」字）：个人号与号池号统一显示登录凭证里工号的首个英文字母（小写），悬停写代称（个人账号 / 号池 · 号 N），不写工号；拿不到字母不显示（core/codeagent-account-badge.js、renderer/session-account-badge.js）。输入框旁的模型提示里照旧写明用的是哪个号。

## 个人账号的配置目录（2026-10-19，v2.1.14 公司真机事故后）

- 来源按优先级：环境变量 `AI_HUB_CODEAGENT_CONFIG_DIR` → Hub 设置 `providers.codeagent.configDir` → Hub 进程继承来的 `CODEAGENT3_CONFIG_DIR`（有条件采用，见下条）→ 默认 `~/.cac`。这个变量名照旧用来在启动 CodeAgent 时由 Hub 显式写入真正的配置目录（个人会话写个人目录，号池会话写号的目录）。
- 继承值只有同时满足两条才采用（审核 2026-10-19：有的同事在用户级 / 系统级环境变量里把它指向自己的 CodeAgent 目录）：①注册表里的用户级或系统级环境变量就是它（同一目录：realpath 后比，Windows 不分大小写和分隔符）；②它和号池（根目录或任一号目录）不重叠。判定在 Hub 启动时做一次（`loadInheritedDecision`：只在有继承值、且不是默认 `~/.cac` 时用 PowerShell 读 `[Environment]::GetEnvironmentVariable(name,'User'/'Machine')`，输出转 UTF-8 再 base64，中文路径不受代码页影响；8 秒超时），结果缓存；部署 CodeAgent hook 前等它出结果，之后 `resolveCodeAgentConfig` 只比缓存，不读注册表。注册表读不出来、出错、超时一律忽略（宁可落到 `~/.cac`，也不回到号 1）。
- 事故：公司 Hub 带着继承来的 `CODEAGENT3_CONFIG_DIR`（指向号池号 1 的目录或等价路径）运行，「个人账号」会话实际开在号 1 的目录里、请求号 1 的 DS 模型，又拿个人账号的 GLM 权限清单比对，从 10-17 晚起每个个人会话都报「模型不存在」；远程修正把 model 改成 GLM 后，号 1 一开新会话，同步配置又把 DS 写了回去。
- 继承从哪来：Hub 自己的代码不往 `process.env` 写这个变量；Hub 派生的子进程（个人 / 号池会话、模型探测、号池登录窗口、自动标题）都是在子进程的环境里显式设，不回流到 Hub。但 Hub 的重启（远程重启、重启并继续的 `app.relaunch`）和更新（增量替换脚本、完整安装包）都把当前进程的环境原样带给新进程，所以只要 Hub 曾经从某个号池会话的进程树里被启动过一次（例如在 CodeAgent 会话里运行安装包或 Hub 程序），这个值就会一直跟下去。
- 想用自定义个人目录：在 Hub 设置里填 `providers.codeagent.configDir`，或设 `AI_HUB_CODEAGENT_CONFIG_DIR`；也可以在用户级 / 系统级环境变量里设 `CODEAGENT3_CONFIG_DIR`（不能落在号池里）。只在启动 Hub 的那个进程里临时设的不再生效。
- 加固：远程维护 `set-personal-model` 先 realpath 再比，个人目录和号池根目录或任何一个号的目录相同、互相包含都拒绝；号池同步遇到来源等于目标不写。UNC 路径（`\\server\share`）不做 realpath、只按字面比，避免网络盘不通时卡住。
- 直查 CodeAgent 段的 `personal`：`configSource`（`hub-env` / `hub-config` / `inherited-user-env` / `inherited-system-env` / `ignored-inherited-env` / `default`）、`configModel`（个人 settings.json 里写的 model）、`inPool` / `inPoolAlias`（个人目录是否和某个号的目录重叠，只给代称）、`inheritedConfigDir`：`adopted` / `ignored`、`reason`（`adopted-user-env` / `adopted-system-env` 采用；`process-only` 忽略：只在进程里出现；`in-pool` 忽略：落在号池；`unverified` 忽略：读不到注册表；`explicit` 忽略：个人目录已显式指定）、`origin`（`user-env` / `system-env` / `process-only` / `unknown`：读注册表出错）、是否指向号池（代称）、`startedInside`（Hub 自己的环境里有没有 Hub 会话标记 `CLAUDE_HUB_SESSION_ID` 或 CodeAgent 启动器标记——有就说明 Hub 是从某个会话的进程树里启动的），都不带路径。判定和直查共用启动时那一次注册表读取。Hub 日志在启动后记一笔同样的说明。
- 已知影响：事故期间（10-17 晚到 10-19 修正版装上之前）开的「个人」会话，原生记录在号 1 的目录里，修正后按个人目录找不到，恢复时会报找不到原会话（这些会话本来也都失败了）。号 1 目录里还留着 09:55 远程修正时的备份 `settings.json.hub-backup-20261019-095502-033`，无害。

## 启动中心按账号建会话（2026-10-19，田哥公司真机 2.1.15）

- 选了号，模型下拉只列这个号有权限的模型；「沿用」那一项（值为空、启动后不切换）写成这个号的默认模型，例如「GLM-5.2 Auto（默认）」。默认模型：个人账号 = 纠正后的默认（`codeagent-model-route.js personalModels`），号池号 = 启动前同步配置会定下的模型（`effectiveModel`），号池自动挑号只在各号默认一样时写出。换号时模型回到新号的默认；点选的正好是默认模型时按「沿用」处理，不走 `/model` 菜单。
- 启动中心的下拉（账号、号池账号、模型等）点开后，选项列表画在页面里、控件正下方（`renderer/launch-select-popover.js`），不再用系统弹层：公司电脑的窗口事件日志显示 Hub 每次启动后窗口按 100% 缩放报尺寸（2578×1398），最小化再还原后才按 125%（2064×1120），系统弹层按错的比例算位置，跑到窗口中间。启动中心的代码和样式从 2.1.8 起没变过。
- 个人账号的登录状态写进账号下拉和说明（登录已过期 / 还没登录 / 登录凭证读不懂），「账号与号池」里个人一行按状态显示并给「重新登录」（同号池的登录窗口，目录是个人配置目录，和号池重叠时拒绝）。凭证读不懂时带原因（读文件出错 / 不是 JSON / 没有登录项及顶层键名，不含内容），直查 pool 段和 CodeAgent 段的 `credentialsNote` 带出；读取时去掉 BOM、登录项键名大小写不敏感（CodeAgent 自己的 `xxxOAuth` 优先，Claude 的 `claudeAiOauth` 不算）。
- 点「后台」的回执写进窗口事件日志（`page-backstage`：会话类型、个人 / 号池、终端层尺寸与是否在最上层、行数、绘制方式、devicePixelRatio；点了没反应时记原因），直查 logs 段能读到。
- 通道指定号、但读不到账号清单（老环境）时：指定个人只开个人，指定号池里的号只开那个号，不再改成号池自动挑号。
- 验证：`node tests/e2e-codeagent-launch-account.js`（公司版导出物、真实点击：个人账号建会话 → GLM，号 1 建会话 → DS，两个会话的后台都能打开、来回切和从各整页切回都能再开，下拉列表在控件正下方），`node --test tests/unit-codeagent-credentials-read.test.js`。

## 不在一期

- 撞到分钟额度时自动换号（需要先在真机上看到 `quota_auto_resume_*` 事件的样子）。
- 跨电脑一键分享（Q-1016-09 同机验证可行：只分享访问凭证，经 `--set-x-auth-token` 免交互登录，号主 Hub 按天补发）。
- 按账号统计用量；群聊成员、自动作答会话使用号池；`plugins/`、`mcp-servers/` 的同步。

## 验证

- `node --test tests/unit-codeagent-pool.test.js`：挑号顺序与过滤、凭证读取与过期、重复号、移出、配置同步（hooks/model/规则/skills）、工作目录凭证拦截、登录窗口参数与隔离夹具。
- `node tests/e2e-codeagent-pool-cdp.js`：真实隔离 Electron + 鼠标操作，假 CodeAgent（`tests/fixtures/codeagent-pool-fake`）记录配置目录并按号目录里部署的 hook 向 Hub 报到。覆盖：号池为空时不显示选项、弹窗添加两个号、两个号池会话落到两个号且第二个挑空闲号、个人会话仍用个人目录、号目录的 hook/规则/模型、卡片标记、休眠后唤醒回到同一个号并接上原会话。登录窗口用隔离夹具代替，真实 CodeAgent 登录未在家里覆盖。
