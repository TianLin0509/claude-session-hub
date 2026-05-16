# AI 群聊 Hub

AI 群聊 Hub 是一个本地 Electron 工作台，用来同时管理多个 AI CLI 会话，并把多位 AI 成员组织到同一个群聊房间里协作。

## 当前定位

- **AI 群聊**：主功能。一个房间可包含多位 AI 成员，成员能看到新增上下文并互相回应。
- **单聊会话**：保留 Claude / Gemini / Codex / DeepSeek / GLM / 千问等单会话入口。
- **场景选择**：群聊创建时可选择通用、投研、开发，用于给群聊成员补充轻量场景约束。
- **隔离工作区**：群聊子会话默认进入独立 workspace，避免污染用户主目录。

## 本地运行

```powershell
cd C:\Users\lintian\claude-session-hub
npm start
```

## 常用验证

```powershell
node --check main.js
node --check renderer\meeting-room.js
node tests\unit-group-chat-orchestrator.test.js
node tests\meeting-create-modal-static.test.js
```

## 目录

- `main.js`：Electron 主进程、IPC、会话创建和群聊调度入口。
- `core/group-chat-orchestrator.js`：群聊消息状态、delta prompt、原文索引。
- `renderer/meeting-room.js`：群聊房间 UI 和卡片更新逻辑。
- `renderer/meeting-create-modal.js`：群聊创建弹窗。
- `tests/`：当前保留的群聊、会话、渲染和 CLI 集成相关测试。
