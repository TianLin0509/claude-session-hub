'use strict';
/**
 * 写作 Tab：作品库索引、文风源文件读写、文章目录、写作场景群聊（场景、群规则、成员参数）、
 * 文风自动优化（用假模型验证把关与写回）、起草配方与隔离。
 * 全部在临时目录里跑，不碰用户真实的文章目录和文风 skill，不调用真实模型。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LibraryIndex, parseArticle, isExemplar } = require('../core/writing/library-index.js');
const { VoiceStore } = require('../core/writing/voice-store.js');
const { PieceStore, titleOf } = require('../core/writing/piece-store.js');
const { withWritingMemberOpts } = require('../core/writing/member-opts.js');
const { buildWritingScenePrompt } = require('../core/writing/scene-prompt.js');
const evolve = require('../core/writing/voice-evolve.js');
const runner = require('../core/writing/draft-runner.js');

let pass = 0;
const pending = [];
function test(name, fn) {
  const r = fn();
  if (r && typeof r.then === 'function') { pending.push(r.then(() => { pass++; console.log('  ✓ ' + name); })); return; }
  pass++; console.log('  ✓ ' + name);
}

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `hub-writing-test-${tag}-`)); }

const SKILL = [
  '# 田哥文风', '', '**一句话画像**：一个工科博士在跟聪明的朋友聊天。', '', '## 十条写法', '',
  '1. **第一句就是现场。** 写在哪。「在啦啦宝都等同事下班的间隙里」', '2. **自问自答往前推。** 替读者问。', '3. **用本行的道理讲别的事。** 类比。', '',
  '## 写技术段落', '', '三拍。', '', '## 其他文件', '', '- exemplars.md', ''].join('\n');

function fixturePaths() {
  const root = tmp('root');
  const voiceDir = tmp('voice');
  const lib = path.join(root, '田哥材料', '文章');
  fs.mkdirSync(path.join(lib, 'PythonicStock', '2023'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'CSDN', '2021'), { recursive: true });
  // 抓取脚本在 Windows 上写出的是 CRLF
  fs.writeFileSync(path.join(lib, 'PythonicStock', '2023', '20230412-通信之道.md'),
    ['# 通信之道', '', '- 公众号：PythonicStock', '- 发布日期：2023-04-12', '- 类型：图文', '- 汉字数：1180', '', '---', '', '在啦啦宝都等同事下班的间隙里，写一段思考。信道估计还不如不做。', ''].join('\r\n'));
  fs.writeFileSync(path.join(lib, 'CSDN', '2021', '20210628-深入浅出GAMP算法（上）：-因子图与消息传递算法.md'),
    ['# 深入浅出GAMP算法（上）', '', '- 平台：CSDN（x）', '- 发布日期：2021-06-28 10:00:00', '- 类型：原创', '- 汉字数：3260', '', '---', '', '最近一直在看 GAMP 算法。优化 迭代 最优解 约束 梯度下降。', ''].join('\n'));
  fs.writeFileSync(path.join(lib, '_索引.md'), '# 索引');
  fs.mkdirSync(path.join(voiceDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(voiceDir, 'SKILL.md'), SKILL);
  fs.writeFileSync(path.join(voiceDir, 'exemplars.md'), ['# 范文', '', '## 开场', '', '> 在啦啦宝都等同事下班的间隙里。', '', '（公众号 20230412-通信之道）', '', '> 最近一直在看 GAMP 算法相关。', '', '（CSDN 20210628-深入浅出GAMP算法（上））', ''].join('\n'));
  fs.writeFileSync(path.join(voiceDir, 'learned-from-edits.md'), '# 规则\n\n## 已确认\n\n（暂无）\n\n## 观察中\n\n（暂无）\n');
  fs.writeFileSync(path.join(voiceDir, 'CHANGELOG.md'), '# 变更记录\n');
  return {
    root, voiceDir,
    libraryRoots: [lib],
    piecesRoot: path.join(root, '写作台'),
    stateDir: path.join(root, 'hub-state'),
    draftGuide: path.join(root, 'draft.md'),
    diffScript: path.join(voiceDir, 'scripts', 'diff_edits.py'),
  };
}

console.log('写作 Tab');

/* ── 作品库 ── */

test('解析文件头：标题、来源、日期、类型', () => {
  const a = parseArticle('CSDN/2021/x.md', '# 标题\n\n- 平台：CSDN（x）\n- 发布日期：2021-06-28 10:00:00\n- 类型：原创\n- 汉字数：12\n\n---\n\n正文');
  assert.deepStrictEqual([a.title, a.source, a.date, a.year, a.original, a.body], ['标题', 'CSDN', '2021-06-28', '2021', true, '正文']);
});

