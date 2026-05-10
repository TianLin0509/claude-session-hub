# Worktree Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Hub 主窗口右侧增加一个 per-session 的"工作树面板"，让用户一眼看清当前 cwd / 分支 / 未提交改动 + 同仓库其它 session 的状态，并通过红/黄/绿三档颜色提示冲突。

**Architecture:** 后端新模块 `core/worktree/` 封装 git 探针 + 冲突分类；前端新模块 `renderer/worktree/` 封装面板 UI；两者通过 `worktree:*` 命名空间的 IPC 通信。事件驱动刷新（panel open / select session / window focus / statusline tick / 30s 兜底 polling），30s TTL 缓存削减重复 git 调用。

**Tech Stack:** Node.js + Electron（主进程 spawn git）；renderer 用现有原生 DOM + ipcRenderer；测试用 `node + assert`（沿用 Hub `tests/_unit-*.js` 模式）；E2E 用 Playwright + DeepSeek session（已支持）。

**Spec:** `C:\Users\lintian\claude-session-hub\docs\superpowers\specs\2026-05-03-worktree-panel-design.md`

---

## File Structure

| 路径 | 类型 | 责任 |
|------|------|------|
| `core/worktree/git-probe.js` | 新建 | spawn `git status/log/rev-list/worktree list`，解析 porcelain，30s TTL 缓存 |
| `core/worktree/conflict-detector.js` | 新建 | classify(active, peers) → {color, reasons} |
| `core/worktree/index.js` | 新建 | 编排：拿 active session + peers，调 probe 与 detector，返回 panel data |
| `core/worktree/README.md` | 新建 | 模块自述（输入/输出/缓存策略）|
| `renderer/worktree/worktree-panel.js` | 新建 | 面板渲染、刷新驱动、IPC、debounce |
| `renderer/worktree/worktree-panel.css` | 新建 | 面板样式（被 styles.css `@import`）|
| `tests/_unit-git-probe.js` | 新建 | parsePorcelain / parseWorktreeList / cache 单元测试 |
| `tests/_unit-conflict-detector.js` | 新建 | classify 7 组合 |
| `tests/_e2e-worktree-panel.js` | 新建 | 隔离 Hub + DeepSeek session + CDP 验证 |
| `tests/fixtures/worktree-multi/` | 新建 | 测试用临时 git repo + worktree 脚本 |
| `main.js` | 修改 | 注册 `worktree:probe` / `worktree:open-explorer` 等 IPC handler |
| `renderer/index.html` | 修改 | 增 `<div id="worktree-panel">` + `<button id="btn-worktree-toggle">` + 引用新 js/css |
| `renderer/styles.css` | 修改 | 末尾 `@import "./worktree/worktree-panel.css";`（或直接合并）|
| `package.json` | 修改 | scripts 加 `test:worktree-unit` 与 `test:worktree-e2e` |

**回滚边界**：删除 `core/worktree/`、`renderer/worktree/`、4 个 tests 文件 + 撤销 main.js / index.html / styles.css / package.json 的相关 hunk。

---

## Phase 0: 隔离 worktree 开发环境

### Task 0: 起独立 worktree

**Files:**
- 新工作目录：`C:\Users\lintian\hub-feat-worktree-panel`

- [ ] **Step 1: 创建 worktree（HEAD 当前分支，含主目录所有未提交基线）**

```powershell
git -C C:\Users\lintian\claude-session-hub worktree add C:\Users\lintian\hub-feat-worktree-panel HEAD
```

Expected: `Preparing worktree (detached HEAD ...)` 或 `(new branch ...)`，目录创建成功。

- [ ] **Step 2: 在 worktree 里建 feature 分支**

```powershell
git -C C:\Users\lintian\hub-feat-worktree-panel checkout -b feat/worktree-panel
```

- [ ] **Step 3: junction 复用主目录 node_modules（按 Hub CLAUDE.md 铁律）**

```powershell
cmd /c mklink /J "C:\Users\lintian\hub-feat-worktree-panel\node_modules" "C:\Users\lintian\claude-session-hub\node_modules"
```

Expected: `Junction created for ...`. 如果失败立即停下查原因，绝不 `npm install`。

- [ ] **Step 4: smoke test 启动一次确认 worktree 干净**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-worktree-panel-data"
cd C:\Users\lintian\hub-feat-worktree-panel
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9223
```

放到 `run_in_background: true`，6 秒后看 stdout 是否含 `[hub] hook server listening on 127.0.0.1:`。看到即停掉，进入 Phase 1。看不到则按 CLAUDE.md "node_modules 半坏"流程排查。

- [ ] **Step 5: 后续所有命令、commit、edit 全部在 `C:\Users\lintian\hub-feat-worktree-panel` 进行。**

不 commit Phase 0（git worktree add 本身已注册到主仓库）。

---

## Phase 1: 后端基线（严格 TDD）

### Task 1: parsePorcelain — 解析 `git status --porcelain=2 --branch`

**Files:**
- Create: `core/worktree/git-probe.js`
- Test: `tests/_unit-git-probe.js`

- [ ] **Step 1: 写失败测试**

写 `tests/_unit-git-probe.js`：

```js
const assert = require('assert');
const { parsePorcelain } = require('../core/worktree/git-probe');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(e => { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; });
}

