'use strict';
// main/ipc/writing-handlers.js
//
// 写作 Tab 的主进程入口（2026-09-30 田哥体验后改版：少让人动手，多自动化，但让人看得见做了什么）。
//
//   作品库  writing:library-*   只读：旧作 + 写作台定稿的新作
//   文风    writing:voice-*     直接展示 / 编辑文风 skill 源文件；看 AI 自动优化的变更记录
//   写作台  writing:article-*   新文章 = 新目录 + 写作场景群聊（群聊由渲染层用 create-meeting 创建）
//           2026-10-01 起写作在 Tab 里完成：writing:article-view 把群聊记录读成「文章工作台」
//           （各家稿件、问题、成员状态、定稿，见 core/writing/workbench.js），并把交稿落成文章目录里的文件
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
const workbench = require('../../core/writing/workbench.js');

const SAFE_ID = /^[a-zA-Z0-9_-]{1,255}$/;

// 写作群默认成员：三家各出一份稿。CLAUDE_HUB_WRITING_MEMBERS 可改（如 E2E 用 "claude:haiku"）
function defaultMembers(env = process.env) {
  const spec = String(env.CLAUDE_HUB_WRITING_MEMBERS || 'claude,codex,deepseek');
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [kind, model] = s.split(':');
    return model ? { kind, model } : { kind };
  });
}

function registerWritingIpc(ipcMain, { getHubDataDir, sendToRenderer, shell, meetingManager, sessionManager } = {}) {
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
  handle('writing:voice-source-save', async ({ name, text, base }) => voice.saveSource(name || 'SKILL.md', text, `田哥手动修改 ${name || 'SKILL.md'}`, base));
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
  handle('writing:article-view', async ({ dir }) => ({ view: refreshPiece(pieces.resolve(dir)) }));
  handle('writing:article-open-dir', async ({ dir }) => { if (shell && shell.openPath) await shell.openPath(pieces.resolve(dir)); return {}; });
  handle('writing:voice-evolve', async ({ dir }) => { enqueue(pieces.resolve(dir), true); return {}; });

  /* ─────────── 文章工作台：群聊记录 → 稿件、问题、成员状态 ─────────── */

  function readGroupState(meetingId) {
    if (!meetingId || !SAFE_ID.test(String(meetingId))) return null;
    try { return JSON.parse(require('fs').readFileSync(path.join(hubDataDir(), 'arena-prompts', `${meetingId}-groupchat.json`), 'utf8')); } catch { return null; }
  }

  // 群成员：按群里的顺序；名字与群聊里一致（会话标题，如「Claude 1」）
  function membersOf(meetingId) {
    const meeting = meetingId && meetingManager && typeof meetingManager.getMeeting === 'function' ? meetingManager.getMeeting(meetingId) : null;
    if (!meeting) return [];
    const specs = Array.isArray(meeting.slotSpecs) ? meeting.slotSpecs : [];
    return (meeting.subSessions || []).map((sid, i) => {
      const s = sessionManager && typeof sessionManager.getSession === 'function' ? sessionManager.getSession(sid) : null;
      const spec = specs[i] || {};
      return { sid, memberId: spec.memberId || `m${i + 1}`, name: (s && s.title) || '', kind: (s && s.kind) || spec.kind || '', dormant: !s || s.status === 'dormant' };
    });
  }

  // 读一篇文章的工作台视图；顺手把群里交的稿、定稿落成文章目录里的文件
  function refreshPiece(full) {
    const meta = pieces.readMeta(full) || {};
    const written = Array.isArray(meta.written) ? meta.written : [];
    const files = pieces.drafts(full)
      .map((d) => ({ name: path.basename(d.file), text: d.text, mtime: d.mtime }))
      .filter((f) => !written.includes(f.name));
    const view = workbench.buildView({ state: readGroupState(meta.meetingId), members: membersOf(meta.meetingId), files, final: pieces.readFinal(full) });
    const next = workbench.materialize(full, view, written);
    if (next.join('|') !== written.join('|')) pieces.mutate(full, (m) => { m.written = next; });
    return { ...view, dir: full, name: path.basename(full), meetingId: meta.meetingId || null, voice: meta.voice || null };
  }

  /* ─────────── 文风自动优化队列（一次只跑一篇） ─────────── */

  const queue = [];
  let running = null;
  // 定稿写完后等它稳定一会儿再优化：AI 汇总改定常常连着写几次 final.md，每次都跑一遍既浪费又重复计数
  const settleMs = () => {
    const v = Number(process.env.CLAUDE_HUB_WRITING_EVOLVE_SETTLE_MS);
    return Number.isFinite(v) && v >= 0 ? v : 2 * 60 * 1000;
  };

  function needsEvolution(a) {
    if (!a.hasFinal) return false;
    if (queue.includes(a.dir) || running === a.dir) return false;
    if (Date.now() - a.finalMtime < settleMs()) return false;
    const v = a.voice || {};
    // 队列只在内存里：piece.json 里残留的 queued / running 是上次 Hub 退出时没跑完的，重新排上
    if (v.status === 'running' || v.status === 'queued') return true;
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
    try {
      const finalMtime = pieces.summary(dir).finalMtime;
      const prev = (pieces.readMeta(dir) || {}).voice || {};
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
      // 没跑成（失败 / 未通过检查）时保留上次已用过的点评条数
      const userCount = result.userCount != null ? result.userCount : prev.userCount;
      pieces.mutate(dir, (m) => { m.voice = { ...result, userCount, finalMtime, at: new Date().toISOString() }; });
      try { library.build(); } catch { /* 作品库下次打开时再建 */ }
      emit({ type: 'voice-evolve', dir, status: result.status });
    } catch (err) {
      // 文章目录被删、piece.json 被占用等：这一篇放弃，队列照常往下走
      console.warn('[writing] 文风优化记录写入失败：', dir, err && err.message);
    } finally {
      running = null;
      setImmediate(pump);
    }
  }

  // 不打开写作 Tab 也要能自动优化：主进程每分钟看一眼有没有新定稿
  const scanTimer = setInterval(() => {
    // 先把群里交的定稿落成 final.md（不打开写作 Tab 也要落），再看有没有要优化文风的
    try { for (const a of pieces.list()) if (a.meetingId) { try { refreshPiece(a.dir); } catch { /* 这篇读不了，下一篇 */ } } } catch { /* 写作目录暂时读不到 */ }
    try { scheduleEvolution(pieces.list()); } catch { /* 写作目录暂时读不到 */ }
  }, 60 * 1000);
  if (scanTimer.unref) scanTimer.unref();

  return { library, voice, pieces };
}

module.exports = { registerWritingIpc, defaultMembers };