test('作品库：CRLF 能解析；筛选、搜索、范文星标（前缀匹配）', () => {
  const p = fixturePaths();
  const lib = new LibraryIndex(p);
  const stems = new VoiceStore(p).exemplarStems();
  assert.strictEqual(lib.build().length, 2);
  assert.ok(isExemplar('20210628-深入浅出GAMP算法（上）：-因子图与消息传递算法', stems));
  const r = lib.list({ sources: ['CSDN'] }, stems);
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.items[0].exemplar, true);
  assert.ok(!('body' in r.items[0]), '列表不带全文');
  assert.ok(lib.list({ query: '信道估计' }, stems).items[0].hit.includes('信道估计'));
});

test('作品库：写作台里有定稿的文章以「新作」收进来，标题取定稿第一行', () => {
  const p = fixturePaths();
  const pieces = new PieceStore(p);
  const a = pieces.create();
  pieces.create(); // 没有定稿的不收
  fs.writeFileSync(path.join(a, 'final.md'), '# 分身不是分集\n\n定稿正文。');
  const n = new LibraryIndex(p).build().filter((i) => i.source === '新作');
  assert.deepStrictEqual(n.map((i) => [i.title, i.status]), [['分身不是分集', '定稿']]);
});

/* ── 文风源文件 ── */

test('文风：只放行三份源文件；保存前备份、记变更日志；回退能恢复', () => {
  const p = fixturePaths();
  const v = new VoiceStore(p);
  assert.throws(() => v.readSource('../secret.md'), /不允许/);
  assert.throws(() => v.saveSource('CHANGELOG.md', 'x'), /只能修改/);
  assert.strictEqual(v.saveSource('SKILL.md', SKILL).unchanged, true);
  v.saveSource('SKILL.md', SKILL.replace('写在哪。', '写在哪、为什么写。'), '田哥手动修改 SKILL.md');
  assert.ok(v.read('SKILL.md').includes('为什么写'));
  assert.ok(v.changelog()[0].includes('田哥手动修改 SKILL.md'));
  assert.strictEqual(v.undo().ok, true);
  assert.strictEqual(v.read('SKILL.md'), SKILL);
});

/* ── 文章目录 ── */

test('写作台：新文章不要标题；目录里有 .vibe-root；标题从稿件第一行读', () => {
  const p = fixturePaths();
  const pieces = new PieceStore(p);
  const dir = pieces.create();
  assert.ok(fs.existsSync(path.join(dir, '.vibe-root')), 'Codex 把文章目录当项目根');
  assert.strictEqual(pieces.summary(dir).title, '');
  fs.writeFileSync(path.join(dir, 'drafts', 'Claude-1.md'), '# 多一根天线，和多一条路\n\n正文');
  const s = pieces.summary(dir);
  assert.strictEqual(s.title, '多一根天线，和多一条路');
  assert.deepStrictEqual(s.drafts.map((d) => d.name), ['Claude-1']);
  assert.strictEqual(pieces.list().length, 1);
  assert.throws(() => pieces.summary(path.join(p.root, '..')), /不在写作台根下/);
  assert.strictEqual(titleOf('正文\n# 《终局思维》'), '终局思维');
});

/* ── 写作场景群聊 ── */

test('群聊：新增 writing 场景（房名留给自动命名），分支也保留场景', () => {
  const { MeetingRoomManager } = require('../core/meeting-room.js');
  const mgr = new MeetingRoomManager();
  const m = mgr.createMeeting({ mode: 'writing', groupChat: true });
  assert.strictEqual(m.scene, 'writing');
  assert.strictEqual(m.autoTitlePending, true, '标题由 AI 根据对话自动起');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'groupchat-fork-handlers.js'), 'utf8').includes("'writing'].includes(meeting.scene)"));
});

test('群规则：写作场景换成写作规则，稿件进消息正文，不写 HTML 产物', () => {
  const p = fixturePaths();
  const env = { CLAUDE_HUB_WRITING_ROOT: p.root, CLAUDE_HUB_VOICE_DIR: p.voiceDir, CLAUDE_HUB_WRITING_SKILLS_DIR: path.dirname(p.voiceDir) };
  const text = buildWritingScenePrompt('Claude 1', { workspace: 'C:\\x\\文章1' }, env);
  assert.ok(text.includes('这是写作群聊'));
  assert.ok(text.includes('先问 2 到 4 个关键问题'));
  assert.ok(text.includes('C:\\x\\文章1\\drafts\\Claude-1.md'));
  assert.ok(text.includes('第一句就是现场'), '注入了文风');
  assert.ok(!/HTML 三段式|artifacts\\/.test(text), '不再要求写 HTML 产物');
  const { buildSystemPromptText } = require('../core/group-chat-orchestrator.js');
  if (typeof buildSystemPromptText === 'function') {
    assert.ok(buildSystemPromptText('Claude 1', 'writing', { workspace: 'C:\\x' }).includes('这是写作群聊'));
    assert.ok(buildSystemPromptText('Claude 1', 'general', {}).includes('HTML 三段式'), '通用场景不受影响');
  }
});

