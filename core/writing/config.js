'use strict';
// core/writing/config.js
//
// 写作 Tab 用到的全部路径集中在这里。文章、范文、规则都是普通文件，Hub 只是它们的界面，
// 所以这些路径指向的是用户自己的目录，而不是 Hub 数据目录。
//
// 每一项都能用环境变量改写：隔离测试必须把它们指到临时目录，
// 否则测试实例会改写用户真实的文风 skill（学习 Tab 在 2026-09-08 出过同类事故）。

const os = require('os');
const path = require('path');

const DEFAULT_WORKSHOP_ROOT = 'C:\\AIWork\\20260926-写作工坊';

function writingPaths(env = process.env) {
  const home = env.CLAUDE_HUB_HOME_DIR || os.homedir();
  const root = env.CLAUDE_HUB_WRITING_ROOT || DEFAULT_WORKSHOP_ROOT;
  const skillsRoot = env.CLAUDE_HUB_WRITING_SKILLS_DIR || path.join(home, '.codex', 'skills');
  const voiceDir = env.CLAUDE_HUB_VOICE_DIR || path.join(skillsRoot, 'tiange-voice');
  const guideDir = path.join(skillsRoot, 'chinese-tech-writing', 'references');
  return {
    root,
    // 旧作：公众号与 CSDN 按年份归档的 Markdown
    libraryRoots: [path.join(root, '田哥材料', '文章')],
    // 新作：写作台产出，<系列>/<篇目>/ 一篇一个目录
    piecesRoot: path.join(root, '写作台'),
    // 作品库的手改题材、摘句本
    stateDir: path.join(root, 'hub-state'),
    voiceDir,
    draftGuide: path.join(guideDir, 'draft.md'),
    reviewGuide: path.join(guideDir, 'review.md'),
    diffScript: path.join(voiceDir, 'scripts', 'diff_edits.py'),
    home,
  };
}

module.exports = { writingPaths, DEFAULT_WORKSHOP_ROOT };
