'use strict';
/**
 * 阶段交接文档（MD 改名交付）的判定逻辑。
 *
 * 守的是任务书 B01 / B03 / B04 / B05 / B08 这几条：
 *   草稿存在、空文件不算交付；重复事件不重复接收；已接收的被改动要停在待核对；
 *   审查缺 RESULT 不猜裁决；文件暂时读不到不算任务失败。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../core/dev-task-docs.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }
function freshDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'task-docs-')); }
function write(dir, name, body) { fs.writeFileSync(path.join(dir, name), body, 'utf8'); }

const FULL_SPEC = [
  '# 开题报告', '## 目标', '把开发群聊的交接从聊天关键词换成文件改名。',
  '## 非目标', '不做通用工作流编辑器。',
  '## 验收标准', '建房→开题→实现→审查全程可跑通。',
  '## 风险与回退', '出问题就停止新派发，保留全部文档。',
].join('\n');

const PASS_REVIEW = ['# 阶段1合并手册', '独立验证记录若干，跑了全量单测。', 'RESULT: PASS', 'BLOCKERS: 无', 'VERIFIED: node scripts/run_unit_tests.js 386 通过', 'NEXT: 无'].join('\n');

console.log('dev-task-docs');

test('步骤位置推导轮次、角色和文件名：0 开题 → 奇数实现 → 偶数审查', () => {
  assert.strictEqual(D.docSpecForPos(0).done, '已完成-开题报告.md');
  assert.strictEqual(D.docSpecForPos(1).done, '已完成-阶段1协作手册.md');
  assert.strictEqual(D.docSpecForPos(2).done, '已完成-阶段1合并手册.md');
  assert.strictEqual(D.docSpecForPos(3).done, '已完成-阶段2协作手册.md');
  assert.strictEqual(D.docSpecForPos(4).round, 2);
  assert.strictEqual(D.docSpecForPos(1).role, 'builder');
  assert.strictEqual(D.docSpecForPos(2).role, 'reviewer');
  assert.strictEqual(D.docSpecForPos(-1), null);
  // 引擎按「第几轮 + 谁」思考，换算必须和上面这张表一致
  assert.strictEqual(D.posForLoopStep(0, 'builder'), 1);
  assert.strictEqual(D.posForLoopStep(0, 'reviewer'), 2);
  assert.strictEqual(D.posForLoopStep(1, 'builder'), 3);
});

test('任务目录按群隔离：同名文件不能证明身份', () => {
  const a = D.taskDocsDir('C:/hub', 'meeting-a');
  const b = D.taskDocsDir('C:/hub', 'meeting-b');
  assert.notStrictEqual(a, b);
  assert(a.includes('task-docs'), '目录落在 Hub 数据目录下的任务附件区，不进生产仓库');
});

test('B01 草稿在、完成文件不在 → 不算交付', () => {
  const dir = freshDir();
  write(dir, '阶段1协作手册.md', '写了一半的草稿'.repeat(20));
  const delivery = D.readDelivery(dir, D.docSpecForPos(1).done);
  assert.strictEqual(delivery.status, 'missing');
  assert.strictEqual(D.reconcileDelivery(D.emptyLedger(dir), 1, delivery, 'build').status, 'pending');
});

test('B01 空文件 / 只写了个标题 → 不算交付', () => {
  const dir = freshDir();
  write(dir, D.docSpecForPos(1).done, '');
  assert.strictEqual(D.readDelivery(dir, D.docSpecForPos(1).done).status, 'empty');
  write(dir, D.docSpecForPos(1).done, '# 阶段1');
  assert.strictEqual(D.readDelivery(dir, D.docSpecForPos(1).done).status, 'empty',
    '一句正经的交接都写不下的长度，是半成品不是交付');
});

test('首次接收成功，重复出现只算一次（丢事件重扫、文件事件重复都走这条）', () => {
  const dir = freshDir();
  write(dir, D.docSpecForPos(1).done, '本轮交付：改了 X 模块。worktree C:/AIWork/x，分支 feat/y，完整提交 abc1234def，跑了全量单测 386 通过。');
  let ledger = D.emptyLedger(dir);
  const first = D.reconcileDelivery(ledger, 1, D.readDelivery(dir, D.docSpecForPos(1).done), 'build');
  assert.strictEqual(first.status, 'accepted');
  ledger = D.withAccepted(ledger, 1, first.record);
  const again = D.reconcileDelivery(ledger, 1, D.readDelivery(dir, D.docSpecForPos(1).done), 'build');
  assert.strictEqual(again.status, 'duplicate', '同一份交付不重复接收，也就不会重复派工');
});

test('B08 已接收的完成文件之后被改动 → 待核对，不覆盖已接收版本', () => {
  const dir = freshDir();
  const name = D.docSpecForPos(1).done;
  write(dir, name, '第一版交付内容：分支 feat/a，提交 aaa111，跑了相关单测，足够长以通过最小长度检查。');
  let ledger = D.emptyLedger(dir);
  const first = D.reconcileDelivery(ledger, 1, D.readDelivery(dir, name), 'build');
  ledger = D.withAccepted(ledger, 1, first.record);
  write(dir, name, '第二版：有人事后又改了这个文件，内容和第一版不一样了，长度同样够过最小长度检查。');
  const changed = D.reconcileDelivery(ledger, 1, D.readDelivery(dir, name), 'build');
  assert.strictEqual(changed.status, 'changed_after_accept');
  assert.strictEqual(changed.prior.fingerprint, first.record.fingerprint, '已接收那一版的凭据原样保留');
});

test('B08 审查手册缺 RESULT → 不猜裁决，停在待核对', () => {
  const dir = freshDir();
  const name = D.docSpecForPos(2).done;
  write(dir, name, '我看了代码，感觉应该没什么问题，测试大概是过的吧，就先这样了，没有写单独成行的裁决。');
  const outcome = D.reconcileDelivery(D.emptyLedger(dir), 2, D.readDelivery(dir, name), 'review');
  assert.strictEqual(outcome.status, 'incomplete');
  assert.deepStrictEqual(outcome.missing, ['RESULT'], '自然语言的「应该没问题」不能被猜成 PASS');
});

test('审查手册有 RESULT 才接收，裁决从手册里取', () => {
  const dir = freshDir();
  write(dir, D.docSpecForPos(2).done, PASS_REVIEW);
  const outcome = D.reconcileDelivery(D.emptyLedger(dir), 2, D.readDelivery(dir, D.docSpecForPos(2).done), 'review');
  assert.strictEqual(outcome.status, 'accepted');
  assert.strictEqual(outcome.verdict, 'pass');
  assert.strictEqual(D.parseReviewVerdict('RESULT：FAIL'), 'fail', '中文冒号也要认');
  assert.strictEqual(D.parseReviewVerdict('引用里提到 RESULT: PASS 三个字'), null, '不单独成行的不算裁决');
});

test('开题报告必须自包含：缺四项之一就不接收', () => {
  const dir = freshDir();
  write(dir, D.docSpecForPos(0).done, FULL_SPEC);
  const ok = D.reconcileDelivery(D.emptyLedger(dir), 0, D.readDelivery(dir, D.docSpecForPos(0).done), 'kickoff');
  assert.strictEqual(ok.status, 'accepted');
  // 长度刻意写够，好把「文件太短」和「字段不全」两种拒收理由分开验。
  write(dir, D.docSpecForPos(0).done, '## 非目标\n本任务不做通用工作流编辑器，也不改 project-prep skill，剩下三项这份草稿里一个字都没写。');
  const bad = D.reconcileDelivery(D.emptyLedger(dir), 0, D.readDelivery(dir, D.docSpecForPos(0).done), 'kickoff');
  assert.strictEqual(bad.status, 'incomplete');
  assert.deepStrictEqual(bad.missing, ['目标', '验收标准', '风险与回退'],
    '「非目标」里含「目标」两字，不能靠它冒充「目标」那一项');
});

test('B05 读不到文件是「现在还不能接收」，不是任务失败', () => {
  const dir = freshDir();
  const outcome = D.reconcileDelivery(D.emptyLedger(dir), 1, { status: 'unreadable', reason: 'EBUSY' }, 'build');
  assert.strictEqual(outcome.status, 'pending');
  assert.strictEqual(outcome.reason, 'EBUSY', '原因要具体，界面上要能说出「文件被占用」而不是「失败了」');
});

test('账本能被反序列化：重启后已接收的事实还在', () => {
  const dir = freshDir();
  const ledger = D.withAccepted(D.emptyLedger(dir), 1, { pos: 1, kind: 'build', fingerprint: 'abc', path: 'p' });
  const roundTrip = D.normalizeLedger(JSON.parse(JSON.stringify(ledger)), dir);
  assert.strictEqual(D.acceptedAt(roundTrip, 1).fingerprint, 'abc');
  assert.strictEqual(D.acceptedAt(roundTrip, 2), null);
  assert.strictEqual(D.normalizeLedger(null, dir).dir, dir, '老房间没有账本字段时给一个空账本，不炸');
});

test('派给 agent 的文档块给绝对路径，并说清「改名才算交付」', () => {
  const block = D.buildDocBlock({ dir: 'C:\\hub\\task-docs\\m1', pos: 2, inputDocs: ['C:\\hub\\task-docs\\m1\\已完成-阶段1协作手册.md'] });
  assert(block.includes('C:\\hub\\task-docs\\m1\\阶段1合并手册.md'), '草稿给绝对路径');
  assert(block.includes('C:\\hub\\task-docs\\m1\\已完成-阶段1合并手册.md'), '完成文件给绝对路径');
  assert(/重命名/.test(block) && /不要直接往完成文件里持续追加/.test(block), '交付动作和它的反面都要写明');
  assert(/RESULT: PASS/.test(block), '审查那一步要明确要求裁决行');
  assert(block.includes('已完成-阶段1协作手册.md'), '上游文档作为阅读入口带进来');
  assert.strictEqual(D.buildDocBlock({ dir: '', pos: 1 }), '', '没有任务目录就一个字都不加');
});

console.log(`\n${pass} passed`);
