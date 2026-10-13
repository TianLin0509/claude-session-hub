'use strict';
// App 2.1.1：手机发的话在电脑卡片上按时间顺序出现并标「手机」；手机预览会话里提到的网页 / 图片（只发出现过的路径、没变就用缓存）。
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { PhoneChannel } = require('../core/hub-phone/channel'), { seal, open, credentials } = require('../core/hub-phone/crypto');
const preview = require('../core/hub-phone/file-preview');
const { cardOf } = require('../core/hub-phone/session-chat');
const origin = require('../core/phone-prompt-origin');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'phone-preview-')); }

function setup(turns, { onPhonePrompt } = {}) {
  const c = credentials(), s = { credentials: c, enabled: true, cursor: 0, created: 1, inbox: [], outbox: [], notices: [], phoneCaps: ['session_chat', 'file_preview'] };
  const remote = [], logs = [], reads = [];
  const deps = {
    getSession: id => ({ id, kind: 'codex', title: '报告会话' }),
    readSessionTurns: async (id, opts) => { reads.push(opts); return { turns: turns.slice() }; },
    sendPrompt: async () => ({ ok: true, receipt: { status: 'confirmed' } }),
    onPhonePrompt,
  };
  const assistant = { deps, sessions: () => [{ id: 's1', title: '报告会话', kind: 'codex', isOpen: true, hubState: { state: 'idle', label: '就绪' } }],
    sessionBusy: () => false, overview: () => ({ status: 'idle' }), notifications: () => ({ notifications: [] }), logDialog: e => logs.push(e),
    readLiveFinal: () => ({ records: [] }), currentProfile: () => null };
  const channel = new PhoneChannel({ assistant, journal: { state: s, change: fn => fn(s) }, transcribe: async () => '' });
  channel.request = async route => route === '/poll' ? { messages: remote.splice(0) } : { ok: true };
  let seq = 0; const incoming = value => { const id = crypto.randomUUID(); remote.push({ seq: ++seq, id, payload: seal(c.key, c.channel, id, 'phone', value) }); return id; };
  const packets = type => s.outbox.map(r => r.payload && open(c.key, c.channel, r.id, 'hub', r.payload)).filter(r => r && r.type === type);
  return { channel, s, logs, reads, incoming, packets };
}

test('paths in card text and tool inputs are found, including Chinese names and JSON-escaped backslashes', () => {
  const found = preview.mentionedPaths([
    '汇总在 D:\\AI-Artifacts\\20261013-助理v2.1-夜间汇总-claude1.html，图是 C:/x/y.PNG。',
    JSON.stringify({ file_path: 'C:\\Users\\a\\b.svg' }),
    '（我从手机分享了一个文件：C:\\AIWork\\inbox\\p.jpg）',
    '不是图片 C:\\a\\b.txt',
  ]);
  assert.deepEqual([...found.values()], ['D:\\AI-Artifacts\\20261013-助理v2.1-夜间汇总-claude1.html', 'C:\\x\\y.PNG', 'C:\\Users\\a\\b.svg', 'C:\\AIWork\\inbox\\p.jpg']);
});

test('only local drive paths without .. and with a page or image extension are accepted', () => {
  assert.throws(() => preview.checkPath('C:\\a\\..\\b.png'), /路径无效/);
  assert.throws(() => preview.checkPath('\\\\server\\share\\x.png'), /本机磁盘/);
  assert.throws(() => preview.checkPath('C:\\a\\run.exe'), /只能预览网页和图片/);
  assert.equal(preview.checkPath('C:/a/b.HTML'), 'C:\\a\\b.HTML');
});

