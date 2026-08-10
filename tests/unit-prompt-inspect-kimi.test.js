'use strict';
// core/prompt-inspect.js 的 kimi 分支单测。
// 断言依据 2026-07-29 探针实测（4 组路径起真实 kimi 会话 + wire.jsonl 核对 From 来源）：
//   - 只读 AGENTS.md，最近 .git 根向下收集到 cwd，嵌套 git 仓库会挡住外层
//   - 没有 .git 时退化为只读 cwd 自己那一份
//   - 全局 = ~/.kimi-code/AGENTS.md；无 Claude 式 memory 桶 → 记忆检查按 kind 跳过

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PI = require('../core/prompt-inspect.js');
const PROMPT_INSPECTOR_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'prompt-inspector.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function withTree(fn) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kimi-inspect-')));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 项目级条目 = 在 tmp root 内的那部分（全局 ~/.kimi-code/AGENTS.md 视本机情况可有可无）
function projectEntries(chain, root) {
  return chain.entries.filter(e => e.path.startsWith(root));
}

console.log('Running prompt-inspect kimi tests...');

test('kimi 链：.git 根向下收集到 cwd，根之上的 AGENTS.md 不读', () => {
  withTree((root) => {
    const deep = path.join(root, 'proj', 'sub', 'deep');
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(path.join(root, 'proj', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'OUTER', 'utf8');           // git 根之上 → 不读
    fs.writeFileSync(path.join(root, 'proj', 'AGENTS.md'), 'PROJ', 'utf8');
    fs.writeFileSync(path.join(root, 'proj', 'sub', 'AGENTS.md'), 'SUB', 'utf8');

    const chain = PI.discoverKimiChain(deep);
    assert.strictEqual(chain.projectRoot, path.join(root, 'proj'));
    assert.deepStrictEqual(chain.markers, ['.git']);
    const rels = projectEntries(chain, root).map(e => path.relative(root, e.path));
    assert.deepStrictEqual(rels, [path.join('proj', 'AGENTS.md'), path.join('proj', 'sub', 'AGENTS.md')]);
  });
});

test('kimi 链：嵌套 git 仓库挡住外层根', () => {
  withTree((root) => {
    const deep = path.join(root, 'outer', 'inner', 'sub');
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(path.join(root, 'outer', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'outer', 'inner', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'outer', 'AGENTS.md'), 'OUTER', 'utf8');   // 被内层 .git 挡住
    fs.writeFileSync(path.join(root, 'outer', 'inner', 'AGENTS.md'), 'INNER', 'utf8');

    const chain = PI.discoverKimiChain(deep);
    assert.strictEqual(chain.projectRoot, path.join(root, 'outer', 'inner'));
    const rels = projectEntries(chain, root).map(e => path.relative(root, e.path));
    assert.deepStrictEqual(rels, [path.join('outer', 'inner', 'AGENTS.md')]);
  });
});

test('kimi 链：没有 .git 时只读 cwd 自己那一份', () => {
  withTree((root) => {
    const sub = path.join(root, 'plain', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(root, 'plain', 'AGENTS.md'), 'PARENT', 'utf8');  // 父目录 → 不读
    fs.writeFileSync(path.join(sub, 'AGENTS.md'), 'CWD', 'utf8');

    const chain = PI.discoverKimiChain(sub);
    assert.strictEqual(chain.projectRoot, null);
    const rels = projectEntries(chain, root).map(e => path.relative(root, e.path));
    assert.deepStrictEqual(rels, [path.join('plain', 'sub', 'AGENTS.md')]);
  });
});

test('kimi 体检：不展示 Claude 自身链路体检，也不再有记忆桶假警告', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'RULES', 'utf8');

    const insp = PI.buildInspection({ cwd: proj, kind: 'kimi' });
    const titles = insp.health.map(c => c.title + ' ' + c.detail).join('\n');
    // 允许「Claude 规则未完整送到 Kimi」这种跨链差异告警；它不是把 Claude 的链路
    // 当作 Kimi 注入，而是在阻止“只有 CLAUDE.md 时仍报全绿”的假 OK。
    assert.ok(!insp.health.some(c => c.title.startsWith('CLAUDE.md 链')),
      `kimi 体检不应展示 Claude 自身的链路体检：\n${titles}`);
    assert.ok(!titles.includes('记忆桶') && !titles.includes('桶名已塌缩') && !titles.includes('规范库'),
      `kimi 体检不应出现记忆桶检查：\n${titles}`);
    assert.ok(insp.health.some(c => c.title.includes('AGENTS.md')), '应报告 AGENTS.md 份数');
    assert.ok(insp.health.some(c => c.title.startsWith('project root')), '应报告 project root');
  });
});

