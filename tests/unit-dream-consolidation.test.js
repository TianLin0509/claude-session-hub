'use strict';
// core/dream-consolidation.js 单测。
// 覆盖：seed 副本状态判定、脱敏、托管区合并、目标白名单、LLM 输出解析与证据门槛、
// 以及端到端 runConsolidation（假 LLM + 临时目录，不碰真实规则文件）。

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dream = require('../core/dream-consolidation.js');

async function test(name, fn) {
  try {
    await fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dream-')));
}

function seedCopy({ hash, body }) {
  return `<!-- 由 AI Hub 在新建临时 workspace 时自动复制自 X，并随源文件自动刷新。\n     seed-sha256: ${hash} —— Hub 靠它判断这份副本有没有被你改过，别删这行。 -->\n\n${body}`;
}

function hashOf(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}

// 搭一套端到端夹具：工作区根 + 一个被改过的 scratch 副本 + 用户级四件套 + hub 数据目录。
function makeFixture() {
  const tmp = mkTmp();
  const workspaceRoot = path.join(tmp, 'vibe');
  const homeDir = path.join(tmp, 'home');
  const hubDataDir = path.join(tmp, 'hub');
  fs.mkdirSync(path.join(workspaceRoot, '_scratch', 'inbox-test'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.md'), '# VIBE ROOT RULES\n', 'utf8');
  const localBody = '# VIBE ROOT RULES\n\n- 以后报告都放 Reports 目录，别放桌面\n';
  fs.writeFileSync(
    path.join(workspaceRoot, '_scratch', 'inbox-test', 'AGENTS.md'),
    seedCopy({ hash: '0000000000000000', body: localBody }),
    'utf8',
  );
  for (const p of ['.kimi-code/AGENTS.md', '.claude/CLAUDE.md', '.codex/AGENTS.md', '.gemini/GEMINI.md']) {
    const fp = path.join(homeDir, p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, '# 全局规则\n\n- 默认中文回复\n', 'utf8');
  }
  return {
    tmp, workspaceRoot, homeDir, hubDataDir,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

async function main() {

  await test('seedCopyStatus：synced / modified / own / missing', () => {
    const tmp = mkTmp();
    try {
      const p = path.join(tmp, 'AGENTS.md');
      assert.strictEqual(dream.seedCopyStatus(p), null);
      fs.writeFileSync(p, '# 项目自己的规则\n', 'utf8');
      assert.strictEqual(dream.seedCopyStatus(p), 'own');
      const body = '# rules\n';
      fs.writeFileSync(p, seedCopy({ hash: hashOf(body), body }), 'utf8');
      assert.strictEqual(dream.seedCopyStatus(p), 'synced');
      fs.writeFileSync(p, seedCopy({ hash: '0000000000000000', body }), 'utf8');
      assert.strictEqual(dream.seedCopyStatus(p), 'modified');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('redactSecrets：密钥不进 LLM', () => {
    const out = dream.redactSecrets('key 是 sk-abcdef1234567890，api_key="xyz78901"，Bearer abcdefghijklmnop');
    assert.ok(!out.includes('sk-abcdef'), out);
    assert.ok(!out.includes('xyz78901'), out);
    assert.ok(!out.includes('abcdefghijklmnop'), out);
  });

  await test('蒸馏 prompt 使用当前工作根，并如实声明不采集普通 Session', () => {
    const system = dream.buildDistillSystem('C:\\AIWork');
    assert.ok(system.includes('C:\\AIWork'));
    assert.ok(system.includes('不在本管线采集范围内'));
    assert.ok(!system.includes('C:\\Vibe'));
    assert.ok(system.includes('新启动会话读取'));
  });

  await test('mergeManagedSection：建区、追加、去重、不动手写区', () => {
    const first = dream.mergeManagedSection('# 手写正文\n', [{ claim: '规则甲' }], '2026-07-31');
    assert.ok(first.content.includes(dream.DREAM_BEGIN));
    assert.ok(first.content.includes('- (2026-07-31) 规则甲'));
    assert.ok(first.content.startsWith('# 手写正文'));
    assert.deepStrictEqual(first.added, ['规则甲']);

    const second = dream.mergeManagedSection(first.content, [{ claim: '规则乙' }, { claim: '规则甲' }], '2026-08-01');
    assert.ok(second.content.includes('- (2026-08-01) 规则乙'));
    // 规则甲已在区里， normalized 去重后不得重复出现。
    assert.strictEqual(second.content.split('规则甲').length - 1, 1);
    assert.deepStrictEqual(second.added, ['规则乙']);
    assert.ok(second.content.includes('# 手写正文'));
  });

  await test('resolveTargetFiles：四件套/三写/项目白名单', () => {
    const homeDir = path.join('C:\\', 'home');
    const workspaceRoot = path.join('C:\\', 'vibe');
    const userFiles = dream.resolveTargetFiles({ target_layer: 'user_global' }, { homeDir, workspaceRoot });
    assert.strictEqual(userFiles.length, 4);
    const wsFiles = dream.resolveTargetFiles({ target_layer: 'workspace' }, { homeDir, workspaceRoot });
    assert.strictEqual(wsFiles.length, 3);
    const okProj = dream.resolveTargetFiles({ target_layer: 'project', project_path: 'C:\\vibe\\AI\\proj' }, { homeDir, workspaceRoot });
    assert.strictEqual(okProj.length, 1);
    const evil = dream.resolveTargetFiles({ target_layer: 'project', project_path: 'C:\\vibe\\..\\Windows' }, { homeDir, workspaceRoot });
    assert.strictEqual(evil.length, 0, '逃逸工作区的 project_path 必须拒写');
    const staging = dream.resolveTargetFiles({ target_layer: 'staging' }, { homeDir, workspaceRoot });
    assert.strictEqual(staging.length, 0);
  });

  await test('parseDistillOutput + validateEntries：抠 JSON、无证据降级 staging', () => {
    const { entries, parseError } = dream.parseDistillOutput('前言\n```json\n{"entries":[{"target_layer":"user_global","claim":"规则甲","type":"rule","confidence":0.9,"evidence":"原文"},{"target_layer":"user_global","claim":"没证据的规则","type":"rule","confidence":0.9,"evidence":""}]}\n```\n后语');
    assert.strictEqual(parseError, null);
    const valid = dream.validateEntries(entries);
    assert.strictEqual(valid.length, 2);
    assert.strictEqual(valid[0].target_layer, 'user_global');
    assert.strictEqual(valid[1].target_layer, 'staging', '无证据必须降级');
    const bad = dream.parseDistillOutput('完全不是 JSON');
    assert.strictEqual(bad.parseError, 'no-json');
  });

  await test('runConsolidation 端到端：假 LLM → 四件套同步落盘 + 快照 + changelog + staging', async () => {
    const fx = makeFixture();
    try {
      const fakeLlm = async () => JSON.stringify({
        entries: [
          { target_layer: 'user_global', claim: '报告统一放 Reports 目录', type: 'preference', confidence: 0.9, evidence: '以后报告都放 Reports 目录' },
          { target_layer: 'staging', claim: '一次性的临时事实', type: 'fact', confidence: 0.3, evidence: '某次提到' },
        ],
      });
      const summary = await dream.runConsolidation({
        homeDir: fx.homeDir,
        workspaceRoot: fx.workspaceRoot,
        hubDataDir: fx.hubDataDir,
        getHubConfig: () => ({ consolidation: { provider: 'deepseek-api' }, deepseekApiKey: 'fake-key' }),
        logger: { log() {}, warn() {} },
        llmCall: fakeLlm,
        trigger: 'test',
      });
      assert.strictEqual(summary.candidates, 1, '应采集到 1 个 modified 副本');
      assert.strictEqual(summary.entries, 2);
      assert.strictEqual(summary.applied, 4, '四件套各写一次');
      assert.strictEqual(summary.staged, 1);

      const texts = ['.kimi-code/AGENTS.md', '.claude/CLAUDE.md', '.codex/AGENTS.md', '.gemini/GEMINI.md']
        .map(p => fs.readFileSync(path.join(fx.homeDir, p), 'utf8'));
      for (const t of texts) {
        assert.ok(t.includes('# 全局规则'), '手写正文必须保留');
        assert.ok(t.includes(dream.DREAM_BEGIN), '必须有托管区');
        assert.ok(t.includes('报告统一放 Reports 目录'), '沉淀必须落盘');
      }
      assert.strictEqual(new Set(texts).size, 1, '四件套必须逐字一致');

      const snapshotDir = path.join(fx.hubDataDir, 'consolidation', 'snapshots', summary.runId);
      assert.strictEqual(fs.readdirSync(snapshotDir).length, 4, '每个写入都要有写前快照');

      const changelog = fs.readFileSync(path.join(fx.hubDataDir, 'consolidation', 'changelog.jsonl'), 'utf8')
        .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
      const phases = changelog.map(e => e.phase);
      for (const p of ['collect', 'distill', 'apply', 'staging', 'done']) {
        assert.ok(phases.includes(p), `changelog 缺 ${p} 阶段`);
      }
      const applyEntry = changelog.find(e => e.phase === 'apply');
      assert.ok(applyEntry.evidence[0].evidence.includes('Reports'), '落盘记录必须带证据');

      const staging = fs.readFileSync(path.join(fx.hubDataDir, 'consolidation', 'staging.md'), 'utf8');
      assert.ok(staging.includes('一次性的临时事实'));

      // 第二轮同样的 LLM 输出：候选指纹未变，增量去重直接短路（零 LLM 调用）。
      const second = await dream.runConsolidation({
        homeDir: fx.homeDir,
        workspaceRoot: fx.workspaceRoot,
        hubDataDir: fx.hubDataDir,
        getHubConfig: () => ({ consolidation: { provider: 'deepseek-api' }, deepseekApiKey: 'fake-key' }),
        logger: { log() {}, warn() {} },
        llmCall: fakeLlm,
        trigger: 'test',
      });
      assert.strictEqual(second.dedupSkipped, 1, '同内容候选必须被增量去重');
      assert.ok(!second.applied, '重复沉淀不得再次落盘');
      const kimiText = fs.readFileSync(path.join(fx.homeDir, '.kimi-code', 'AGENTS.md'), 'utf8');
      assert.strictEqual(kimiText.split('报告统一放 Reports 目录').length - 1, 1, '托管区不得出现重复条目');
    } finally {
      fx.cleanup();
    }
  });

  await test('runConsolidation 无 LLM Key：显式降级为只采集，不写规则文件', async () => {
    const fx = makeFixture();
    try {
      const summary = await dream.runConsolidation({
        homeDir: fx.homeDir,
        workspaceRoot: fx.workspaceRoot,
        hubDataDir: fx.hubDataDir,
        getHubConfig: () => ({ consolidation: { provider: 'deepseek-api' }, deepseekApiKey: '' }),
        logger: { log() {}, warn() {} },
        trigger: 'test',
      });
      assert.ok(summary.note && summary.note.startsWith('no-llm'), `应显式标注降级，实际：${summary.note}`);
      const t = fs.readFileSync(path.join(fx.homeDir, '.kimi-code', 'AGENTS.md'), 'utf8');
      assert.ok(!t.includes(dream.DREAM_BEGIN), '无 LLM 时不得写规则文件');
      const changelog = fs.readFileSync(path.join(fx.hubDataDir, 'consolidation', 'changelog.jsonl'), 'utf8');
      assert.ok(changelog.includes('"collect"'), '采集记录必须留存');
    } finally {
      fx.cleanup();
    }
  });

  await test('collectCandidates：memory 孤岛桶也能被采集', async () => {    const fx = makeFixture();
    try {
      const islandDir = path.join(fx.homeDir, '.claude', 'projects', 'C--Vibe--scratch-inbox-x', 'memory');
      fs.mkdirSync(islandDir, { recursive: true });
      fs.writeFileSync(path.join(islandDir, 'feedback_x.md'), '# 偏好\n\n- 别用 emoji\n', 'utf8');
      // 规范库自身（home 桶）也有文件——它必须被排除，它本来就是共享的。
      const { projectSlug } = require('../core/claude-transcript-locator.js');
      const canonicalDir = path.join(fx.homeDir, '.claude', 'projects', projectSlug(fx.homeDir), 'memory');
      fs.mkdirSync(canonicalDir, { recursive: true });
      fs.writeFileSync(path.join(canonicalDir, 'MEMORY.md'), '# 规范库\n', 'utf8');
      const { candidates } = dream.collectCandidates({
        workspaceRoot: fx.workspaceRoot,
        homeDir: fx.homeDir,
        config: dream.normalizeConsolidationConfig({}),
        logger: { log() {}, warn() {} },
      });
      const kinds = candidates.map(c => c.kind).sort();
      assert.deepStrictEqual(kinds, ['agents-diff', 'memory-island'], '规范库自身不得成为候选');
      assert.ok(candidates.find(c => c.kind === 'memory-island').excerpt.includes('别用 emoji'));
    } finally {
      fx.cleanup();
    }
  });

  await test('增量去重：同内容第二轮零 LLM 调用，内容变了才重新蒸馏', async () => {
    const fx = makeFixture();
    try {
      let llmCalls = 0;
      const fakeLlm = async () => {
        llmCalls++;
        return JSON.stringify({ entries: [{ target_layer: 'user_global', claim: '规则甲', type: 'rule', confidence: 0.9, evidence: '原文' }] });
      };
      const mkOpts = () => ({
        homeDir: fx.homeDir,
        workspaceRoot: fx.workspaceRoot,
        hubDataDir: fx.hubDataDir,
        getHubConfig: () => ({ consolidation: { provider: 'deepseek-api' }, deepseekApiKey: 'fake' }),
        logger: { log() {}, warn() {} },
        llmCall: fakeLlm,
        trigger: 'test',
      });
      const first = await dream.runConsolidation(mkOpts());
      assert.strictEqual(llmCalls, 1);
      assert.strictEqual(first.dedupSkipped, 0);

      const second = await dream.runConsolidation(mkOpts());
      assert.strictEqual(llmCalls, 1, '内容没变不得再调 LLM');
      assert.strictEqual(second.dedupSkipped, 1);
      assert.ok(second.note.startsWith('all-deduped'), second.note);

      // 副本内容再改一次 → 指纹变 → 重新蒸馏。
      const p = path.join(fx.workspaceRoot, '_scratch', 'inbox-test', 'AGENTS.md');
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\n- 又学到一条新规矩\n', 'utf8');
      const third = await dream.runConsolidation(mkOpts());
      assert.strictEqual(llmCalls, 2, '内容变化必须重新蒸馏');
      assert.strictEqual(third.dedupSkipped, 0);
    } finally {
      fx.cleanup();
    }
  });

  await test('mergeIslandBucket：并入规范库 + 冲突另存 + 换 junction + 留底', async () => {
    const { mergeIslandBucket, canonicalMemoryDir } = require('../core/claude-memory-link.js');
    const tmp = mkTmp();
    try {
      const homeDir = path.join(tmp, 'home');
      const canonical = canonicalMemoryDir(homeDir);
      fs.mkdirSync(canonical, { recursive: true });
      fs.writeFileSync(path.join(canonical, 'MEMORY.md'), '# 规范库\n', 'utf8');
      fs.writeFileSync(path.join(canonical, 'dup.md'), 'same\n', 'utf8');
      const bucket = path.join(homeDir, '.claude', 'projects', 'C--Vibe--scratch-inbox-x');
      const island = path.join(bucket, 'memory');
      fs.mkdirSync(island, { recursive: true });
      fs.writeFileSync(path.join(island, 'only-in-island.md'), '独有记忆\n', 'utf8');
      fs.writeFileSync(path.join(island, 'dup.md'), 'same\n', 'utf8');

      const r = mergeIslandBucket('.claude', 'C--Vibe--scratch-inbox-x', { homeDir, logger: { log() {}, warn() {} } });
      assert.strictEqual(r.error, null);
      assert.deepStrictEqual(r.merged, ['only-in-island.md']);
      assert.deepStrictEqual(r.deduplicated, ['dup.md']);
      assert.ok(fs.readFileSync(path.join(canonical, 'only-in-island.md'), 'utf8').includes('独有记忆'));
      assert.ok(fs.lstatSync(island).isSymbolicLink(), '孤岛桶必须换成 junction');
      assert.ok(r.backup && fs.existsSync(path.join(r.backup, 'only-in-island.md')), '原目录必须留底');

      const again = mergeIslandBucket('.claude', 'C--Vibe--scratch-inbox-x', { homeDir, logger: { log() {}, warn() {} } });
      assert.ok(again.error && again.error.includes('已是链接'), '重复并入必须幂等拒绝');

      const bad = mergeIslandBucket('.claude', 'evil/slug', { homeDir, logger: { log() {}, warn() {} } });
      assert.ok(bad.error && bad.error.includes('invalid slug'), '非法 slug 必须拒绝');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log(process.exitCode ? '\n有失败' : '\n全部通过');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
