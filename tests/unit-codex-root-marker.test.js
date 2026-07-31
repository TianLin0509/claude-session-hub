'use strict';
// seed 副本与 Codex root 标记必须成对出现（2026-07-29 第五轮，用户决策 1）。
//
// 背景：Kimi 无 .git 时只读 cwd 自己那份 AGENTS.md，所以必须 seed；而 Codex 从 project
// root 向下逐层收集，会把沿途每一份 seed 副本都读进去，同一份规则重复注入 N 遍。
// 只在工作区根/分类根放 `.vibe-root` 解决不了深层（Codex 2 实测证伪）。成立的做法是
// 让标记跟着 seed 走：Codex root 收缩到该目录本身，无论多深都只读「全局 + 自己」两份。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkspaceService } = require('../core/workspace-service.js');
const PI = require('../core/prompt-inspect.js');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}`); console.error(err.message); }
}

function withTree(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codexroot-'));
  try {
    const ws = path.join(root, 'Vibe');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, '.vibe-root'), '# root marker\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# 全局约定\n\n- 工作区边界\n', 'utf8');
    const svc = new WorkspaceService({
      workspaceRoot: ws,
      registryPath: path.join(root, 'ws.json'),
      logger: { warn() {}, log() {} },
    });
    fn({ root, ws, svc });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const codexEntries = cwd => PI.buildInspection({ cwd, kind: 'codex' }).codex.entries
  .filter(e => e.source !== 'user-global')
  .map(e => e.path);

console.log('Running codex root marker tests...');

test('seed 一份副本就配一个 .vibe-root', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, 'AI');
    fs.mkdirSync(dir);
    assert.strictEqual(svc.seedUngovernedAgentsFile(dir), true);
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')), 'seed 副本要在');
    assert.ok(fs.existsSync(path.join(dir, '.vibe-root')), '标记必须与副本成对出现');
  });
});

test('任意深度都只读「全局 + 自己」一份，不随深度增长', () => {
  withTree(({ ws, svc }) => {
    const ai = path.join(ws, 'AI');
    const proj = path.join(ai, 'proj');
    const deep = path.join(proj, 'sub');
    fs.mkdirSync(deep, { recursive: true });
    svc.seedUngovernedAgentsFile(ai);
    svc.seedUngovernedAgentsFile(proj);
    svc.seedUngovernedAgentsFile(deep);

    for (const [label, dir] of [['AI', ai], ['AI/proj', proj], ['AI/proj/sub', deep]]) {
      const entries = codexEntries(dir);
      assert.strictEqual(entries.length, 1,
        `${label} 的 Codex 链应只剩自己那份，实际 ${entries.length} 份：${entries.join(', ')}`);
      assert.strictEqual(path.dirname(entries[0]), dir, `${label} 读的必须是自己那份`);
    }
  });
});

test('规则一个字都没丢（副本正文 === 根规则正文）', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, 'AI');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# 全局约定\n\n- 工作区边界\n\n', 'utf8');
    svc.seedUngovernedAgentsFile(dir);
    const source = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
    const copy = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
      .replace(/^<!--[\s\S]*?-->\r?\n\r?\n/, '');
    assert.strictEqual(copy, source, 'Codex 不再读根规则，靠的就是副本与根规则逐字相同');
  });
});

test('深层 seed 必须合并祖先项目规则，不能用去重换丢规则', () => {
  withTree(({ ws, svc }) => {
    const project = path.join(ws, 'AI', 'project');
    const deep = path.join(project, 'packages', 'web');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# 项目规则\n\n- 只改 web 包\n', 'utf8');

    assert.strictEqual(svc.seedUngovernedAgentsFile(deep), true);
    assert.ok(fs.existsSync(path.join(deep, '.vibe-root')), '深层副本仍要配 Codex 边界');
    const body = fs.readFileSync(path.join(deep, 'AGENTS.md'), 'utf8')
      .replace(/^<!--[\s\S]*?-->\r?\n\r?\n/, '');
    assert.match(body, /工作区边界/, '根规则要保留');
    assert.match(body, /只改 web 包/, '祖先项目规则也必须合并进副本');

    const entries = codexEntries(deep);
    assert.strictEqual(entries.length, 1, 'Codex 仍只读一份合并副本');
    assert.match(fs.readFileSync(entries[0], 'utf8'), /只改 web 包/, 'Codex 实际注入链必须含项目规则');
    const kimiEntries = PI.buildInspection({ cwd: deep, kind: 'kimi' }).kimi.entries
      .filter(e => e.source === 'project');
    assert.strictEqual(kimiEntries.length, 1, '无 git 时 Kimi 仍只读 cwd 这一份');
    assert.match(fs.readFileSync(kimiEntries[0].path, 'utf8'), /只改 web 包/, 'Kimi 也必须拿到祖先项目规则');
  });
});

test('Kimi 侧完全不受影响（只认 .git，对 .vibe-root 视而不见）', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, 'AI');
    fs.mkdirSync(dir);
    svc.seedUngovernedAgentsFile(dir);
    const kimi = PI.buildInspection({ cwd: dir, kind: 'kimi' }).kimi.entries
      .filter(e => e.source !== 'user-global');
    assert.strictEqual(kimi.length, 1);
    assert.strictEqual(path.dirname(kimi[0].path), dir);
  });
});

test('项目自有的 AGENTS.md 不会被 seed，也就拿不到标记', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, 'Stock');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Stock 自己的规则\n', 'utf8');
    assert.strictEqual(svc.seedUngovernedAgentsFile(dir), false);
    assert.strictEqual(fs.existsSync(path.join(dir, '.vibe-root')), false,
      '没被 Hub 接管的目录不许被改变 Codex root 边界');
    // 行为不变：仍从工作区根收集
    const entries = codexEntries(dir);
    assert.strictEqual(entries.length, 2, `应仍读根 + 自己两份，实际：${entries.join(', ')}`);
  });
});

test('存量副本（已是最新、无标记）会在下次 spawn 补上标记', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, 'legacy');
    fs.mkdirSync(dir);
    svc.seedUngovernedAgentsFile(dir);            // 先生成一份最新副本
    fs.unlinkSync(path.join(dir, '.vibe-root'));  // 模拟本次改动之前的存量状态
    assert.strictEqual(svc.seedUngovernedAgentsFile(dir), false, '内容已最新，不该重写文件');
    assert.ok(fs.existsSync(path.join(dir, '.vibe-root')), '但标记要补上');
  });
});

// 这条是真实环境实测卡死后补的：存量副本没有 seed-sha256，而源在「补标记之前」就变了，
// 于是既不能靠标记判断、正文又对不上。原先在这里保守跳过 = 副本永久停在旧规则，
// Codex/Kimi 读到的与 Claude 读到的长期不一致（2026-07-29 往根规则加豁免章节后实际发生）。
test('存量副本 + 源已变：留证据后升级，不许卡死在旧规则', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, 'legacy-stale');
    fs.mkdirSync(dir);
    svc.seedUngovernedAgentsFile(dir);
    const target = path.join(dir, 'AGENTS.md');
    // 退回到本轮改动之前的状态：Hub 头注释在，但没有 seed-sha256，也没有标记
    const oldBody = '# 全局约定\n\n- 工作区边界\n';
    fs.writeFileSync(target,
      `<!-- 由 AI Hub 在启动会话时自动复制自 ${path.join(ws, 'AGENTS.md')}，\n     旧格式头注释。 -->\n\n${oldBody}`, 'utf8');
    fs.unlinkSync(path.join(dir, '.vibe-root'));
    // 源变了
    const newBody = '# 全局约定\n\n- 工作区边界\n- 新增章节\n';
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), newBody, 'utf8');

    assert.strictEqual(svc.seedUngovernedAgentsFile(dir), true, '必须升级，不能保守跳过');
    const after = fs.readFileSync(target, 'utf8');
    assert.match(after, /新增章节/, '副本要跟上新规则');
    assert.match(after, /seed-sha256: [0-9a-f]{16}/, '升级后必须带上标记，之后走正常路径');
    assert.ok(fs.existsSync(path.join(dir, '.vibe-root')), '同时补上 Codex root 标记');
    const backups = fs.readdirSync(dir).filter(n => n.startsWith('AGENTS.md.hub-backup-'));
    assert.strictEqual(backups.length, 1, '原件必须留底，一个字都不能丢');
    assert.strictEqual(fs.readFileSync(path.join(dir, backups[0]), 'utf8').includes('旧格式头注释'), true);
  });
});

test('其他源路径生成的 Hub 副本不接管', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, 'foreign-hub');
    fs.mkdirSync(dir);
    const target = path.join(dir, 'AGENTS.md');
    const foreign = '<!-- 由 AI Hub 在启动会话时自动复制自 D:\\Other\\AGENTS.md，\n     旧 Hub。 -->\n\n# 另一套规则\n';
    fs.writeFileSync(target, foreign, 'utf8');
    assert.strictEqual(svc.seedUngovernedAgentsFile(dir), false);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), foreign, '其他来源的副本必须原样保留');
    assert.strictEqual(fs.existsSync(path.join(dir, '.vibe-root')), false);
    assert.strictEqual(fs.readdirSync(dir).some(n => n.includes('hub-backup')), false);
  });
});

test('同一秒已有备份时使用唯一后缀，不覆盖旧证据', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, 'backup-collision');
    fs.mkdirSync(dir);
    const target = path.join(dir, 'AGENTS.md');
    const source = path.join(ws, 'AGENTS.md');
    svc.now = () => new Date(2026, 6, 29, 21, 51, 34).getTime();
    fs.writeFileSync(target,
      `<!-- 由 AI Hub 在启动会话时自动复制自 ${source}，\n     旧格式头注释。 -->\n\n# 旧规则\n`, 'utf8');
    fs.writeFileSync(source, '# 新规则\n', 'utf8');
    const firstBackup = `${target}.hub-backup-20260729-215134`;
    fs.writeFileSync(firstBackup, '已有证据', 'utf8');

    assert.strictEqual(svc.seedUngovernedAgentsFile(dir), true);
    assert.strictEqual(fs.readFileSync(firstBackup, 'utf8'), '已有证据', '旧备份不能被覆盖');
    assert.match(fs.readFileSync(`${firstBackup}-2`, 'utf8'), /旧规则/, '新证据要写入独立后缀');
  });
});

