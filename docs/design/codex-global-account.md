# Codex 全局额度账号

用户常在一个账号额度用完后切到另一个。启动中心选择 Codex 订阅账号即修改全局默认，取消新建不撤销选择；不再为普通会话、群聊成员或旧会话保留固定额度账号。

## 行为

- 新建使用当前全局账号。旧卡片恢复、重启、下一次发送均核对当前选择。
- 已打开且空闲的会话立即切换；正在回答或等待审批的会话继续当前轮次，结束后切换。继续当前轮次的 steer 仍属于原账号，不在中途截断模型输出。
- 上次提交结果不明时不强行切换，不自动重发。先通过原生历史核对提交，再切换；错误显示在原会话。
- 失败不回退旧账号或其他账号，不创建空会话替代已有历史。仅刚创建且确证从未提交、没有历史的空壳可重建原生 ID，保留 Hub 卡片。
- API、DeepSeek API 和 ChatGPT 网页桥接使用各自授权配置，不参与 Codex 订阅额度切换。
- 账号必须预先在账号中心登录。本功能选择现有账号，不复制 auth.json，不保证供应商登录永久有效，不依据配置文件存在宣称登录有效。

## 历史与授权分离

`CODEX_HOME` 指向当前全局账号，凭据与刷新仍交给原生 Codex。原会话 `transcriptPath`、`codexSessionsRoot` 保持原位置；新进程用 `thread/resume` 的 `path` 加载原始 rollout，校验文件内身份与返回的 native ID。该 path 字段目前是实验接口；本机真实 Codex 验证通过，版本不支持时明确失败，不隐式降级。

分页历史还依赖原位置的 SQLite 状态与历史索引。只传 JSONL 路径、却把 SQLite 目录跟随账号切走，会在真实 Codex 0.153.4 返回 `no rollout found for thread id`；旧格式合成历史不能覆盖这个故障。现在首次绑定通过原生 `config/read` 解析历史所属 home 的 `sqlite_home`（兼容环境变量与默认目录），记录在 `nativeRuntime.sqliteHome`；账号切换、休眠恢复和 Hub 重启都保留它。进程同时设置 `CODEX_SQLITE_HOME` 和命令行 `sqlite_home`，避免新账号自身配置覆盖原历史目录。新建空会话跟随新账号重新绑定。没有复制凭据或数据库，也没有新建线程替代原会话。

原生连接失败时，聊天卡片可读取已经绑定且会话 ID 校验通过的本地历史。运行状态仍显示断开，不把历史展示当成恢复成功，也不自动重发消息。

切换前必须等待旧 App Server 子进程真正退出。Hub 卡片归属和 native writer 租约都仍使用历史所属 home，避免账号切换绕开原生单 writer 约束；换账号不改变已有对话 native ID。新分支读取源历史，在新账号目录创建自己的历史和租约。

配置写入只替换 `providers.codex.subscription_profile`，保留其他配置。`HUB_CODEX_PROFILE` 若固定了不同账号，明确拒绝切换。启动中心异步模型目录按账号隔离，旧响应不得覆盖新账号目录。

当前窗口的空闲会话立即跟随切换。其他同版本 Hub 窗口在下一次新建、发送、恢复或轮次结束时严格重读账号选择，避免进程配置缓存继续使用旧额度；不启动周期登录检查。已经运行的旧版本 Hub 需要用户自行正常退出并打开新版本才能获得此逻辑，不由实现脚本重启生产窗口。

## 验证

- `node --test tests/unit-codex-global-account.test.js tests/unit-codex-native-options.test.js`：配置保留、无效账号、单 writer、旧历史、发送去重、忙碌延后、未知提交和缺失历史。
- `node tests/e2e-codex-global-account-cdp.js`：真实隔离 Electron 与真实选择控件；原生进程使用协议夹具，核对当前/休眠/重启/新建会话及完整 Hub 重启。
- `node tests/manual-codex-cross-home-resume.js`：真实本机 Codex，两个隔离 home 与合成历史，不读取个人凭据、不发送模型请求，确认相同 native ID、路径与历史跨 home 恢复。
- `node tests/manual-codex-paginated-account-resume.js`：真实本机 Codex 与合成分页记录、SQLite 索引，先复现旧启动方式的错误，再验证默认/自定义数据库目录下 B/A/B 往返、重启、相同 native ID、已保存消息和旧 writer 退出；不发送模型请求。
- `node scripts/run_unit_tests.js`：项目完整单测。

这些测试不代表两份真实订阅均已成功扣费；账号到期、网络和额度由供应商响应决定。
