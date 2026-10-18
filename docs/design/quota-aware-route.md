# 额度感知路由（v2.1.13，2026-10-18）

田哥：「不是停用号池，而是给到 agent 自主选择账号的机会……最好能识别出 API 用量到达上限了（我看到的是 codeagent 后台的报错），然后自动避让。」

## 识别（公司一端，只读）

- 规则与状态：`core/codeagent-quota.js`。内置规则只放真实样本确认过的；公司可在 `<Hub 数据目录>/codeagent-pool/quota-rules.json` 里加规则（`rules`）、停用内置规则（`disabled`），写错的规则不生效并在「账号与号池」页签和直查 errors 段报出来。
- 样本 1（2026-10-18 田哥转述，公司 Hub 会话卡片视图）：`API Error token消耗过快， 已达到4亿上限`。规则 `codeagent-token-cap-v1`：`API Error` 后 120 字内出现「token消耗过快」或「已达到 N(亿|万)上限」，全角半角标点、空格宽松。转述的标点不精确，2.1.12 上线后用直查 errors 段取回精确原文再核对。
- 读法：`core/company-bridge/quota-watch.js` 每 20 秒（checkNow 时立即）看开着的 CodeAgent 会话（通道、号池、个人账号上的都算）：
  1. 原生记录为主：只看 API 错误消息（`isApiErrorMessage`、带 `error` 字段、`<synthetic>` 模型的回答，或正文以 `API Error` 开头的回答 / 系统消息）；用户消息和普通回答正文不看（问题里引用报错不会误判）。超过一个重试周期的旧报错只留样本、不避让。
  2. 终端屏幕补充：会话缓冲经 @xterm/headless 渲染，只看去掉框线后以 `API Error` 开头的行；同一行留在屏幕上只算一次。顺带读 Stats 面板的 Credit。
  3. 绝不往会话发按键或命令。
- 避让状态：`<Hub 数据目录>/codeagent-pool/quota-avoid.json`（键 personal / 号池编号）。报错读不出重置时间按设置 `quotaRetryMinutes`（默认 60 分钟）后再试；Credit ≤ `creditFloor`（默认 0）也避让；额度类避让在 Credit 读数变化且为正时提前解除（限流、手动暂停不解除）；手动暂停可带到点恢复。

## 路由

- `pickAnyRoute` / `pickRoute` 跳过带 `avoid` 的号（`CompanyBridge.routeAccounts` 叠加避让状态）；全部避让 → `reason:'avoid'`，问题排队，回执写「所有号都在避让中，预计 X 恢复」，不占名额、不硬派；号池开会话失败时个人账号在避让中就不退回。
- 撞额度换号重做：在途轮次的会话在发出后撞到额度 → 该轮不判失败，旧会话不动，`rehome` 把这一轮退回排队、换号新开会话，提问带原问题 + 「上一会话在号 N 上因额度中断，已读到的进展」。只重做一次，重做又撞到就如实报失败（`retry` 清零后可再换一次）。
- 追问：原会话的号在避让中、或追问指定了别的号 → 换号新开会话，附上此前各轮问答（≤12000 字）。

## 家里自主选号

- 模型表升级为「号 + 模型」：`accountRows` 每号一行（代称、模型、进行中会话、通道在处理几个、还能并行、避让原因与预计恢复、Credit），只有代称（个人 / 号 N，号池登记顺序，和直查一致）。避让状态变化最快 30 秒推一次（模型变化仍 10 分钟节流）。
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
