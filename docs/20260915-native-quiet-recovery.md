# 原生会话取消手动核对提醒

用户要求：不再显示“待核对消息 UUID / 我已核对 / 复制为新草稿”这类内部恢复面板，同时维持普通会话与群聊功能。

- Claude、Codex 的手动提交核对面板移除；原生输入框不再重复显示核对横条。连接状态保留在现有状态行，工具审批、问题和实际发送失败仍正常显示。
- 用户通过普通输入框发送新消息时，Main 串行恢复连接，再派发这条新消息。没有新发送操作时，不因未知状态或超时重启仍在工作的进程。
- Claude 必须先等旧 writer 退出，再恢复同一原生身份并只读检查历史。旧记录以 `source: hub / do-not-replay` 保存恢复决定，保留 `unknown`，不伪造完成事件、不自动重发；记录中的历史证据只表示收到与否，不表示任务成功。
- Codex 先读取同一线程，以当前 epoch/revision 的原生快照确认空闲或终态。历史中的消息身份或正文冲突、仍在运行的未知轮次均不能自动放行。
- 新消息尚未发送就恢复失败时，输入草稿恢复；不覆盖用户新写的草稿。旧进程无法关闭、历史损坏、持久化失败及会话身份变化都会阻止发送并返回实际失败。
- 自动群聊派发不调用此恢复入口，保留未知 attempt、暂停与禁止自动重试规则；恢复普通输入不会把群聊旧任务改成成功。

验证入口：`node --test tests/unit-native-quiet-recovery.test.js`、`node tests/e2e-claude-native-cdp.js --mode=recovery`、`node tests/e2e-native-quiet-recovery-cdp.js`，以及两家 provider 的 `e2e-native-consumer-matrix-cdp.js` 群聊断线和审批场景。GUI 使用独立 Electron、数据/home/CDP 与协议 fixture，不代表真实供应商服务的稳定性测试。

本次实现分支不升版本、不改生产数据；合并仍由项目入口统一处理。