test('kimi 体检：无 .git 时给出明确警告', () => {
  withTree((root) => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    const insp = PI.buildInspection({ cwd: plain, kind: 'kimi' });
    assert.ok(insp.health.some(c => c.level === 'warn' && c.title.includes('.git')),
      '无 .git 应警告只读 cwd');
  });
});

test('kimi 的 ruleBytes 按 AGENTS.md 链（kimi）统计，不按 CLAUDE.md 链', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'RULES', 'utf8');
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'X'.repeat(500), 'utf8');    // 干扰项：不应计入

    const insp = PI.buildInspection({ cwd: proj, kind: 'kimi' });
    const kimiBytes = insp.kimi.entries.reduce((s, e) => s + e.bytes, 0);
    assert.strictEqual(insp.totals.ruleBytes, kimiBytes);
  });
});

test('kimi 拼装预览：只拼 kimi 链，无 memory 索引段', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'RULES', 'utf8');

    const insp = PI.buildInspection({ cwd: proj, kind: 'kimi' });
    const asm = PI.buildAssembly(insp);
    assert.strictEqual(asm.kind, 'kimi');
    assert.ok(asm.segments.every(s => s.role !== 'memory-index'), 'kimi 不应有 memory 索引段');
    const fromProj = asm.segments.filter(s => s.path.startsWith(root));
    assert.strictEqual(fromProj.length, 1);
    assert.strictEqual(path.basename(fromProj[0].path), 'AGENTS.md');
  });
});

test('claude / codex 分支行为未被 kimi 改动影响', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'C', 'utf8');

    const claudeInsp = PI.buildInspection({ cwd: proj, kind: 'claude' });
    const claudeTitles = claudeInsp.health.map(c => c.title).join('\n');
    assert.ok(claudeTitles.includes('CLAUDE.md'), 'claude 仍检查 CLAUDE.md 链');
    assert.ok(claudeTitles.includes('记忆'), 'claude 仍检查记忆桶');

    const codexInsp = PI.buildInspection({ cwd: proj, kind: 'codex' });
    const codexTitles = codexInsp.health.map(c => c.title).join('\n');
    assert.ok(codexTitles.includes('AGENTS.md'), 'codex 仍检查 AGENTS.md 链');
    // 2026-07-29 三方审查（Codex 2 提出，Claude 实测复核）：这里原本断言「codex 仍检查
    // 记忆桶」，固化了一个错误行为——记忆桶是 Claude Code 独有机制，而 buildInspection
    // 给 codex 传的 configDirName 是 '.claude'，于是 Codex 会话面板上显示的是 **Claude 的**
    // 记忆库（实测报「记忆已接入规范库 156 条」，Codex 一条都读不到）。Codex 自己的全局
    // 记忆是 ~/.codex/AGENTS.md，已经算在上面那条 AGENTS.md 链里。假 OK 比没有检查更坏。
    assert.ok(!codexTitles.includes('记忆'), 'codex 不应出现记忆桶检查（那是 Claude 的桶）');
    assert.strictEqual(codexInsp.totals.memoryIndexBytes, 0);
    assert.strictEqual(codexInsp.totals.memoryFiles, 0);
  });
});