test('html inlines its relative images and styles; unchanged files answer not_modified', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'pic.png'), PNG);
  fs.writeFileSync(path.join(dir, 'a.css'), 'body{color:#123}');
  const page = path.join(dir, 'report.html');
  fs.writeFileSync(page, '<link rel="stylesheet" href="a.css"><img src="pic.png"><img src="https://x.test/remote.png">');
  const first = preview.buildPreview(page, null);
  assert.equal(first.status, 'ok'); assert.equal(first.kind, 'html');
  assert.match(first.html, /<style>body\{color:#123\}<\/style>/);
  assert.match(first.html, /src="data:image\/png;base64,/);
  assert.match(first.html, /https:\/\/x\.test\/remote\.png/);
  const again = preview.buildPreview(page, { sha: first.sha, mtime: first.mtime, size: first.size });
  assert.equal(again.status, 'not_modified'); assert.equal(again.html, undefined);
  fs.writeFileSync(page, '<p>新版</p>');
  const changed = preview.buildPreview(page, { sha: first.sha });
  assert.equal(changed.status, 'ok'); assert.match(changed.html, /新版/);
});

test('oversized html is refused in plain words', () => {
  const dir = tmpdir(), page = path.join(dir, 'big.html');
  fs.writeFileSync(page, 'x'.repeat(preview.BUDGET + 10));
  assert.throws(() => preview.buildPreview(page, null), /文件太大，请在电脑上看/);
});

test('cards carry existing preview files so the phone can show tappable chips', () => {
  const dir = tmpdir(), img = path.join(dir, 'chart.png');
  fs.writeFileSync(img, PNG);
  const card = cardOf({ id: 'a1', role: 'assistant', text: '图在 ' + img + '，另一个 ' + path.join(dir, 'missing.png'), ts: 1 });
  assert.deepEqual(card.files, [img]);
  assert.equal(cardOf({ id: 'a2', role: 'assistant', text: '没有文件', ts: 2 }).files, undefined);
});

test('file_get sends a file mentioned in the session, uses the cache when unchanged, and refuses unmentioned paths', async () => {
  const dir = tmpdir(), img = path.join(dir, 'chart.png'), secret = path.join(dir, 'secret.png');
  fs.writeFileSync(img, PNG); fs.writeFileSync(secret, PNG);
  const x = setup([{ id: 'a1', role: 'assistant', text: '画好了：' + img, ts: 1 }]);
  const r1 = x.incoming({ type: 'file_get', sessionId: 's1', path: img });
  await x.channel.tick();
  const got = x.packets('file').find(p => p.requestId === r1);
  assert.equal(got.status, 'ok'); assert.equal(got.kind, 'image'); assert.equal(Buffer.from(got.data, 'base64').equals(PNG), true);
  const r2 = x.incoming({ type: 'file_get', sessionId: 's1', path: img, have: { sha: got.sha, mtime: got.mtime, size: got.size } });
  await x.channel.tick();
  const cached = x.packets('file').find(p => p.requestId === r2);
  assert.equal(cached.status, 'not_modified'); assert.equal(cached.data, undefined);
  const r3 = x.incoming({ type: 'file_get', sessionId: 's1', path: secret });
  await x.channel.tick();
  assert.equal(x.packets('file').some(p => p.requestId === r3), false);
  const refused = x.packets('status').find(p => p.requestId === r3);
  assert.equal(refused.state, 'rejected'); assert.match(refused.text, /没有出现在该会话的卡片里/);
  const lines = x.logs.map(e => e.text).filter(t => /手机 → 预览/.test(t));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /已发送/); assert.match(lines[1], /未变化/); assert.match(lines[2], /「secret.png」：未发送/);
});

test('a confirmed phone send is announced to the desktop and remembered for the 手机 chip', async () => {
  const seen = [];
  const x = setup([], { onPhonePrompt: e => seen.push(e) });
  x.incoming({ type: 'session_send', sessionId: 's1', text: '你调研下降智测试' });
  await x.channel.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, 's1'); assert.equal(seen[0].text, '你调研下降智测试');
  assert.deepEqual(x.channel.sessionChat.sentPrompts('s1'), [{ text: '你调研下降智测试', at: seen[0].at }]);
  assert.deepEqual(x.channel.sessionChat.sentPrompts('other'), []);
});

