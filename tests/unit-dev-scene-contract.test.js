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
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('dev-scene-contract');

const WT = require('../renderer/workflow-templates.js');
const modal = read('renderer/meeting-create-modal.js');
const room = read('renderer/meeting-room.js');

test('开发场景建群时自动写入默认工作流（否则「零配置」不成立）', () => {
  assert(/_applyDefaultDevWorkflow\(meeting, scene, slots\)/.test(modal),
    'create-meeting 之后必须调用 _applyDefaultDevWorkflow');
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

test('闸门齐备：两个钩子 + 合并脚本都在', () => {
  for (const f of ['.githooks/pre-commit', '.githooks/pre-push', 'scripts/merge_task.py']) {
    assert(fs.existsSync(path.join(REPO, f)), '缺文件：' + f);
  }
  // 钩子必须是 LF，否则 Windows 上 #!/bin/sh\r 会让它静默失效
  const attrs = read('.gitattributes');
  assert(/\.githooks\/\*\s+text\s+eol=lf/.test(attrs), '.gitattributes 必须强制钩子用 LF');
});

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
