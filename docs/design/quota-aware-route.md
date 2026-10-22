# 额度感知路由（v2.1.13，2026-10-18）

田哥：「不是停用号池，而是给到 agent 自主选择账号的机会……最好能识别出 API 用量到达上限了（我看到的是 codeagent 后台的报错），然后自动避让。」

## 识别（公司一端，只读）

- 规则与状态：`core/codeagent-quota.js`。内置规则只放真实样本确认过的；公司可在 `<Hub 数据目录>/codeagent-pool/quota-rules.json` 里加规则（`rules`）、停用内置规则（`disabled`），写错的规则不生效并在「账号与号池」页签和直查 errors 段报出来。
- 样本 1（2026-10-18 田哥转述，公司 Hub 会话卡片视图）：`API Error token消耗过快， 已达到4亿上限`。规则 `codeagent-token-cap-v1`：`API Error` 后 120 字内出现「token消耗过快」或「已达到 N(亿|万)上限」，全角半角标点、空格宽松。转述的标点不精确，2.1.12 上线后用直查 errors 段取回精确原文再核对。
- 读法：`core/company-bridge/quota-watch.js` 每 20 秒（checkNow 时立即）看开着的 CodeAgent 会话（通道、号池、个人账号上的都算）：
  1. 原生记录——唯一触发避让的来源：只看 API 错误消息（`isApiErrorMessage`、带 `error` 字段、`<synthetic>` 模型的回答，或正文以 `API Error` 开头的回答 / 系统消息）；用户消息和普通回答正文不看（问题里引用报错不会误判）。超过一个重试周期的旧报错只留样本、不避让；记不下避让状态时不前进读取位置，下一轮重读。尾部读取按字节找行，不切坏多字节字符。
  2. 终端屏幕——只留样本、读 Credit，不避让（审核 2026-10-18：回显的「> API Error…」、回答里的「- API Error…」列表行会误停号）。只认 ⎿ 开头或无前缀的行；每个会话第一次读屏只记基线；同一行留在屏幕上只算一次。
  3. 样本：命中规则的都留；没命中的「疑似」只收通道会话里以 `API Error` 开头的。脱敏：号身份、令牌、路径、工号、邮箱、IP、域名。
  4. 自定义规则防护：匹配输入截到 2000 字，拒绝嵌套量词，reset 正则限长，读出的恢复时间最多 24 小时后。
  5. 绝不往会话发按键或命令。
- 避让状态：`<Hub 数据目录>/codeagent-pool/quota-avoid.json`（键 personal / 号池编号）。报错读不出重置时间按设置 `quotaRetryMinutes`（默认 60 分钟）后再试；Credit ≤ `creditFloor`（默认 0）也避让；额度类避让只在 Credit 读数比标记时回升且高于阈值时提前解除（下降、没变、标记时没有读数都不解除；限流、手动暂停不解除）；同一个号多个会话取最近活动会话的读数。手动暂停可带到点恢复。

## 路由

- `pickAnyRoute` / `pickRoute` 跳过带 `avoid` 的号（`CompanyBridge.routeAccounts` 叠加避让状态）；全部避让 → `reason:'avoid'`，问题排队，回执写「所有号都在避让中，预计 X 恢复」，不占名额、不硬派；号池开会话失败时个人账号在避让中就不退回。
- 撞额度换号重做：在途轮次的会话在发出后撞到额度 → 该轮不判失败。旧会话还在忙（多半在自己重试）就等 60 秒；等的时候它自己答出来了就不换号、照常收。否则 `rehome` 把这一轮退回排队、换号新开会话，提问带原问题 + 「上一会话在号 N 上因额度中断，已读到的进展」。旧会话不发按键、不关，记进 `prevSessions`，停下后由会话收放休眠。只重做一次，重做又撞到就如实报失败（`retry` 清零后可再换一次）。
- 追问：原会话的号在避让中、或追问指定了别的号 → 换号新开会话，附上此前各轮问答（≤12000 字）。

## 家里自主选号

- 模型表升级为「号 + 模型」：`accountRows` 每号一行（代称、模型、进行中会话、通道在处理几个、还能并行、避让原因与预计恢复、Credit），只有代称（个人 / 号 N：每个号第一次出现时按登记顺序分一个固定序号，落盘在 `codeagent-pool/quota-aliases.json`，删号不复用，和直查一致）。避让状态变化最快 30 秒推一次（模型变化仍 10 分钟节流）。
- `ask_company` / `followup_company` 新增可选 `account`（代称）。家里按号表核对：写法不对、没有这个号、在避让中直接报错并给出可用的号，不发出；公司同样再核一遍。默认不填交给自动路由。回执元数据 `accountAlias` / `requestedAccount` / `rehomedFrom`，家里提示里写明换号。
- 公司 `caps` 带 `quota`：家里据此判断老公司不认 account / pause-account。

