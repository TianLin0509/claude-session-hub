# DEPLOY_NOTE 2026-06-16 · LT 投研场景：research 职责帽工具行 + 禁用词铁律

## 背景
群聊讨论结论：不重建投委会，把投委会的"后台精华"轻量缝进现有 research 职责帽（前台）。本次落地 **P0（帽子双补丁）**；P1（`/体检`）、P2（`/记一笔`）留后续。

## 本次改动（仅 5 处，均为纯 prompt/文本，无结构/逻辑改动）
1. **`core/group-chat-orchestrator.js`**（+2 行，干净独占）
   - 顶层 `require('./committee-scene.js')` 复用 `BANNED_PHRASES`
   - `RESEARCH_SCENE_PROMPT` 末尾加「反空话铁律」（禁用词与投委会**同源**，不另造一份）
2. **`renderer/meeting-room.js`**（仅 `_DUTY_HATS_BY_SCENE.research` 6 顶帽子 duty 各加一句祈使句工具行；**行 838–878 区域**）
   - 数据核验员→`stock_static` ／ 空头→`stock_static`+`stock_news` ／ 多头→`stock_static`+`stock_news` ／ 催化→`stock_news` ／ 技术→`stock_market` ／ 裁判→不另调(以基线为锚)
   - 与 `RESEARCH_SCENE_PROMPT` 既有性能约束一致（帽子决定工具入口，避免同轮批量调用触发 120s 超时）
3. **`package.json`**：version `1.5.3`→`1.5.4`（干净独占）
4. **`renderer/index.html`**：`launcher-version` `v1.5.3`→`v1.5.4`（干净独占）
5. **`tests/unit-research-duty-hats-contract.test.js`**（新增）

## 测试
- 新单测 **PASS**：
  - Part A 真 require 执行：`buildSystemPromptText('x','research')` 输出含「反空话铁律」且禁用词与 committee `BANNED_PHRASES` 同源；`general` 场景不被污染（隔离验证）
  - Part B 源码契约：6 帽子 duty 工具行绑定正确，原 label/结构未破坏
- 两个 **pre-existing 失败，与本次无关（已坐实）**：
  - `unit-group-chat-manual-sync-contract`：断言 `dispatcher.js`；该文件未改、HEAD 状态下断言串格式即不匹配
  - `unit-group-chat-copy-action`：断言 `_renderGroupChatMessage` 含 `mr-gc-bubble-row`；HEAD 状态下即为 false

## ⚠️ 并发冲突警告（重要）
检测到本仓库工作区有**兄弟会话的未提交改动**（非本次 LT 任务）：
- `renderer/meeting-room.js` 混入 **2041 / 2189 区域**改动（+38 行，疑似 UI 优化，与 copy-action 测试相关）
- 其他 M：`core/{claude,codex}-transcript-parser.js`、`core/session-manager.js`、`core/committee-scene.js`、`main/groupchat/committee-conductor.js` + 多个 test
- 其他 ??：`DEPLOY_NOTE-20260614-ui-optimizations.md`、`core/synthetic-user-filter.js` 等

→ 按 CLAUDE.md「并发会话冲突」铁律：**本会话未 commit、未 push、未改任何兄弟会话文件、未重启生产 Hub。**

## 交付状态
- 代码改动**已落地工作区**（重启 Hub 后生效）
- commit / push **暂缓**，交用户裁决（见下）

## 安全提交建议（工作区收敛后）
- 干净独占、可直接 `git add`：`core/group-chat-orchestrator.js`、`package.json`、`renderer/index.html`、`tests/unit-research-duty-hats-contract.test.js`
- `renderer/meeting-room.js` 为混合文件：**仅 838–878 区域 6 个 duty 行**是本次改动，2041/2189 属兄弟会话 → 需 `git add -p` 或协调后分别提交

## review 修正（2026-06-16，基于 Codex/DeepSeek 群聊审查，已读 `core/research-mcp-server.js` 核实，非盲信）
- **技术分析师**：删除 `stock_market` 已下线能力「龙虎榜/北向」（该工具 2026-06-06 瘦身下线，描述明示 dragon-tiger/northbound 已死）；角色描述+工具行改为 K线/RSI/MACD/资金流/融资融券/实时盘口；新增「问历史形态时调 `kline_similarity`」（条件触发，因其冷启动 ~30s）。
- **消息催化帽**：情绪/社区观点从 `stock_news` 分流到 `stock_sentiment`（stock_news 仅公告/新闻/快讯，情绪在专门 sentiment 工具）；改为「优先 stock_news；问情绪/争议/V大观点再调 stock_sentiment」。
- **空头审稿人**：补证据分级（strong/medium/weak），与多头对称；weak 级不能单独作为「建议打回」理由。
- **测试**：新增 3 类断言锁口径——research 帽子不得含「龙虎榜/北向」、催化帽必须提 stock_sentiment 且情绪不归 stock_news、技术帽必须提 kline_similarity。**全测 PASS（exit 0）**。
- 受影响文件仍只有 `renderer/meeting-room.js`（research 帽子区域）+ 测试，未扩散。

## 生效
prompt 在 Hub 启动时加载，改动需**重启 Hub** 生效。本会话遵守「禁止操作生产 Electron 进程」，未重启、未启动测试 Hub（避免在污染工作区上跑混合代码）。
