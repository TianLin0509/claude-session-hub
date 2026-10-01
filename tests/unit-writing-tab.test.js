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

test('文风：编辑期间文件被 AI 改过就不覆盖；只保护田哥真正动过的写法条目', () => {
  const p = fixturePaths();
  const v = new VoiceStore(p);
  const edited = SKILL.replace('2. **自问自答往前推。** 替读者问。', '2. **自问自答往前推。** 替读者把疑问问出来。');
  assert.throws(() => v.saveSource('SKILL.md', edited, '田哥手动修改 SKILL.md', SKILL.replace('类比。', '类比，AI 刚改的。')), /编辑期间/);
  v.saveSource('SKILL.md', edited, '田哥手动修改 SKILL.md', SKILL);
  assert.deepStrictEqual(v.protectedRules(), ['2. **自问自答往前推。** 替读者把疑问问出来。']);
  // AI 可以照常改第 3 条，但不能改田哥手改的第 2 条
  assert.strictEqual(evolve.validate(edited, edited.replace('类比。', '类比要真的参与推理。'), v.protectedRules()), '');
  assert.match(evolve.validate(edited, edited.replace('替读者把疑问问出来。', '替读者问。'), v.protectedRules()), /手动确认/);
});

test('文风回退：同一次优化写的两份文件一起退；同一秒内的先后顺序不乱', () => {
  const p = fixturePaths();
  const v = new VoiceStore(p);
  const learned = v.read('learned-from-edits.md');
  v.writeWithBackup('exemplars.md', '# 范文\n\n先改的\n', '手动');
  const batch = v.newBatch();
  v.writeWithBackup('SKILL.md', SKILL.replace('类比。', '类比二。'), 'AI 根据', batch);
  v.writeWithBackup('learned-from-edits.md', '# 规则\n\n新\n', '同一次', batch);
  const r = v.undo();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(v.read('SKILL.md'), SKILL);
  assert.strictEqual(v.read('learned-from-edits.md'), learned);
  assert.ok(v.read('exemplars.md').includes('先改的'), '更早的另一批不受影响');
  // 旧格式备份（毫秒没补零）也能按时间排对
  const bd = path.join(p.voiceDir, 'backups');
  for (const f of fs.readdirSync(bd)) fs.unlinkSync(path.join(bd, f));
  fs.writeFileSync(path.join(bd, '20260930-101010-95-SKILL.md'), 'A');
  fs.writeFileSync(path.join(bd, '20260930-101010-130-SKILL.md'), 'B');
  v.undo();
  assert.strictEqual(v.read('SKILL.md'), 'B');
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

test('群规则：写作场景换成写作规则——回答即稿件，末尾附 hub-writing 卡片；文风给文件路径', () => {
  const p = fixturePaths();
  const env = { CLAUDE_HUB_WRITING_ROOT: p.root, CLAUDE_HUB_VOICE_DIR: p.voiceDir, CLAUDE_HUB_WRITING_SKILLS_DIR: path.dirname(p.voiceDir) };
  const text = buildWritingScenePrompt('Claude 1', { workspace: 'C:\\x\\文章1' }, env);
  assert.ok(text.includes('这是写作群聊'));
  assert.ok(text.includes('hub-writing'), '讲清卡片格式');
  for (const type of ['"type":"draft"', '"type":"final"', '"type":"questions"']) assert.ok(text.includes(type), type);
  assert.ok(text.includes('稿里先按推荐答案写，不等他回答'), '有问题也先写一版（田哥 2026-10-01 拍板）');
  assert.ok(text.includes(path.join(p.voiceDir, 'SKILL.md')), '文风给文件路径让 AI 自己读');
  assert.ok(text.length < 1600, `群规则要短，首条消息才不容易卡在 Codex 长文本通道（现在 ${text.length} 字）`);
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

test('自动优化：模型运行期间田哥手动改了文件，就不拿旧快照覆盖；改稿规则被截断也不写回', async () => {
  const p = fixturePaths();
  const voice = new VoiceStore(p);
  const pieces = new PieceStore(p);
  const dir = pieces.create();
  fs.writeFileSync(path.join(dir, 'final.md'), '# 并发\n\n正文。');
  const manual = SKILL.replace('类比。', '类比，田哥刚改。');
  const racing = async () => {
    voice.saveSource('SKILL.md', manual, '田哥手动修改 SKILL.md');
    return { text: JSON.stringify({ changed: true, summary: 's', skill_md: SKILL.replace('写在哪。', '写在哪，AI 改。'), learned_md: '' }) };
  };
  const r1 = await evolve.evolveVoiceFromPiece({ dir, pieces, voice, paths: p, hubDataDir: tmp('hub'), model: 'x', runner: racing });
  assert.strictEqual(r1.status, 'rejected');
  assert.strictEqual(voice.read('SKILL.md'), manual, '田哥的手动修改保住了');
  const longLearned = `# 规则\n\n${'已有的一条改稿规则。\n'.repeat(30)}`;
  fs.writeFileSync(path.join(p.voiceDir, 'learned-from-edits.md'), longLearned);
  const truncating = async () => ({ text: JSON.stringify({ changed: true, summary: 's', skill_md: '', learned_md: '# 规则' }) });
  const r2 = await evolve.evolveVoiceFromPiece({ dir, pieces, voice, paths: p, hubDataDir: tmp('hub'), model: 'x', runner: truncating });
  assert.strictEqual(r2.status, 'rejected');
  assert.strictEqual(voice.read('learned-from-edits.md'), longLearned);
});

test('自动优化：模型第一次输出不是合法 JSON，提醒转义后再试一次', async () => {
  const p = fixturePaths();
  const voice = new VoiceStore(p);
  const pieces = new PieceStore(p);
  const dir = pieces.create();
  fs.writeFileSync(path.join(dir, 'final.md'), '# 重试\n\n正文。');
  const systems = [];
  const flaky = async (_kind, { system }) => { systems.push(system); return { text: systems.length === 1 ? '{"changed": true, "skill_md": "坏的\n没转义"' : '{"changed": false, "summary": "没有新依据"}' }; };
  const r = await evolve.evolveVoiceFromPiece({ dir, pieces, voice, paths: p, hubDataDir: tmp('hub'), model: 'x', runner: flaky });
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(systems.length, 2);
  assert.ok(systems[1].includes('上一次输出不是合法 JSON'));
});

test('自动优化：同一篇定稿再改，群里没有新点评就不再跑模型', async () => {
  const p = fixturePaths();
  const voice = new VoiceStore(p);
  const pieces = new PieceStore(p);
  const dir = pieces.create();
  fs.writeFileSync(path.join(dir, 'final.md'), '# 再改\n\n正文。');
  const hub = tmp('hub');
  fs.mkdirSync(path.join(hub, 'arena-prompts'), { recursive: true });
  fs.writeFileSync(path.join(hub, 'arena-prompts', 'm1-groupchat.json'), JSON.stringify({ messages: [{ role: 'user', sid: 'user', content: '开头太像讲义' }] }));
  pieces.mutate(dir, (m) => { m.meetingId = 'm1'; m.voice = { status: 'queued', userCount: 1 }; });
  let calls = 0;
  const counting = async () => { calls++; return { text: '{"changed": false, "summary": "x"}' }; };
  const r = await evolve.evolveVoiceFromPiece({ dir, pieces, voice, paths: p, hubDataDir: hub, model: 'x', runner: counting });
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(calls, 0);
});

/* ── 文章工作台：群聊记录 → 稿件、问题、成员状态 ── */

const wb = require('../core/writing/workbench.js');
const FENCE = '```';
const card = (...objs) => `\n\n${FENCE}hub-writing\n${objs.map((o) => JSON.stringify(o)).join('\n')}\n${FENCE}\n`;
const DRAFT_BODY = `# 分身不是分集\n\n正文第一段。\n\n${FENCE}python\nprint("稿里的代码块不能把卡片解析截断")\n${FENCE}\n\n结尾。`;

test('卡片：交稿与问题写在同一个代码块里也认；稿里的代码块原样保留；坏卡片不吞正文', () => {
  const r = wb.parseCards(DRAFT_BODY + card({ type: 'questions', items: [{ q: '写给谁？', recommend: '算法工程师' }] }, { type: 'draft', title: '分身不是分集', note: '先讲反例' }));
  assert.deepStrictEqual(r.cards.map((c) => c.type), ['questions', 'draft']);
  assert.strictEqual(r.cards[0].items[0].recommend, '算法工程师');
  assert.ok(r.body.includes('print("稿里的代码块'), '正文代码块还在');
  assert.ok(!r.body.includes('hub-writing'));
  const bad = wb.parseCards(`# 稿\n\n正文${card('x').replace('"x"', '{坏的')}`);
  assert.strictEqual(bad.cards.length, 0);
  assert.ok(bad.errors.length && bad.body.includes('正文'));
});

function groupState() {
  const A = 'sid-a'; const B = 'sid-b'; const C = 'sid-c';
  return {
    currentTurn: 2,
    messages: [
      { id: 'u1', role: 'user', turnNum: 1, content: '中心思想：多模型互审不等于分集增益\n\n（写作 Tab：请按写作群规则交稿，回答末尾附 hub-writing 卡片。）', origin: 'user' },
      { id: 'a1-m1', role: 'assistant', sid: A, speaker: 'Claude 1', turnNum: 1, status: 'completed', content: DRAFT_BODY + card({ type: 'questions', items: [{ q: '写给谁？', recommend: '算法工程师' }] }, { type: 'draft', title: '分身不是分集', note: '先讲反例' }) },
      { id: 'a1-m2', role: 'assistant', sid: B, speaker: 'Codex 2', turnNum: 1, status: 'completed', content: '田哥，我建议这篇先帮读者选产品。' + '这是一段没有附卡片、也不像稿件的回答。'.repeat(20) },
      { id: 'a1-m3', role: 'assistant', sid: C, speaker: 'DeepSeek 3', turnNum: 1, status: 'errored', content: '' },
      { id: 'h2', role: 'user', turnNum: 2, content: '[Hub 派工卡片]', origin: 'hub' },
      { id: 'u2', role: 'user', turnNum: 2, content: '我的点评：开头再狠一点', origin: 'user' },
      { id: 'a2-m1', role: 'assistant', sid: A, speaker: 'Claude 1', turnNum: 2, status: 'completed', content: '# 分身不是分集（改）\n\n改过的正文。' + card({ type: 'draft', title: '分身不是分集（改）', note: '按点评改了开头' }, { type: 'questions', items: [{ q: '要不要放公式？', recommend: '放一个' }] }) },
    ],
    attempts: {
      x1: { sid: A, memberId: 'm1', kind: 'claude', turnNum: 2, status: 'completed', updatedAt: 5 },
      x2: { sid: B, memberId: 'm2', kind: 'codex', turnNum: 2, status: 'running', updatedAt: 5 },
      x3: { sid: C, memberId: 'm3', kind: 'deepseek', turnNum: 1, status: 'failed', updatedAt: 3, failure: { detail: '未确认 Codex 已接收长文本并恢复输入，未发回车；请重开此会话后重试' } },
    },
  };
}
const MEMBERS = [{ sid: 'sid-a', memberId: 'm1', name: 'Claude 1', kind: 'claude' }, { sid: 'sid-b', memberId: 'm2', name: 'Codex 2', kind: 'codex' }, { sid: 'sid-c', memberId: 'm3', name: 'DeepSeek 3', kind: 'deepseek' }];

test('工作台：每位一栏、版本递增；没卡片的回答原样显示；出错与在写看得见；问题只留最新一轮', () => {
  const v = wb.buildView({ state: groupState(), members: MEMBERS, files: [] });
  assert.strictEqual(v.idea, '中心思想：多模型互审不等于分集增益', 'Hub 派工卡片不算田哥的话');
  assert.deepStrictEqual(v.columns.map((c) => c.name), ['Claude 1', 'Codex 2', 'DeepSeek 3']);
  const [a, b, c] = v.columns;
  assert.deepStrictEqual(a.items.map((it) => [it.kind, it.version, it.title]), [['draft', 1, '分身不是分集'], ['draft', 2, '分身不是分集（改）']]);
  assert.ok(!a.items[0].text.includes('hub-writing') && a.items[0].text.includes('print('), '正文去掉卡片、保留代码块');
  assert.strictEqual(b.items[0].kind, 'reply');
  assert.strictEqual(b.status, 'working');
  assert.strictEqual(c.status, 'error');
  assert.ok(c.error.includes('重开此会话'));
  assert.deepStrictEqual(v.questions.map((q) => q.q), ['要不要放公式？'], '第 1 轮的问题田哥开口后就收起');
  assert.strictEqual(v.title, '分身不是分集（改）');
  assert.deepStrictEqual(v.steps, { idea: true, draft: true, review: true, revise: true, final: false });
  assert.strictEqual(v.running, true);
});

test('工作台：忘了附卡片但明显是一份稿（# 标题开头、有篇幅），照样按稿件收下并编版本', () => {
  const st = { currentTurn: 1, messages: [
    { id: 'u1', role: 'user', origin: 'user', turnNum: 1, content: '中心思想' },
    { id: 'a1', role: 'assistant', sid: 'sid-a', speaker: 'Claude 1', turnNum: 1, status: 'completed', content: '# 多分身不等于分集\n\n' + '同一个模型的分身错误高度相关。'.repeat(15) },
  ], attempts: {} };
  const it = wb.buildView({ state: st, members: MEMBERS.slice(0, 1) }).columns[0].items[0];
  assert.deepStrictEqual([it.kind, it.version, it.title, it.implicit], ['draft', 1, '多分身不等于分集', true]);
  assert.ok(it.note.includes('没附交稿卡'));
});

test('工作台：Tab 点名「请 X 汇总定稿」的那一轮，X 交的稿忘了附定稿卡也按定稿收下', () => {
  const st = groupState();
  st.messages.push({ id: 'u3', role: 'user', origin: 'user', turnNum: 3, content: '请 Claude 1 汇总定稿：读完群里所有稿和我的全部点评，取各稿之长改定，交定稿卡。' });
  st.messages.push({ id: 'a3-m1', role: 'assistant', sid: 'sid-a', speaker: 'Claude 1', turnNum: 3, status: 'completed', content: '# 汇总后的定稿\n\n' + '取两稿之长改定的正文。'.repeat(20) });
  st.currentTurn = 3;
  const v = wb.buildView({ state: st, members: MEMBERS });
  assert.strictEqual(v.final && v.final.title, '汇总后的定稿');
  assert.strictEqual(v.steps.final, true);
  assert.ok(v.columns[0].items.pop().implicit);
});

test('工作台：定稿卡置顶；文章目录里 Hub 没写过的稿件文件按名字归到成员，内容重复的不列', () => {
  const st = groupState();
  st.messages.push({ id: 'a3-m1', role: 'assistant', sid: 'sid-a', speaker: 'Claude 1', turnNum: 3, status: 'completed', content: '# 定稿标题\n\n定稿正文。' + card({ type: 'final', title: '定稿标题', note: '合了两稿' }) });
  st.currentTurn = 3;
  const files = [
    { name: 'Codex-2.md', text: '# Codex 自己存的稿\n\n另一份内容。', mtime: 1 },
    { name: 'Claude-1.md', text: '# 分身不是分集（改）\n\n改过的正文。', mtime: 1 },
    { name: '随手.md', text: '# 没主的稿\n\n内容。', mtime: 1 },
  ];
  const v = wb.buildView({ state: st, members: MEMBERS, files });
  assert.strictEqual(v.final.title, '定稿标题');
  assert.strictEqual(v.final.from, 'Claude 1');
  assert.strictEqual(v.steps.final, true);
  assert.ok(v.columns[1].items.some((it) => it.kind === 'file' && it.file === 'Codex-2.md'));
  assert.ok(!v.columns[0].items.some((it) => it.kind === 'file'), '与群里那份相同的文件不重复列');
  assert.strictEqual(v.columns[3].name, '其他稿件文件');
});

test('工作台落盘：交稿存成 drafts/<成员>-v<n>.md、定稿存成 final.md；再读时不当成「其他文件」', () => {
  const p = fixturePaths();
  const pieces = new PieceStore(p);
  const dir = pieces.create();
  const st = groupState();
  st.messages.push({ id: 'a3-m1', role: 'assistant', sid: 'sid-a', speaker: 'Claude 1', turnNum: 3, status: 'completed', content: '# 定稿标题\n\n定稿正文。' + card({ type: 'final', title: '定稿标题' }) });
  const v = wb.buildView({ state: st, members: MEMBERS, files: [] });
  const first = wb.materialize(dir, v, {});
  assert.deepStrictEqual(first.written, ['Claude-1-v1.md', 'Claude-1-v2.md'], '定稿不另存进 drafts/（否则文风优化算出的改动比例永远是 0%）');
  assert.ok(fs.readFileSync(path.join(dir, 'drafts', 'Claude-1-v1.md'), 'utf8').startsWith('# 分身不是分集'));
  assert.ok(fs.readFileSync(path.join(dir, 'final.md'), 'utf8').startsWith('# 定稿标题'));
  assert.strictEqual(pieces.summary(dir).hasFinal, true, '作品库与文风优化照旧读 final.md');
  // 田哥直接改了 final.md：同一张定稿卡再读多少次，都不把他的改动改回去
  fs.writeFileSync(path.join(dir, 'final.md'), '# 定稿标题\n\n田哥亲手改过的定稿。\n');
  const again = wb.materialize(dir, wb.buildView({ state: st, members: MEMBERS, files: [] }), first);
  assert.ok(fs.readFileSync(path.join(dir, 'final.md'), 'utf8').includes('田哥亲手改过'));
  assert.strictEqual(again.finalHash, first.finalHash);
  // 群里出了新的定稿卡（田哥又请人改定），才覆盖
  st.messages.push({ id: 'a4-m1', role: 'assistant', sid: 'sid-a', speaker: 'Claude 1', turnNum: 4, status: 'completed', content: '# 第二版定稿\n\n再改过。' + card({ type: 'final', title: '第二版定稿' }) });
  wb.materialize(dir, wb.buildView({ state: st, members: MEMBERS, files: [] }), again);
  assert.ok(fs.readFileSync(path.join(dir, 'final.md'), 'utf8').startsWith('# 第二版定稿'));
  // 只附卡片没有正文：不当稿、不落空文件
  st.messages.push({ id: 'a5-m2', role: 'assistant', sid: 'sid-b', speaker: 'Codex 2', turnNum: 5, status: 'completed', content: card({ type: 'draft', title: '空的' }).trim() });
  const v5 = wb.buildView({ state: st, members: MEMBERS, files: [] });
  assert.strictEqual(v5.columns[1].items.pop().kind, 'reply');
});

test('工作台 IPC：按文章目录读群聊记录与成员，交稿落盘并记进 piece.json', async () => {
  const p = fixturePaths();
  const hub = tmp('hub');
  fs.mkdirSync(path.join(hub, 'arena-prompts'), { recursive: true });
  fs.writeFileSync(path.join(hub, 'arena-prompts', 'meet-1-groupchat.json'), JSON.stringify(groupState()));
  const saved = { ...process.env };
  Object.assign(process.env, { CLAUDE_HUB_WRITING_ROOT: p.root, CLAUDE_HUB_VOICE_DIR: p.voiceDir });
  try {
    const handlers = new Map();
    const { registerWritingIpc } = require('../main/ipc/writing-handlers.js');
    registerWritingIpc({ handle: (k, fn) => handlers.set(k, fn) }, {
      getHubDataDir: () => hub,
      meetingManager: { getMeeting: (id) => (id === 'meet-1' ? { id, subSessions: ['sid-a', 'sid-b', 'sid-c'], slotSpecs: [] } : null) },
      sessionManager: { getSession: (sid) => ({ 'sid-a': { title: 'Claude 1', kind: 'claude', status: 'idle' }, 'sid-b': { title: 'Codex 2', kind: 'codex', status: 'idle' } })[sid] || null },
    });
    const pieces = new PieceStore(p);
    const dir = pieces.create();
    await handlers.get('writing:article-bind')({}, { dir, meetingId: 'meet-1' });
    const r = await handlers.get('writing:article-view')({}, { dir });
    assert.strictEqual(r.ok, true, r.message);
    assert.deepStrictEqual(r.view.columns.map((c) => c.name), ['Claude 1', 'Codex 2', 'DeepSeek 3']);
    assert.strictEqual(r.view.columns[2].status, 'error');
    assert.deepStrictEqual(pieces.readMeta(dir).written, ['Claude-1-v1.md', 'Claude-1-v2.md']);
    const again = await handlers.get('writing:article-view')({}, { dir });
    assert.ok(!again.view.columns.some((c) => c.name === '其他稿件文件'), 'Hub 自己写的稿件文件不重复列');
    const outside = await handlers.get('writing:article-view')({}, { dir: path.join(p.root, '..') });
    assert.strictEqual(outside.ok, false, '文章目录必须在写作台根下');
  } finally {
    for (const k of ['CLAUDE_HUB_WRITING_ROOT', 'CLAUDE_HUB_VOICE_DIR']) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
  }
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