test('不是 Hub 生成的 AGENTS.md 永远不碰（没有 Hub 头注释）', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, 'foreign');
    fs.mkdirSync(dir);
    const own = '<!-- 这是项目自己的注释 -->\n\n# 全局约定\n\n- 工作区边界\n';
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), own, 'utf8');
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# 全局约定\n\n- 改过了\n', 'utf8');
    assert.strictEqual(svc.seedUngovernedAgentsFile(dir), false);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), own, '原样不动');
    assert.strictEqual(fs.existsSync(path.join(dir, '.vibe-root')), false);
    assert.strictEqual(fs.readdirSync(dir).some(n => n.includes('hub-backup')), false, '不该产生备份');
  });
});

test('用户接管正文后不主动补标记（那已是项目自己的规则）', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, 'taken');
    fs.mkdirSync(dir);
    svc.seedUngovernedAgentsFile(dir);
    const target = path.join(dir, 'AGENTS.md');
    const header = fs.readFileSync(target, 'utf8').match(/^<!--[\s\S]*?-->\r?\n\r?\n/)[0];
    fs.writeFileSync(target, header + '# 我自己改的规则\n', 'utf8');
    fs.unlinkSync(path.join(dir, '.vibe-root'));
    assert.strictEqual(svc.seedUngovernedAgentsFile(dir), false);
    assert.strictEqual(fs.existsSync(path.join(dir, '.vibe-root')), false);
    assert.match(fs.readFileSync(target, 'utf8'), /我自己改的规则/, '用户正文不许被覆盖');
  });
});

