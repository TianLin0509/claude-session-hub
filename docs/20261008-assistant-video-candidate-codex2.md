# 2026-10-08 助理视频学习候选 · Codex 2

目的：四个用户纠正落实到原生 App；由 Claude 独立审查、优化、合入和发布。本分支不发布。

- 视觉：AI Hub hub 浅色主题同源 tokens，统一浅灰紫画布、白面板、细边框、紫色强调。学习改视频图标和视频卡片；旧音频入口及锁屏播放器保留。
- 计划：归纳 2–4 条有目标的工作方向，同项目操作合并；真实约定保留时间；待用户确认。业务完成不由运行状态猜测。
- 兴趣：复用只读 SQLite 自然语言索引，最近 168 小时，直接筛选 user scope；避免长篇 Agent 回复挤走用户原话。排除助理自己的原生身份；30k 字预算，缺失如实说明。不执行材料旧请求。
- 视频：同一份 3000–6500 字完整稿 + 4–16 章机制图，重用既有 TTS，sharp 绘制分步因果图，FFmpeg 本机产 MP4。相对章节篇幅分配时间；并非逐字字幕对齐，也未复刻 Vibe 全套视觉。失败有原因与保留稿件。
- 新手机能力：session_cards、learning_video；旧客户端不自动取数。点击会话只读加载，默认 6 卡，before 游标加载更早，当前来源覆盖范围可见。原生通道优先；PTY 回退精确绑定最终回复，不伪造整段历史。
- MP4：192 KiB 分片，通过已有加密中继；有序追加、断点继续、整文件 SHA-256 校验后原子保存，完整才播放；本地保留观看位置，支持横屏全屏。

验证入口：新增 unit-assistant-learning-video；unit-phone-workbench；unit-hub-assistant-history；unit-phone-channel；项目全量入口 scripts/run_unit_tests.js。
安卓：gradlew :app:assembleRelease :app:lintRelease :driver:assembleRelease -PassistantVersionName=1.2.4-video -PassistantVersionCode=10204；真实模拟器 UiDriver videov124（与生产手机无关）。

保留：08:00/21:00 时间配置、通知合并、备忘、对话、语音输入、旧音频及锁屏播放。上述旧功能保留源实现，本轮实测重点为四项修改，并未重做全部语音场景。

审查重点：学习质量/兴趣覆盖、长会话分页边界、视频失败续做、手机生命周期播放器恢复。群聊提问暂未接入单会话 SQLite user-only 取题，需下一步补只读群聊用户原话来源；本轮选题不会冒充已读取群聊提问。
