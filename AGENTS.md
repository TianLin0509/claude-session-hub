# AI Hub 项目规则

Claude 经 `CLAUDE.md` 的 `@AGENTS.md` 导入本文件；Codex / Kimi 等直接读取。个人规则由全局原生入口加载，此处仅列项目边界。专项操作按任务读取 [docs/agent-operations.md](docs/agent-operations.md) 对应章节；事故背景见 `docs/agent-rules-background.md`。

## 开发、依赖与合入

- `C:/Users/lintian/claude-session-hub` 是生产目录，只有 `master` 主干。实现先开 `C:/AIWork/YYYYMMDD-<任务>-<席位>` 的独立 worktree；席位必带。保留其他人的未提交改动，按路径提交，不在主目录提交功能开发。
- 日常 worktree 的 `node_modules` junction 指向生产；禁止安装、裁剪、打包或删改依赖。动依赖须用户同意并用独立依赖目录。清理先仅摘 junction、核验链接消失，再清目录；不用强制 worktree 删除或递归穿透链接。依赖缺失、EBUSY、smoke、打包按操作手册「node_modules 完整性」。
- 不关闭、重启或 kill 生产 Hub，不改生产 state/config。开发合同见 `.agents/AUTHOR.md`，独立审核与合并见 `.agents/MERGER.md`、`.agents/project.json`。用户已授权合入或双席位开题范围内独立合并时，按项目入口执行；其他情形先报告、取得合入授权。
- 分支不改版本：`scripts/merge_task.py` 在合并时抬 patch、同步 package 与 lock、跑全量测试。minor/major 须同意；窗口标题 PID 与版本用于辨认实际实例。fixture 里的版本字面量保持原样。

## 验证

- 先读需求与设计；Bug 先复现、日志与调用链定位再窄改。语法改动至少 check/相关单测，UI 行为用隔离实例 CDP/Playwright 真实操作；IPC 仅作为后端验证。最终报告实际命令、结果与未覆盖范围。
- 隔离实例用 `tests/helpers/hub-launcher.js`（默认后台、不抢焦点、内存剪贴板），独立 `CLAUDE_HUB_DATA_DIR` 与 CDP 端口；只设数据 env，不额外传 `--user-data-dir`，不用安装器或 npx 启动。CLI 嵌套环境剥离、记忆/梦境额外 home 与密钥隔离、剪贴板例外，读取手册「隔离测试」。真实 Claude 测试优先 Haiku；长时测试降低优先级，合并闸门按正常优先级。
- 每项 CLI 能力平等覆盖 Claude / Codex / Gemini / Kimi；声称不支持前核对原生能力缓存/无请求探测。Codex effort 按 `core/codex-model-catalog.js`，速度档按 `core/codex-speed-tier.js`；不凭旧模型经验加参数。

## CLI、群聊与会话归属

- Claude / Codex 默认真实 PTY/TUI。状态以 CLI hook 为权威、精确 native id + transcript path 绑定，屏幕识别仅能推向运行/等待。原生后端是保留的回退开关，未知提交先核对历史，避免自动重发。设计：`docs/design/cli-pty-core.md`。
- 发 prompt 走 `session:send-prompt` 或 `groupChatWatcher.sendToPty`；`terminal-input` 仅真实按键/短 shell 命令。保持 `core/pty-prompt-submit.js` 分块→settle→语义确认→有界补回车闭环，禁固定延时/文本与回车一次写入；拿不到确认报 stuck，补发仍走同一入口。改链路先读 `tests/unit-prompt-submit-ui-contract.test.js` 和手册对应章。新增输出匹配须真实样本，避免空白尾巴判完成。
- 单会话卡片读原生落盘；群聊卡片读 `task-docs/<群>/answers/turn-<n>/<成员>/回答.md`，工作流读该步交付。草稿标草稿，异常看成员状态；文件更新随时生效。旧 transcript 协议仅作兼容逃生入口。设计：`docs/design/group-answer-files.md`。
- 同一原生 session 同时仅一个 Hub writer；关闭先保存、停 writer 再释放，其他 Hub 从最新记录恢复。未打开历史入口不订阅/监听/回写，窗口关闭不驻托盘；保留事务锁与定时去重。设计：`docs/design/session-exclusive-ownership.md`。

## UI、记忆与专项入口

- 会话/群聊/成员进入默认卡片，主动点击后台才显示 CLI，PowerShell 直接终端。PTY→main→renderer→xterm 单写入；重复显示先查 TUI 重绘/resize/reopen。修改 resize、splitter、zoom 等先看手册「UI 与终端风险区」。
- 记忆加载证据区分磁盘存在、预计加载、已发送、正文已读；Claude InstructionsLoaded 仅路径，Codex 从绑定 rollout 提取。临时目录不默认复制规则/git init，祖先规则随真实消息送达留回执，全局规则差异只提示。
- 造梦用实体 session，原生 MEMORY/规则只读，产物仅写 Hub 数据目录，校验后发布再推进游标；梦境索引仅随用户亲手发消息送达，压缩后补发，自动派发不带。昨日之我只索引自然语言，工具只留短元信息；造梦/搜索/库迁移/旧兼容任务读取手册「记忆与昨日之我」和 `docs/design/memory-mvp.md`。
- 浏览器代理/网络任务读 `docs/browser-network-rules.md`；节点延时、下载、真实网页分别取证。任务栏图标任务读手册「任务栏图标」：只改品牌副本，永不改 electron.exe 本体。
