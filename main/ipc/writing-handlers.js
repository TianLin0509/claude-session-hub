'use strict';
// main/ipc/writing-handlers.js
//
// 写作 Tab 的主进程入口。三块：
//   作品库  writing:library-*   只读旧作 + 新作，手改题材，摘句本
//   文风    writing:voice-*     读写 tiange-voice skill（每次写回先备份）
//   写作台  writing:piece-* / draft / review / final / finalize
//
// 起草、审阅都在后台直接调用模型（见 core/writing/draft-runner.js），
// 进度通过 'writing-event' 推给渲染层；任何一份失败都写进 piece.json，不静默跳过。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writingPaths } = require('../../core/writing/config.js');
const { LibraryIndex, isExemplar } = require('../../core/writing/library-index.js');
const { VoiceStore } = require('../../core/writing/voice-store.js');
const { PieceStore, renderBrief } = require('../../core/writing/piece-store.js');
const runner = require('../../core/writing/draft-runner.js');

const LABELS = 'ABCDEFGH';

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function registerWritingIpc(ipcMain, { getHubDataDir, sendToRenderer, shell } = {}) {
  const paths = writingPaths();
  const library = new LibraryIndex(paths);
  const voice = new VoiceStore(paths);
  const pieces = new PieceStore(paths);
  const jobs = new Map(); // dir → Map(draftId → AbortController)
  const hubDataDir = () => (typeof getHubDataDir === 'function' ? getHubDataDir() : undefined);
  const emit = (payload) => { try { sendToRenderer && sendToRenderer('writing-event', payload); } catch { /* 窗口已关 */ } };

  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, args = {}) => {
    try { return { ok: true, ...(await fn(args || {})) }; }
    catch (err) { return { ok: false, message: err && err.message ? err.message : String(err) }; }
  });

  /* ─────────── 作品库 ─────────── */

  handle('writing:config', async () => ({ paths: { root: paths.root, piecesRoot: paths.piecesRoot, voiceDir: paths.voiceDir, libraryRoots: paths.libraryRoots } }));

  handle('writing:library-list', async (q) => library.list(q, voice.exemplarStems()));

  handle('writing:library-article', async ({ id }) => {
    const it = library.get(id);
    if (!it) throw new Error('找不到这篇文章');
    return { article: { ...it, exemplar: isExemplar(it.stem, voice.exemplarStems()) } };
  });

  handle('writing:library-rebuild', async () => { library.build(); return { builtAt: library.builtAt }; });

  handle('writing:library-set-topics', async ({ id, topics }) => {
    library.setTopics(id, (topics || []).map(String).filter(Boolean).slice(0, 4));
    return {};
  });

  const quotesFile = () => path.join(paths.stateDir, 'quotes.json');
  const readQuotes = () => { try { return JSON.parse(fs.readFileSync(quotesFile(), 'utf8')); } catch { return []; } };

  handle('writing:quotes-list', async () => ({ quotes: readQuotes() }));

  handle('writing:quote-add', async ({ text, source, articleId }) => {
    const t = String(text || '').trim();
    if (!t) throw new Error('摘句为空');
    const quotes = readQuotes();
    const q = { id: `q${Date.now()}`, text: t, source: String(source || ''), articleId: articleId || '', at: new Date().toISOString() };
    quotes.unshift(q);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(quotesFile(), JSON.stringify(quotes, null, 2), 'utf8');
    return { quote: q };
  });

  /* ─────────── 文风 ─────────── */

  handle('writing:voice-get', async () => ({ voice: voice.snapshot() }));
  handle('writing:voice-rule', async ({ n, action, text }) => voice.setRule(n, action, text));
  handle('writing:voice-candidate-add', async (c) => voice.addCandidate(c));
  handle('writing:voice-candidate', async ({ id, action }) => voice.resolveCandidate(id, action));
  handle('writing:voice-undo', async () => voice.undo());

  /* ─────────── 写作台 ─────────── */

  handle('writing:providers', async () => ({ providers: runner.providerStatus({ hubDataDir: hubDataDir() }), angles: runner.ANGLES }));
  handle('writing:series-list', async () => ({ series: pieces.listSeries() }));
  handle('writing:piece-list', async ({ series }) => ({ pieces: pieces.listPieces(series) }));
  handle('writing:piece-create', async ({ series, title }) => pieces.create({ series, title }));
  handle('writing:piece-get', async ({ dir }) => ({ piece: pieces.get(dir), running: Array.from((jobs.get(path.resolve(dir)) || new Map()).keys()) }));
  handle('writing:piece-save', async ({ dir, patch }) => {
    const allowed = ['brief', 'qa', 'quotes', 'stage', 'blind', 'review', 'title'];
    const clean = {};
    for (const k of allowed) if (patch && k in patch) clean[k] = patch[k];
    return { meta: pieces.update(dir, clean) };
  });

  handle('writing:interview-questions', async ({ dir }) => {
    const { meta } = pieces.get(dir);
    const status = runner.providerStatus({ hubDataDir: hubDataDir() });
    const pick = ['deepseek', 'claude', 'codex'].find((id) => (status.find((p) => p.id === id) || {}).available);
    if (!pick) throw new Error('没有可用的模型');
    const { system, user } = runner.interviewPrompt(meta, renderBrief(meta));
    const r = await runner.runModel(pick, { system, user, hubDataDir: hubDataDir(), model: pick === 'claude' ? 'haiku' : undefined, effort: 'low' });
    const questions = runner.parseQuestions(r.text);
    const next = pieces.mutate(dir, (m) => { m.qa = [...(m.qa || []), ...questions.map((q) => ({ q, a: '' }))]; });
    return { qa: next.qa, provider: pick };
  });

  handle('writing:draft-start', async ({ dir, providers = [] }) => {
    const full = path.resolve(dir);
    if (jobs.get(full) && jobs.get(full).size) throw new Error('这篇还有草稿在写，先等它们结束或取消');
    const status = runner.providerStatus({ hubDataDir: hubDataDir() });
    const chosen = providers.filter((id) => (status.find((p) => p.id === id) || {}).available);
    if (!chosen.length) throw new Error('没有选中可用的模型');
    const { meta } = pieces.get(full);
    const angles = shuffle(runner.ANGLES);
    const labels = shuffle(chosen.map((_, i) => LABELS[i]));
    const round = (meta.drafts || []).reduce((m, d) => Math.max(m, d.round || 0), 0) + 1;
    const created = chosen.map((provider, i) => ({
      id: `r${round}-${provider}`,
      round,
      provider,
      model: (status.find((p) => p.id === provider) || {}).model || '',
      angle: angles[i % angles.length],
      label: labels[i],
      status: 'running',
      startedAt: new Date().toISOString(),
      file: `drafts/r${round}-${provider}.md`,
    }));
    pieces.mutate(full, (m) => {
      m.drafts = [...(m.drafts || []).filter((d) => d.round !== round), ...created];
      m.stage = 'draft';
      m.blind = { layout: (m.blind && m.blind.layout) || 'three', scores: {}, marks: {}, picks: {}, winner: null, revealed: false, stitched: null, round };
    });
    const briefText = renderBrief(meta);
    const user = runner.draftUserPrompt(meta, briefText);
    const controllers = new Map();
    jobs.set(full, controllers);
    emit({ type: 'piece-updated', dir: full });
    for (const d of created) {
      const ctrl = new AbortController();
      controllers.set(d.id, ctrl);
      const system = runner.draftSystemPrompt({ paths, voice, angle: d.angle });
      let lastEmit = 0;
      runner.runModel(d.provider, {
        system, user, hubDataDir: hubDataDir(), signal: ctrl.signal,
        onProgress: (p) => { const now = Date.now(); if (now - lastEmit > 800) { lastEmit = now; emit({ type: 'draft-progress', dir: full, id: d.id, ...p }); } },
      }).then((r) => {
        pieces.writeFile(full, d.file, r.text.trim() + '\n');
        pieces.mutate(full, (m) => {
          const x = m.drafts.find((y) => y.id === d.id);
          if (x) Object.assign(x, { status: 'done', finishedAt: new Date().toISOString(), inputTokens: r.meta.inputTokens, clean: r.meta.clean || null, authSyncedBack: !!r.meta.authSyncedBack });
        });
      }).catch((err) => {
        pieces.mutate(full, (m) => {
          const x = m.drafts.find((y) => y.id === d.id);
          if (x) Object.assign(x, { status: 'failed', finishedAt: new Date().toISOString(), error: String(err && err.message || err).slice(0, 400) });
        });
      }).finally(() => {
        controllers.delete(d.id);
        if (!controllers.size) {
          jobs.delete(full);
          pieces.mutate(full, (m) => {
            const mine = m.drafts.filter((y) => y.round === round);
            if (mine.some((y) => y.status === 'done') && m.stage === 'draft') m.stage = 'blind';
          });
        }
        emit({ type: 'piece-updated', dir: full });
      });
    }
    return { drafts: created.map(({ angle, ...rest }) => rest) };
  });

  handle('writing:draft-cancel', async ({ dir }) => {
    const controllers = jobs.get(path.resolve(dir));
    if (controllers) for (const c of controllers.values()) c.abort();
    return {};
  });

  // 盲选的胜出稿：拼接稿优先，其次选中的那一份
  function winnerText(full, meta) {
    const b = meta.blind || {};
    if (b.stitched && String(b.stitched).trim()) return String(b.stitched);
    const d = (meta.drafts || []).find((x) => x.id === b.winner);
    return d ? pieces.readFile(full, d.file) : '';
  }

  handle('writing:review-start', async ({ dir, provider }) => {
    const full = path.resolve(dir);
    const { meta } = pieces.get(full);
    const text = winnerText(full, meta);
    if (!text.trim()) throw new Error('还没有选出胜出稿');
    const winnerProvider = ((meta.drafts || []).find((x) => x.id === (meta.blind || {}).winner) || {}).provider;
    const status = runner.providerStatus({ hubDataDir: hubDataDir() });
    const pick = provider || ['codex', 'claude', 'deepseek'].find((id) => id !== winnerProvider && (status.find((p) => p.id === id) || {}).available);
    if (!pick) throw new Error('没有可用的审阅模型');
    pieces.mutate(full, (m) => { m.stage = 'review'; m.review = { provider: pick, status: 'running', items: [], startedAt: new Date().toISOString() }; });
    emit({ type: 'piece-updated', dir: full });
    runner.runModel(pick, { system: runner.reviewSystemPrompt({ paths, voice }), user: `# 待审阅正文\n\n${text}`, hubDataDir: hubDataDir() })
      .then((r) => {
        const items = runner.parseReviewItems(r.text);
        pieces.writeFile(full, 'review.md', `# 审阅批注（${pick}）\n\n${items.map((x) => `- [${x.level || ''}] 「${x.anchor || ''}」 ${x.problem}\n  依据：${x.basis || ''}\n  建议：${x.suggestion || ''}`).join('\n')}\n\n---\n\n原始输出：\n\n${r.text}\n`);
        pieces.mutate(full, (m) => { m.review = { provider: pick, status: items.length ? 'done' : 'failed', items, error: items.length ? '' : '审阅输出不是可解析的批注列表，原文见 review.md', finishedAt: new Date().toISOString() }; });
      })
      .catch((err) => {
        pieces.mutate(full, (m) => { m.review = { provider: pick, status: 'failed', items: [], error: String(err && err.message || err).slice(0, 400) }; });
      })
      .finally(() => emit({ type: 'piece-updated', dir: full }));
    return { provider: pick };
  });

  handle('writing:final-load', async ({ dir }) => {
    const full = path.resolve(dir);
    const { meta, final } = pieces.get(full);
    return { text: final || winnerText(full, meta), fromWinner: !final };
  });

  handle('writing:final-save', async ({ dir, text }) => {
    const full = path.resolve(dir);
    pieces.writeFile(full, 'final.md', String(text || ''));
    pieces.mutate(full, (m) => { m.final = { savedAt: new Date().toISOString() }; if (m.stage !== 'reflow') m.stage = 'final'; });
    return {};
  });

  handle('writing:finalize', async ({ dir }) => {
    const full = path.resolve(dir);
    const { meta, final } = pieces.get(full);
    if (!String(final || '').trim()) throw new Error('还没有保存定稿');
    const base = winnerText(full, meta);
    if (!base.trim()) throw new Error('找不到胜出稿，无法对比改动');
    pieces.writeFile(full, 'drafts/_winner.md', base);
    const out = path.join(full, 'diff.md');
    const r = await runPython(paths.diffScript, ['--before', path.join(full, 'drafts', '_winner.md'), '--after', path.join(full, 'final.md'), '--out', out]);
    if (r.code !== 0) throw new Error(`改动对比脚本失败：${(r.err || '').slice(-300)}`);
    const diff = fs.readFileSync(out, 'utf8');
    const m = diff.match(/改动比例[^：]*：(\d+)%/);
    const ratio = m ? Number(m[1]) : null;
    voice.addEditRatio({ piece: path.basename(full), title: meta.title, ratio });
    pieces.mutate(full, (mm) => { mm.stage = 'reflow'; mm.reflow = { ratio, diffFile: 'diff.md' }; mm.finalizedAt = new Date().toISOString(); });
    library.build();
    return { ratio, diff };
  });

  // 只放行篇目目录里的几个说明性文件，渲染层不能借此读任意路径
  handle('writing:piece-file', async ({ dir, rel }) => {
    if (!['diff.md', 'review.md', 'brief.md', 'final.md'].includes(rel)) throw new Error('不允许读取这个文件');
    return { text: pieces.readFile(dir, rel) };
  });

  handle('writing:open-path', async ({ dir, rel }) => {
    const full = rel ? path.join(pieces.resolve(dir), rel) : pieces.resolve(dir);
    if (shell && typeof shell.openPath === 'function') await shell.openPath(full);
    return {};
  });

  return { library, voice, pieces };
}

function runPython(script, args) {
  return new Promise((resolve) => {
    const child = spawn('python', [script, ...args], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

module.exports = { registerWritingIpc };