test('Codex / Kimi 的 raw、汇总和拼装都不能夹带 Claude MEMORY.md', () => {
  withTree((root) => {
    const oldUserProfile = process.env.USERPROFILE;
    try {
      process.env.USERPROFILE = root;
      const proj = path.join(root, 'proj');
      fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
      fs.writeFileSync(path.join(proj, 'AGENTS.md'), 'PROJECT RULES\n', 'utf8');
      fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(root, '.codex', 'AGENTS.md'), 'CODEX GLOBAL\n', 'utf8');
      fs.mkdirSync(path.join(root, '.kimi-code'), { recursive: true });
      fs.writeFileSync(path.join(root, '.kimi-code', 'AGENTS.md'), 'KIMI GLOBAL\n', 'utf8');

      const slug = path.resolve(proj).replace(/[^A-Za-z0-9]/g, '-');
      const memoryDir = path.join(root, '.claude', 'projects', slug, 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), 'CLAUDE SECRET MEMORY\n', 'utf8');

      for (const kind of ['codex', 'deepseek', 'kimi']) {
        const insp = PI.buildInspection({ cwd: proj, kind });
        assert.strictEqual(insp.totals.memoryIndexBytes, 0, `${kind} totals must exclude Claude memory`);
        assert.strictEqual(insp.totals.memoryFiles, 0, `${kind} totals must exclude Claude memory`);
        assert.ok(PI.collectRawSources(insp).every(source => source.group !== 'memory'),
          `${kind} raw source list must exclude Claude memory`);
        assert.ok(PI.buildAssembly(insp).segments.every(segment => segment.role !== 'memory-index'),
          `${kind} assembly must exclude Claude memory`);
      }

      const claude = PI.buildInspection({ cwd: proj, kind: 'claude' });
      assert.ok(PI.collectRawSources(claude).some(source => source.group === 'memory'));
      assert.ok(PI.buildAssembly(claude).segments.some(segment => segment.role === 'memory-index'));

      // The legacy inspector remains available to diagnose old Claude-backed
      // DeepSeek buckets, but current DeepSeek buildInspection follows Codex rules.
      const deepseekMemory = PI.inspectMemory(proj, '.claude-deepseek');
      assert.strictEqual(deepseekMemory.canonicalDir,
        path.join(root, '.claude', 'projects', path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'), 'memory'),
        'DeepSeek buckets must point at the shared main Claude canonical store');
    } finally {
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
    }
  });
});

test('Prompt 检视把指错目标的 memory junction 报成真错误', () => {
  withTree((root) => {
    const oldUserProfile = process.env.USERPROFILE;
    try {
      process.env.USERPROFILE = root;
      const proj = path.join(root, 'proj');
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Rules\n', 'utf8');
      const slug = path.resolve(proj).replace(/[^A-Za-z0-9]/g, '-');
      const memoryDir = path.join(root, '.claude', 'projects', slug, 'memory');
      const alternate = path.join(root, 'alternate-memory');
      fs.mkdirSync(path.dirname(memoryDir), { recursive: true });
      fs.mkdirSync(alternate, { recursive: true });
      fs.writeFileSync(path.join(alternate, 'MEMORY.md'), '# Wrong target\n', 'utf8');
      fs.symlinkSync(alternate, memoryDir, 'junction');

      const insp = PI.buildInspection({ cwd: proj, kind: 'claude' });
      assert.strictEqual(insp.memory.state, 'WRONG_LINK');
      assert.ok(insp.health.some(check => check.level === 'bad' && check.title.includes('链接指向了别处')));
    } finally {
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
    }
  });
});

test('Prompt 检视 UI 对 Codex 明示不使用 Claude memory 桶', () => {
  assert.match(PROMPT_INSPECTOR_SRC, /function renderCodexMemoryNote\(\)/);
  assert.match(PROMPT_INSPECTOR_SRC,
    /isCodex \? renderCodexMemoryNote\(\) : isKimi \? renderKimiMemoryNote\(\) : renderMemoryGroup\(d\)/,
    'Codex must not fall through to the Claude memory renderer');
});

test('Kimi 无 git 告警不再建议在聚合根 git init', () => {
  const insp = PI.buildInspection({ kind: 'kimi', cwd: 'C:\\Vibe\\AI' });
  const healthText = insp.health.map(item => `${item.title} ${item.detail}`).join('\n');
  assert.ok(healthText.includes('不要为此在 C:\\Vibe 聚合根 git init'));
  assert.ok(!healthText.includes('或 git init 让向上收集生效'));
});

test('镜像判定保留 Markdown 空白语义，不把不同规则误判成相同', () => {
  withTree((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '<!-- claude provenance -->\n\n# Rule\n\n- token: ab c\n', 'utf8');
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), '<!-- agents provenance -->\n\n# Rule\n\n- token: a bc\n', 'utf8');
    const different = PI.buildInspection({ cwd: proj, kind: 'claude' });
    assert.ok(different.orphanAgents.some(item => item.path === path.join(proj, 'AGENTS.md')),
      'different word boundaries must remain a real orphan warning');

    fs.writeFileSync(path.join(proj, 'AGENTS.md'), '<!-- agents provenance -->\n\n# Rule\n\n- token: ab c\n', 'utf8');
    const mirrored = PI.buildInspection({ cwd: proj, kind: 'claude' });
    assert.ok(!mirrored.orphanAgents.some(item => item.path === path.join(proj, 'AGENTS.md')),
      'same rules with different provenance comments should be recognized as a mirror');
  });
});
