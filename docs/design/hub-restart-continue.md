# 重启并继续任务

用户允许当前任务中断，要求升级后一次操作恢复原会话并继续未完成的工作。入口为左侧底部的环形箭头按钮「重启并继续任务」。首次升级到包含此功能的版本，旧窗口仍需普通重启一次；之后源码目录更新后可用此按钮加载新版。

## 用户行为

- 保存已打开会话、草稿、模型设置及当前视图，停止任务和原生 writer，退出旧 Hub，再启动同一程序目录的新 Hub。
- 恢复原来的 Hub session ID 和 provider 原生身份。工作中的原生会话收到一条续作提示，明确先核对工具和文件结果，避免从头重做。空闲会话只恢复；历史休眠会话保持休眠。
- 待审批、待回答、原提交结果未知的会话不自动发送，面板提示核对。没有可靠恢复身份的提供方也明确列出，不新建一个空会话冒充恢复成功。
- 普通群聊只向原来工作中的成员续作；串行/循环工作流恢复检查点；文件工作流重新读取交付文件，选择实际阶段的执行成员，已完成阶段不重派。
- 原生回执确认后才显示续作成功。恢复失败可逐项重试；已发送但结果不明的提交不会自动重发。

## Agent 覆盖

| 入口 | 当前接入 | 续作确认 |
| --- | --- | --- |
| Codex | App Server | 结构化提交回执 |
| Claude、历史 DeepSeek Claude 会话 | stream-json | 结构化提交回执 |
| 千问、DeepSeek 原生、智谱 | ACP | 结构化提交回执；停止后等待终态及实际进程退出 |
| DeepSeek 普通入口 | Codex PTY | 原生 rollout 中当前提交的完整用户消息 |
| Kimi | Kimi PTY | wire 中当前提交的 turn.prompt |
| Gemini | Gemini PTY | 当前会话 JSONL/JSON 中完整用户消息，含 `$set.messages` 与文本片段数组 |

终端提供方在 Main 通过当前绑定的新消息/完成事件记录工作状态；历史回放、空闲计时和终端重绘不能证明新提交成功。恢复前使用真实 CLI 家族判断输入框就绪；发送正文一次，体积自适应等待后提交，仅在未确认时允许一次有界补 Enter，不重贴正文。UI 已知的等待输入状态可以否决自动续作。未知或不兼容的原生记录格式保留待核对状态，不虚报成功。

这是中断后基于原有上下文续作，不是把模型内部计算状态冻结后恢复。仅保存和恢复会话本身不能证明任意外部工具操作恰好执行一次，所以提示词要求先核对最后一步；Hub 保证不重放原 prompt、不重复发送已记录的续作。

## 实现和屏障

`core/hub-restart.js` 管理持久化清单，`main/ipc/hub-restart-handlers.js` 对接现有原生会话、工作流及退出流程；renderer 控制按钮和进度面板。

1. renderer 刷新草稿和现场保存后，Main 在 `Hub 数据目录/restart/<token>.json` 原子写入清单，才允许中断。
2. 冻结新派工，停止文件扫描和工作流，先 interrupt，再走已有 `disposeGracefully`，最终保存和原生 writer 退出完成后才能 relaunch。历史索引子进程、ACP 进程和 node-pty 的 ConPTY 输出 worker 也必须确认 exit；kill 请求与 PTY socket 关闭均不算全部退出。
3. 退出前严格保存 `state.json`，将清单标记为 ready，通过 `--hub-restart=<token>` 交给新的进程。普通启动不扫描并重放历史重启清单。
4. 新进程等旧 PID 退出、按原独占规则取得归属，严格读取最新 per-session 文件并验证原生身份；失败项不影响其他会话恢复。
5. 发送前持久化 dispatching，成功后记录 continued。掉电或回执丢失留下 dispatching 时转为 uncertain，不再猜测性补发。已完成清单重复读取不会重派。
6. 重启启动期间关闭原有启动扫描，避免与重启协调器双重派工。文件工作流恢复后扫描限定在恢复的任务及此后用户亲自开启的任务。
7. 退出失败保留初次快照；重试重启沿用原工作集，避免停止部分 writer 后把空列表当成原工作现场。
8. 恢复进程崩溃后，再次使用同一 token 会重新打开原会话；已经提交或可能提交的续作保留待核对，绝不自动重发。即使重新打开失败、用户随后重试，也保留提交痕迹。
9. Gemini 模型元数据只从状态栏识别，启动命令的分块回显不得覆盖已选模型，否则重启可能使用一个截断的模型名。

持久化文件只在显式重启和恢复进度变化时写入，没有新增常驻逐会话轮询。

## 验证

- `node --test tests/unit-hub-restart.test.js tests/unit-hub-restart-fileflow.test.js tests/unit-loop-engine.test.js`：原生身份、工作集、完成竞态、回执去重、失败重试、文件交接和最后一轮续作。
- `node --test tests/unit-session-search-service.test.js tests/unit-session-auto-suspend.test.js`：子进程实际退出屏障及现有关机契约。
- `node --test tests/unit-hub-restart-legacy.test.js tests/unit-agent-usage-parser-contract.test.js`：当前绑定、完整消息回执、超时、实际进程退出、CLI 就绪家族、群聊回执、模型回显污染。
- `node tests/e2e-hub-restart-continue-cdp.js`：真实隔离 Electron 窗口和按钮点击、实际 app.relaunch，15 个已打开会话、2 个群聊；覆盖全部 8 类 Agent，逐项核对原生身份、设置及原指令/续作次数，同时验证草稿、审批、休眠和文件交接。ACP 模拟延迟停止回执，3 类终端经真实 Windows PTY 运行测试 CLI；不调用真实模型网络。历史 DeepSeek Claude 路径共用 stream-json 实现，未另做真实云端验证。
- `node scripts/run_unit_tests.js --strict --jobs 4`：完整单测入口。

端到端证据写入 `artifacts/hub-restart/<timestamp>/`。测试只使用隔离数据目录、home、provider 配置和 CDP 端口，仅关闭测试 PID。
