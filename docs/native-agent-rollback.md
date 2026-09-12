# 原生会话迁移的回退合同

回退必须保留新数据，并明确使用哪一个读取器。旧版 Hub 不认识新版原生 journal 和草稿格式；仅启动旧代码不能保证旧界面显示全部新内容。只读恢复副本负责补齐这一读取边界，它不是另一条发送通道。

## 执行顺序

1. 暂停受影响的新派发，记录实际发布 SHA、旧版 SHA、Hub PID、数据目录、CODEX_HOME / CLAUDE_CONFIG_DIR。逐条核对在途提交。断线只能记为未知；不能把未知标成未发送或成功。执行代码回退的合并/运维位负责此步骤，实现位不得关闭生产 Hub。
2. 在当前版仍能读取时，按 Hub session ID 调用 `get-sessions`、`parse-session-transcript` 和 `native-draft:read`，导出以下 JSON。接口均为只读；草稿必须取 Main 的保存记录。界面仍显示保存错误或未保存时，先保留编辑框的完整文本，不能声称 Main 已保存。保存原始导出，再生成独立 HTML，回读原始记录确认内容与身份一致。
3. 由负责回退的人正常关闭该实例，确认其所属引擎退出、写入权释放后，对 Hub 整个数据目录以及对应引擎历史目录做完整快照。包括 state、群聊/阶段账本、`native-agent-submissions`、`native-input-drafts.sqlite` 和存在的 WAL/SHM；Claude `projects`、Codex `sessions` / `archived_sessions` 及历史索引不能遗漏。快照保留在访问权限受控的本机目录，不提交账号配置或认证文件。不要在 writer 活跃时只复制一个 SQLite 主文件。
4. 启动记录过 SHA 的旧代码，保留新格式文件。旧版原有历史由旧读取器显示；新版回答、草稿、后台记录和提交身份由只读 HTML/JSON 核对。需要继续的新消息由人明确另行发送；历史与未知提交不批量重发。旧版仍有 PTY 投喂风险，不作为自动降级或容灾路径。
5. 再升级时读取保留的数据，核对同一引擎 ID、每条历史 ID/正文、草稿 revision 和未确认记录。恢复本身不得新增模型请求。核对无误才恢复派发；出现差异保留现场及快照，不覆盖新数据解决冲突。

## 恢复副本格式与入口

`parse-session-transcript` 参数为 `{ hubSessionId: session.id }`；`native-draft:read` 参数为 `{ sessionId: session.id }`。前者返回 `turns`，后者返回 `record.text/revision`。引擎身份取当前原生快照的 `threadId`（Codex）或会话 `ccSessionId`（Claude），不得凭目录名猜测。完整快照另存；下面展示最小导出格式，可增加 runtime、草稿 revision、后台任务、协议版本等字段，它们都会原样留在 HTML 的完整记录区。

```json
{
  "sessionId": "准确的 Hub 会话 ID",
  "providerId": "准确的引擎会话或 thread ID",
  "submission": { "原始提交身份字段": "原样保存" },
  "turns": [{ "id": "原始消息 ID", "role": "assistant", "text": "完整正文" }],
  "unsentDraft": "Main 已保存的完整未发送草稿"
}
```

```powershell
node scripts/render-native-recovery.js C:\Recovery\session.json C:\Recovery\session.html
```

输出必须是尚不存在的新文件。命令严格按 UTF-8 读取，拒绝缺少会话身份、历史或草稿的输入，不覆盖已有文件，不写 Hub 或引擎。HTML 不依赖网络、没有脚本/表单/发送按钮，所有历史内容按文本转义。它提供读取能力，不能恢复引擎未持久化的未知结果。

## 可执行隔离演练

```powershell
node --test tests/unit-native-recovery-report.test.js
node tests/e2e-claude-native-migration-cdp.js --rollback
node tests/e2e-codex-native-migration-cdp.js --rollback
```

两项 GUI 演练使用冻结的 `8c5c6928181565c541943c5dc1941bac049e53c0` 旧代码，目录为 `artifacts/native-agent/baseline-8c5c6928`。旧版与新版均是真实隔离 Hub；不能用生产数据演练。Claude 历史/协议为受控样本，Codex 使用已安装 CLI 和本地模型服务；均不代表成功的真实模型验收。

检查旧 writer 未释放时不双写；新回答与新草稿形成后，实际回到旧版、打开只读副本，再升级核对精确身份、文本和草稿版本。Codex 还核对模型服务请求数没有增长。`rollbackOldComposerCompatible=false` 仍如实保留；`rollbackGatePassed` 只表示包含只读副本的显式回退方案通过，不表示旧界面已支持新格式，也不代替发布位的实际快照及独立验收。
