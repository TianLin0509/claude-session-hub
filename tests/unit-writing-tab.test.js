'use strict';
/**
 * 写作 Tab 的数据层：作品库索引、文风 skill 读写、写作台篇目、起草配方。
 * 全部在临时目录里跑，不碰用户真实的文章目录和 tiange-voice skill。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LibraryIndex, parseArticle, isExemplar } = require('../core/writing/library-index.js');
const { VoiceStore } = require('../core/writing/voice-store.js');
const { PieceStore } = require('../core/writing/piece-store.js');
const runner = require('../core/writing/draft-runner.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `hub-writing-test-${tag}-`)); }

function fixturePaths() {
  const root = tmp('root');
  const voiceDir = tmp('voice');
  const lib = path.join(root, '田哥材料', '文章');
  fs.mkdirSync(path.join(lib, 'PythonicStock', '2023'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'CSDN', '2021'), { recursive: true });
  // 抓取脚本在 Windows 上写出的是 CRLF
  fs.writeFileSync(path.join(lib, 'PythonicStock', '2023', '20230412-通信之道.md'),
    ['# 通信之道', '', '- 公众号：PythonicStock', '- 发布日期：2023-04-12', '- 类型：图文', '- 原文链接：https://mp.weixin.qq.com/s/x', '- 汉字数：1180', '', '---', '', '在啦啦宝都等同事下班的间隙里，写一段思考。信道估计还不如不做。', ''].join('\r\n'));
  fs.writeFileSync(path.join(lib, 'CSDN', '2021', '20210628-深入浅出GAMP算法（上）：-因子图与消息传递算法.md'),
    ['# 深入浅出GAMP算法（上）', '', '- 平台：CSDN（x）', '- 发布日期：2021-06-28 10:00:00', '- 类型：原创', '- 汉字数：3260', '', '---', '', '最近一直在看 GAMP 算法。优化 迭代 最优解 约束 梯度下降。', ''].join('\n'));
  fs.writeFileSync(path.join(lib, '_索引.md'), '# 索引');
  fs.mkdirSync(path.join(voiceDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(voiceDir, 'SKILL.md'), [
    '# 田哥文风', '', '**一句话画像**：一个工科博士在跟聪明的朋友聊天。', '', '## 十条写法', '',
    '1. **第一句就是现场。** 写在哪。', '2. **自问自答往前推。** 替读者问。', '3. **用本行的道理讲别的事。** 类比。', '',
    '## 写技术段落', '', '三拍。', ''].join('\n'));
  fs.writeFileSync(path.join(voiceDir, 'exemplars.md'), [
    '# 田哥范文', '', '## 开场：第一句就是现场', '', '> 在啦啦宝都等同事下班的间隙里。', '', '（公众号 20230412-通信之道）', '',
    '> 最近一直在看 GAMP 算法相关。', '', '（CSDN 20210628-深入浅出GAMP算法（上））', '', '## 收束：在判断处停', '', '> 许多时候，再坚持一会就好了。', '', '（公众号 20230923-等待）', ''].join('\n'));
  fs.writeFileSync(path.join(voiceDir, 'learned-from-edits.md'), '# 规则\n\n## 已确认\n\n- 删掉解释性过渡句\n\n## 观察中\n\n（暂无）\n');
  fs.writeFileSync(path.join(voiceDir, 'CHANGELOG.md'), '# 变更记录\n');
  return {
    root, voiceDir,
    libraryRoots: [lib],
    piecesRoot: path.join(root, '写作台'),
    stateDir: path.join(root, 'hub-state'),
    draftGuide: path.join(root, 'draft.md'),
    reviewGuide: path.join(root, 'review.md'),
    diffScript: path.join(voiceDir, 'scripts', 'diff_edits.py'),
  };
}

console.log('写作 Tab 数据层');

test('解析文件头：标题、来源、日期、类型、字数', () => {
  const a = parseArticle('CSDN/2021/x.md', '# 标题\n\n- 平台：CSDN（x）\n- 发布日期：2021-06-28 10:00:00\n- 类型：原创\n- 汉字数：12\n\n---\n\n正文');
  assert.strictEqual(a.title, '标题');
  assert.strictEqual(a.source, 'CSDN');
  assert.strictEqual(a.date, '2021-06-28');
  assert.strictEqual(a.year, '2021');
  assert.strictEqual(a.original, true);
  assert.strictEqual(a.body, '正文');
});

test('作品库：CRLF 文件也能解析，下划线开头的索引文件不收', () => {
  const p = fixturePaths();
  const lib = new LibraryIndex(p);
  const items = lib.build();
  assert.strictEqual(items.length, 2);
  const wx = items.find((i) => i.source === '公众号');
  assert.strictEqual(wx.title, '通信之道');
  assert.strictEqual(wx.date, '2023-04-12');
  assert.ok(!wx.body.includes('\r'));
});

test('作品库：筛选、搜索、范文前缀匹配', () => {
  const p = fixturePaths();
  const lib = new LibraryIndex(p);
  const voice = new VoiceStore(p);
  const stems = voice.exemplarStems();
  assert.ok(isExemplar('20210628-深入浅出GAMP算法（上）：-因子图与消息传递算法', stems), '出处只写了文件名前半段也要算范文');
  const r = lib.list({ sources: ['CSDN'] }, stems);
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.items[0].exemplar, true);
  assert.ok(!('body' in r.items[0]), '列表不带全文');
  const s = lib.list({ query: '信道估计' }, stems);
  assert.strictEqual(s.total, 1);
  assert.ok(s.items[0].hit.includes('信道估计'));
  assert.strictEqual(r.stats.total, 2);
  assert.strictEqual(r.stats.exemplarCount, 2);
});

test('作品库：手改题材写进 overrides，重建后仍在', () => {
  const p = fixturePaths();
  const lib = new LibraryIndex(p);
  lib.build();
  const id = 'PythonicStock/2023/20230412-通信之道.md';
  lib.setTopics(id, ['无线通信', '随笔']);
  lib.build();
  assert.deepStrictEqual(lib.get(id).topics, ['无线通信', '随笔']);
});

test('文风：解析画像、写法、范文分组、改稿规则', () => {
  const v = new VoiceStore(fixturePaths());
  const s = v.snapshot();
  assert.ok(s.portrait.startsWith('一个工科博士'));
  assert.deepStrictEqual(s.rules.map((r) => r.title), ['第一句就是现场', '自问自答往前推', '用本行的道理讲别的事']);
  assert.ok(s.rules.every((r) => r.status === 'pending'));
  assert.deepStrictEqual(s.groups.map((g) => [g.key, g.items.length]), [['开场', 2], ['收束', 1]]);
  assert.deepStrictEqual(s.learned.confirmed, ['删掉解释性过渡句']);
});

test('文风：确认只改状态，不改 SKILL.md', () => {
  const p = fixturePaths();
  const v = new VoiceStore(p);
  const before = fs.readFileSync(path.join(p.voiceDir, 'SKILL.md'), 'utf8');
  assert.strictEqual(v.setRule(2, 'confirm').ok, true);
  assert.strictEqual(fs.readFileSync(path.join(p.voiceDir, 'SKILL.md'), 'utf8'), before);
  assert.strictEqual(v.snapshot().rules[1].status, 'confirmed');
  assert.ok(fs.readFileSync(path.join(p.voiceDir, 'CHANGELOG.md'), 'utf8').includes('确认第 2 条'));
});

test('文风：划掉一条后顺延编号，状态跟着挪；回退能恢复', () => {
  const p = fixturePaths();
  const v = new VoiceStore(p);
  v.setRule(3, 'confirm');
  assert.strictEqual(v.setRule(1, 'strike').ok, true);
  const s = v.snapshot();
  assert.deepStrictEqual(s.rules.map((r) => `${r.n}:${r.title}`), ['1:自问自答往前推', '2:用本行的道理讲别的事']);
  assert.strictEqual(s.rules[1].status, 'confirmed', '原第 3 条的确认状态随编号挪到第 2 条');
  assert.strictEqual(v.undo().ok, true);
  assert.strictEqual(v.parseSkill().rules.length, 3);
});

test('文风：改写整行并备份', () => {
  const p = fixturePaths();
  const v = new VoiceStore(p);
  assert.strictEqual(v.setRule(2, 'rewrite', '**自问自答往前推。** 把疑问替读者问出来。').ok, true);
  assert.ok(fs.readFileSync(path.join(p.voiceDir, 'SKILL.md'), 'utf8').includes('2. **自问自答往前推。** 把疑问替读者问出来。'));
  assert.ok(fs.readdirSync(path.join(p.voiceDir, 'backups')).length >= 1);
});

test('文风：范文候选转正写进对应分组，放弃则不写', () => {
  const p = fixturePaths();
  const v = new VoiceStore(p);
  const a = v.addCandidate({ group: '开场', text: '第一行\n第二行', source: '公众号 20240101-测试', why: '有现场' });
  const b = v.addCandidate({ group: '收束', text: '不要这段', source: '公众号 x' });
  assert.strictEqual(v.addCandidate({ group: '瞎写的分组', text: 'x' }).ok, false);
  v.resolveCandidate(a.candidate.id, 'promote');
  v.resolveCandidate(b.candidate.id, 'dismiss');
  const ex = fs.readFileSync(path.join(p.voiceDir, 'exemplars.md'), 'utf8');
  const open = ex.indexOf('## 开场'); const close = ex.indexOf('## 收束');
  const at = ex.indexOf('> 第一行\n> 第二行');
  assert.ok(at > open && at < close, '转正的范文插在开场分组里');
  assert.ok(!ex.includes('不要这段'));
  assert.strictEqual(v.readState().candidates.length, 0);
});

test('写作台：新建篇目、生成 brief、越界目录被拒', () => {
  const p = fixturePaths();
  const store = new PieceStore(p);
  const { dir, meta } = store.create({ series: '当无线通信遇上 Agent', title: '分身不是分集' });
  assert.strictEqual(meta.stage, 'interview');
  store.update(dir, { brief: { ...meta.brief, reader: '算法专家', thesis: '分身不是分集' } });
  const brief = fs.readFileSync(path.join(dir, 'brief.md'), 'utf8');
  assert.ok(brief.includes('- 读者：算法专家'));
  assert.deepStrictEqual(store.listPieces('当无线通信遇上 Agent').map((x) => x.title), ['分身不是分集']);
  assert.ok(fs.existsSync(path.join(p.piecesRoot, '当无线通信遇上 Agent')), '系列目录保留空格');
  assert.deepStrictEqual(store.listSeries().filter((x) => x.includes('无线')), ['当无线通信遇上 Agent'], '默认系列与目录名不重复');
  assert.throws(() => store.get(path.join(p.root, '..')), /不在写作台根下/);
});

test('作品库：写作台里定稿的文章以「新作」收进来', () => {
  const p = fixturePaths();
  const store = new PieceStore(p);
  const { dir } = store.create({ series: '随笔', title: '新文章' });
  fs.writeFileSync(path.join(dir, 'final.md'), '定稿正文，有几个字。');
  store.mutate(dir, (m) => { m.finalizedAt = new Date().toISOString(); });
  const lib = new LibraryIndex(p);
  const n = lib.build().find((i) => i.source === '新作');
  assert.ok(n);
  assert.strictEqual(n.status, '定稿');
});

test('起草配方：清掉嵌套会话与 API Key 环境变量', () => {
  const env = runner.cleanEnv({ PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_HUB_PORT: '3456', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', CODEX_HOME: 'y', KEEP: 'v' });
  assert.deepStrictEqual(Object.keys(env).sort(), ['KEEP', 'NO_COLOR', 'PATH']);
});

test('起草配方：Codex 只认订阅登录，API Key 登录不算', () => {
  const home = tmp('home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }));
  assert.strictEqual(runner.findCodexSubscription(home), null);
  fs.mkdirSync(path.join(home, '.codex-profiles', 'second'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex-profiles', 'second', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { a: 1 } }));
  fs.writeFileSync(path.join(home, '.codex-profiles', 'second', 'config.toml'), 'model = "gpt-6-astra"\n');
  const sub = runner.findCodexSubscription(home);
  assert.strictEqual(path.basename(sub.dir), 'second');
  assert.strictEqual(sub.model, 'gpt-6-astra');
});

test('起草配方：Codex 以 PATH 上 codex.cmd 实际指向的安装为准，不用 npm 目录里的旧包', () => {
  const dir = tmp('shim');
  const target = path.join(dir, 'managed', 'codex-managed.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '');
  fs.writeFileSync(path.join(dir, 'codex.cmd'), ['@ECHO off', 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "' + target + '" %*', ''].join('\r\n'));
  assert.strictEqual(runner.resolveCodexJs({ PATH: dir, APPDATA: tmp('appdata') }), target);
});

test('起草配方：Codex 临时配置关掉工具、记忆、skill，并换掉基础指令', () => {
  const toml = runner.codexConfigToml({ model: 'm', effort: 'high', instructionsFile: 'C:\\t\\i.md' });
  for (const line of ['shell_tool = false', 'memories = false', 'web_search = "disabled"', 'include_instructions = false', 'project_doc_max_bytes = 0', 'model_instructions_file = "C:/t/i.md"']) {
    assert.ok(toml.includes(line), line);
  }
});

test('审阅与访谈输出的解析容错', () => {
  const items = runner.parseReviewItems('好的：\n[{"anchor":"一句","problem":"太满","level":"建议"},{"x":1}]\n以上');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].status, 'open');
  assert.deepStrictEqual(runner.parseReviewItems('不是 JSON'), []);
  assert.deepStrictEqual(runner.parseQuestions('["问一","问二"]'), ['问一', '问二']);
  assert.deepStrictEqual(runner.parseQuestions('1. 你卡在哪里过？\n2. 哪个结论让你意外？'), ['你卡在哪里过？', '哪个结论让你意外？']);
});

test('隔离启动器：写作根默认圈进测试目录，指到外面直接报错', () => {
  const { buildIsolatedHubEnv } = require('./helpers/hub-launcher.js');
  const base = tmp('launcher');
  const dataDir = path.join(base, 'data');
  const env = buildIsolatedHubEnv(dataDir, {}, { PATH: process.env.PATH });
  assert.ok(env.CLAUDE_HUB_WRITING_ROOT.startsWith(path.resolve(dataDir)), '写作根必须在隔离数据目录里');
  assert.ok(env.CLAUDE_HUB_HOME_DIR.startsWith(path.resolve(dataDir)), '文风 skill 跟随隔离 home');
  assert.throws(() => buildIsolatedHubEnv(dataDir, { CLAUDE_HUB_WRITING_ROOT: 'C:\\AIWork\\20260926-写作工坊' }, {}), /CLAUDE_HUB_WRITING_ROOT/);
  assert.throws(() => buildIsolatedHubEnv(dataDir, { CLAUDE_HUB_VOICE_DIR: path.join(os.homedir(), '.codex', 'skills', 'tiange-voice') }, {}), /writing skill/);
});

console.log(`写作 Tab：${pass} 项通过`);