test('成员参数：写作群成员标 purpose=writing；Claude 不加载 CLAUDE.md 与记忆', () => {
  const c = withWritingMemberOpts('claude', { model: 'opus', extraEnv: { A: '1' } });
  assert.strictEqual(c.purpose, 'writing');
  assert.deepStrictEqual(c.extraEnv, { A: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  assert.ok(!('settingSources' in c), '不能关掉 user settings：Hub 靠其中的 hooks 判断会话状态');
  const x = withWritingMemberOpts('codex', { model: 'gpt' });
  assert.strictEqual(x.purpose, 'writing');
  assert.ok(!x.extraEnv);
  assert.strictEqual(withWritingMemberOpts('claude-resume', {}).extraEnv.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'hub-memory-service.js'), 'utf8');
  assert.ok(src.includes("s.purpose==='writing'"), '写作成员不追加共享工作区规则');
});

/* ── 文风自动优化 ── */

test('自动优化：只取田哥真实发言（排除 Hub 派工与系统提示）', () => {
  const hub = tmp('hub');
  fs.mkdirSync(path.join(hub, 'arena-prompts'), { recursive: true });
  fs.writeFileSync(path.join(hub, 'arena-prompts', 'm1-groupchat.json'), JSON.stringify({ messages: [
    { role: 'user', content: '写一篇关于分身不是分集的文章', origin: 'user' },
    { role: 'assistant', content: '稿子' },
    { role: 'user', content: '派工卡片', origin: 'hub' },
    { role: 'user', content: '系统', systemNote: true },
    { role: 'user', content: 'B 稿开头太像讲义，A 稿第二段好' },
  ] }));
  assert.deepStrictEqual(evolve.userMessagesOf(hub, 'm1'), ['写一篇关于分身不是分集的文章', 'B 稿开头太像讲义，A 稿第二段好']);
});

test('自动优化：把关——结构、条数、篇幅、标签腔、田哥手改过的条目', () => {
  const ok = SKILL.replace('替读者问。', '替读者把疑问问出来。');
  assert.strictEqual(evolve.validate(SKILL, ok, []), '');
  assert.match(evolve.validate(SKILL, ok.replace('## 十条写法', '## 写法'), []), /十条写法/);
  const eleven = SKILL.replace('3. **用本行', Array.from({ length: 9 }, (_, i) => `${i + 3}. **条${i}** x`).join('\n') + '\n12. **用本行');
  assert.match(evolve.validate(SKILL, eleven, []), /超过十条/);
  // 「写技术段落」小节里的加粗编号步骤不算写法（E2E 用真实 SKILL.md 撞到过：被误数成 13 条）
  const withSteps = ok + '\n## 写技术段落\n\n1. **先问为什么**：x\n2. **再推导**：y\n3. **最后一句大白话**：z\n';
  assert.strictEqual(evolve.rulesOf(withSteps).length, 3);
  assert.strictEqual(evolve.validate(SKILL, withSteps, []), '');
  assert.match(evolve.validate(SKILL, SKILL.slice(0, 60), []), /篇幅/);
  assert.match(evolve.validate(SKILL, ok + '【推断】', []), /标签腔/);
  const protectedLine = '1. **第一句就是现场。** 写在哪。「在啦啦宝都等同事下班的间隙里」';
  assert.match(evolve.validate(SKILL, ok.replace(protectedLine, '1. **开头要有现场感。** x'), [protectedLine]), /手动确认/);
});

test('自动优化：定稿后读写作过程，改 SKILL.md、记变更；未通过检查不写回', async () => {
  const p = fixturePaths();
  const hub = tmp('hub');
  const voice = new VoiceStore(p);
  const pieces = new PieceStore(p);
  const dir = pieces.create();
  fs.writeFileSync(path.join(dir, 'drafts', 'Claude-1.md'), '# 稿\n\n正文一。');
  fs.writeFileSync(path.join(dir, 'final.md'), '# 分身不是分集\n\n正文一。结尾。');
  const fakeGood = async () => ({ text: JSON.stringify({ changed: true, summary: '田哥说 B 稿开头像讲义，第 1 条补上“开头别像讲义”', skill_md: SKILL.replace('写在哪。', '写在哪，别像讲义。'), learned_md: '' }) });
  const r1 = await evolve.evolveVoiceFromPiece({ dir, pieces, voice, paths: p, hubDataDir: hub, model: 'x', runner: fakeGood });
  assert.strictEqual(r1.status, 'done');
  assert.ok(voice.read('SKILL.md').includes('别像讲义'));
  assert.ok(voice.changelog()[0].includes('AI 根据《分身不是分集》的写作过程优化文风'), voice.changelog()[0]);
  const fakeBad = async () => ({ text: JSON.stringify({ changed: true, summary: 'x', skill_md: '# 只剩一行' }) });
  const before = voice.read('SKILL.md');
  const r2 = await evolve.evolveVoiceFromPiece({ dir, pieces, voice, paths: p, hubDataDir: hub, model: 'x', runner: fakeBad });
  assert.strictEqual(r2.status, 'rejected');
  assert.strictEqual(voice.read('SKILL.md'), before, '未通过检查不写回');
});

test('自动优化：只改了改稿规则时，变更日志同样记下 AI 这次优化', async () => {
  const p = fixturePaths();
  const voice = new VoiceStore(p);
  const pieces = new PieceStore(p);
  const dir = pieces.create();
  fs.writeFileSync(path.join(dir, 'final.md'), '# 开头别像讲义\n\n正文。');
  const skill = voice.read('SKILL.md');
  const fake = async () => ({ text: JSON.stringify({ changed: true, summary: '观察中加一条：开头别像讲义', skill_md: '', learned_md: '# 改稿规则\n\n## 观察中\n\n- 开头从具体场景起笔' }) });
  const r = await evolve.evolveVoiceFromPiece({ dir, pieces, voice, paths: p, hubDataDir: tmp('hub'), model: 'x', runner: fake });
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.changed, true);
  assert.strictEqual(voice.read('SKILL.md'), skill, 'SKILL.md 没动');
  assert.ok(voice.read('learned-from-edits.md').includes('具体场景起笔'));
  assert.ok(/AI 根据《开头别像讲义》的写作过程优化文风.*改稿规则/.test(voice.changelog()[0]), voice.changelog()[0]);
});

