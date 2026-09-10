'use strict';
/**
 * 开发场景契约 —— 用源码断言守住「零配置」和「底座通用」这两条。
 *
 * 为什么要用 grep 式契约测试：这几条约束跨了 3 个文件（预设、建群、群聊室），
 * 任何一处被改掉，用户看到的就是「选了开发场景但点发送只是普通提问」——
 * 一个不报错、只是悄悄退化的失败。单跑某个模块的单测抓不到它。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('dev-scene-contract');

const WT = require('../renderer/workflow-templates.js');
const modal = read('renderer/meeting-create-modal.js');
const room = read('renderer/meeting-room.js');

test('开发场景建群时自动写入默认工作流（否则「零配置」不成立）', () => {
  assert(/_applyDefaultDevWorkflow\(meeting, scene, slots, \{ atWorkRoot, projects: devProjects \}\)/.test(modal),
    'create-meeting 之后必须调用 _applyDefaultDevWorkflow，并把「是否开在工作根 + 项目库快照 + 起手方式」传进去');
  assert(/function _applyDefaultDevWorkflow/.test(modal), '该函数必须存在');
  assert(/scene !== 'dev'/.test(modal), '只对 dev 场景生效');
  assert(/createTemplateConfig\(templateId, members/.test(modal), '默认工作流由 templateId 决定');
  assert(/const templateId = 'dev-task'/.test(modal), '新建群聊统一按成员数量配置');
  assert(/serialWorkflow: config/.test(modal), '必须写进 meeting.serialWorkflow');
});

test('发送按钮仍按 serialWorkflow 三岔路分发（默认工作流才有意义）', () => {
  // 这是「不加开跑按钮」的前提：配了循环就跑循环，没配就是普通提问。
  assert(/serialWorkflow\.loop && m\.serialWorkflow\.loop\.enabled/.test(room),
    '发送路径必须仍然检查 loop.enabled');
  assert(/loop:start/.test(room), '循环分支必须走 loop:start');
});

test('先讨论再开工：讨论阶段发送走普通群聊，循环配置原样保留（2026-09-06）', () => {
  // 用户的痛点：有些任务本身就要先讨论。做法不是第三个场景，而是同一个群两个阶段。
  // 讨论阶段的判断必须在循环分支之前，否则「先讨论」选了也是一发就开跑。
  const iDiscuss = room.indexOf('if (DevFile.enabled(m) || DevDiscuss.isDiscussing(m)) {');
  const iLoop = room.indexOf('m.serialWorkflow.loop && m.serialWorkflow.loop.enabled &&', iDiscuss);
  assert(iDiscuss > 0 && iLoop > iDiscuss, '讨论阶段判断必须排在循环分支前面');
  // 2026-09-08：取消了「任务已明确，直接开工」那一挡 —— 它绕过开题，实现位手里
  // 只有聊天记录、没有一份自包含可验收的任务书。双席位现在一律从讨论阶段起步，
  // 需求本来就明确时直接点「开题」即可，不强制多聊几轮。
  assert(!/data-mcm-dev-start/.test(modal), '删除起手选项');
  const members = [{ memberId: 'm1', kind: 'claude' }, { memberId: 'm2', kind: 'codex' }];
  const discuss = WT.createTemplateConfig('dev-task', members, { devPhase: 'discuss' });
  assert.strictEqual(discuss.devPhase, 'discuss');
  assert.strictEqual(discuss.loop.enabled, false, '新房间不启动旧循环');
  assert.strictEqual(discuss.fileFlowVersion, 2);
  const build = WT.createTemplateConfig('dev-task', members, {});
  assert.strictEqual(build.devPhase, 'discuss', '不传就是讨论起手（取消分岔之后的默认）');
  assert.strictEqual(build.mdHandoff, true, '新建的双席位开发群聊默认走 MD 改名交接');
  assert.strictEqual(WT.createTemplateConfig('dev-task', members, { devPhase: 'build' }).devPhase, 'build',
    '显式传 build 仍然认：老房间改配置和单测都要用');
  // 开在工作根时讨论阶段同样要能定位项目根：定位说明得单独存一份，普通群聊路径才拿得到
  const atRoot = WT.createTemplateConfig('dev-task', members, { devPhase: 'discuss', workspace: { atWorkRoot: true, projects: [{ name: 'X', path: 'C:\\repo\\x' }] } });
  assert(/先定位项目根/.test(atRoot.projectLocator) && atRoot.projectLocator.includes('X → C:\\repo\\x'));
  assert(!build.projectLocator, '不在工作根就不带');
  // 主进程逐轮追加讨论块（和英雄块同一位置），不能塞 systemPrompt——那只发一次
  const dispatcher = read('main/groupchat/dispatcher.js');
  assert(/DevDiscuss\.appendDiscussBlock\(/.test(dispatcher) && /DevDiscuss\.discussBlockFor\(meeting, member\.memberId\)/.test(dispatcher),
    'dispatcher 普通群聊路径必须逐轮追加讨论块');
  assert(/update-meeting-sync/.test(room.slice(room.indexOf('async function _setDevPhase'), room.indexOf('async function _openDevKickoffDialog'))),
    '切阶段必须同步写回主进程，再启动循环');
});

test('讨论阶段堵死「恢复旧循环」的三条路（2026-09-06 合并位复现的绕过）', () => {
  // 旧循环暂停 → 回到讨论 → 点「已暂停 · 继续」→ 后端照跑旧目标，绕过了「开工」的任务说明确认。
  // 前端不露入口只是礼貌，引擎和 IPC 才是闸门；三层各守一条。
  assert(/loopSt\.status === 'paused' && discussingNow/.test(room), '前端：讨论阶段不渲染循环恢复入口');
  assert(/serialSt\.status === 'paused' && !discussingNow/.test(room), '前端：串行恢复入口同样不露');
  const engine = read('main/groupchat/loop-engine.js');
  assert(/if \(discussPhaseBlock\(meeting\)\)/.test(engine.slice(engine.indexOf('async function runLoop'))), '引擎：runLoop 入口按阶段拒绝');
  assert(/validateResume/.test(read('main/ipc/loop-handlers.js')), 'IPC：loop:resume 先问引擎阶段校验');
  assert(/devPhase === 'discuss'\) return \{ ok: false/.test(read('main/groupchat/dev-workbench.js')), '工作台：恢复动作按阶段拒绝');
});

test('单人按当前成员配置双职责，不限制 AI 品牌', () => {
  for (const kind of ['claude', 'codex', 'deepseek']) {
    const c = WT.createTemplateConfig('dev-task', [{ memberId: 'm1', kind }]);
    assert.equal(c.soloDevelopment, true);
    assert.deepEqual(c.steps, [['m1'], ['m1']]);
    assert.equal(c.loop.enabled, false);
    const F = require('../core/dev-file-workflow');
    const m = {groupChat:true, scene:'dev', serialWorkflow:c};
    assert(F.isSolo(m));
    assert(!F.common(m, 'dir').includes('第二席位'));
    assert(F.common(m, 'dir').includes('自审'));
  }
});

test('极简起手：一位 Codex 既当工作位也当合并位（2026-09-07 用户要求）', () => {
  // 小到不值得占两个席位的改动（改一句文案、加一个开关），双席位的代价是
  // 一次完整的上下文交接 + 一倍 token。极简把这条代价换成「没有独立第三方」，
  // 取舍由用户在建群那一刻选，不由 Hub 替他决定。
  assert(!/data-mcm-dev-start/.test(modal), '旧模板只兼容历史配置，创建入口已移除');
  const solo = WT.createTemplateConfig('dev-task-solo', [{ memberId: 'm1', kind: 'codex' }]);
  assert(solo, '单人也要能构造出配置');
  assert.deepStrictEqual(solo.steps, [['m1'], ['m1']],
    '两步派给同一个 memberId：loop-engine 的 builder=steps[0][0]、reviewer=steps.slice(1) 照常成立');
  assert.strictEqual(solo.loop.enabled, true, '极简仍然是循环，只是循环里只有一个人');
  assert.strictEqual(solo.devPhase, 'build', '极简没有讨论阶段');
  assert.notStrictEqual(solo.mdHandoff, true, '极简保留原流程，不套用双席位的 MD 交接链路');
  // 工作流配置弹窗的闭环形状校验：恰好 2 步、第 1 步 1 人、第 2 步 ≥1 人
  assert(solo.steps.length === 2 && solo.steps[0].length === 1 && solo.steps[1].length >= 1,
    '形状必须仍然是配置弹窗认的那种闭环，否则用户一打开配置就被判非法');

  const [impl, merge] = solo.stepConfigs.map(s => s.prompt);
  assert(/\.agents\/AUTHOR\.md/.test(impl) && /\.agents\/MERGER\.md/.test(merge), '两步仍各读各的合同');
  assert(/自己写的/.test(merge), '必须点明这一步没有独立第三方，否则模型会照抄「独立性成立」那套说辞');
  assert(/ASK/.test(impl), '规模超预期时要能提议升级成双席位，而不是硬做');
  assert(!/[A-Za-z]:\\/.test(impl + merge), '不许有 Windows 绝对路径');
  assert(!/SuperRAN|superran|claude-session-hub/i.test(impl + merge), '不许写死项目名');

  // 开在工作根时同样要带项目库定位说明
  const soloPath = 'C:\\repo\\x';
  const atRoot = WT.createTemplateConfig('dev-task-solo', [{ memberId: 'm1', kind: 'codex' }],
    { workspace: { atWorkRoot: true, projects: [{ name: 'X', path: soloPath }] } });
  assert(atRoot.stepConfigs.every(step => step.prompt.startsWith('【先定位项目根】')), '两步都要带定位说明');
  assert(atRoot.projectLocator.includes('X → ' + soloPath), '讨论/普通路径也要拿得到定位说明');
});

test('dev 场景有工作位与合并位两顶流水线角色帽子', () => {
  const devBlock = room.slice(room.indexOf('    dev: ['), room.indexOf('  };', room.indexOf('    dev: [')));
  assert(/id: 'worker'/.test(devBlock) && /工作位/.test(devBlock), '缺工作位');
  assert(/id: 'merger'/.test(devBlock) && /合并位/.test(devBlock), '缺合并位');
  assert(/AUTHOR\.md/.test(devBlock) && /MERGER\.md/.test(devBlock),
    '两顶帽子必须指向合同文件，和工作流预设保持同一套说法');
});

test('底座通用：预设里不许出现项目名或绝对路径', () => {
  // Hub 是通用底座，项目差异沉淀在各项目自己的 .agents/ 里。
  // 一旦有人图省事把路径写死进 Hub，这条会红。
  const c = WT.createTemplateConfig('dev-task', [
    { memberId: 'm1', kind: 'claude' }, { memberId: 'm2', kind: 'codex' },
  ]);
  assert(c, 'dev-task 必须能构造出配置');
  const all = c.stepConfigs.map(s => s.prompt).join('\n');
  assert(!/[A-Za-z]:\\/.test(all), '不许有 Windows 绝对路径');
  assert(!/SuperRAN|superran|claude-session-hub/i.test(all), '不许写死项目名');
  assert(/\.agents\/AUTHOR\.md/.test(all) && /\.agents\/MERGER\.md/.test(all),
    '必须用仓库内相对路径指向合同');
});

test('开在工作根时，两步 prompt 前面都带项目库让 AI 自己定位项目根（2026-09-06 允许选默认目录的代价）', () => {
  // 用户不想每次找项目路径，于是默认工作目录也能开开发场景。代价必须由 prompt 承担：
  // 没有这段，agent 落在 C:\AIWork 上会「读不到 .agents/AUTHOR.md → 乱翻或乱选仓库」。
  const members = [{ memberId: 'm1', kind: 'claude' }, { memberId: 'm2', kind: 'codex' }];
  const projects = [
    { name: 'AI HUB', path: 'C:\\some\\where\\hub' },
    { name: 'SuperRAN', path: 'C:\\some\\where\\ran' },
  ];
  const c = WT.createTemplateConfig('dev-task', members, { devPhase: 'build', workspace: { atWorkRoot: true, projects } });
  for (const [i, step] of c.stepConfigs.entries()) {
    assert(step.prompt.startsWith('【先定位项目根】'), `第 ${i + 1} 步必须以定位说明开头，放后面会被合同指令盖过`);
    assert(step.prompt.includes('AI HUB → C:\\some\\where\\hub'), `第 ${i + 1} 步要列出中文名 → 路径`);
    assert(step.prompt.includes('SuperRAN → C:\\some\\where\\ran'));
    assert(/不要猜/.test(step.prompt), '判断不了要问，不许猜');
  }
  // 顺序必须保留：项目库本身按活跃时间排好，prompt 不许重排
  const p = c.stepConfigs[0].prompt;
  assert(p.indexOf('AI HUB') < p.indexOf('SuperRAN'));
  // 合同指向仍然在，不是替换而是前置
  assert(/\.agents\/AUTHOR\.md/.test(c.stepConfigs[0].prompt));
  assert(/\.agents\/MERGER\.md/.test(c.stepConfigs[1].prompt));

  // 项目库空的时候也要给出可执行的找法，而不是一句「自己找」
  const empty = WT.createTemplateConfig('dev-task', members, { devPhase: 'build', workspace: { atWorkRoot: true, projects: [] } });
  assert(/\.agents\/project\.json/.test(empty.stepConfigs[0].prompt), '空库时要说清判据');

  // 不在工作根（选了项目根）时，一个字都不多：agent 已经站在项目里了
  const onRepo = WT.createTemplateConfig('dev-task', members, { devPhase: 'build', workspace: { atWorkRoot: false, projects } });
  assert(!/先定位项目根/.test(onRepo.stepConfigs[0].prompt));
  assert(!/some\\where/.test(onRepo.stepConfigs[0].prompt));
});

test('建群弹窗：开发场景不再强制切到「选择已有路径」，但开在工作根必须先拿项目库', () => {
  assert(!/radio\.value === 'dev' && _meetingWorkspaceMode !== 'existing'/.test(modal),
    '选中 dev 时不许再替用户把档位切走');
  // 2026-09-08：这一行从 const 改成 let —— 失效目录退到工作根时要把它翻成 true，
  // 项目库和定位说明才会跟进来（见 dev-workspace-guard 的 ready-fallback）。判据本身没变。
  assert(/let atWorkRoot = scene === 'dev' && _meetingWorkspaceMode === 'default' && !!\(workspace && workspace\.flat\)/.test(modal),
    '只有「默认档 + 平铺工作根」才算开在工作根');
  assert(/if \(fellBackToWorkRoot\) atWorkRoot = true;/.test(modal),
    '唯一能额外把它翻成 true 的，只有「失效目录退到工作根」这一条');
  assert(/checkDevWorkspace\(workspace && workspace\.path, \{ workRoot: workRootPath \}\)/.test(modal),
    '闸门要拿到工作根路径才知道该放行');
  const iLoad = modal.indexOf('devProjects = await _loadProjectLibrary(true)');
  const iCreate = modal.indexOf("invoke('create-meeting'");
  assert(iLoad > 0 && iCreate > 0 && iLoad < iCreate, '项目库必须在建群前拉到，否则 prompt 里是空的');
});

test('合同文件真实存在，且与预设指向一致', () => {
  // skill 生成什么、工作流读什么，必须是同一组文件名。
  for (const f of ['.agents/AUTHOR.md', '.agents/MERGER.md', '.agents/project.json']) {
    assert(fs.existsSync(path.join(REPO, f)), '缺文件：' + f);
  }
  const cfg = JSON.parse(read('.agents/project.json'));
  assert.strictEqual(cfg.contracts.author, '.agents/AUTHOR.md');
  assert.strictEqual(cfg.contracts.merger, '.agents/MERGER.md');
  assert(Array.isArray(cfg.test) && cfg.test.length, 'project.json 必须配测试命令，否则闸门是空的');
});

test('合同里写的四行格式，引擎的解析器真的认（skill ↔ 工作流 ↔ 引擎三方对齐）', () => {
  // 这是整条链最容易悄悄断掉的地方：
  //   project-prep skill 教 agent 写什么格式 → 合同 .md 里规定什么格式
  //   → 合并位真的输出什么 → loop-engine 的 parseVerdict 认不认。
  // 任何一环措辞漂移，引擎就判不出 PASS，循环会一直空转到轮次上限。
  // 所以这里直接把合同里的格式抠出来，喂给真正的解析器。
  const LW = require('../renderer/loop-workflow.js');
  const merger = WT.createTemplateConfig('dev-task', [{memberId:'m1'},{memberId:'m2'}], {devPhase:'build'}).stepConfigs[1].prompt;

  // 合同必须写明这四个标签
  for (const label of ['RESULT:', 'BLOCKERS:', 'VERIFIED:', 'NEXT:']) {
    assert(merger.includes(label), 'MERGER.md 缺标签 ' + label);
  }

  // 按合同格式造一份真实输出，解析器必须认出来
  const passSample = 'RESULT: PASS\nBLOCKERS: 无\nVERIFIED: 跑了 337 个单测全过\nNEXT: 无';
  const failSample = 'RESULT: FAIL\nBLOCKERS: 边界情况没测\nVERIFIED: 单测有 1 条红\nNEXT: 补测试';
  assert.strictEqual(LW.parseVerdict(passSample).decision, 'pass', 'PASS 必须被认出，否则循环停不下来');
  assert.strictEqual(LW.parseVerdict(failSample).decision, 'fail', 'FAIL 必须被认出，否则不会回炉');
  assert.strictEqual(LW.parseVerdict('我觉得可以合并了'), null, '不按格式就不该瞎猜');

  // 工作位那四行标签也要和合同一致
  const author = WT.createTemplateConfig('dev-task', [{memberId:'m1'},{memberId:'m2'}], {devPhase:'build'}).stepConfigs[0].prompt;
  for (const label of ['PROGRESS:', 'VERIFIED:', 'RISK:', 'REPORT:']) {
    assert(author.includes(label), 'AUTHOR.md 缺标签 ' + label);
  }

  assert(!/合完把结果写成人话[\s\S]{0,300}PROGRESS:/.test(merger),
    '合并位完成后不能切到工作位协议，否则引擎认不出 PASS');
  assert(/RESULT: PASS 或 FAIL/.test(merger),
    '合并位必须明确在正式合并后仍输出 RESULT 四行');
});

test('闸门齐备：两个钩子 + 合并脚本都在', () => {
  for (const f of ['.githooks/pre-commit', '.githooks/pre-push', 'scripts/merge_task.py']) {
    assert(fs.existsSync(path.join(REPO, f)), '缺文件：' + f);
  }
  // 钩子必须是 LF，否则 Windows 上 #!/bin/sh\r 会让它静默失效
  const attrs = read('.gitattributes');
  assert(/\.githooks\/\*\s+text\s+eol=lf/.test(attrs), '.gitattributes 必须强制钩子用 LF');
  // 这里不比对变量名（实现换过一次，从 $trunk 换成兜底名单 + 配置的并集），
  // 直接拿真实的钩子跑一遍：给它一个非常规主干名，它必须挡住。
  // 断言实现细节的写法上次就是这么误报的——钩子行为没坏，只是变量改了名。
  const prePush = read('.githooks/pre-push');
  assert(/project\.json/.test(prePush), 'pre-push 必须读 .agents/project.json');

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-contract-'));
  try {
    fs.mkdirSync(path.join(sandbox, '.agents'));
    fs.writeFileSync(path.join(sandbox, '.agents', 'project.json'),
      JSON.stringify({ trunk: 'release-x', protectedBranches: ['ship-it'] }), 'utf-8');
    const hook = path.join(REPO, '.githooks', 'pre-push');
    const push = (branch) => spawnSync('sh', [hook, 'origin', 'url'], {
      cwd: sandbox,
      input: `refs/heads/${branch} aaa refs/heads/${branch} bbb\n`,
      encoding: 'utf-8',
    }).status;

    assert.strictEqual(push('release-x'), 1, '配置声明的主干必须挡住');
    assert.strictEqual(push('ship-it'), 1, 'protectedBranches 里的也必须挡住');
    assert.strictEqual(push('master'), 1, '兜底名单必须仍然生效（配置读不到时的最后一道）');
    assert.strictEqual(push('feat/whatever'), 0, '特性分支必须放行，否则没人能干活');
  } finally {
    try { require('child_process').execSync(`cmd /c rmdir /S /Q "${sandbox}"`, { stdio: 'ignore' }); } catch (e) {}
  }
});

test('全量运行器隔离父 Hub 环境，开发群聊内自测不能被隔离实例变量污染', () => {
  const runner = read('scripts/run_unit_tests.js');
  assert(/CLAUDE_HUB_DATA_DIR\s*:\s*SUITE_TEMP/.test(runner),
    '子测试必须覆盖父进程的 CLAUDE_HUB_DATA_DIR');
  assert(/TEMP\s*:\s*SUITE_TEMP/.test(runner) && /TMP\s*:\s*SUITE_TEMP/.test(runner),
    'os.tmpdir() 产物必须落在同一个隔离根内，安全策略才能判定为 contained');
});

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