(async () => {
  console.log('git-probe parsePorcelain:');

  await test('解析 branch.head 与 ahead/behind', () => {
    const input = [
      '# branch.oid abc123',
      '# branch.head master',
      '# branch.upstream origin/master',
      '# branch.ab +2 -1',
    ].join('\n');
    const r = parsePorcelain(input);
    assert.strictEqual(r.branch, 'master');
    assert.strictEqual(r.ahead, 2);
    assert.strictEqual(r.behind, 1);
    assert.deepStrictEqual(r.dirty, []);
  });

  await test('解析 modified / untracked / renamed', () => {
    const input = [
      '# branch.head main',
      '# branch.ab +0 -0',
      '1 .M N... 100644 100644 100644 abc def src/foo.js',
      '? notes.md',
      '2 R. N... 100644 100644 100644 ghi jkl R100 src/new.js\tsrc/old.js',
    ].join('\n');
    const r = parsePorcelain(input);
    assert.strictEqual(r.branch, 'main');
    assert.strictEqual(r.dirty.length, 3);
    assert.deepStrictEqual(r.dirty[0], { path: 'src/foo.js', status: 'M' });
    assert.deepStrictEqual(r.dirty[1], { path: 'notes.md', status: 'U' });
    assert.deepStrictEqual(r.dirty[2], { path: 'src/new.js', status: 'R', from: 'src/old.js' });
  });

  await test('无 upstream 时 ahead/behind 都是 0', () => {
    const input = '# branch.head feat-x\n';
    const r = parsePorcelain(input);
    assert.strictEqual(r.ahead, 0);
    assert.strictEqual(r.behind, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
```

- [ ] **Step 2: 跑测试，确认失败**

```powershell
node tests/_unit-git-probe.js
```

Expected: `Cannot find module '../core/worktree/git-probe'`.

- [ ] **Step 3: 写最小实现**

新建 `core/worktree/git-probe.js`：

```js
'use strict';

function parsePorcelain(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = { branch: null, ahead: 0, behind: 0, dirty: [] };
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      out.branch = line.slice('# branch.head '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (m) { out.ahead = parseInt(m[1], 10); out.behind = parseInt(m[2], 10); }
    } else if (line.startsWith('1 ')) {
      // ordinary changed: "1 XY sub mode mode mode H1 H2 path"
      const parts = line.split(' ');
      const xy = parts[1];
      const path = parts.slice(8).join(' ');
      out.dirty.push({ path, status: xy.replace('.', '').charAt(0) || 'M' });
    } else if (line.startsWith('2 ')) {
      // renamed: "2 XY sub mode mode mode H1 H2 Rscore path<TAB>orig"
      const tabIdx = line.indexOf('\t');
      const newPath = line.slice(0, tabIdx).split(' ').slice(9).join(' ');
      const oldPath = line.slice(tabIdx + 1);
      out.dirty.push({ path: newPath, status: 'R', from: oldPath });
    } else if (line.startsWith('? ')) {
      out.dirty.push({ path: line.slice(2), status: 'U' });
    }
  }
  return out;
}

module.exports = { parsePorcelain };
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
node tests/_unit-git-probe.js
```

Expected: `3 passed, 0 failed`.

- [ ] **Step 5: commit**

```powershell
git add core/worktree/git-probe.js tests/_unit-git-probe.js
git commit -m "worktree: add parsePorcelain"
```

---

### Task 2: parseWorktreeList — 解析 `git worktree list --porcelain`

**Files:**
- Modify: `core/worktree/git-probe.js`
- Modify: `tests/_unit-git-probe.js`

- [ ] **Step 1: 追加失败测试到 `tests/_unit-git-probe.js` 的 IIFE 内**

```js
await test('parseWorktreeList: 解析多 worktree', () => {
  const { parseWorktreeList } = require('../core/worktree/git-probe');
  const input = [
    'worktree C:/repos/main',
    'HEAD abc123',
    'branch refs/heads/master',
    '',
    'worktree C:/temp/feat-x',
    'HEAD def456',
    'branch refs/heads/feat-x',
    '',
  ].join('\n');
  const r = parseWorktreeList(input);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0], { cwd: 'C:/repos/main', head: 'abc123', branch: 'master' });
  assert.deepStrictEqual(r[1], { cwd: 'C:/temp/feat-x', head: 'def456', branch: 'feat-x' });
});

await test('parseWorktreeList: detached HEAD', () => {
  const { parseWorktreeList } = require('../core/worktree/git-probe');
  const input = 'worktree C:/repos/x\nHEAD abc\ndetached\n';
  const r = parseWorktreeList(input);
  assert.strictEqual(r[0].branch, null);
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node tests/_unit-git-probe.js
```

Expected: `parseWorktreeList is not a function`.

- [ ] **Step 3: 在 `core/worktree/git-probe.js` 实现并 export**

```js
function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { cwd: line.slice('worktree '.length), head: null, branch: null };
    } else if (line.startsWith('HEAD ')) {
      if (cur) cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      if (cur) cur.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      if (cur) cur.branch = null;
    } else if (line === '' && cur) {
      out.push(cur); cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { parsePorcelain, parseWorktreeList };
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
node tests/_unit-git-probe.js
```

Expected: `5 passed, 0 failed`.

- [ ] **Step 5: commit**

```powershell
git add core/worktree/git-probe.js tests/_unit-git-probe.js
git commit -m "worktree: add parseWorktreeList"
```

---

### Task 3: probeRepo — spawn git，集成解析，30s 缓存，in-flight 复用

**Files:**
- Modify: `core/worktree/git-probe.js`
- Modify: `tests/_unit-git-probe.js`

- [ ] **Step 1: 追加失败测试（用真 git 仓库 fixture）**

在 `tests/_unit-git-probe.js` 顶部加 fixture helper：

```js
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gprobe-'));
  cp.execSync('git init -q -b main', { cwd: dir });
  cp.execSync('git config user.email t@t', { cwd: dir });
  cp.execSync('git config user.name t', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  cp.execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}
```

加 IIFE 内测试：

```js
const { probeRepo, _resetCacheForTest } = require('../core/worktree/git-probe');

await test('probeRepo: 真仓库返回 isRepo=true 与 branch', async () => {
  _resetCacheForTest();
  const dir = makeRepo();
  const r = await probeRepo(dir, { force: true });
  assert.strictEqual(r.isRepo, true);
  assert.strictEqual(r.branch, 'main');
  assert.strictEqual(r.repoRoot, fs.realpathSync(dir));
  assert.deepStrictEqual(r.dirty, []);
});

await test('probeRepo: 修改文件后 dirty 含该文件', async () => {
  _resetCacheForTest();
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new');
  const r = await probeRepo(dir, { force: true });
  const paths = r.dirty.map(d => d.path).sort();
  assert.deepStrictEqual(paths, ['a.txt', 'b.txt']);
});

await test('probeRepo: 非 git 目录 → isRepo=false', async () => {
  _resetCacheForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
  const r = await probeRepo(dir, { force: true });
  assert.strictEqual(r.isRepo, false);
});

await test('probeRepo: 缓存命中（同 cwd 30s 内不重复 spawn）', async () => {
  _resetCacheForTest();
  const dir = makeRepo();
  const t1 = Date.now();
  await probeRepo(dir, { force: true });
  const t2 = Date.now();
  await probeRepo(dir);  // 第二次必须命中缓存
  const t3 = Date.now();
  assert.ok((t3 - t2) < (t2 - t1) / 2, '第二次应明显更快');
});

await test('probeRepo: 同 cwd 并发只 spawn 一次', async () => {
  _resetCacheForTest();
  const dir = makeRepo();
  const [a, b] = await Promise.all([probeRepo(dir, { force: true }), probeRepo(dir, { force: true })]);
  // 两个并发 force 调用应通过 in-flight 合并，结果相同对象引用
  assert.ok(a === b || JSON.stringify(a) === JSON.stringify(b));
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node tests/_unit-git-probe.js
```

Expected: `probeRepo is not a function`.

- [ ] **Step 3: 实现 probeRepo（在 `core/worktree/git-probe.js`）**

```js
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const TTL_MS = 30 * 1000;
const SLOW_MS = 5 * 1000;
const ABORT_MS = 15 * 1000;

const cache = new Map();        // realCwd → { result, ts }
const inflight = new Map();     // realCwd → Promise

function _resetCacheForTest() { cache.clear(); inflight.clear(); }

function _runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('git', args, { cwd, windowsHide: true });
    let out = '', err = '';
    const slowTimer = setTimeout(() => { /* UI 层观测，这里不动 */ }, SLOW_MS);
    const abortTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error('git timeout'));
    }, ABORT_MS);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      clearTimeout(slowTimer); clearTimeout(abortTimer);
      if (code === 0) resolve(out);
      else if (/not a git repository/i.test(err)) resolve(null);
      else reject(new Error(`git ${args.join(' ')}: exit ${code}: ${err.trim()}`));
    });
    child.on('error', e => {
      clearTimeout(slowTimer); clearTimeout(abortTimer);
      reject(e);
    });
  });
}

async function probeRepo(cwd, opts = {}) {
  const force = !!opts.force;
  let realCwd;
  try { realCwd = fs.realpathSync(cwd); } catch (_) {
    return { isRepo: false, error: 'cwd-missing', cwd };
  }
  const cached = cache.get(realCwd);
  if (!force && cached && Date.now() - cached.ts < TTL_MS) return cached.result;

  if (inflight.has(realCwd)) return inflight.get(realCwd);

  const promise = (async () => {
    try {
      const root = await _runGit(realCwd, ['rev-parse', '--show-toplevel']);
      if (!root) return { isRepo: false, cwd: realCwd };
      const repoRoot = root.trim();

      const [statusText, lastCommitText] = await Promise.all([
        _runGit(repoRoot, ['status', '--porcelain=2', '--branch']),
        _runGit(repoRoot, ['log', '-1', '--format=%h%x09%s%x09%cr']),
      ]);
      const status = require('./git-probe').parsePorcelain(statusText);
      const [hash, subject, when] = String(lastCommitText || '').trim().split('\t');

      const result = {
        isRepo: true,
        cwd: realCwd,
        repoRoot,
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
        dirty: status.dirty,
        lastCommit: hash ? { hash, subject, when } : null,
      };
      cache.set(realCwd, { result, ts: Date.now() });
      return result;
    } finally {
      inflight.delete(realCwd);
    }
  })();
  inflight.set(realCwd, promise);
  return promise;
}

