'use strict';
// v2 deliberately reads names only. Document quality belongs to the two Agents.
const fs = require('node:fs');
const path = require('node:path');
const VERSION = 2;
const PRESET_START = '【AI HUB 开题提示词】';
const PRESET_END = '【开题提示词结束】';
const PROJECT_PREP_PROMPT = '用 project-prep 整理当前仓库，接入 AI HUB 群聊开发，保留现有测试和合并规则。';
function appendProjectPrep(text) {
  const base = String(text || '');
  if (base.includes(PROJECT_PREP_PROMPT)) return base;
  return base ? `${base}\n\n${PROJECT_PREP_PROMPT}` : PROJECT_PREP_PROMPT;
}
const enabled = m => !!(m?.groupChat && m.scene === 'dev' && m.serialWorkflow?.fileFlowVersion === VERSION);
function directory(dataDir, id) {
  if (!/^[a-zA-Z0-9_-]{1,255}$/.test(String(id || ''))) throw new Error('无效的群聊任务目录');
  return path.join(dataDir, 'task-docs', id);
}
function spec(phase, round = 0) {
  const name = phase === 'kickoff' ? '开题报告.md' : `${phase === 'build' ? '实现' : '合并'}手册-轮次${round}.md`;
  return { phase, round, key: `${phase}:${round}`, draft: name, completed: `已完成-${name}`,
    ...(phase === 'merge' ? { rework: `需返工-${name}` } : {}) };
}
function fromNames(input) {
  const names = new Set(input);
  const known = [...names].filter(n => /^(?:已完成-)?开题报告\.md$|^(?:已完成-)?实现手册-轮次[1-9]\d*\.md$|^(?:已完成-|需返工-)?合并手册-轮次[1-9]\d*\.md$/.test(n));
  const seen = new Set();
  const fail = (s, error) => ({ ...s, error, label: '文件命名冲突 · 请查看任务目录', files: known, done: false });
  const at = (s, label, done = false) => {
    const extras = known.filter(n => !seen.has(n));
    if (extras.length) return fail(s, `存在未接续的阶段文件：${extras.join('、')}`);
    return { ...s, label, done, files: known, draftExists: names.has(s.draft), error: null };
  };
  let s = spec('kickoff');
  for (;;) {
    const found = [s.draft, s.completed, s.rework].filter(n => n && names.has(n));
    found.forEach(n => seen.add(n));
    if (found.length > 1) return fail(s, `同一阶段只能保留一个状态文件：${found.join('、')}`);
    if (!found.length || found[0] === s.draft) {
      if (!found.length && s.phase === 'kickoff') return at({ phase: 'discuss', key: 'discuss:0', round: 0 }, '讨论 · 尚未开题');
      const label = { kickoff: '开题报告', build: `实现手册 · 第 ${s.round} 轮`, merge: `合并手册 · 第 ${s.round} 轮` }[s.phase];
      return at(s, `${label} · ${found.length ? '未交付' : '待开始'}`);
    }
    if (s.phase === 'kickoff') s = spec('build', 1);
    else if (s.phase === 'build') s = spec('merge', s.round);
    else if (found[0] === s.completed) return at(s, '合并完成', true);
    else s = spec('build', s.round + 1);
  }
}
function scan(dir) {
  try { return fromNames(fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name)); }
  catch (error) {
    if (error.code === 'ENOENT') return fromNames([]);
    return { phase: 'discuss', key: 'unreadable', round: 0, files: [], done: false, label: '任务目录暂不可读', error: error.message };
  }
}
function isResume(text) {
  return /^(?:继续(?:执行|施工|开工|开题|任务)?|接着做|恢复执行)(?:[。！!\s]*$|[，,：:]\s*[^？?]+$)/u.test(String(text || '').trim());
}
function appendKickoff(text, prompt) {
  let base = String(text || '');
  const start = base.indexOf(PRESET_START), end = base.indexOf(PRESET_END, start);
  if (start >= 0 && end >= start) base = base.slice(0, start).trimEnd() + base.slice(end + PRESET_END.length);
  return [base.trim(), `${PRESET_START}\n${prompt}\n${PRESET_END}`].filter(Boolean).join('\n\n');
}
function common(meeting, dir) {
  return [
    '## AI HUB 文件工作流',
    `本群任务目录：${dir}`,
    `工作目录：${meeting.workspace || '按本群项目线索定位并核实真实 Git 根目录'}`,
    meeting.serialWorkflow?.projectLocator || '',
    '角色固定：第一席位负责开题和实现，第二席位负责独立验证与合并；头像选择只决定下一条用户消息发送给谁。',
    '用户发送开题提示词后，授权按开题范围实现，并在独立验证通过后按项目入口合并；用户明确的禁止事项或额外审批条件优先。',
    '能从现有需求和项目事实判断的选择，直接采用推荐方案并简述取舍；不使用 ASK，不反复索取流程批准。遵守用户明确的范围、禁止事项以及必要的权限边界。',
    '普通讨论和进度询问只回答，不据此开始施工。收到明确的开题、阶段派工或继续执行指令才执行对应阶段。',
    '“继续”指本群同一个任务：先读已有草稿和已交付文件，核对现场，复用原 worktree、分支和已完成成果；不要新开一个任务。',
    '每阶段先创建或接续草稿，在草稿记录进展、决策、真实验证和阻碍。写完保存、回读，最后同目录原子改名交付；不覆盖已完成文件。',
    '开题报告.md → 已完成-开题报告.md；实现手册-轮次N.md → 已完成-实现手册-轮次N.md；合并手册-轮次N.md → 需返工-合并手册-轮次N.md 或 已完成-合并手册-轮次N.md。',
    'Hub 只按文件名接续流程，不读取正文裁决。客观阻塞或中断就保留草稿并说明事实，不能用完成文件表示失败。改名交付后结束本阶段，由 Hub 派下一位。',
    '正文中的 SHA、验证命令、结果和项目位置供下一位 Agent 核查，不能省略；无需固定的聊天标签或重复交接四行。',
  ].filter(Boolean).join('\n');
}
function phasePrompt(meeting, dir, state) {
  const s = state.phase === 'discuss' ? spec('kickoff') : state;
  const base = [common(meeting, dir), `\n## 执行${{ kickoff: '开题', build: '施工', merge: '合并' }[s.phase]}${s.round ? ` · 第 ${s.round} 轮` : ''}`,
    `本阶段草稿：${path.join(dir, s.draft)}`, `完成交付：${path.join(dir, s.completed)}`];
  if (s.phase === 'kickoff') base.push(
    '依据用户这条消息和此前讨论，先核实项目位置、阅读项目 AGENTS.md 和 .agents/project.json，写自包含开题报告。',
    '报告包括：目标、范围、推荐方案、可执行验收、风险与回退、项目绝对路径及工作入口；记录你采用的合理假设。',
    '本阶段仅写开题文件，不改业务代码、不建 worktree、不提交、不推送。已有完成报告则不重写。交付后自动开工。');
  if (s.phase === 'build') base.push(
    `阅读 ${path.join(dir, '已完成-开题报告.md')}、项目 .agents/AUTHOR.md 及用户后续补充。`,
    s.round > 1 ? `阅读 ${path.join(dir, spec('merge', s.round - 1).rework)}，优先修复其中具体阻断项，保留此前成果。` : '按开题范围开始实现。',
    '在独立 worktree 实现并完成必要测试，形成可审查提交；不得改写生产工作目录或混入别人的改动。',
    '手册写明项目根、worktree、分支、完整提交 SHA、实际执行的验证命令/结果和残余风险。GUI 改动需真实隔离 GUI 证据。',
    '只有可交给独立审查时才改名交付；工作位不自行合并。');
  if (s.phase === 'merge') base.push(
    `阅读 ${path.join(dir, '已完成-开题报告.md')}、${path.join(dir, spec('build', s.round).completed)}、项目 .agents/MERGER.md 和 .agents/project.json。`,
    '独立检查实际分支和完整 SHA，不采信工作位的自报通过，不代修实现。亲自执行项目 dry-run 和必要验证；使用测试隔离环境，不能触碰运行中的生产服务。',
    '针对最新主干核验集成；只有真实冲突或测试失败才要求返工，主干单纯前移不构成返工理由。',
    `有具体代码或验收缺陷：写清证据及修复要求，改名为 ${path.join(dir, s.rework)}，由 Hub 派下一轮实现。`,
    '验证通过且本任务已有合并授权时，按项目规定入口合并被验证的完整 SHA，并完成规定的合并后检查。项目既有人工审批或远端发布要求仍须满足，不从“无 ASK”推导新的权限。',
    '先核查该提交是否已合并；中断发生在 Git 成功后时只补剩余检查和记录，不重复合并或升版本。',
    '只有真实合并及要求的后置操作成功才用“已完成”改名。环境、权限、审批或工具失败保留草稿并说明，不把它伪装成实现缺陷或成功。');
  return base.join('\n');
}
module.exports = { VERSION, enabled, directory, spec, fromNames, scan, isResume, appendKickoff, appendProjectPrep, PRESET_START, PRESET_END, common, phasePrompt };