## 直查与远程维护

- `pool` 段每号带 `avoid`、`credit`；`codeagent` 段带 `avoid` 列表；新段 `errors`：最近 N 条（默认 20，最多 50）识别到 / 疑似的 API 报错原文（号身份、令牌、路径、工号脱敏），标注命中的规则与来源。
- 远程维护 `pause-account`（account 代称，hours 0.25–72，不填 = 直到手动恢复）/ `resume-account`。

## 界面

- 公司「AI特战队专用功能 → 账号与号池」：每号「派活」列（可用 / 避让中·原因·预计恢复、Credit），「暂停派活 / 恢复派活」（确认框）；设置里「额度避让」开关、Credit 阈值、默认再试时长。公司侧文案不出现「家里」。
- 家里「公司电脑状态」卡片：号池段「派活」列与远程暂停 / 恢复（二次确认），新增「API 报错」段。

## 验证

- 单测 `tests/unit-company-quota-route.test.js`：真实样本与 6 种标点空格变体、数据文件规则、避让与过期、挑号、换号重做（只一次）、全部避让排队与远程恢复、追问换号、account 与代称、隐私、屏幕与 Credit、errors 段脱敏与条数。
- 真实端到端 `tests/e2e-company-quota-route.js`：双 Electron + 公司版导出 + 替身（真 Claude Code + Haiku）；号 1 的配置目录放 `standin-api-base.txt`，替身把它的请求发到本机假后端，按样本文字回报错误，真 Claude Code 把它写成 API 错误消息落进原生记录。公司 CodeAgent 的确切写法（是否带状态码、JSON）待直查 errors 段取回核对。

## 模型配置有误（v2.1.14，2026-10-19）

- 真机证据（2026-10-19 00:18 公司 v2.1.13 直查）：个人账号权限只有 `GLM-5.2-WX-Auto`，pool 段个人 `defaultModel` 为空；errors 段两条结构化 API 错误原文 `API Error: 模型 "deepseek-v4-flash-0731" 不存在或配置有误，请检查模型配置`（10-18 22:4x、00:16 各一次）。即个人配置目录 `settings.json` 的 `model` 写成了它没有权限的 DS 模型，个人账号开的每个会话一启动就报。
- 规则 `codeagent-model-config-v1`（`kind: model-config`）：`API Error` 后 160 字内「模型 X 不存在或（者）配置有误」，全角半角冒号、各种引号（含 JSON 转义的 `\"`）、空格宽松；第 1 个捕获组是被请求的模型。
- 避让按「号 + 被请求的模型」记在 `quota-avoid.json` 的 `models` 段（和整号避让分开）：不设自动到期（配置不变就一直会报），`probeAt`（6 小时）之后放行一次试探，派出时推后 6 小时；试探又报重新计时。解除：这个号用那个模型正常答出来（原生记录里该模型的正常回答）、「恢复派活」、远程修正个人账号默认模型成功。
- 路由：账号带 `configModel`（不指定模型时它实际会请求的模型——个人账号是 settings 里写的值，哪怕没权限）。不指定模型按 `configModel` 判断，指定模型按指定的判断；其余模型照常可派。撞到时走和额度一样的换号重做（`MAX_REHOME = 1`），回执元数据 `rehomeKind: 'model-config'`。
- 号表 / 直查写明「模型配置有误：请求了 X，该号只有 Y」；个人账号默认模型为空、权限清单只有一个模型时另标「默认模型和权限不符：settings.json 里写的是 X，权限只有 Y」（`configNote`；直查 pool 段 `configMismatch`，codeagent 段带 `configModel`、`settingsMtime`、`configSource`）。

## 远程修正个人账号默认模型 set-personal-model（v2.1.14，2026-10-19 田哥授权）

- 只由远程维护手动触发（MCP `company_act`、`company-ask.js --act set-personal-model --model X | --restore`、家里「公司电脑状态」卡片个人一行的「改成 X」，均二次确认）；Hub 不自动改个人 `settings.json`。
- 目标必须在个人账号权限清单里（探测文件，没有时用配置文件里的账号清单），否则拒绝并列出可选；只改 `model` 一个键，改前整份备份为 `settings.json.hub-backup-<时间>`，临时文件 + 改名（失败重试一次），回读核对不过就从备份还原并报失败；`restore: true` 用最近一次（非 `-undo`）备份里的值；个人目录落在号池目录里拒绝。
- 只影响之后新开的会话；成功后解除个人账号的模型配置避让，审计写 `company-act.log`，公司界面轻提示「对端修改了个人账号默认模型：A → B」。限频 60 秒一次，「远程维护」开关关闭时拒绝；公司 `caps` 带 `personal-model`，老公司家里直接说明不支持。
- 端到端 `tests/e2e-company-model-config.js`：替身按 `standin-model-permissions.json` 模拟后端按号校验模型，假后端回报真机原文。
### 独立审核后的修正（2026-10-19）

