'use strict';
/**
 * 开发场景的工作目录闸门。
 *
 * 为什么需要它：dev-task 预设的两步 prompt 写死了「读本仓库的 .agents/AUTHOR.md」
 * 和「跑 scripts/merge_task.py --dry-run」，路径都是**仓库内相对路径**。
 * 群聊把工作目录直接给 CLI 当 cwd，而**建群弹窗默认选的是「默认工作目录」**
 * （平铺工作根 C:\AIWork，不是任何仓库）。
 *
 * 落在那里会发生什么：agent 找不到 .agents/AUTHOR.md，**它不会自己 cd 到某个项目**
 * ——它根本不知道你指的是哪个仓库。实际表现是它开始满盘乱翻、或者反问你一句、
 * 或者随便挑一个仓库动手。三种都不是你要的，而且都要等好几分钟才看得出来。
 *
 * 所以在建群那一刻就挡住，比让它在第一步失败便宜得多。
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {string} dir 用户选的工作目录
 * @param {{fs?: object}} [deps] 注入用，测试传假 fs
 * @returns {{ok: boolean, reason: string, message: string}}
 */
function checkDevWorkspace(dir, deps = {}) {
  const _fs = deps.fs || fs;
  const d = typeof dir === 'string' ? dir.trim() : '';

  if (!d) {
    return {
      ok: false,
      reason: 'no-path',
      message: '开发场景必须选一个项目目录。请点「选择已有路径」挑到项目根。',
    };
  }

  let stat = null;
  try {
    stat = _fs.statSync(d);
  } catch (e) {
    return {
      ok: false,
      reason: 'not-found',
      message: `目录不存在：${d}`,
    };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: 'not-dir', message: `这不是一个目录：${d}` };
  }

  const isGit = _exists(_fs, path.join(d, '.git'));
  const cfg = path.join(d, '.agents', 'project.json');
  const hasCfg = _exists(_fs, cfg);

  if (!isGit) {
    return {
      ok: false,
      reason: 'not-a-repo',
      message: [
        `${d} 不是一个 git 仓库。`,
        '开发场景要在项目根上开：工作位要建分支、合并位要合主干，都需要仓库。',
        '如果你本来就想随便问一句，把场景切回「通用」即可。',
      ].join('\n'),
    };
  }

  if (!hasCfg) {
    return {
      ok: false,
      reason: 'not-prepared',
      message: [
        `${d} 还没整理成可并行开发的形态（缺 .agents/project.json）。`,
        '',
        '开发场景的预设 prompt 会读这个仓库里的 .agents/AUTHOR.md 与 .agents/MERGER.md，',
        '合并位还要跑 scripts/merge_task.py。这些现在都不在，流程会在第一步就断掉。',
        '',
        '先开一个普通会话（不是群聊），在这个项目目录下说：',
        '    用 project-prep skill，把这个仓库整理成能开并行群聊的规范项目。',
        '整理是一次性的，之后这个项目的每个群聊都不用再做。',
      ].join('\n'),
    };
  }

  return { ok: true, reason: 'ready', message: '' };
}

function _exists(_fs, p) {
  try {
    _fs.statSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { checkDevWorkspace };
}
if (typeof window !== 'undefined') {
  window.DevWorkspaceGuard = { checkDevWorkspace };
}
