'use strict';
// 资料口播：拆章（长章拆集、参考文献只读）、写稿退回、后台调度与产物、手机通道按需取文件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chapters, markdownBlocks } = require('../core/hub-assistant/podcast/extract');
const { buildPrompt, writeScript, tidy } = require('../core/hub-assistant/podcast/script');
const { PodcastStudio } = require('../core/hub-assistant/podcast/studio');
const { edgeAll } = require('../core/hub-assistant/podcast/voice');

test('long voice synthesis splits at sentences, preserves all text and removes every partial file on failure', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-voice-')), prefix = path.join(dir, 'lesson');
 const text = ('完整讲解一段技术原理。').repeat(400), seen = [];
 try {
  const files = await edgeAll(text, prefix, { edgeImpl: async (part, file) => { seen.push(part); fs.writeFileSync(file, 'audio'); }, t: {} });
  assert.equal(seen.join(''), text); assert.ok(files.length > 1); assert.ok(seen.every(p => p.length <= 1200));
  let calls = 0; await assert.rejects(edgeAll(text, prefix, { edgeImpl: async (_part, file) => { fs.writeFileSync(file, 'partial'); if (++calls === 2) throw Error('connection lost'); }, t: {} }), /connection lost/);
  assert.equal(fs.existsSync(files[0]), false); assert.equal(fs.existsSync(files[1]), false);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('a failed lesson can be retried by a new request; duplicate current calls do not synthesize twice', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-retry-')); let calls = 0;
 const studio = new PodcastStudio({ dataDir: dir, synthesize: async (_text, out) => { if (++calls === 1) throw Error('network interrupted'); fs.writeFileSync(out, 'verified audio'); return { seconds: 720, bytes: 14, voice: 'fixture' }; } });
 const b = { id: 'lesson-20261007-retry', title: '课程', script: '公开知识', markdown: '公开知识', requestId: 'one' };
 try {
  await studio.startLesson(b); await studio.running.get(b.id); assert.equal(studio.read(b.id).status, 'failed');
  await studio.startLesson(b); assert.equal(calls, 1);
  await studio.startLesson({ ...b, requestId: 'two' }); await studio.running.get(b.id); assert.equal(calls, 2); assert.equal(studio.read(b.id).status, 'done'); assert.equal(studio.read(b.id).retryCount, 1);
  await studio.startLesson({ ...b, requestId: 'three' }); assert.equal(calls, 2);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const para = (n, ch = '说') => ch.repeat(n);
test('chapters split on the repeated top heading; long chapters become parts; reference chapters are reading-only', () => {
  const md = ['# 学习手册', '开篇说明' + para(150), '## 第一章 偏好', para(400), '## 第二章 十六型', '### 甲', para(4000), '### 乙', para(4000), '### 丙', para(2000), '## 资料与阅读路径', '- 链接一' + para(200)].join('\n');
  const d = chapters(markdownBlocks(md), '备用名');
  assert.equal(d.title, '学习手册');
  assert.deepEqual(d.chapters.map(c => c.title), ['导读', '第一章 偏好', '第二章 十六型（上）', '第二章 十六型（下）', '资料与阅读路径']);
  assert.deepEqual(d.chapters.map(c => c.readOnly), [false, false, false, false, true]);
  assert.match(d.chapters[1].markdown, /^## 第一章 偏好/);
  assert.match(d.chapters[3].markdown, /#### 乙|#### 丙/);
});

test('the prompt carries the listener, the golden-line rule and a length that fits the chapter; tidy keeps only spoken text', () => {
  const p = buildPrompt({ book: 'MBTI 手册', chapter: '四个维度', index: 3, total: 12, text: para(800) });
  assert.match(p, /《MBTI 手册》第 3 集（共 12 集）：「四个维度」/); assert.match(p, /金句/); assert.match(p, /900～1300/);
  assert.match(buildPrompt({ book: 'b', chapter: 'c', index: 1, total: 1, text: para(9000) }), /1800～2400/);
  assert.equal(tidy('# 标题\n第一句。\n---\n**重点**第二句。\n【片尾音乐】'), '第一句。\n重点第二句。');
});

test('writing falls back to the next writer when the first fails', async () => {
  const r = await writeScript('p', [{ name: 'Claude Opus', write: async () => { throw new Error('额度用完'); } }, { name: '千问', write: async () => '稿子正文' }]);
  assert.equal(r.writer, '千问'); assert.equal(r.text, '稿子正文');
  await assert.rejects(writeScript('p', [{ name: 'A', write: async () => { throw new Error('x'); } }]), /A：x/);
});

test('the studio writes, voices and records every episode in the background, keeps reading-only chapters silent, and reports when done', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'book.md'); fs.writeFileSync(src, 'x');
  const doc = chapters(markdownBlocks(['# 书', '## 一', para(300), '## 二', para(300), '## 参考资料', para(300)].join('\n')));
  const prompts = [], done = []; let changes = 0;
  const studio = new PodcastStudio({ dataDir: dir, extract: async () => doc,
    writers: [{ name: 'Claude Opus', write: async p => { prompts.push(p); return '金句开头。' + para(1200, '讲') + '金句收尾。'; } }],
    synthesize: async (text, out) => { fs.writeFileSync(out, 'OggS' + text.length); return { seconds: 300, bytes: 1000, voice: '微软 曉臻' }; },
    onChange: () => changes++, onDone: m => done.push(m) });
  const r = await studio.start(src);
  assert.equal(r.episodes, 3); assert.equal(r.audio, 2);
  await studio.running.get(r.id);
  const m = studio.read(r.id);
  assert.equal(m.status, 'done'); assert.equal(done.length, 1); assert.ok(changes >= 6, '每一步都通知手机刷新');
  assert.deepEqual(m.episodes.map(e => e.status), ['done', 'done', 'reading']);
  assert.equal(prompts.length, 2, '参考资料那章不写稿');
  assert.match(fs.readFileSync(studio.file(r.id, 1, 'text'), 'utf8'), /^## 一/);
  assert.match(fs.readFileSync(studio.file(r.id, 2, 'audio'), 'utf8'), /^OggS/);
  assert.throws(() => studio.file(r.id, 3, 'audio'), /还没做好/);
  assert.equal(studio.summary()[0].episodes[2].readOnly, true);
  assert.throws(() => studio.dir('../etc'), /编号无效/);
  // Hub 重启时没做完的任务标成中断。
  const m2 = studio.save({ ...studio.read(r.id), status: 'working' });
  const again = new PodcastStudio({ dataDir: dir, extract: async () => doc, writers: [], synthesize: async () => ({}) });
  assert.equal(again.read(m2.id).status, 'interrupted');
});
