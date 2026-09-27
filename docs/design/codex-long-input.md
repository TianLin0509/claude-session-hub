# Windows Codex 长文本输入

2026-09-27。真实 Codex 0.153.4 / 0.157.1 的隔离实验表明：PTY 写入调用 0–1ms 即返回，但几千到几万字符经 Windows 按键链路接收、绘制要数秒。原生外部编辑器回填可一次导入完整文本。PTY 继续运行原生 TUI；不是换成 App Server，也不是把文件路径作为 prompt 让模型另读。

## 输入契约

- Windows Codex PTY 中，正文达到 2048 个 UTF-16 单元且不是斜杠命令、没有显式附件时，使用原生 Ctrl+G 编辑器入口。短文本和其它 provider 保留原路径。
- 配置文件出现自定义 keymap 时保留原有输入路径，避免猜测或覆盖快捷键；`HUB_CODEX_EDITOR_INPUT=0` 可在启动环境中关闭此路径。桥接初始化失败会记录诊断，保留 PTY 输入。
- VISUAL 仅在此会话的子进程环境内包装，不修改 Codex 或用户全局配置。没有待处理交接时，手动 Ctrl+G 调用用户原 VISUAL / EDITOR；不存在原编辑器时明确提示。
- 每个会话使用单独随机目录。交接含请求 ID、正文哈希和截止时间；helper 原子认领、写入 Codex 创建的临时编辑文件、读回校验，并留下只含 ID / 哈希的回执。正文不进入诊断日志。
- Codex 从编辑器返回时会清空输入事件，因此文件写好不代表可以发 Enter。Hub 同时等待匹配回执，以及原始 PTY 的 bracketed-paste 关闭/开启后首个同步重绘结束。该屏幕信号只确认“可继续输入”，不证明模型任务已开始。
- 回填确认后继续使用原有提交回执、语义开始确认与有界恢复流程；用户轮次必须完整且唯一。原生编辑器会按 Codex 本身的规则 trim_end，提交规范化仍由原有回执链路处理。
- 交接失败不发 Enter、不自动改用逐字粘贴；UI 恢复原文。该桥接在本会话剩余生命周期中停用并明确要求重开会话，避免迟到的 Ctrl+G 消费下一条草稿。
- CLI 输入框已有图片时，helper 拒绝替换原生草稿，避免图片附件丢失；显式附件沿原路径。每条交接完成/失败即清理正文文件，关闭会话释放会话目录；清理错误有日志且不得打断 PTY 退出处理。

## 验证

- `node --test tests/unit-codex-editor-input.test.js`：Unicode、换行、协议分片、双确认、超时、迟到回执、并发、损坏正文、图片草稿、关闭释放、自定义键位、原编辑器委派和退出失败。
- 设置 `FIDELITY_EDITOR_TESTS=1`，运行 `node tests/e2e-codex-cli-fidelity-cdp.js`：真实 Hub 输入框、原编辑器 Ctrl+G、6千/2万多字符多行文本、原生正文和唯一轮次、diff、编辑器故障后 UI 草稿恢复且不提交。不设置该开关时覆盖普通输入及原生 /status。旧版通过 `FIDELITY_CODEX_EXE` / `FIDELITY_LEGACY_CLI=1` 选择。
- `node scripts/run_unit_tests.js`：全量回归；合并入口绑定最终完整 SHA，再验证与最新主干集成后的同一代码树。

实现根据官方 `app/input.rs::launch_external_editor` 与 `tui.rs::with_restored` 的恢复顺序设计。未宣称所有终端/所有 Codex 版本支持该回填入口；新版本若无法确认恢复协议，按未提交处理而不盲发。
