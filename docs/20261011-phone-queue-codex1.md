# 手机拍题排队故障 · 2026-10-11 · 修复候选

## 生产证据（只读）

- 用户 11:55 拍题请求 `400cee7c-6d3f-4862-9bbb-f5b5223e501b` 已入手机收件箱，状态 `queued`，没有 dispatch 时间、sessionId 或助理 action 记录。
- JPEG 已保存至 `D:\AIWork\20261011-手机分享\115509-capture-400cee7c-6d3f-4862-9bbb-f5b5223e501b.jpg`，1,356,882 字节，实际打开可正常解码；画面倾斜且文字较模糊。这不影响队列故障判断，但影响后续解题质量。
- 生产只读 IPC：助理 `idle`、`submissionPending=false`、手机 `connected=true`、`pending=1`、`unknown=1`、无通道错误。
- 队首旧请求 `0bdb48fd-f32f-4600-a2b4-f41a76121a07` 于 10 月 5 日提交到旧助理会话 `7cd209c1-d197-469a-a82d-3f9a6c0261be`，一直为 `unknown`。
- 该旧会话精确绑定的 Claude 原生记录中存在原问题和已结束的回答；助理上下文闭合标签后有 `1~` 残留。现有严格解析器拒绝该额外尾部，故对应回答的 clientSubmissionId 为 null。这解释了后续核对为什么没有消除未知状态；最初的回执为何缺失没有进一步断言。
- `PhoneChannel` 把 unknown 永久纳入 ACTIVE，只要存在就不派发下一条；该规则来自 `c440ef47`（2026-10-03）。截图中的“正在回答”只依据最近用户消息没有回答，未依据真实发送状态。

## 修复及保留行为

- 超过 30 分钟且原会话确实空闲的未知请求，保留为 `unresolved` 待核对，但释放后续队列；不重发、不宣称失败或完成、不修改历史原文。
- 正在运行、等待用户、提交仍待确认的会话继续等待；没有忙闲查询能力时不贸然释放。
- 已释放请求仍接受精确编号或原生 turnId 对应的迟到回答；每轮最多额外核对一条，避免历史条目集中扫描。
- 修正忙闲查询：直接查询已打开的会话，避免业务会话列表排除助理自身后误判助理空闲。
- 手机送达状态写入对话记录。界面区分“已到电脑，等待助理接收”和“送达尚未确认”，不再将无回答推断为正在运行。
- 保留配对、照片附件、现有语音、快答、模型切换、朗读和去重功能。没有修改 APK、生产队列、生产配置或生产进程。

## 验证

- 修改前新增行为断言：46 项中 3 项失败，复现旧 unknown 阻塞、迟到回执关联以及助理自身忙闲误判。
- 修改后相关测试：65/65 通过。
  `node --test tests/unit-phone-channel.test.js tests/unit-assistant-backends.test.js tests/unit-phone-journal.test.js tests/unit-phone-native-correlation.test.js tests/unit-assistant-workbench.test.js`
- 真实隔离 Hub 界面：`node scripts/20261011-phone-queue-ui-codex1.js`，排队、未知回执、回答后停止等待三项通过；对话使用合成数据，没有模型调用。截图已实际打开检查。
- 首次全量 730/732 文件通过；两项 Git 钩子测试因 `spawnSync('sh')` 返回 ENOENT 未启动。已确认 Git 自带 `sh.exe` 存在，仅为当前终端 PATH 缺失。首次失败日志保留为 `artifacts/20261011-phone-queue-codex1/20261011-full-unit-codex1.log`，不将其当成通过。
- 补充本轮测试进程 PATH 后的全量结果见 `artifacts/20261011-phone-queue-codex1/20261011-full-unit-with-git-path-codex1.log`。

## 启用边界与验收

修复在独立分支 `fix/phone-unknown-queue-20261011`，未合入、未推送、未替用户重启 Hub。主干版本由合并入口统一更新。

用户授权正式合入后，通过 `scripts/merge_task.py` 执行项目闸门。用户自行重启 Hub 后，旧未知请求应退出队首，已收到的照片应自动继续派发，无须重拍或再发同一条。再看手机是否收到回答并朗读；这是尚待真机确认的部分。
