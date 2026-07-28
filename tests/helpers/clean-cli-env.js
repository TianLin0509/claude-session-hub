'use strict';
// 诊断脚本里起嵌套 CLI 时必须用它，别直接透传 process.env。
//
// 起因（2026-07-28 实测）：在 Hub 管理的会话里再跑一个 `claude`，子进程会继承
// CLAUDE_HUB_SESSION_ID，它结束时的 Stop hook 就以**父会话的 Hub id** 上报自己的
// session_id / transcript_path / 模型。Hub 照单全收，于是：
//   - 会话卡的模型徽章跳成子进程用的模型（探针常用 haiku，看起来就像"偷偷降级了"）
//   - 卡片视图绑到子进程的 transcript；那个临时目录一清理就 ENOENT 打不开
// main.js 已加 cwd 校验挡住这种重绑，但那要 Hub 重启才生效，而且诊断脚本本来
// 就不该去动用户的真实会话。
const HUB_ENV_KEYS = [
  'CLAUDE_HUB_SESSION_ID',
  'CLAUDE_HUB_PORT',
  'CLAUDE_HUB_TOKEN',
];

function cleanCliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of HUB_ENV_KEYS) delete env[k];
  return env;
}

module.exports = { HUB_ENV_KEYS, cleanCliEnv };