test('the 手机 chip matches the same words within the send window only', () => {
  origin.reset();
  origin.remember('s1', [{ text: '你调研下  降智测试', at: 1_000_000 }]);
  const turn = (text, ts) => ({ role: 'user', text, ts });
  assert.equal(origin.matchesPhonePrompt(turn('你调研下 降智测试', 1_000_500), origin.promptsFor('s1')), true);
  assert.equal(origin.matchesPhonePrompt(turn('你调研下 降智测试', 1_000_000 - 10 * 60000), origin.promptsFor('s1')), false);
  assert.equal(origin.matchesPhonePrompt(turn('别的话', 1_000_500), origin.promptsFor('s1')), false);
  assert.equal(origin.matchesPhonePrompt({ role: 'assistant', text: '你调研下 降智测试', ts: 1_000_500 }, origin.promptsFor('s1')), false);
  assert.equal(origin.matchesPhonePrompt(turn('你调研下 降智测试', 1_000_500), origin.promptsFor('s2')), false);
  origin.reset();
});

test('desktop live refresh fetches more than the last card and inserts late cards before newer ones', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(src, /state\.catchUp \? undefined : \{ limit: 4, fromTail: true \}/);
  assert.match(src, /insertBeforeById\.set\(id, laterCard\)/);
  assert.match(src, /before: staging \? null : insertBeforeById\.get\(turn\.id\) \|\| null/);
  assert.match(src, /ipcRenderer\.on\('session:phone-prompt'[\s\S]{0,300}catchUp: true/);
  assert.match(src, /reason: 'visible-again'/);
  assert.match(src, /force: true, catchUp: true, reason: 'visible-again'/);
});

test('mountSessionTurnCard honours the before anchor so a late user card lands above the answer', () => {
  const { createTurnCardRenderer } = require('../renderer/turn-card-renderer');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 极简 DOM：只实现本用例用到的节点操作。
  class El {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.parentNode = null; this._html = ''; this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} }; this.style = {}; }
    get firstElementChild() { return this.children[0] || null; }
    set innerHTML(html) { this._html = html; this.children = []; const m = /data-turn-id="([^"]*)"/.exec(html); if (m) { const c = new El('div'); c._html = html; c.dataset.turnId = m[1]; c.className = /class="([^"]*)"/.exec(html)[1]; c.parentNode = this; this.children.push(c); } }
    get innerHTML() { return this._html; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
    querySelector(sel) { const m = /data-turn-id="([^"]*)"/.exec(sel); return m ? this.children.find(c => c.dataset.turnId === m[1]) || null : null; }
    querySelectorAll() { return []; }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 0 }; }
    addEventListener() {}
    setAttribute() {}
  }
  const doc = { createElement: tag => new El(tag), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
  const container = new El('div'); container.scrollTop = 0; container.scrollHeight = 0; container.clientHeight = 0;
  const r = createTurnCardRenderer({ root: new El("div"), document: doc, window: {}, navigator: {}, escapeHtml: esc, CSS: { escape: s => s },
    marked: { parse: s => '<p>' + esc(s) + '</p>' }, DOMPurify: { sanitize: s => s }, formatAbsoluteTime: () => '', normalizeMarkdownPathBreaks: s => s,
    wrapPathLinksInElement: () => {} });
  const answer = r.mountSessionTurnCard('s1', { id: 'a1', role: 'assistant', text: '回答', ts: 2 }, { container });
  assert.ok(answer, 'assistant card mounted');
  origin.reset(); origin.remember('s1', [{ text: '手机上的问题', at: 1 }]);
  const user = r.mountSessionTurnCard('s1', { id: 'u1', role: 'user', text: '手机上的问题', ts: 1 }, { container, before: answer });
  assert.ok(user, 'user card mounted');
  assert.deepEqual(container.children.map(c => c.dataset.turnId), ['u1', 'a1']);
  assert.match(user._html, /turn-phone-chip/);
  origin.reset();
});