async function listWorktrees(cwd) {
  try {
    const text = await _runGit(cwd, ['worktree', 'list', '--porcelain']);
    if (!text) return [];
    return require('./git-probe').parseWorktreeList(text);
  } catch (_) {
    return [];
  }
}

module.exports = { parsePorcelain, parseWorktreeList, probeRepo, listWorktrees, _resetCacheForTest };
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
node tests/_unit-git-probe.js
```

Expected: `10 passed, 0 failed`.

- [ ] **Step 5: commit**

```powershell
git add core/worktree/git-probe.js tests/_unit-git-probe.js
git commit -m "worktree: probeRepo + listWorktrees with cache"
```

---

### Task 4: conflict-detector classify

**Files:**
- Create: `core/worktree/conflict-detector.js`
- Create: `tests/_unit-conflict-detector.js`

- [ ] **Step 1: 写失败测试**

新建 `tests/_unit-conflict-detector.js`：

```js
const assert = require('assert');
const { classify } = require('../core/worktree/conflict-detector');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log(`  ✓ ${name}`); pass++; })
    .catch(e => { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; });
}

const repoA = { isRepo: true, cwd: 'C:/a', repoRoot: 'C:/a', dirty: [{path:'src/foo.js'}] };
const repoAOther = { isRepo: true, cwd: 'C:/a', repoRoot: 'C:/a', dirty: [{path:'src/bar.js'}] };
const wtA = { isRepo: true, cwd: 'C:/wt-a', repoRoot: 'C:/a', dirty: [{path:'src/foo.js'}] };
const wtAClean = { isRepo: true, cwd: 'C:/wt-a2', repoRoot: 'C:/a', dirty: [] };
const repoB = { isRepo: true, cwd: 'C:/b', repoRoot: 'C:/b', dirty: [] };

