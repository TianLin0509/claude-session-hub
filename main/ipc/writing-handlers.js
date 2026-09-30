'use strict';
// main/ipc/writing-handlers.js
//
// 写作 Tab 的主进程入口（2026-09-30 田哥体验后改版：少让人动手，多自动化，但让人看得见做了什么）。
//
//   作品库  writing:library-*   只读：旧作 + 写作台定稿的新作
//   文风    writing:voice-*     直接展示 / 编辑文风 skill 源文件；看 AI 自动优化的变更记录
//   写作台  writing:article-*   新文章 = 新目录 + 写作场景群聊（群聊由渲染层用 create-meeting 创建）
//
// 文风自动优化：文章一有定稿（final.md），就在后台排队交给 Claude 读这次的写作过程，
// 小步修改文风 skill（core/writing/voice-evolve.js）。结果写进 piece.json 和 CHANGELOG，
// 并通过 'writing-event' 推给渲染层。

const path = require('path');
const { writingPaths } = require('../../core/writing/config.js');
const { LibraryIndex, isExemplar } = require('../../core/writing/library-index.js');
const { VoiceStore } = require('../../core/writing/voice-store.js');
const { PieceStore } = require('../../core/writing/piece-store.js');
const { evolveVoiceFromPiece } = require('../../core/writing/voice-evolve.js');

// 写作群默认成员：三家各出一份稿。CLAUDE_HUB_WRITING_MEMBERS 可改（如 E2E 用 "claude:haiku"）
function defaultMembers(env = process.env) {
  const spec = String(env.CLAUDE_HUB_WRITING_MEMBERS || 'claude,codex,deepseek');
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [kind, model] = s.split(':');
    return model ? { kind, model } : { kind };
  });
}

function registerWritingIpc(ipcMain, { getHubDataDir, sendToRenderer, shell } = {}) {
  const paths = writingPaths();
  const library = new LibraryIndex(paths);
  const voice = new VoiceStore(paths);
  const pieces = new PieceStore(paths);
  const hubDataDir = () => (typeof getHubDataDir === 'function' ? getHubDataDir() : undefined);
  const emit = (payload) => { try { sendToRenderer && sendToRenderer('writing-event', payload); } catch { /* 窗口已关 */ } };

  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, args = {}) => {
    try { return { ok: true, ...(await fn(args || {})) }; }
    catch (err) { return { ok: false, message: err && err.message ? err.message : String(err) }; }
  });

  /* ─────────── 作品库（只读） ─────────── */

  handle('writing:library-list', async (q) => library.list(q, voice.exemplarStems()));
  handle('writing:library-article', async ({ id }) => {
    const it = library.get(id);
    if (!it) throw new Error('找不到这篇文章');
    return { article: { ...it, exemplar: isExemplar(it.stem, voice.exemplarStems()) } };
  });
  handle('writing:library-rebuild', async () => { library.build(); return { builtAt: library.builtAt }; });

  /* ─────────── 文风（展示源文件，可直接改） ─────────── */

  handle('writing:voice-source', async ({ name }) => ({
    text: voice.readSource(name || 'SKILL.md'),
    dir: paths.voiceDir,
    changelog: voice.changelog(),
    editRatios: voice.readState().editRatios || [],
  }));
  handle('writing:voice-source-save', async ({ name, text }) => voice.saveSource(name || 'SKILL.md', text, `田哥手动修改 ${name || 'SKILL.md'}`));
  handle('writing:voice-undo', async () => voice.undo());
  handle('writing:voice-open-dir', async () => { if (shell && shell.openPath) await shell.openPath(paths.voiceDir); return {}; });

  /* ─────────── 写作台 ─────────── */

  handle('writing:article-defaults', async () => ({ members: defaultMembers(), piecesRoot: paths.piecesRoot }));
  handle('writing:article-create', async () => ({ dir: pieces.create() }));
  handle('writing:article-bind', async ({ dir, meetingId }) => {
    pieces.mutate(dir, (m) => { m.meetingId = String(meetingId || ''); });
    return {};
  });
  handle('writing:article-list', async () => {
    const list = pieces.list();
    scheduleEvolution(list);
    return { articles: list };
  });
  handle('writing:article-final', async ({ dir }) => ({ text: pieces.readFinal(dir) }));
  handle('writing:article-open-dir', async ({ dir }) => { if (shell && shell.openPath) await shell.openPath(pieces.resolve(dir)); return {}; });
  handle('writing:voice-evolve', async ({ dir }) => { enqueue(pieces.resolve(dir), true); return {}; });

  /* ─────────── 文风自动优化队列（一次只跑一篇） ─────────── */

  const queue = [];
  let running = null;

  function needsEvolution(a) {
    if (!a.hasFinal) return false;
    const v = a.voice || {};
    if (v.status === 'running' || v.status === 'queued') return false;
    return v.finalMtime !== a.finalMtime;
  }

  function scheduleEvolution(list) {
    for (const a of list) if (needsEvolution(a)) enqueue(a.dir, false);
  }

  function enqueue(dir, force) {
    if (queue.includes(dir) || running === dir) return;
    const s = pieces.summary(dir);
    if (!s.hasFinal) return;
    if (!force && !needsEvolution(s)) return;
    pieces.mutate(dir, (m) => { m.voice = { ...(m.voice || {}), status: 'queued', finalMtime: s.finalMtime, at: new Date().toISOString() }; });
    queue.push(dir);
    emit({ type: 'voice-evolve', dir, status: 'queued' });
    pump();
  }

  async function pump() {
    if (running || !queue.length) return;
    running = queue.shift();
    const dir = running;
    const finalMtime = pieces.summary(dir).finalMtime;
    pieces.mutate(dir, (m) => { m.voice = { ...(m.voice || {}), status: 'running', at: new Date().toISOString() }; });
    emit({ type: 'voice-evolve', dir, status: 'running' });
    let result;
    try {
      result = await evolveVoiceFromPiece({
        dir, pieces, voice, paths, hubDataDir: hubDataDir(),
        model: process.env.CLAUDE_HUB_WRITING_EVOLVE_MODEL || 'opus',
      });
    } catch (err) {
      result = { status: 'failed', error: String(err && err.message || err).slice(0, 300) };
    }
    pieces.mutate(dir, (m) => { m.voice = { ...result, finalMtime, at: new Date().toISOString() }; });
    library.build();
    emit({ type: 'voice-evolve', dir, status: result.status });
    running = null;
    pump();
  }

  return { library, voice, pieces };
}

module.exports = { registerWritingIpc, defaultMembers };
