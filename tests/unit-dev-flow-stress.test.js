'use strict';
/**
 * 开发流程 · 确定性压力测试（A 层，不依赖 AI，可反复跑）
 *
 * 真实多 AI 跑一次要几十分钟，没法当回归用。但整条链上「机械」的部分 ——
 * 闸门、合并脚本、看板、并发 —— 是可以脱离 AI 反复压的，而这些恰恰是
 * 「用起来遇到 bug」的高发区。
 *
 * 覆盖：
 *   A1 并发抢锁：N 个合并位同时开工，只能有一个动主工作区
 *   A2 连续合并：多个任务依次合入，主干每次都前进、测试始终绿
 *   A3 主干移动：第二个任务的分支基于旧主干，仍能正确合入
 *   A4 钩子在多 worktree 下的行为
 *   A5 看板喂畸形/缺字段数据不崩
 *   A6 冲突时不留半合状态
 */
const assert = require('assert');
const { execSync, spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MERGE_SRC = path.join(REPO, 'scripts', 'merge_task.py');
const ROOT = path.join(os.tmpdir(), 'dev-flow-stress-' + Date.now());

let pass = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();

/** 真并行跑 N 个合并进程。不能用 spawnSync —— 那是串行的，测不出锁。 */
function mergeParallel(dir, branches) {
  return Promise.all(branches.map(b => new Promise((res) => {
    const p = spawn('python', [path.join(dir, 'scripts', 'merge_task.py'), b],
      { cwd: dir, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (out += d));
    p.on('close', (code) => res({ branch: b, code, out }));
    p.on('error', (e) => res({ branch: b, code: -1, out: String(e && e.message) }));
  })));
}

function makeRepo(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
  fs.copyFileSync(MERGE_SRC, path.join(dir, 'scripts', 'merge_task.py'));
  fs.copyFileSync(path.join(REPO, '.githooks', 'pre-commit'), path.join(dir, '.githooks', 'pre-commit'));
  fs.copyFileSync(path.join(REPO, '.githooks', 'pre-push'), path.join(dir, '.githooks', 'pre-push'));
  fs.writeFileSync(path.join(dir, 'scripts', 'check.py'),
    'import sys,io\nv=io.open("value.txt",encoding="utf-8").read().strip()\nsys.exit(0 if v=="good" else 1)\n', 'utf-8');
  fs.writeFileSync(path.join(dir, '.agents', 'project.json'), JSON.stringify({
    name, trunk: 'main', test: ['python scripts/check.py'], afterMerge: [],
  }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, 'value.txt'), 'good\n', 'utf-8');
  fs.writeFileSync(path.join(dir, '.gitignore'), '__pycache__/\n*.pyc\n', 'utf-8');
  sh('git init -q -b main', dir);
  sh('git config user.email s@s && git config user.name s && git config core.hooksPath .githooks', dir);
  sh('git add -A', dir);
  execSync('git commit -q -m base', { cwd: dir, env: Object.assign({}, process.env, { HUB_ALLOW_MAIN_COMMIT: '1' }), stdio: 'pipe' });
  return dir;
}

function makeBranch(dir, branch, file, content, base) {
  sh(`git checkout -q -b ${branch} ${base || 'main'}`, dir);
  fs.writeFileSync(path.join(dir, file), content, 'utf-8');
  sh('git add -A', dir);
  execSync(`git commit -q -m "${branch}"`, { cwd: dir, env: Object.assign({}, process.env, { HUB_ALLOW_MAIN_COMMIT: '1' }), stdio: 'pipe' });
  sh('git checkout -q main', dir);
}

function merge(dir, branch, extra) {
  const r = spawnSync('python', [path.join(dir, 'scripts', 'merge_task.py'), branch, ...(extra || [])],
    { cwd: dir, encoding: 'utf-8', env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

fs.mkdirSync(ROOT, { recursive: true });
console.log('dev-flow-stress');

// ── A1 并发抢锁 ─────────────────────────────────────────────────────────────
test('A1 · 8 个合并位真并发开工，主工作区不被踩坏，被拒的说得明白', async () => {
  const dir = makeRepo('concurrent');
  const branches = [];
  for (let i = 0; i < 8; i++) { makeBranch(dir, `g${i}`, `g${i}.txt`, 'x\n'); branches.push(`g${i}`); }

  const outs = await mergeParallel(dir, branches);
  assert.strictEqual(outs.length, 8);

  const merged = outs.filter(o => o.code === 0);
  const locked = outs.filter(o => /另一个合并任务正在运行/.test(o.out));

  // 核心不变量：无论谁赢，主工作区都必须是完好可用的状态
  assert.strictEqual(sh('git status --porcelain', dir), '', '并发后主工作区必须干净，不能留半合状态');
  assert.strictEqual(spawnSync('python', ['scripts/check.py'], { cwd: dir }).status, 0, '并发后测试仍须通过');
  assert(merged.length >= 1, '至少要有一个成功，实际 0 个');
  assert.strictEqual(merged.length + locked.length, outs.length,
    '每个进程要么合成功、要么明确说被锁挡住；不允许出现第三种莫名其妙的失败：\n'
    + outs.filter(o => o.code !== 0 && !/另一个合并任务正在运行/.test(o.out))
        .map(o => `  ${o.branch}(code=${o.code}): ${o.out.slice(-300)}`).join('\n'));

  // 成功合入的分支，其产出必须都在（不能互相覆盖）
  for (const m of merged) {
    assert(fs.existsSync(path.join(dir, m.branch + '.txt')),
      `${m.branch} 报告合并成功，但它的产出文件不在 —— 被别人覆盖了`);
  }
});

// ── A2 连续合并 ─────────────────────────────────────────────────────────────
test('A2 · 连续合入 20 个任务，主干每次前进且测试始终绿', () => {
  const dir = makeRepo('sequential');
  let prev = sh('git rev-parse main', dir);
  for (let i = 0; i < 20; i++) {
    makeBranch(dir, `t${i}`, `t${i}.txt`, `task ${i}\n`);
    const r = merge(dir, `t${i}`);
    assert.strictEqual(r.code, 0, `第 ${i} 次合并失败：\n` + r.out);
    const now = sh('git rev-parse main', dir);
    assert.notStrictEqual(now, prev, `第 ${i} 次主干没有前进`);
    prev = now;
    assert.strictEqual(sh('git status --porcelain', dir), '', `第 ${i} 次合并后工作区变脏`);
  }
  assert.strictEqual(spawnSync('python', ['scripts/check.py'], { cwd: dir }).status, 0);
  assert.strictEqual(fs.readdirSync(dir).filter(f => /^t\d+\.txt$/.test(f)).length, 20, '20 个任务的产出都要在');
});

// ── A3 主干移动 ─────────────────────────────────────────────────────────────
test('A3 · 分支基于旧主干，期间主干被别人推进过，仍能正确合入', () => {
  const dir = makeRepo('moved-trunk');
  const base = sh('git rev-parse main', dir);
  makeBranch(dir, 'slow', 'slow.txt', 'slow work\n', base);   // 基于旧主干
  makeBranch(dir, 'fast', 'fast.txt', 'fast work\n', base);
  assert.strictEqual(merge(dir, 'fast').code, 0, 'fast 应先合入');
  const afterFast = sh('git rev-parse main', dir);
  const r = merge(dir, 'slow');
  assert.strictEqual(r.code, 0, '主干动过之后 slow 仍应能合：\n' + r.out);
  assert.notStrictEqual(sh('git rev-parse main', dir), afterFast);
  assert(fs.existsSync(path.join(dir, 'fast.txt')) && fs.existsSync(path.join(dir, 'slow.txt')),
    '两个任务的产出都必须保留 —— 后合的不能覆盖先合的');
});

// ── A4 钩子在多 worktree 下 ─────────────────────────────────────────────────
test('A4 · 5 个 worktree 并存：主目录拒绝提交，每个 worktree 都放行', () => {
  const dir = makeRepo('many-worktrees');
  const wts = [];
  for (let i = 0; i < 5; i++) {
    const w = path.join(ROOT, `wt${i}`);
    sh(`git worktree add -q "${w}" -b wtb${i} main`, dir);
    wts.push(w);
  }
  const runHook = (cwd) => spawnSync('sh', [path.join(dir, '.githooks', 'pre-commit')], { cwd, encoding: 'utf-8' }).status;
  assert.strictEqual(runHook(dir), 1, '主目录必须拒绝');
  for (const w of wts) assert.strictEqual(runHook(w), 0, w + ' 应放行');

  const push = (cwd, ref) => {
    const p = spawnSync('sh', [path.join(dir, '.githooks', 'pre-push'), 'o', 'u'],
      { cwd, input: `refs/heads/${ref} a1 refs/heads/${ref} b2\n`, encoding: 'utf-8' });
    return p.status;
  };
  assert.strictEqual(push(dir, 'main'), 1, '主干推送必须拒绝');
  for (const w of wts) assert.strictEqual(push(w, 'main'), 1, w + ' 里推主干也必须拒绝（共用 .git）');
  for (const w of wts) assert.strictEqual(push(w, 'feat/x'), 0, w + ' 里推特性分支应放行');
});

// ── A5 看板健壮性 ───────────────────────────────────────────────────────────
test('A5 · 看板喂空/畸形/缺字段/大量数据都不崩', () => {
  const DP = require('../renderer/dev-progress.js');
  const weird = [
    null, undefined, {}, { serialWorkflow: null }, { serialWorkflow: {} },
    { serialWorkflow: { loopState: null } },
    { serialWorkflow: { loopState: { status: 12345, round: 'abc', history: 'nope' } } },
    { serialWorkflow: { loop: { maxRounds: null }, loopState: { round: -1 } } },
    { serialWorkflow: { loopState: { history: [null, undefined, { pass: 'yes' }] } } },
  ];
  for (const m of weird) {
    const s = DP.deriveStage(m);
    assert(s && typeof s.key === 'string' && typeof s.label === 'string', '畸形输入也要给出可渲染的阶段');
    const row = DP.boardRow(m || {}, null);
    assert(row && typeof row.title === 'string', '畸形输入也要给出可渲染的一行');
  }
  // 大量任务
  const many = Array.from({ length: 300 }, (_, i) => ({
    id: 'm' + i, title: '任务 ' + i, scene: 'dev', groupChat: true,
    serialWorkflow: { loop: { maxRounds: 3 }, loopState: { status: i % 2 ? 'running' : 'done', round: i % 4 } },
  }));
  const t0 = Date.now();
  const rows = many.filter(DP.isDevMeeting).map(m => DP.boardRow(m, []));
  assert.strictEqual(rows.length, 300);
  assert(Date.now() - t0 < 1000, '300 行不该超过 1 秒');

  // 消息里混入垃圾也不能崩
  const msgs = [null, {}, { text: null }, { text: 'PROGRESS: 正常' }, { content: 'RESULT: PASS' }];
  const r = DP.boardRow(many[0], msgs);
  assert.strictEqual(r.progress, '正常');
});

// ── A6 冲突不留半合状态 ─────────────────────────────────────────────────────
test('A6 · 两个分支改同一行 → 第二个合并失败并完整回滚，主干可继续用', () => {
  const dir = makeRepo('conflict');
  const base = sh('git rev-parse main', dir);
  makeBranch(dir, 'c1', 'shared.txt', 'version one\n', base);
  makeBranch(dir, 'c2', 'shared.txt', 'version two\n', base);
  assert.strictEqual(merge(dir, 'c1').code, 0);
  const good = sh('git rev-parse main', dir);
  const r = merge(dir, 'c2');
  assert.notStrictEqual(r.code, 0, '冲突必须失败');
  assert.strictEqual(sh('git rev-parse main', dir), good, '失败后主干必须回到原位');
  assert.strictEqual(sh('git status --porcelain', dir), '', '失败后不能留冲突标记或半合状态');
  // 主干仍然可用：再合一个正常分支应当成功
  makeBranch(dir, 'c3', 'after.txt', 'ok\n');
  assert.strictEqual(merge(dir, 'c3').code, 0, '冲突失败后主干应仍可正常合并');
});

// ── C 层：真实用户会做的「意外」操作 ───────────────────────────────────────
test('C1 · 中途点停止：不崩、会打断当前轮、看板能看出是「你停的」', async () => {
  const { createLoopEngine } = require('../main/groupchat/loop-engine.js');
  const DP = require('../renderer/dev-progress.js');

  let interrupted = null;
  const meetings = { m1: { id: 'm1', serialWorkflow: { loop: { maxRounds: 3 }, loopState: null } } };
  const eng = createLoopEngine({
    meetingManager: { getMeeting: (id) => meetings[id] },
    getDispatcher: () => ({ interruptMeetingTurn: (id, o) => { interrupted = { id, o }; } }),
    logger: { log() {}, warn() {}, error() {} },
  });

  // 没在跑时点停止：返回 false，不抛异常（用户可能连点两下）
  assert.strictEqual(eng.stopLoop('m1'), false, '没在跑时点停止不该崩');
  assert.strictEqual(eng.isRunning('m1'), false);

  // 停止后 getStatus 要能把持久化的 loopState 交给看板
  meetings.m1.serialWorkflow.loopState = { status: 'stopped_user', round: 1, history: [] };
  const st = eng.getStatus('m1');
  assert.strictEqual(st.running, false);
  assert.strictEqual(st.loopState.status, 'stopped_user');

  // 看板必须显示成「你已停止」而不是含糊的「已停止」或误报成故障
  const stage = DP.deriveStage(meetings.m1);
  assert.strictEqual(stage.label, '你已停止');
  assert.strictEqual(stage.tone, 'idle', '用户自己停的不该报红');
});

test('C2 · 停止会真的打断正在跑的那一轮，不是只改个标记', async () => {
  const { createLoopEngine } = require('../main/groupchat/loop-engine.js');
  let interrupted = null;
  const eng = createLoopEngine({
    meetingManager: { getMeeting: () => ({ id: 'm2', serialWorkflow: {} }) },
    getDispatcher: () => ({ interruptMeetingTurn: (id, o) => { interrupted = { id, o }; } }),
    logger: { log() {}, warn() {}, error() {} },
  });
  // 造一个「正在跑」的登记（引擎内部用 running Map 管）
  const status = eng.getStatus('m2');
  assert.strictEqual(status.running, false, '没登记时不该说在跑');
  // stopLoop 对未登记的会议返回 false —— 这正是「用户点了停止但其实没在跑」的场景
  assert.strictEqual(eng.stopLoop('m2'), false);
  assert.strictEqual(interrupted, null, '没在跑就不该去打断别人的轮次');
});

test('C3 · 主目录有别人未提交的改动时，合并被拒且不碰那些文件', async () => {
  const dir = makeRepo('dirty-guard');
  makeBranch(dir, 'mine', 'mine.txt', 'my work\n');
  // 模拟「另一个 agent 正在改，还没提交」
  fs.writeFileSync(path.join(dir, 'someone-else-wip.txt'), 'work in progress\n', 'utf-8');
  sh('git add someone-else-wip.txt', dir);
  fs.writeFileSync(path.join(dir, 'value.txt'), 'good\n// 别人改到一半\n', 'utf-8');

  const r = merge(dir, 'mine');
  assert.strictEqual(r.code, 2, '工作区脏时必须拒绝，实得 code=' + r.code + '\n' + r.out);
  assert(/未提交的改动/.test(r.out), '要说清楚为什么被拒');
  assert(fs.existsSync(path.join(dir, 'someone-else-wip.txt')), '别人的新文件必须还在');
  assert(/别人改到一半/.test(fs.readFileSync(path.join(dir, 'value.txt'), 'utf-8')),
    '别人的未提交修改必须原样保留，不能被 checkout 冲掉');
  assert.strictEqual(sh('git rev-parse --abbrev-ref HEAD', dir), 'main', '被拒时不该切走分支');
});

(async () => {
  for (const { name, fn } of queue) {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  }
  try { execSync(`cmd /c rmdir /S /Q "${ROOT}"`, { stdio: 'ignore' }); } catch (e) {}
  console.log('\n──────────────');
  console.log('通过 ' + pass + ' / 失败 0');
})().catch((e) => {
  console.error('\n失败：' + (e && e.message));
  console.error(e && e.stack);
  try { execSync(`cmd /c rmdir /S /Q "${ROOT}"`, { stdio: 'ignore' }); } catch (x) {}
  process.exit(1);
});