test('scratch 工作区同样成对', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, '_scratch', 'inbox-x');
    fs.mkdirSync(dir, { recursive: true });
    assert.strictEqual(svc.seedScratchAgentsFile(dir), true);
    assert.ok(fs.existsSync(path.join(dir, '.vibe-root')));
    assert.strictEqual(codexEntries(dir).length, 1);
  });
});

test('存量 scratch 已有 .git 也会刷新，不会被 git 守卫永久挡住', () => {
  withTree(({ ws, svc }) => {
    const dir = path.join(ws, '_scratch', 'inbox-old');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const target = path.join(dir, 'AGENTS.md');
    const source = path.join(ws, 'AGENTS.md');
    fs.writeFileSync(target,
      `<!-- 由 AI Hub 在新建临时 workspace 时自动复制自 ${source}，并随源文件自动刷新。 -->\n\n# 旧规则\n`, 'utf8');
    fs.writeFileSync(source, '# 新规则\n', 'utf8');

    assert.strictEqual(svc.seedUngovernedAgentsFile(dir), true);
    assert.match(fs.readFileSync(target, 'utf8'), /新规则/);
    assert.ok(fs.existsSync(path.join(dir, '.vibe-root')));
    assert.ok(fs.readdirSync(dir).some(n => n.startsWith('AGENTS.md.hub-backup-')),
      '刷新前必须留底');
  });
});

test('托管目录后来 git init 仍继续刷新，项目自有文件仍不接管', () => {
  withTree(({ ws, svc }) => {
    const managed = path.join(ws, 'managed-then-git');
    fs.mkdirSync(managed);
    assert.strictEqual(svc.seedUngovernedAgentsFile(managed), true);
    fs.mkdirSync(path.join(managed, '.git'));
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# 根规则已更新\n', 'utf8');
    assert.strictEqual(svc.seedUngovernedAgentsFile(managed), true);
    assert.match(fs.readFileSync(path.join(managed, 'AGENTS.md'), 'utf8'), /根规则已更新/);

    const owned = path.join(ws, 'owned-git');
    fs.mkdirSync(path.join(owned, '.git'), { recursive: true });
    fs.writeFileSync(path.join(owned, 'AGENTS.md'), '# 项目自有\n', 'utf8');
    assert.strictEqual(svc.seedUngovernedAgentsFile(owned), false);
    assert.strictEqual(fs.readFileSync(path.join(owned, 'AGENTS.md'), 'utf8'), '# 项目自有\n');
    assert.strictEqual(fs.existsSync(path.join(owned, '.vibe-root')), false);
  });
});

if (failed) process.exitCode = 1;
else console.log('All codex root marker tests passed.');