- 撞到模型配置有误、又没有别的号能接这一题（其余号都在避让、或没有该模型权限）：不换号重做、不排队 6 小时，直接回报「模型配置有误：个人请求了 X，该号只有 Y；可用 set-personal-model 改成 Y」；新问题同理。避让说明里也带这条修法（号池的号提示到「账号与号池」核对）。
- 「默认模型和权限不符」只在 settings 写的值不在清单里（分档名按 `-Auto` 算在内）、且对这个值有还没清除的模型配置避让记录时标出，合法的内部别名不标红。
- 用户自己开的会话报错：只有报错里的模型就是这个号配置里会请求的模型才标记（通道会话照常标）。界面、直查的「避让中」只显示和号此刻会请求的模型对得上的记录。
- set-personal-model 回给对端的只有固定文案 + code（`bad-json` / `unverified` / `verify-failed` 等），路径、JSON 片段只写本机 `company-act.log`。
- 权限依据：清单权威（「获取模型权限」的探测文件 `probe`，或 CodeAgent 自己存在 `.cac.json` 的账号清单 `enterprise`——2.1.12 直查个人号 models 只有 GLM、没有混进 settings 里写的 DS，说明来自后者），或个人账号实际用该模型作答过（回执元数据的实际模型 + 代称 / 会话归属，或会话记录的 `codeagentActualModel`；分档名 `GLM-5.2-WX` 算 `GLM-5.2-WX-Auto`）。都没有时拒绝并提示「获取模型权限」或 `--force-unverified`；`force:true` 只跳过这一条，回报、轻提示、审计都标「未经权限校验」。直查 pool 段带 `modelsAuthoritative` / `modelsProbedAt` / `modelsSource`，个人一行另带 `answeredModels`、`lastBackup`。
- 撤销（restore）不清避让；家里卡片个人一行有「撤销上次修改（改回 X）」按钮（二次确认）。

## 号池号的默认模型权限兜底（v3.1.2，2026-10-22 公司真机 v3.1.1）

- 真机证据：只有 `DeepSeek-V4-Flash-0731` 权限的号 2、号 4 在「特战通道」会话里请求 `GLM-5.2-WX-Auto`，被后端判「模型不存在或配置有误」，记成按「号 + 模型」的模型配置避让（不自动到期、6 小时一次试探），看起来「一直避让」。号 1 的模型日志：`default-model before=GLM-5.2-WX-Auto after=deepseek-v4-flash-0731 restoredTo=GLM-5.2-WX-Auto`——号池号自己的 `settings.json` 里就写着 GLM。
- 来源：导入号池时会把源 `.cac` 目录 `settings.json` 的 `model` 抄进新号（`importLocal`），公司那个目录常年写着 GLM；开关关着（账号即模型）时 `syncSharedConfig` 只认号自己写的值、不做权限校验，于是 GLM 一直留着，全靠启动后 `/model` 菜单纠正。
- 两处纠正漏口：`codeagent-auto-pick.js` 的 `account-default` 跳过菜单时直接继承配置里的模型；`session-handlers.js` 的 `fallback=send-with-cli-model` 在菜单没选上时照发。任一漏口都会拿 GLM 去撞后端。
- **A 启动前**：`codeagent-pool.js` 的 `permissionSafeModel` —— 号写的模型不在权限清单里、清单权威且只有一个模型时，一律换成清单里那个（写进 `settings.json`，其余键原样保留），`syncSharedConfig` 回报 `modelFix` 并记 `pool-model-fix`；`importLocal` 抄模型时同样按源目录的权限清单纠正。清单有多个模型或清单不权威时不动（该用哪个无法判断）。
- **B 兜底**：`quota-watch.js` 撞到模型配置有误时，先对**号池的号**（Hub 管配置）调 `fixPoolModel` 把配置改对，并且这次不记「一直避让」（`probeMs: 0`，下一次直接重试）；同一个号同一个模型 6 小时内只自动修一次，修了还报同样的错说明问题不在配置，照旧 6 小时试探。个人账号是号主自己的配置，只提示不改（仍走 `set-personal-model`）。
- **B 兜底（发送前）**：`runCodeAgentPick` 在自动会话发第一条问题前核对「这次会用的模型」（选成了就是选中的；没选成就是配置里写的）在不在权限清单里，不在就不发——发出去只会得到「模型不存在」并被记成长期避让。日志 `pick ... error=off-permission`。
- 单测 `tests/unit-codeagent-model-permission-fix.test.js`。