/* ── 起草配方（文风优化用的后台调用） ── */

test('后台调用：清掉嵌套会话与 API Key 环境变量', () => {
  const env = runner.cleanEnv({ PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_HUB_PORT: '3456', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', CODEX_HOME: 'y', KEEP: 'v' });
  assert.deepStrictEqual(Object.keys(env).sort(), ['KEEP', 'NO_COLOR', 'PATH']);
});

test('后台调用：Codex 只认订阅登录；以 PATH 上 codex.cmd 实际指向的安装为准', () => {
  const home = tmp('home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }));
  assert.strictEqual(runner.findCodexSubscription(home), null);
  fs.mkdirSync(path.join(home, '.codex-profiles', 'second'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex-profiles', 'second', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { a: 1 } }));
  assert.strictEqual(path.basename(runner.findCodexSubscription(home).dir), 'second');
  const dir = tmp('shim');
  const target = path.join(dir, 'managed', 'codex-managed.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '');
  fs.writeFileSync(path.join(dir, 'codex.cmd'), ['@ECHO off', 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "' + target + '" %*', ''].join('\r\n'));
  assert.strictEqual(runner.resolveCodexJs({ PATH: dir, APPDATA: tmp('appdata') }), target);
});

test('隔离启动器：写作根默认圈进测试目录，指到外面直接报错', () => {
  const { buildIsolatedHubEnv } = require('./helpers/hub-launcher.js');
  const dataDir = path.join(tmp('launcher'), 'data');
  const env = buildIsolatedHubEnv(dataDir, {}, { PATH: process.env.PATH });
  assert.ok(env.CLAUDE_HUB_WRITING_ROOT.startsWith(path.resolve(dataDir)));
  assert.ok(env.CLAUDE_HUB_HOME_DIR.startsWith(path.resolve(dataDir)), '文风 skill 跟随隔离 home');
  assert.throws(() => buildIsolatedHubEnv(dataDir, { CLAUDE_HUB_WRITING_ROOT: 'C:\\AIWork\\20260926-写作工坊' }, {}), /CLAUDE_HUB_WRITING_ROOT/);
  assert.throws(() => buildIsolatedHubEnv(dataDir, { CLAUDE_HUB_VOICE_DIR: path.join(os.homedir(), '.codex', 'skills', 'tiange-voice') }, {}), /writing skill/);
});

Promise.all(pending).then(() => console.log(`写作 Tab：${pass} 项通过`)).catch((e) => { console.error(e); process.exit(1); });
