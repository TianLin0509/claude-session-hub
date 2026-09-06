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
    'create-meeting 之后必须调用 _applyDefaultDevWorkflow，并把「是否开在工作根 + 项目库快照」传进去');
  assert(/function _applyDefaultDevWorkflow/.test(modal), '该函数必须存在');
  assert(/scene !== 'dev'/.test(modal), '只对 dev 场景生效');
  assert(/createTemplateConfig\('dev-task'/.test(modal), '默认工作流必须是 dev-task');
  assert(/serialWorkflow: config/.test(modal), '必须写进 meeting.serialWorkflow');
});

test('发送按钮仍按 serialWorkflow 三岔路分发（默认工作流才有意义）', () => {
  // 这是「不加开跑按钮」的前提：配了循环就跑循环，没配就是普通提问。
  assert(/serialWorkflow\.loop && m\.serialWorkflow\.loop\.enabled/.test(room),
    '发送路径必须仍然检查 loop.enabled');
  assert(/loop:start/.test(room), '循环分支必须走 loop:start');
});

test('单人群聊不写默认工作流（一个人没法自审自合）', () => {
  assert(/slots\.length < 2/.test(modal), '必须有成员数下限判断');
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
  const c = WT.createTemplateConfig('dev-task', members, { workspace: { atWorkRoot: true, projects } });
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
  const empty = WT.createTemplateConfig('dev-task', members, { workspace: { atWorkRoot: true, projects: [] } });
  assert(/\.agents\/project\.json/.test(empty.stepConfigs[0].prompt), '空库时要说清判据');

  // 不在工作根（选了项目根）时，一个字都不多：agent 已经站在项目里了
  const onRepo = WT.createTemplateConfig('dev-task', members, { workspace: { atWorkRoot: false, projects } });
  assert(!/先定位项目根/.test(onRepo.stepConfigs[0].prompt));
  assert(!/some\\where/.test(onRepo.stepConfigs[0].prompt));
});

test('建群弹窗：开发场景不再强制切到「选择已有路径」，但开在工作根必须先拿项目库', () => {
  assert(!/radio\.value === 'dev' && _meetingWorkspaceMode !== 'existing'/.test(modal),
    '选中 dev 时不许再替用户把档位切走');
  assert(/const atWorkRoot = scene === 'dev' && _meetingWorkspaceMode === 'default' && !!\(workspace && workspace\.flat\)/.test(modal),
    '只有「默认档 + 平铺工作根」才算开在工作根');
  assert(/checkDevWorkspace\(workspace && workspace\.path, \{ workRoot: atWorkRoot \? workspace\.path : '' \}\)/.test(modal),
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
  const merger = read('.agents/MERGER.md');

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
  const author = read('.agents/AUTHOR.md');
  for (const label of ['PROGRESS:', 'VERIFIED:', 'RISK:', 'REPORT:']) {
    assert(author.includes(label), 'AUTHOR.md 缺标签 ' + label);
  }

  assert(!/合完把结果写成人话[\s\S]{0,300}PROGRESS:/.test(merger),
    '合并位完成后不能切到工作位协议，否则引擎认不出 PASS');
  assert(/成功后仍输出上节同一套四行/.test(merger),
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