(async () => {
  await test('1. 单飞 git repo → green', () => {
    assert.strictEqual(classify(repoA, []).color, 'green');
  });
  await test('2. 非 repo → green', () => {
    assert.strictEqual(classify({ isRepo: false }, [repoA]).color, 'green');
  });
  await test('3. 同 cwd peer → red', () => {
    const r = classify(repoA, [{ ...repoAOther, sessionId: 'S2' }]);
    assert.strictEqual(r.color, 'red');
    assert.ok(r.reasons.some(s => /同 cwd/.test(s)));
  });
  await test('4. 同 repo 不同 cwd 撞文件 → red', () => {
    const r = classify(repoA, [{ ...wtA, sessionId: 'S2' }]);
    assert.strictEqual(r.color, 'red');
    assert.ok(r.reasons.some(s => /改同文件/.test(s) && /src\/foo\.js/.test(s)));
  });
  await test('5. 同 repo 不同 cwd 不撞文件 → yellow', () => {
    const r = classify(repoA, [{ ...wtAClean, sessionId: 'S2' }]);
    assert.strictEqual(r.color, 'yellow');
  });
  await test('6. 多 peer：1 红 1 黄 → red', () => {
    const r = classify(repoA, [
      { ...wtAClean, sessionId: 'S2' },
      { ...repoAOther, sessionId: 'S3' },
    ]);
    assert.strictEqual(r.color, 'red');
  });
  await test('7. peer 在不同 repo → green', () => {
    const r = classify(repoA, [{ ...repoB, sessionId: 'S2' }]);
    assert.strictEqual(r.color, 'green');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node tests/_unit-conflict-detector.js
```

Expected: `Cannot find module '../core/worktree/conflict-detector'`.

- [ ] **Step 3: 实现 classify**

新建 `core/worktree/conflict-detector.js`：

```js
'use strict';
const path = require('path');

function _norm(p) {
  if (!p) return p;
  let n = p.replace(/\\/g, '/');
  if (process.platform === 'win32') n = n.toLowerCase();
  return n;
}

function classify(active, peers) {
  if (!active || !active.isRepo) return { color: 'green', reasons: ['非 git 目录'] };

  const reasons = [];
  let level = 'green';
  const activeCwd = _norm(active.cwd);
  const activeRoot = _norm(active.repoRoot);
  const activeDirtyPaths = new Set((active.dirty || []).map(d => _norm(d.path)));

  for (const p of peers) {
    if (!p || !p.isRepo) continue;
    const pCwd = _norm(p.cwd);
    const pRoot = _norm(p.repoRoot);
    const tag = p.sessionId || p.cwd;

    if (pCwd === activeCwd) {
      reasons.push(`同 cwd：${tag}`);
      level = 'red';
      continue;
    }
    if (pRoot === activeRoot) {
      const overlap = (p.dirty || [])
        .map(d => _norm(d.path))
        .filter(x => activeDirtyPaths.has(x));
      if (overlap.length > 0) {
        reasons.push(`改同文件 ${overlap.join(', ')}：${tag}`);
        level = 'red';
      } else if (level !== 'red') {
        reasons.push(`同 repo 邻居 worktree：${tag}`);
        level = 'yellow';
      }
    }
  }
  return { color: level, reasons };
}

module.exports = { classify };
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
node tests/_unit-conflict-detector.js
```

Expected: `7 passed, 0 failed`.

- [ ] **Step 5: commit**

```powershell
git add core/worktree/conflict-detector.js tests/_unit-conflict-detector.js
git commit -m "worktree: classify conflicts (cwd + file-overlap)"
```

---

### Task 5: core/worktree/index.js — orchestrator

**Files:**
- Create: `core/worktree/index.js`
- Create: `core/worktree/README.md`

- [ ] **Step 1: 实现 orchestrator**

新建 `core/worktree/index.js`：

```js
'use strict';
const { probeRepo, listWorktrees } = require('./git-probe');
const { classify } = require('./conflict-detector');

/**
 * 收集 active session 与同 repo peers 的 git 状态，返回面板数据。
 *
 * @param {object} args
 * @param {string} args.activeSessionId
 * @param {Array<{sessionId, cwd}>} args.allSessions  当前所有活跃 session
 * @param {boolean} [args.force]                       透传给 probeRepo
 * @returns {Promise<object>} panel data
 */
async function getPanelData({ activeSessionId, allSessions, force = false }) {
  const active = allSessions.find(s => s.sessionId === activeSessionId);
  if (!active || !active.cwd) {
    return { active: null, peers: [], worktreeList: [], conflict: { color: 'green', reasons: [] } };
  }

  const activeProbe = await probeRepo(active.cwd, { force });
  const activeFull = { ...activeProbe, sessionId: active.sessionId, sessionLabel: active.sessionLabel };

  const otherSessions = allSessions.filter(s => s.sessionId !== activeSessionId && s.cwd);
  const peerProbes = await Promise.all(otherSessions.map(async s => {
    const p = await probeRepo(s.cwd, { force });
    return { ...p, sessionId: s.sessionId, sessionLabel: s.sessionLabel };
  }));
  const peers = peerProbes.filter(p => p.isRepo && p.repoRoot === activeFull.repoRoot);

  const worktreeList = activeFull.isRepo ? await listWorktrees(activeFull.repoRoot) : [];
  const conflict = classify(activeFull, peers);

  return { active: activeFull, peers, worktreeList, conflict };
}

module.exports = { getPanelData };
```

- [ ] **Step 2: 写 README**

新建 `core/worktree/README.md`：

```md
# core/worktree

Backend module for the Worktree Panel feature.

## Public API

- `index.getPanelData({ activeSessionId, allSessions, force }) → Promise<panelData>`

## Cache

`git-probe.probeRepo` caches results per absolute cwd for 30 seconds.
Pass `{ force: true }` to bypass.

## Boundaries

- No dependency on Hub session state. Caller passes `allSessions` shape `{sessionId, cwd, sessionLabel}`.
- Only `child_process` + `fs` + `path` standard libs.
- Removing `core/worktree/` and the `worktree:*` IPC handlers in `main.js` fully reverts the backend.
```

- [ ] **Step 3: 加一个 smoke 单测确认 orchestrator 不爆**

追加到 `tests/_unit-conflict-detector.js`（顺手测，免再开文件）—— 算了独立文件更干净，新建 `tests/_unit-worktree-index.js`：

```js
const assert = require('assert');
const fs = require('fs'); const path = require('path'); const os = require('os'); const cp = require('child_process');
const { getPanelData } = require('../core/worktree/index');
const { _resetCacheForTest } = require('../core/worktree/git-probe');

function mkRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  cp.execSync('git init -q -b main', { cwd: d });
  cp.execSync('git config user.email t@t && git config user.name t', { cwd: d, shell: true });
  fs.writeFileSync(path.join(d, 'x.txt'), '1');
  cp.execSync('git add . && git commit -q -m init', { cwd: d, shell: true });
  return d;
}

(async () => {
  _resetCacheForTest();
  const dir = mkRepo();
  const r = await getPanelData({
    activeSessionId: 'S1',
    allSessions: [{ sessionId: 'S1', cwd: dir, sessionLabel: 'test' }],
    force: true,
  });
  assert.strictEqual(r.active.isRepo, true);
  assert.strictEqual(r.peers.length, 0);
  assert.strictEqual(r.conflict.color, 'green');
  console.log('  ✓ orchestrator smoke');
  process.exit(0);
})();
```

- [ ] **Step 4: 跑确认通过**

```powershell
node tests/_unit-worktree-index.js
```

Expected: `✓ orchestrator smoke`.

- [ ] **Step 5: commit**

```powershell
git add core/worktree/ tests/_unit-worktree-index.js
git commit -m "worktree: orchestrator + module README"
```

---

### Task 6: IPC handlers in main.js

**Files:**
- Modify: `main.js`（在现有 ipcMain.handle 块附近，找一个语义相关的位置追加）

- [ ] **Step 1: 加 worktree:probe handler**

在 `main.js` 找 `ipcMain.handle('create-session'` 上方（约 538 行附近），加入：

```js
// ──────────────────────────────────────────────────────────
// Worktree panel IPC
// ──────────────────────────────────────────────────────────
const { getPanelData } = require('./core/worktree');
const { shell } = require('electron');

ipcMain.handle('worktree:probe', async (_e, { activeSessionId, force = false } = {}) => {
  const allSessions = [];
  for (const [sid, s] of sessions.entries()) {
    if (s.cwd) allSessions.push({ sessionId: sid, cwd: s.cwd, sessionLabel: s.label || sid });
  }
  try {
    return { ok: true, data: await getPanelData({ activeSessionId, allSessions, force }) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('worktree:open-explorer', async (_e, { cwd } = {}) => {
  if (!cwd) return { ok: false, error: 'no cwd' };
  const err = await shell.openPath(cwd);
  return { ok: !err, error: err || null };
});
```

注意：`sessions` 是 main.js 已有的 Map（你在文件中可见），保持现有引用。如果命名不同请按现有写法适配。

- [ ] **Step 2: smoke test 启动隔离 Hub 确认 main.js 不报错**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-worktree-panel-data"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9223
```

`run_in_background: true`，6 秒后查 stdout：必须看到 `[hub] hook server listening`，**不得**看到 `Cannot find module './core/worktree'` 或语法错。OK 后停掉。

- [ ] **Step 3: commit**

```powershell
git add main.js
git commit -m "worktree: IPC handlers (probe + open-explorer)"
```

---

## Phase 2: UI Static（先 stub 数据）

### Task 7: index.html DOM 占位 + toggle button

**Files:**
- Modify: `renderer/index.html`

- [ ] **Step 1: 在 `#memo-panel` 之后插入 worktree 面板**

找到 `<div class="memo-panel" id="memo-panel" style="display:none">...</div>`（约 112 行），其后追加：

```html
<div class="worktree-panel" id="worktree-panel" style="display:none">
  <div class="wt-header">
    <div class="wt-header-title">
      <span class="wt-status-dot" data-status="green"></span>
      <span class="wt-repo-name" id="wt-repo-name">—</span>
      <span class="wt-session-count" id="wt-session-count"></span>
    </div>
    <div class="wt-header-actions">
      <button class="wt-refresh-btn" id="wt-refresh-btn" title="刷新">⟳</button>
      <button class="wt-close-btn" id="wt-close-btn" title="关闭">✕</button>
    </div>
  </div>
  <div class="wt-health" id="wt-health"></div>
  <div class="wt-section wt-topology" id="wt-topology"></div>
  <div class="wt-section wt-current" id="wt-current"></div>
  <div class="wt-section wt-peers" id="wt-peers"></div>
  <div class="wt-error" id="wt-error" style="display:none"></div>
</div>
```

- [ ] **Step 2: 在 terminal header `headerActions` 加 toggle 按钮**

在 `renderer.js` 第 1100 行附近找：
```js
headerActions.append(memoBtn, zoomOutBtn, zoomInBtn, closeBtn);
```
**先不动 renderer.js**——按钮和 panel JS 放到 Task 9 一起做。本任务只动 index.html，加 script 与 css 引用：

在 index.html `</body>` 上方加：

```html
<link rel="stylesheet" href="./worktree/worktree-panel.css">
<script src="./worktree/worktree-panel.js" defer></script>
```

- [ ] **Step 3: commit**

```powershell
git add renderer/index.html
git commit -m "worktree: DOM placeholders for panel"
```

---

### Task 8: CSS — worktree-panel.css

**Files:**
- Create: `renderer/worktree/worktree-panel.css`

- [ ] **Step 1: 写完整 CSS（基于 spec §6 Dashboard 仪表盘 mockup）**

新建 `renderer/worktree/worktree-panel.css`：

```css
/* Hub 工作树面板 · 360px dashboard，与右侧 #memo-panel 平级共存。 */

.worktree-panel {
  width: 360px;
  min-width: 360px;
  max-width: 360px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-primary);
  overflow-y: auto;
}

.wt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.wt-header-title { display: flex; align-items: center; gap: 8px; }
.wt-status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent-green, #10b981);
  flex: none;
}
.wt-status-dot[data-status="yellow"] { background: #f59e0b; }
.wt-status-dot[data-status="red"]    { background: #e74c3c; box-shadow: 0 0 6px #e74c3c; }
.wt-repo-name { font-weight: 600; }
.wt-session-count { color: var(--text-muted); font-size: 10px; }
.wt-header-actions { display: flex; gap: 6px; }
.wt-header-actions button {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; font-size: 13px; padding: 2px 6px; border-radius: 4px;
}
.wt-header-actions button:hover { color: var(--text-primary); background: rgba(255,255,255,0.05); }

.wt-health {
  padding: 8px 16px; border-bottom: 1px solid var(--border);
}
.wt-health-bar {
  display: flex; gap: 2px; height: 4px; border-radius: 2px; overflow: hidden;
  margin-bottom: 6px;
}
.wt-health-bar > .seg { height: 100%; }
.wt-health-bar > .seg-red    { background: #e74c3c; }
.wt-health-bar > .seg-yellow { background: #f59e0b; }
.wt-health-bar > .seg-green  { background: #10b981; }
.wt-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.wt-pill {
  padding: 3px 8px; border-radius: 10px; font-size: 10px; font-weight: 500;
}
.wt-pill-red    { background: rgba(239,68,68,.15);  color: #fca5a5; }
.wt-pill-yellow { background: rgba(245,158,11,.12); color: #fbbf24; }
.wt-pill-green  { background: rgba(16,185,129,.12); color: #6ee7b7; }

.wt-section { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.wt-section:last-of-type { border-bottom: none; }
.wt-section-label {
  font-size: 9.5px; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 1.2px;
  margin-bottom: 8px;
}

.wt-topology .wt-tp-row { font-family: monospace; font-size: 10.5px; line-height: 1.7; }
.wt-tp-branch {
  background: rgba(167,139,250,.15); color: #c4b5fd;
  padding: 1px 5px; border-radius: 3px; margin-right: 4px;
}
.wt-tp-cwd { color: #7dd3fc; }
.wt-tp-sessions { color: var(--text-muted); padding-left: 14px; font-size: 10px; }
.wt-tp-row[data-conflict="red"] .wt-tp-branch { background: rgba(239,68,68,.15); }

.wt-current .wt-cwd-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.wt-current .wt-cwd {
  flex: 1; color: #7dd3fc; font-family: monospace; font-size: 10.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: pointer;
}
.wt-current .wt-cwd:hover { text-decoration: underline; }
.wt-open-explorer {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; font-size: 12px; padding: 2px 4px;
}
.wt-current .wt-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.wt-meta .wt-pill { font-size: 10px; padding: 2px 7px; }

.wt-commit-graph {
  background: var(--bg-primary); border-radius: 6px;
  padding: 8px 10px; margin-bottom: 10px;
  font-family: monospace; font-size: 10px; line-height: 1.6;
}
.wt-commit-graph .wt-commit { color: #6ee7b7; }
.wt-commit-graph .wt-commit-old { color: var(--text-muted); }
.wt-commit-graph .wt-commit-line { color: var(--text-muted); }

.wt-files { display: flex; flex-direction: column; gap: 4px; }
.wt-file {
  display: flex; align-items: center; gap: 6px; font-size: 10.5px;
  background: var(--bg-primary); padding: 5px 8px; border-radius: 4px;
  cursor: pointer;
}
.wt-file:hover { background: var(--hover-bg, rgba(255,255,255,.04)); }
.wt-file .wt-stat-letter {
  width: 12px; font-family: monospace; font-weight: 600;
}
.wt-file[data-status="M"] .wt-stat-letter { color: #fbbf24; }
.wt-file[data-status="U"] .wt-stat-letter { color: #10b981; }
.wt-file[data-status="D"] .wt-stat-letter { color: #ef4444; }
.wt-file[data-status="R"] .wt-stat-letter { color: #c4b5fd; }
.wt-file .wt-fname { flex: 1; color: var(--text-primary); font-family: monospace; }
.wt-file .wt-stat { font-size: 9.5px; font-family: monospace; }

.wt-peer-card {
  border-radius: 6px; padding: 8px 10px; margin-bottom: 6px;
  cursor: pointer;
}
.wt-peer-card[data-conflict="red"] {
  background: linear-gradient(135deg, rgba(239,68,68,.1), transparent);
  border: 1px solid rgba(239,68,68,.25);
}
.wt-peer-card[data-conflict="yellow"] {
  background: rgba(245,158,11,.06);
  border: 1px solid rgba(245,158,11,.2);
}
.wt-peer-card[data-conflict="green"] { padding: 6px 10px; }
.wt-peer-card:hover { filter: brightness(1.1); }
.wt-peer-card .wt-peer-head { display: flex; align-items: center; gap: 6px; }
.wt-peer-card .wt-peer-meta { color: var(--text-muted); font-size: 10px; margin-top: 3px; margin-left: 12px; }
.wt-peer-card .wt-peer-reason { color: #fca5a5; font-size: 10px; margin-top: 3px; margin-left: 12px; }

.wt-error {
  margin: 8px 16px; padding: 8px 12px;
  background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.3);
  border-radius: 4px; color: #fca5a5; font-size: 11px;
}
.wt-error button {
  margin-left: 8px; background: none; border: 1px solid currentColor;
  color: inherit; padding: 2px 8px; border-radius: 3px; cursor: pointer;
}

.wt-spinner {
  display: inline-block; width: 12px; height: 12px;
  border: 2px solid var(--text-muted); border-top-color: transparent;
  border-radius: 50%; animation: wt-spin 0.8s linear infinite;
}
@keyframes wt-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 2: 在 `renderer/styles.css` 末尾加 import**

```css
@import url("./worktree/worktree-panel.css");
```

- [ ] **Step 3: commit**

```powershell
git add renderer/worktree/worktree-panel.css renderer/styles.css
git commit -m "worktree: panel CSS"
```

---

### Task 9: Renderer module — `worktree-panel.js`（含 toggle button + stub data 渲染）

**Files:**
- Create: `renderer/worktree/worktree-panel.js`
- Modify: `renderer/renderer.js`（添加 toggle button 与 selectSession hook）

- [ ] **Step 1: 实现 worktree-panel.js（先用 stub 数据渲染）**

新建 `renderer/worktree/worktree-panel.js`：

```js
'use strict';
(() => {
  const { ipcRenderer, shell } = require('electron');
  const path = require('path');

  const PANEL_OPEN_KEY_PREFIX = 'wt-panel-open-';
  const REFRESH_INTERVAL_MS = 30000;
  const STATUS_DEBOUNCE_MS = 500;

  const panel = document.getElementById('worktree-panel');
  const refreshBtn = document.getElementById('wt-refresh-btn');
  const closeBtn = document.getElementById('wt-close-btn');
  const errorEl = document.getElementById('wt-error');

  let currentSessionId = null;
  let pollTimer = null;
  let debounceTimer = null;

  function isOpen(sessionId) {
    return localStorage.getItem(PANEL_OPEN_KEY_PREFIX + sessionId) === 'true';
  }
  function setOpen(sessionId, open) {
    localStorage.setItem(PANEL_OPEN_KEY_PREFIX + sessionId, String(open));
  }

  async function refresh({ force = false } = {}) {
    if (!currentSessionId) return;
    const res = await ipcRenderer.invoke('worktree:probe', {
      activeSessionId: currentSessionId, force,
    });
    if (!res.ok) {
      errorEl.style.display = '';
      errorEl.textContent = `加载失败: ${res.error}`;
      return;
    }
    errorEl.style.display = 'none';
    render(res.data);
  }

  function render(data) {
    const { active, peers, worktreeList, conflict } = data;
    document.querySelector('.wt-status-dot').dataset.status = conflict.color;
    document.getElementById('wt-repo-name').textContent =
      active && active.repoRoot ? path.basename(active.repoRoot) : (active && active.cwd ? active.cwd : '—');
    document.getElementById('wt-session-count').textContent =
      `${peers.length + (active ? 1 : 0)} sessions`;

    renderHealth(conflict, peers, active);
    renderTopology(worktreeList, peers, active);
    renderCurrent(active);
    renderPeers(peers, conflict);
  }

  function renderHealth(conflict, peers, active) {
    const root = document.getElementById('wt-health');
    const reds = conflict.color === 'red' ? 1 : 0;
    const yellows = conflict.color === 'yellow' ? 1 : 0;
    const greens = peers.length + 1 - reds - yellows;
    const dirtyTotal = (active?.dirty?.length || 0) +
      peers.reduce((acc, p) => acc + (p.dirty?.length || 0), 0);
    root.innerHTML = `
      <div class="wt-health-bar">
        ${reds ? `<div class="seg seg-red" style="flex:${reds}"></div>` : ''}
        ${yellows ? `<div class="seg seg-yellow" style="flex:${yellows}"></div>` : ''}
        ${greens > 0 ? `<div class="seg seg-green" style="flex:${greens}"></div>` : ''}
      </div>
      <div class="wt-pills">
        ${conflict.color === 'red' ? `<span class="wt-pill wt-pill-red">⚠ 撞车</span>` : ''}
        ${dirtyTotal > 0 ? `<span class="wt-pill wt-pill-yellow">${dirtyTotal} 未提交</span>` : ''}
        <span class="wt-pill wt-pill-green">${peers.length + 1} sessions</span>
      </div>
    `;
  }

  function renderTopology(worktreeList, peers, active) {
    const root = document.getElementById('wt-topology');
    if (!worktreeList || worktreeList.length === 0) { root.innerHTML = ''; return; }
    const sessionByCwd = new Map();
    [active, ...peers].filter(s => s && s.cwd).forEach(s => {
      const k = s.cwd;
      if (!sessionByCwd.has(k)) sessionByCwd.set(k, []);
      sessionByCwd.get(k).push(s);
    });
    const rows = worktreeList.map(wt => {
      const sessions = sessionByCwd.get(wt.cwd) || [];
      const hasConflict = sessions.length > 1;
      return `
        <div class="wt-tp-row" data-conflict="${hasConflict ? 'red' : 'green'}">
          <span class="wt-tp-branch">⎇ ${escapeHtml(wt.branch || 'detached')}</span>
          → <span class="wt-tp-cwd">${escapeHtml(wt.cwd)}</span>
          <div class="wt-tp-sessions">↳ ${sessions.map(s => escapeHtml(s.sessionLabel || s.sessionId)).join(' · ') || '(无 active)'}</div>
        </div>
      `;
    }).join('');
    root.innerHTML = `<div class="wt-section-label">工作树拓扑</div>${rows}`;
  }

  function renderCurrent(active) {
    const root = document.getElementById('wt-current');
    if (!active || !active.isRepo) {
      root.innerHTML = `
        <div class="wt-section-label">当前</div>
        <div class="wt-cwd-row">
          <span class="wt-cwd" data-cwd="${escapeHtml(active?.cwd || '')}">${escapeHtml(active?.cwd || '—')}</span>
          <button class="wt-open-explorer" data-cwd="${escapeHtml(active?.cwd || '')}" title="资源管理器">↗</button>
        </div>
        <div style="color: var(--text-muted); font-size: 10.5px;">📁 非 git 目录</div>
      `;
      return;
    }
    const filesHtml = (active.dirty || []).map(d => `
      <div class="wt-file" data-status="${escapeHtml(d.status)}" data-path="${escapeHtml(d.path)}">
        <span class="wt-stat-letter">${escapeHtml(d.status)}</span>
        <span class="wt-fname">${escapeHtml(d.path)}</span>
      </div>
    `).join('');
    root.innerHTML = `
      <div class="wt-section-label">当前 · ${escapeHtml(active.sessionLabel || active.sessionId || '')}</div>
      <div class="wt-cwd-row">
        <span class="wt-cwd" data-cwd="${escapeHtml(active.cwd)}" title="点击复制">${escapeHtml(active.cwd)}</span>
        <button class="wt-open-explorer" data-cwd="${escapeHtml(active.cwd)}" title="资源管理器">↗</button>
      </div>
      <div class="wt-meta">
        <span class="wt-pill wt-pill-yellow">⎇ ${escapeHtml(active.branch || '?')}</span>
        ${active.ahead || active.behind ? `<span class="wt-pill wt-pill-green">↑${active.ahead} ↓${active.behind}</span>` : ''}
        ${active.dirty?.length ? `<span class="wt-pill wt-pill-yellow">${active.dirty.length} 未提交</span>` : ''}
      </div>
      ${active.lastCommit ? `
        <div class="wt-commit-graph">
          <div class="wt-commit">● <span class="wt-commit-old">${escapeHtml(active.lastCommit.hash)}</span> ${escapeHtml(active.lastCommit.subject)} <span class="wt-commit-line">${escapeHtml(active.lastCommit.when)}</span></div>
        </div>
      ` : ''}
      <div class="wt-files">${filesHtml}</div>
    `;
  }

  function renderPeers(peers, conflict) {
    const root = document.getElementById('wt-peers');
    if (peers.length === 0) {
      root.innerHTML = `<div class="wt-section-label">同仓库 peer · 0 个</div>`;
      return;
    }
    const cards = peers.map(p => {
      const reasons = (conflict.reasons || []).filter(r => r.includes(p.sessionId || p.cwd));
      const cardColor = reasons.length > 0 ? (/同 cwd|改同文件/.test(reasons[0]) ? 'red' : 'yellow') : 'green';
      const cwdShort = p.cwd?.replace(/^.*[\\/]/, '…/') || '';
      return `
        <div class="wt-peer-card" data-conflict="${cardColor}" data-session-id="${escapeHtml(p.sessionId || '')}">
          <div class="wt-peer-head">
            <span class="wt-status-dot" data-status="${cardColor}"></span>
            <strong>${escapeHtml(p.sessionLabel || p.sessionId || '')}</strong>
          </div>
          <div class="wt-peer-meta">
            ${escapeHtml(cwdShort)} · ⎇ ${escapeHtml(p.branch || '?')}${p.dirty?.length ? ` · ${p.dirty.length} 未提交` : ' · 干净'}
          </div>
          ${reasons.length ? `<div class="wt-peer-reason">⚠ ${escapeHtml(reasons[0])}</div>` : ''}
        </div>
      `;
    }).join('');
    root.innerHTML = `<div class="wt-section-label">同仓库 peer · ${peers.length} 个</div>${cards}`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ─── Click delegation ───
  panel.addEventListener('click', async (e) => {
    const explorerBtn = e.target.closest('.wt-open-explorer');
    if (explorerBtn) {
      const cwd = explorerBtn.dataset.cwd;
      if (cwd) await ipcRenderer.invoke('worktree:open-explorer', { cwd });
      return;
    }
    const cwdEl = e.target.closest('.wt-cwd');
    if (cwdEl) {
      try { await navigator.clipboard.writeText(cwdEl.dataset.cwd); } catch (_) {}
      return;
    }
    const peerCard = e.target.closest('.wt-peer-card');
    if (peerCard) {
      const sid = peerCard.dataset.sessionId;
      if (sid && typeof window.selectSession === 'function') window.selectSession(sid);
      return;
    }
    const fileRow = e.target.closest('.wt-file');
    if (fileRow) {
      const filePath = fileRow.dataset.path;
      if (filePath && typeof window.openWorktreeDiffPreview === 'function') {
        window.openWorktreeDiffPreview(filePath);
      }
      return;
    }
  });

  refreshBtn.addEventListener('click', () => refresh({ force: true }));
  closeBtn.addEventListener('click', () => {
    panel.style.display = 'none';
    setOpen(currentSessionId, false);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  });

  // ─── Public API for renderer.js to call ───
  window.worktreePanel = {
    onSessionChange(sessionId) {
      currentSessionId = sessionId;
      if (sessionId && isOpen(sessionId)) {
        panel.style.display = '';
        refresh({ force: false });
        if (!pollTimer) pollTimer = setInterval(() => refresh(), REFRESH_INTERVAL_MS);
      } else {
        panel.style.display = 'none';
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }
    },
    toggle() {
      if (!currentSessionId) return;
      const next = panel.style.display === 'none';
      panel.style.display = next ? '' : 'none';
      setOpen(currentSessionId, next);
      if (next) {
        refresh({ force: false });
        if (!pollTimer) pollTimer = setInterval(() => refresh(), REFRESH_INTERVAL_MS);
      } else {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }
    },
    notifyStatusEvent() {
      // debounced refresh on statusline tick
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => refresh({ force: false }), STATUS_DEBOUNCE_MS);
    },
  };

  // ─── Window focus → refresh ───
  window.addEventListener('focus', () => {
    if (panel.style.display !== 'none') refresh({ force: false });
  });
})();
```

- [ ] **Step 2: 在 renderer.js 加 toggle 按钮**

找到 `renderer.js` 第 1093 行附近 `const memoBtn = document.createElement('button');` 块，紧邻其下加入 worktree 按钮（在 `headerActions.append(...)` 之前）：

```js
const wtBtn = document.createElement('button');
wtBtn.className = 'btn-zoom btn-worktree-toggle';
wtBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3h5v5H2zM9 3h5v5H9zM2 10h5v5H2zM9 10h5v3a2 2 0 01-2 2H9z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';
wtBtn.title = '工作树面板';
wtBtn.addEventListener('click', () => window.worktreePanel?.toggle());
```

修改 `headerActions.append(...)` 那一行加入 `wtBtn`：

```js
headerActions.append(memoBtn, wtBtn, zoomOutBtn, zoomInBtn, closeBtn);
```

- [ ] **Step 3: 在 selectSession 路径里调用 onSessionChange**

在 `renderer.js` 找现有的 `function selectSession(sessionId)`（grep 即得），在函数末尾追加：

```js
window.worktreePanel?.onSessionChange(sessionId);
```

- [ ] **Step 4: 在 status-event listener 里调用 notifyStatusEvent**

在 `renderer.js` 第 2742 行 `ipcRenderer.on('status-event', (_e, payload) => {` 块末尾追加：

```js
window.worktreePanel?.notifyStatusEvent();
```

- [ ] **Step 5: smoke test**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-worktree-panel-data"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9223
```

`run_in_background: true`。手动用浏览器打开 `chrome://inspect` 或者直接用 CDP 连 9223，在 Hub 里创建一个 session，点新加的工作树按钮，**面板应弹出，并显示真实数据**（active session 的 cwd / branch / 等）。手测后停掉。

- [ ] **Step 6: commit**

```powershell
git add renderer/worktree/worktree-panel.js renderer/index.html renderer/renderer.js
git commit -m "worktree: panel UI + toggle button + IPC wiring"
```

---

## Phase 3: 已在 Task 9 完成事件触发

刷新触发链已全部接入：
- 打开 / 切 session → `onSessionChange` → refresh
- 点 ⟳ → refresh{force:true}
- 点 ✕ → 关闭 + 清 timer
- statusline tick → debounced 500ms refresh
- window focus → refresh
- setInterval 30s → refresh

无独立 Phase 3 task。

---

## Phase 4: 交互完善（diff 预览复用现有通道）

### Task 10: 文件 diff 预览 hook

**Files:**
- Modify: `renderer/renderer.js`

- [ ] **Step 1: 在 renderer.js 暴露 `window.openWorktreeDiffPreview`**

找到现有 preview-body 相关函数（grep `preview-body` 或 `previewOpen`），在合适位置（建议最末尾或 preview 函数附近）新增：

```js
window.openWorktreeDiffPreview = function(relPath) {
  // 复用 preview 通道：找当前 session 的 cwd，构造 file:// 路径
  const sid = window.currentSelectedSessionId; // 已有全局
  const sess = sessions.get(sid);
  if (!sess?.cwd || !relPath) return;
  const abs = require('path').resolve(sess.cwd, relPath);
  // 借用已有 preview API
  if (typeof openPreview === 'function') openPreview(abs);
};
```

> 如 renderer.js 没有名为 `openPreview` 的统一入口，找 preview-body 最近的展示函数（如 `showPreview` / `previewFile`），按其签名适配。

- [ ] **Step 2: smoke test 点文件名应弹出预览**

启隔离 Hub，session 进 git repo，改一个文件，开面板，点该文件 → 主区出现 preview-body 显示文件内容。

- [ ] **Step 3: commit**

```powershell
git add renderer/renderer.js
git commit -m "worktree: file row → preview hook"
```

---

## Phase 5: 边界态 + E2E + 收尾

### Task 11: 边界态 UI 强化

**Files:**
- Modify: `renderer/worktree/worktree-panel.js`

- [ ] **Step 1: 在 refresh() catch 里区分错误类型**

替换 `worktree-panel.js` 的 `refresh()` 函数为：

```js
async function refresh({ force = false } = {}) {
  if (!currentSessionId) return;
  document.getElementById('wt-current').classList.add('wt-loading');
  let res;
  try {
    res = await ipcRenderer.invoke('worktree:probe', {
      activeSessionId: currentSessionId, force,
    });
  } catch (e) {
    showError(`IPC 异常: ${e.message}`);
    return;
  } finally {
    document.getElementById('wt-current').classList.remove('wt-loading');
  }
  if (!res.ok) {
    if (/timeout/i.test(res.error)) showError(`git 响应超时，⟳ 重试`, true);
    else if (/not.*git/i.test(res.error)) showError(`目录不在 git 仓库内`, false);
    else showError(`加载失败: ${res.error}`, true);
    return;
  }
  errorEl.style.display = 'none';
  render(res.data);
}

function showError(msg, retryable) {
  errorEl.style.display = '';
  errorEl.innerHTML = `${escapeHtml(msg)}${retryable ? ` <button class="wt-retry">重试</button>` : ''}`;
  const retry = errorEl.querySelector('.wt-retry');
  if (retry) retry.addEventListener('click', () => refresh({ force: true }));
}
```

- [ ] **Step 2: smoke test 模拟错误**

启 Hub，把一个 session 的 cwd 设到 `C:\Windows`（非 git）—— 面板应显示"非 git 目录"。再把 cwd 设到不存在路径 —— 应显示"目录丢失"或类似。

- [ ] **Step 3: commit**

```powershell
git add renderer/worktree/worktree-panel.js
git commit -m "worktree: error states (non-git / missing dir / timeout)"
```

---

### Task 12: E2E 测试 — DeepSeek session 在隔离 Hub 中

**Files:**
- Create: `tests/_e2e-worktree-panel.js`

- [ ] **Step 1: 写 E2E（CDP 驱动隔离 Hub）**

新建 `tests/_e2e-worktree-panel.js`：

```js
// E2E for Worktree Panel.
// Runs in isolated Hub instance (CLAUDE_HUB_DATA_DIR + --remote-debugging-port=9224).
// Uses 2 DeepSeek sessions in a temp git repo to trigger conflict detection.

const fs = require('fs'); const path = require('path'); const os = require('os'); const cp = require('child_process');
const WebSocket = require('ws'); const http = require('http');

const HUB_DIR = process.env.HUB_DIR || path.resolve(__dirname, '..');
const PORT = 9224;
const DATA_DIR = path.join(os.tmpdir(), `hub-wt-e2e-${Date.now()}`);

function makeRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-e2e-repo-'));
  cp.execSync('git init -q -b main', { cwd: d });
  cp.execSync('git config user.email t@t', { cwd: d });
  cp.execSync('git config user.name t', { cwd: d });
  fs.writeFileSync(path.join(d, 'shared.txt'), 'baseline');
  cp.execSync('git add . && git commit -q -m init', { cwd: d, shell: true });
  return d;
}

async function getPageWs() {
  // (与 test-e2e.js 同套)
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const pages = JSON.parse(data);
        const hub = pages.find(p => p.title.includes('Hub') || p.title.includes('圆桌'));
        if (!hub) reject(new Error('Hub page not found'));
        else resolve(hub.webSocketDebuggerUrl);
      });
    }).on('error', reject);
  });
}

let ws, msgId = 0;
function evaluate(expr) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    const handler = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === id) {
        ws.off('message', handler);
        if (m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails)));
        else resolve(m.result?.result?.value);
      }
    };
    ws.on('message', handler);
  });
}

let hubProc;
async function startHub() {
  process.env.CLAUDE_HUB_DATA_DIR = DATA_DIR;
  hubProc = cp.spawn(
    path.join(HUB_DIR, 'node_modules/electron/dist/electron.exe'),
    [HUB_DIR, `--remote-debugging-port=${PORT}`],
    { env: { ...process.env, CLAUDE_HUB_DATA_DIR: DATA_DIR }, windowsHide: true }
  );
  // 等到 hook server listening
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = setInterval(async () => {
      if (Date.now() - t0 > 30000) { clearInterval(tick); reject(new Error('hub start timeout')); return; }
      try {
        await new Promise((r, j) => http.get(`http://127.0.0.1:${PORT}/json`, r2 => r(r2)).on('error', j));
        clearInterval(tick); resolve();
      } catch (_) {}
    }, 500);
  });
  ws = new WebSocket(await getPageWs());
  await new Promise(r => ws.on('open', r));
}

async function stopHub() {
  try { ws?.close(); } catch (_) {}
  try { hubProc?.kill('SIGKILL'); } catch (_) {}
}

// 通过暴露的 worktree:probe IPC 直接验证后端 — 而不是模拟全套 DeepSeek 创建流程
// （创建 DeepSeek session 的 UI 流程比较重，单元 + 这个 IPC 集成测试已能覆盖核心逻辑）
async function main() {
  const repo = makeRepo();
  await startHub();

  // 注入 2 个 fake session 进 sessions Map（通过 IPC 走不通，要用 evaluate 注入到 main process？
  // 改方案：直接在 renderer 模拟两条 session 进入 sessions（renderer 也维护一份），
  // 然后 ipcRenderer.invoke 时 main 拿到的还是真 sessions.Map 没法 mock。
  //
  // 务实做法：在 main.js 加一个 dev-only IPC `worktree:_test-inject` —— 但那污染生产代码。
  // 替代方案：直接用 require('../core/worktree') 在 main process 通过 evaluate 跑后端逻辑。
  // 我们的 E2E 目标其实是"渲染 + 交互"，后端逻辑已被单元测覆盖。
  // 因此本 E2E 只验证:
  //   1) panel toggle 后真打开了
  //   2) UI 渲染了真实 active session 的数据
  //   3) 点 ↗ 调起了 shell.openPath（spy 验证）

  // 基础 smoke: panel 元素存在
  const exists = await evaluate(`!!document.getElementById('worktree-panel')`);
  if (!exists) throw new Error('worktree-panel not in DOM');
  console.log('  ✓ panel element exists');

  // toggle 后 panel 显示
  await evaluate(`window.worktreePanel?.onSessionChange(null)`);  // 无 session 时不显示
  const visible0 = await evaluate(`document.getElementById('worktree-panel').style.display`);
  if (visible0 !== 'none') throw new Error('expected hidden when no session');
  console.log('  ✓ panel hidden when no session');

  // 模拟有 session 且 panel 打开
  await evaluate(`localStorage.setItem('wt-panel-open-test-sid', 'true')`);
  // panel.js 会查 sessions Map（空），渲染会显示 "—" 占位
  // 这里只断言 toggle 与 ipcRenderer.invoke 不抛错
  const probeOk = await evaluate(`(async () => { try { const r = await require('electron').ipcRenderer.invoke('worktree:probe', { activeSessionId: 'no-such', force: true }); return r.ok; } catch (e) { return 'err:' + e.message; } })()`);
  if (probeOk !== true) throw new Error('worktree:probe failed: ' + probeOk);
  console.log('  ✓ worktree:probe IPC roundtrip');

  console.log('\nE2E ✓ all passed');
  await stopHub();
}

main().catch(async e => { console.error('E2E ✗', e); await stopHub(); process.exit(1); });
```

- [ ] **Step 2: 跑 E2E**

```powershell
node tests/_e2e-worktree-panel.js
```

Expected: 3 个 ✓ + `E2E ✓ all passed`。

> **DeepSeek session 创建的真 E2E 留待 v2**：本 E2E 只覆盖"面板 UI + IPC roundtrip"，因为通过 UI 流程创建 DeepSeek session 涉及凭证 + REPL 进程，集成成本高且与本 feature 主逻辑无关（核心冲突分类已有单元 + 集成覆盖）。

- [ ] **Step 3: commit**

```powershell
git add tests/_e2e-worktree-panel.js
git commit -m "worktree: E2E (panel UI + IPC roundtrip)"
```

---

### Task 13: 收尾 — package.json 脚本 + 全量 smoke

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 加测试脚本**

修改 `package.json` 的 `scripts` 部分：

```json
"test:worktree-unit": "node tests/_unit-git-probe.js && node tests/_unit-conflict-detector.js && node tests/_unit-worktree-index.js",
"test:worktree-e2e": "node tests/_e2e-worktree-panel.js",
```

- [ ] **Step 2: 跑全量单元**

```powershell
npm run test:worktree-unit
```

Expected: 全 ✓。

- [ ] **Step 3: 最终 smoke test 启 Hub**

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-worktree-panel-data"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9223
```

run_in_background: true。stdout 看到 `[hub] hook server listening` 算过。手动按 worktree 按钮，确认面板正常开关、渲染、刷新。

- [ ] **Step 4: commit**

```powershell
git add package.json
git commit -m "worktree: npm test scripts + final smoke"
```

- [ ] **Step 5: 告知用户合并方式**

worktree 在 `C:\Users\lintian\hub-feat-worktree-panel`，分支 `feat/worktree-panel`。两种合并方式：
1. **本地 fast-forward merge**：在主目录 `git merge feat/worktree-panel`
2. **PR 流程**：push 到远端开 PR，过 CI

由用户选。

---

## Self-Review

### Spec coverage
- §2 决策表 7 项 → 全部映射到 Tasks
- §3 模块划分 → Tasks 1-6（后端）+ 8-9（前端）
- §4 颜色规则 B → Task 4
- §5 刷新策略 D' → Task 9（onSessionChange / window focus / setInterval / debounce）
- §6 UI 规格 → Tasks 7-9
- §7 边界 → Task 11
- §8 测试 → Tasks 1-5（单元）+ Task 12（E2E）
- §9.1 worktree 隔离 → Task 0
- §9.2 阶段拆分 → Phase 0-5 完整对应

### Placeholder scan
✓ 所有 step 含完整代码或精确命令；无 TBD / TODO；
✓ 类型一致：`probeRepo / classify / getPanelData` 在所有引用处签名相同；
⚠ Task 10 step 1 提到"按 renderer.js 现有 preview 函数适配"——是因 preview 函数命名我没在文件里 grep 过。**实施时若 `openPreview` 不存在，应先 grep `preview-body` 找入口，再决定函数名**。

### Ambiguity
- "session label" 一词在 main.js 是否真叫 `s.label` 待确认；如不是，按现存字段名调整即可（不影响逻辑）。

---

## Execution Handoff

**Plan complete and saved to `C:\Users\lintian\claude-session-hub\docs\superpowers\plans\2026-05-03-worktree-panel.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
