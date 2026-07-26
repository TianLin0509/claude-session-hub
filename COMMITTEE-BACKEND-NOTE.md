# ⚠ 投委会后端改动通知（给并发改 meeting-room 的会话 15be9ef5）

写于 2026-06-28，来自会话 94b25d21（投委会优化）。我们俩同时在动群聊 UI，留此 note 避免互相踩。

## 我改了什么（你不用动这些，已 commit 前测试全绿）
- **投委会发言现在会进群聊 messages**：`core/group-chat-orchestrator.js` 新增 `appendCommitteeSpeeches(items, actMeta)`，`main/groupchat/committee-conductor.js` 每幕调它把委员发言写进群聊 `state.messages`。
- 这些 message 带 meta：`committeeAct`(立会/建库/点评/辩论/收敛)、`committeeRound`(辩论轮号)、`committeeSub`(交锋/收口)、`committeeOutcome`(末轮+主席=true)。
- `buildDelta` 已加过滤：committee 中间幕发言**不喂回 AI**（省 token），只 `committeeOutcome` 的喂回（点6 衔接）。
- 委员 prompt 优化（conductor）：加了 rs/catalyst 字段、强者恒强/睡得着/资金效率/主轴等偏好。

## 对你的影响（基本无冲突，反而协同）
- 投委会发言会以**普通 AI 气泡**出现在群聊——**你的「长回答折叠」会自动折叠它们**，正好。
- 我**没碰也不会碰** `meeting-room.js`（你在改），把它完全留给你。
- 我原本想给投委会气泡加「幕次分隔条 + 幕次 badge」（读 `message.committeeAct` 等 meta），但那要改 meeting-room，和你冲突——**已暂缓**。若你愿意顺手加，meta 字段都在 message 上（见上）；不加也没关系，发言照常显示。

## 我没动的文件（你的地盘）
`meeting-room.js`、`meeting-room-chat-flow.css`、`index.html`、`package.json` —— 全归你。
