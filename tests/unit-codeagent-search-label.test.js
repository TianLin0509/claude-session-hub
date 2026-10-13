'use strict';
// 「昨日之我」里的 CodeAgent（2026-10-13 公司版）：
// - CodeAgent 记录与 Claude 同格式，放在它自己配置目录的 projects/ 下；这里的记录（或绑定在 CodeAgent 会话上的记录）
//   标为 CodeAgent、可单独筛选，~/.claude 下的记录仍是 Claude；
// - 点一条还没有 Hub 会话的 CodeAgent 记录，用 codeagent-resume 在原目录恢复，而不是 claude-resume；
// - 公司版筛选栏是「全部 / CodeAgent / 群聊」；个人版 CodeAgent 按钮零命中时隐藏；
// - 会话引用与分支提示里的名字带上 CodeAgent。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sources = require('../core/session-search-sources');
const { isOtherSearchProvider, matchesSearchProvider } = require('../core/session-search-providers');
const { resumeRequestForSearchHit } = require('../renderer/search-hit-resume');
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name + '\n    ' + (error.stack || error.message)); }
}
function transcript(file, cwd, prompt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'user', uuid: 'u1', timestamp: '2026-10-13T01:00:00Z', cwd, message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-10-13T01:00:05Z', cwd, message: { role: 'assistant', model: 'GLM-5.2', content: [{ type: 'text', text: '好的' }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-search-'));
  const claudeRoot = path.join(home, '.claude', 'projects');
  const cacRoot = path.join(home, '.cac', 'projects');
  const ids = { claude: '11111111-1111-4111-8111-111111111111', ca: '22222222-2222-4222-8222-222222222222', bound: '33333333-3333-4333-8333-333333333333' };
  transcript(path.join(claudeRoot, 'D--c', ids.claude + '.jsonl'), 'D:\\c', 'Claude 的问题');
  transcript(path.join(cacRoot, 'D--a', ids.ca + '.jsonl'), 'D:\\a', 'CodeAgent 的问题');
  // 由 HUB_SESSION_SEARCH_CLAUDE_ROOTS 之类指过来、不认作 CodeAgent 根的目录，但记录绑定在 CodeAgent 会话上。
  const otherRoot = path.join(home, 'elsewhere', 'projects');
  const boundFile = path.join(otherRoot, 'D--b', ids.bound + '.jsonl');
  transcript(boundFile, 'D:\\b', '绑定的 CodeAgent 问题');
  const snapshot = { sessions: [{ hubId: 'hub-ca', kind: 'codeagent', ccSessionId: ids.bound, transcriptPath: boundFile, title: '绑定会话', cwd: 'D:\\b' }] };
  const collected = sources.collectSourceDescriptors({ claudeRoots: [claudeRoot, cacRoot, otherRoot], codeagentRoots: [cacRoot] }, snapshot);
  const byId = Object.fromEntries(collected.descriptors.map(d => [d.nativeSessionId, d]));

  await test('按根区分提供方：CodeAgent 根下是 codeagent，~/.claude 与 ~/.claude-deepseek 不变', () => {
    assert.strictEqual(sources.providerForClaudeRoot(cacRoot, [cacRoot]), 'codeagent');
    assert.strictEqual(sources.providerForClaudeRoot(cacRoot.toUpperCase() + path.sep, [cacRoot]), 'codeagent', '大小写与尾斜杠不影响');
    assert.strictEqual(sources.providerForClaudeRoot(claudeRoot, [cacRoot]), 'claude');
    assert.strictEqual(sources.providerForClaudeRoot(path.join(home, '.claude-deepseek', 'projects'), [cacRoot]), 'deepseek');
    assert.strictEqual(sources.providerForClaudeRoot(cacRoot), 'claude', '没传 CodeAgent 根时保持原行为');
  });

  await test('收集到的记录：CodeAgent 根、绑定 CodeAgent 会话的都标 codeagent；Claude 记录仍是 claude', () => {
    assert.strictEqual(byId[ids.claude].provider, 'claude');
    assert.strictEqual(byId[ids.ca].provider, 'codeagent');
    assert.strictEqual(byId[ids.ca].key, `claude:codeagent:${ids.ca}`);
    assert.strictEqual(byId[ids.bound].provider, 'codeagent');
    assert.strictEqual(byId[ids.bound].hubSession.hubId, 'hub-ca');
  });

  await test('索引条目：标签「CodeAgent」、恢复类型 codeagent-resume、发言人是 CodeAgent', async () => {
    assert.strictEqual(sources.providerLabel('codeagent'), 'CodeAgent');
    assert.strictEqual(sources.resumeKindForDescriptor(byId[ids.ca]), 'codeagent-resume');
    assert.strictEqual(sources.resumeKindForDescriptor(byId[ids.claude]), 'claude-resume');
    assert.strictEqual(sources.resumeKindForDescriptor({ type: 'claude', provider: 'deepseek' }), 'deepseek-resume');
    const parsed = await sources.parseSourceDescriptor(byId[ids.ca], collected.maps, {});
    assert.strictEqual(parsed.session.provider, 'codeagent');
    assert.strictEqual(parsed.session.kind, 'codeagent-resume');
    assert.strictEqual(parsed.session.nativeFamily, 'claude');
    assert.strictEqual(parsed.session.cwd, 'D:\\a', '没有 Hub 会话时从记录里取原工作目录，恢复才能在原目录接上');
    assert.ok(parsed.docs.some(doc => doc.role === 'assistant' && doc.speaker === 'CodeAgent'));
    const claude = await sources.parseSourceDescriptor(byId[ids.claude], collected.maps, {});
    assert.strictEqual(claude.session.provider, 'claude');
    assert.strictEqual(claude.session.kind, 'claude-resume');
  });

  await test('筛选：CodeAgent 有自己的按钮，不再算进「其他」', () => {
    assert.strictEqual(isOtherSearchProvider('codeagent'), false);
    assert.strictEqual(isOtherSearchProvider('kimi'), true);
    assert.strictEqual(matchesSearchProvider('codeagent', ['codeagent']), true);
    assert.strictEqual(matchesSearchProvider('codeagent', ['other']), false);
    assert.strictEqual(matchesSearchProvider('claude', ['codeagent']), false);
  });

  await test('从搜索结果恢复：CodeAgent 记录用 codeagent-resume 在原目录接着聊，带默认模型；Claude/DeepSeek/Codex 不变', () => {
    const hit = { provider: 'codeagent', nativeFamily: 'claude', nativeSessionId: ids.ca, cwd: 'D:\\a', transcriptPath: 'x.jsonl', title: 'T' };
    assert.deepStrictEqual(resumeRequestForSearchHit(hit, { codeagentModel: 'GLM-5.2' }), {
      kind: 'codeagent-resume',
      opts: { title: 'T', cwd: 'D:\\a', resumeTranscriptPath: 'x.jsonl', autoTitleGenerated: true, resumeCCSessionId: ids.ca, model: 'GLM-5.2' },
    });
    assert.strictEqual('model' in resumeRequestForSearchHit(hit).opts, false, '没设默认模型就不传，由 Hub 用默认');
    assert.strictEqual(resumeRequestForSearchHit({ ...hit, provider: 'claude' }).kind, 'claude-resume');
    const ds = resumeRequestForSearchHit({ ...hit, provider: 'deepseek' });
    assert.strictEqual(ds.kind, 'deepseek-resume'); assert.strictEqual(ds.opts.deepseekLegacyClaude, true);
    const codex = resumeRequestForSearchHit({ provider: 'codex', nativeFamily: 'codex', nativeSessionId: 'sid', codexSessionsRoot: 'R' });
    assert.strictEqual(codex.kind, 'codex-resume'); assert.strictEqual(codex.opts.codexSid, 'sid'); assert.strictEqual(codex.opts.codexSessionsRoot, 'R');
    assert.strictEqual(resumeRequestForSearchHit({ provider: 'meeting', nativeFamily: 'meeting', nativeSessionId: 'm' }), null);
    assert.strictEqual(resumeRequestForSearchHit({ provider: 'codeagent', nativeFamily: 'claude' }), null);
    const renderer = fs.readFileSync(path.join(root, 'renderer/renderer.js'), 'utf8');
    assert.match(renderer, /resumeRequestForSearchHit\(hit, \{ codeagentModel \}\)/, 'renderer 走这条路径');
    assert.match(renderer, /defaultModels\?\.codeagent/);
  });

  await test('结果行与筛选栏：CodeAgent 有标签和按钮，个人版零命中时隐藏', () => {
    const { PROVIDER_META, loadSearchFacets } = require('../renderer/global-session-search');
    assert.strictEqual(PROVIDER_META.codeagent.label, 'CodeAgent');
    assert.strictEqual(loadSearchFacets({ getItem: () => JSON.stringify({ provider: 'codeagent' }) }).provider, 'codeagent');
    const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
    assert.match(html, /class="session-search-chip" data-provider="codeagent" aria-pressed="false" hidden>/);
    const ui = fs.readFileSync(path.join(root, 'renderer/global-session-search.js'), 'utf8');
    assert.match(ui, /OPTIONAL_PROVIDERS = Object\.freeze\(\[\.\.\.ADVANCED_PROVIDERS, 'codeagent'\]\)/);
    assert.match(ui, /button\.dataset\.alwaysVisible !== '1'/);
  });

  // edition-trim 在假 DOM 上跑一遍：公司版（只留 codeagent）与主仓库。
  function fakeChip(provider, hidden = false) {
    const chip = { dataset: { provider }, hidden, removed: false, remove() { this.removed = true; } };
    return chip;
  }
  function runTrim(allowedKinds) {
    const chips = ['all', 'claude', 'codex', 'codeagent', 'other', 'meeting', 'deepseek', 'kimi', 'gemini']
      .map(p => fakeChip(p, ['codeagent', 'deepseek', 'kimi', 'gemini'].includes(p)));
    const group = { removed: false, remove() { this.removed = true; }, querySelector: () => chips.find(c => ['deepseek', 'kimi', 'gemini'].includes(c.dataset.provider) && !c.removed) || null };
    const live = () => chips.filter(c => !c.removed);
    const document = {
      querySelectorAll(selector) {
        if (selector === '.session-search-chip[data-provider]') return live();
        if (selector === '.session-search-specific-providers') return group.removed ? [] : [group];
        return [];
      },
      querySelector(selector) {
        const m = /data-provider="([^"]+)"/.exec(selector);
        if (m) return live().find(c => c.dataset.provider === m[1]) || null;
        return null;
      },
      getElementById: () => null,
    };
    const kindAllowed = kind => !allowedKinds || allowedKinds.includes(String(kind || '').replace(/-resume$/, ''));
    const stubs = {
      '../core/distribution': { allowedKinds, kindAllowed, featureEnabled: () => true, productName: null, editionBadge: null },
      '../core/ai-kinds': require('../core/ai-kinds'),
      '../core/session-search-providers': require('../core/session-search-providers'),
    };
    const code = fs.readFileSync(path.join(root, 'renderer/edition-trim.js'), 'utf8');
    vm.runInNewContext(code, { document, require: id => { if (!(id in stubs)) throw new Error('unexpected require ' + id); return stubs[id]; } });
    return { visible: live().filter(c => !c.hidden).map(c => c.dataset.provider), chips, group };
  }

  await test('公司版筛选栏：全部 / CodeAgent / 群聊（CodeAgent 常显，「其他」与空的「其他模型」去掉）', () => {
    const company = runTrim(['codeagent']);
    assert.deepStrictEqual(company.visible, ['all', 'codeagent', 'meeting']);
    assert.strictEqual(company.chips.find(c => c.dataset.provider === 'codeagent').dataset.alwaysVisible, '1');
    assert.strictEqual(company.group.removed, true);
    const personal = runTrim(null);
    assert.deepStrictEqual(personal.visible, ['all', 'claude', 'codex', 'other', 'meeting'], '主仓库不裁剪，CodeAgent 由命中数决定是否显示');
  });

  await test('会话引用与分支提示里有 CodeAgent', () => {
    const { kindLabel } = require('../core/session-reference');
    assert.strictEqual(kindLabel('codeagent'), 'CodeAgent');
    assert.strictEqual(kindLabel('codeagent-resume'), 'CodeAgent');
    assert.strictEqual(kindLabel('claude'), 'Claude');
    const { supportsForkSession } = require('../core/session-capabilities');
    assert.strictEqual(supportsForkSession({ kind: 'codeagent', agentRuntime: 'pty' }), true, 'CodeAgent 确实能分支');
    const shortcuts = fs.readFileSync(path.join(root, 'renderer/keyboard-shortcuts.js'), 'utf8');
    assert.match(shortcuts, /仅支持 Claude Code、Codex、DeepSeek 和 CodeAgent/);
    assert.match(shortcuts, /请先打开一个 Claude Code、Codex、DeepSeek 或 CodeAgent 会话/);
  });

  await test('main.js 把 CodeAgent 的记录目录传给搜索；服务与引擎把它带进子进程', () => {
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.match(main, /codeagentRoots: \[codeAgentProjectsRoot\(\)\]\.filter\(Boolean\)/);
    for (const file of ['core/session-search-service.js', 'core/session-search-engine.js']) {
      assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /codeagentRoots: Array\.isArray\(options\.codeagentRoots\)/, file);
    }
    const { codeAgentProjectsRoot, claudeProjectRoots } = require('../core/claude-transcript-locator');
    const saved = process.env.AI_HUB_CODEAGENT_CONFIG_DIR;
    process.env.AI_HUB_CODEAGENT_CONFIG_DIR = path.join(home, '.cac');
    try {
      assert.strictEqual(path.resolve(codeAgentProjectsRoot(home)), path.resolve(cacRoot));
      assert.ok(claudeProjectRoots(home).some(r => path.resolve(r) === path.resolve(cacRoot)));
    } finally {
      if (saved === undefined) delete process.env.AI_HUB_CODEAGENT_CONFIG_DIR; else process.env.AI_HUB_CODEAGENT_CONFIG_DIR = saved;
    }
  });

  if (failed) { console.error(`${failed} failed`); process.exit(1); }
  console.log('unit-codeagent-search-label: all passed');
})();
