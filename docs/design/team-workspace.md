# 团队工作台

团队页把可见工作消息整理为本人确认的承诺和周报草稿。云端六个工具仍独立登录；团队服务没有云端写入接口，聊天原文和分析文件只存当前电脑 Hub 数据目录。

## 本机业务接口

`createTeamWorkspace({dataDir,getAssistant,onChanged,now?})` 返回 `state()`、异步 `execute(args)`、`start()` 和 `stop()`。主进程负责 IPC 和生命周期。`state()` 是当前已核实 WeLink owner 的完整状态；助理不存在、登录未知或失效时返回 `available:false` 和空业务集合，绝不回退历史快照身份。资料文件按 owner 的 SHA-256 命名，文件内部再核对 owner；损坏文件报错，不能当空资料覆盖。

AuthKeeper 在新进程中将磁盘上的 online/renewing 视为待核实，清除运行态登录身份和五分钟查询缓存；保留续期计数与诊断历史。第一次只读 `auth status` 核实成功前不展示历史账号团队资料，避免 Hub 关闭期间 CLI 已换号而误信旧登录。

`execute` 的普通修改返回完整状态，`resolve` 单独返回候选。操作串行；身份在每个异步取数后、写盘前复核。主要操作：

所有 `execute` 请求必须携带 `expectedOwner`，值取页面上一次 `state().owner`，后端校验与当前登录账号严格相等；缺失同样拒绝。这样账号已切换但页面尚未刷新时，旧草稿不会写进新账号。内部定时器也显式传入自己捕获的 owner。

| op | 输入 | 行为 |
|---|---|---|
| resolve | input | 只读 contact detail；验证输入等于返回 account 或 workId，返回 resolutionId/candidates/expiresAt |
| follow | resolutionId, account, confirmed:true | 仅确认有效期内、属于当前 owner 的明确候选 |
| unfollow / restore | memberId，取消须 confirmed:true | 可恢复地取消关注，保留历史 |
| refresh | scope 可选 all/private | 一次查询所有关注成员的近七天可见消息 |
| analyze | memberId 可选 | 通过现有 CompanyAssistant.ask 发一个团队批量分析任务 |
| analysis.sync | 无 | 按准确 chatId、requestId 归集分析结果并验证每项出处 |
| commitment.add | title, memberId?, sourceIds:[], confirmed:true | 人工确认后保存，完整相同条目去重 |
| commitment.update | id, title?, status:open/done/cancelled | 保存更正历史，可取消、重开 |
| weekly.draft | 无 | 从已确认承诺生成本地草稿 |
| weekly.update | id, text | 保存人工编辑后的草稿 |
| settings | autoRefresh?, intervalHours?, scope? | 默认关闭定时；6/12/24/48/168 小时间隔 |

## 证据与覆盖

复用 `AssistantQuery.execute` 的七天自定义时间窗和分页读取；查询 scope=all 表示当前登录账号可见的群及私聊，不代表整个公司消息。不能把 person 姓名包含匹配用作成员身份。采集只接受消息 `account === 已确认 account`，正文通过 read 翻完所有分段，同时取同次查询相邻上下文。结果按 sourceId 去重。分页失败、重复游标、全文失败均保留可用证据，标记 partial 和原因；没有消息不代表成员正常或异常。

`lastRefresh` 包含 at/range/scope/queryId/coverage/count/pages/error。coverage 继承原查询 scanned、knownConversations、partialConversations、unknownTime、limitation、details 和 errors，额外包含 reasons。不能仅凭 count 或 complete 推断员工状态。

每次重新采集替换当前证据，旧分析标记 historical。分析和承诺各自保存当时引用的证据快照，因此消息更正、撤回、窗口滚动不会让旧结论失去审查依据；旧记录不是当前事实。首版不提供长期趋势判断。

## AI 与人工确认

原文写入 `team-workspace/requests/<owner-hash>/<request-id>.json`。现有公司助理/原生 CodeAgent 读取该本机文件；prompt 本身只引用本机路径和身份，不拷贝所有原文。输入聊天是材料，不是工具指令。分析只产出事实、明确表达、待核实事项和建议跟进，不推断心理健康、忠诚度、离职或绩效。覆盖不全时不能作整体状态判断。

团队任务复用助理的串行队列，但原生会话按 owner 单独创建和复用，工作目录分开；与普通助理不共享上下文、记忆或管理 MCP。任务在排队、原生会话建立后、结果收集时核对 owner；换号即拒绝发送/归集，已经运行的本团队任务请求中断，其他任务不受影响。助理页同样过滤非当前 owner 的团队任务记录，重试保留身份绑定。

结果必须为绑定 requestId 的 JSON findings，每项有合法 kind、非空 text、至少一条属于本次输入的 sourceId。格式不合规、出处缺失或任务绑定不符显示失败，不能把任意文本或关键词规则冒充已验证 AI 分析。源码核对引用存在只能证明出处可定位，语义是否得到原文支持仍需本人复核。

承诺不随分析自动创建。用户确认后保存内容、出处快照和状态；周报只列确认后的承诺文字，不附原始聊天、个人分析或自动外发。周报可本地编辑保存，复制到现有工具前由用户核对。

## 定时与边界

一个轻量计时器轮询分析结果，只有记录变化才写盘。用户主动开启后按账号设置刷新证据，默认每日；整批串行，不为每成员创建 Agent。定时不自动分析、不发消息、不写云端。失败按本轮间隔退避，下次可手动接续。

单测用合成联系人、消息和助理任务，覆盖身份确认、同名/歧义、未登录/换号、异步身份改变、分页、长正文、覆盖不足、证据去重、AI请求绑定、承诺历史、周报持久化和定时防重叠。真实公司登录、真实员工样本及原生 CodeAgent 语义质量仍须公司侧验收，不以替身测试冒充真实完成。
