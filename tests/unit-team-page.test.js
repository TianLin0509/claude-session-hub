'use strict';
const assert = require('assert');
const { createTeamPage } = require('../renderer/team-page');

// A minimal DOM adapter runs the actual renderer handlers; browser layout is
// independently covered by the isolated Hub CDP acceptance test.
class Element {
  constructor() {
    this.hidden = false; this.style = {}; this.dataset = {}; this.listeners = {}; this.children = new Map(); this.html = '';
    this.classes = new Set(); this.classList = { add: v => this.classes.add(v), remove: v => this.classes.delete(v), toggle: (v, on) => on ? this.classes.add(v) : this.classes.delete(v) };
  }
  set innerHTML(v) { this.html = v; this.children.clear(); }
  get innerHTML() { return this.html; }
  setAttribute() {}
  addEventListener(name, handler) { this.listeners[name] = handler; }
  removeEventListener() {}
  append(child) { this.child = child; }
  remove() {}
  getBoundingClientRect() { return { left: 240, top: 240, right: 1440, bottom: 900, width: 1200, height: 660 }; }
  querySelector(selector) {
    if (selector === '.tp-web-slot' || selector === '.tp-web-status') {
      if (!this.html.includes(selector.slice(1))) return this.children.get('.tp-content')?.querySelector(selector) || null;
    }
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  querySelectorAll() { return []; }
  insertAdjacentHTML(_, html) { this.html += html; }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const body = new Element(), calls = [], listeners = new Map();
  let state = { ok: true, available: true, owner: 'owner-a', settings: { scope: 'all' }, members: [], evidence: [], analyses: [], commitments: [], weeklyDrafts: [], lastRefresh: null };
  let failure = null;
  const ipcRenderer = {
    async invoke(channel, payload) {
      calls.push({ channel, payload });
      if (failure) { const e = failure; failure = null; throw e; }
      if (channel === 'team:state') return structuredClone(state);
      if (channel === 'team:call' && payload.op === 'resolve') return { ok: true, resolutionId: 'r1', candidates: [{ account: 'person-a', name: '<img src=x onerror=alert(1)>', workId: '007' }] };
      return channel === 'team:call' ? structuredClone(state) : { ok: true };
    },
    on(channel, listener) { listeners.set(channel, listener); }, removeListener(channel) { listeners.delete(channel); },
  };
  const document = { body, createElement: () => new Element(), getElementById: () => null };
  const window = { addEventListener() {}, removeEventListener() {} };
  const api = createTeamPage({ document, window, ipcRenderer });
  const page = () => body.child, html = () => page().querySelector('.tp-content').innerHTML;
  const click = async (team, extra = {}) => { const button = { dataset: { team, ...extra } }; page().listeners.click({ target: { closest: () => button } }); await settle(); };
  const input = (draft, value) => page().listeners.input({ target: { dataset: { draft }, value } });
  return { api, calls, listeners, page, html, click, input, state: () => state, setState: value => { state = value; }, fail: () => { failure = new Error('网络暂不可用'); } };
}
async function test(name, fn) { try { await fn(); console.log('  PASS ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + e.stack); process.exitCode = 1; } }
(async () => {
  await test('member search escapes untrusted names and follows only an explicitly confirmed account', async () => {
    const h = harness(); h.api.open(); await settle(); await h.click('tab', { tab: 'members' });
    h.input('memberInput', '007'); await h.click('resolve');
    assert(h.html().includes('&lt;img')); assert(!h.html().includes('<img'));
    assert.equal(h.calls.filter(c => c.payload?.op === 'follow').length, 0);
    await h.click('follow', { account: 'person-a' });
    assert.deepEqual(h.calls.find(c => c.payload?.op === 'follow').payload, { op: 'follow', resolutionId: 'r1', account: 'person-a', confirmed: true, expectedOwner: 'owner-a' });
  });
  await test('unfinished inputs survive navigation but are cleared when the logged-in owner changes', async () => {
    const h = harness(); h.api.open(); await settle(); await h.click('tab', { tab: 'members' }); h.input('memberInput', 'unfinished-id');
    await h.click('tab', { tab: 'today' }); await h.click('tab', { tab: 'members' }); assert(h.html().includes('unfinished-id'));
    h.setState({ ...h.state(), owner: 'owner-b' }); await h.click('reload'); assert(!h.html().includes('unfinished-id'));
  });
  await test('partial coverage remains visible with reasons and does not imply the member is fine', async () => {
    const h = harness(); h.setState({ ...h.state(), lastRefresh: { at: 1, coverage: { status: 'partial', reasons: ['分页失败'], errors: [{ error: '<script>bad</script>' }], unknownTime: 2, scanned: 3 } } });
    h.api.open(); await settle(); assert(h.html().includes('覆盖不完整')); assert(h.html().includes('分页失败')); assert(h.html().includes('&lt;script&gt;')); assert(!h.html().includes('<script>')); assert(h.html().includes('时间未知 2 条'));
  });
  await test('source-backed commitment is never created just by opening a follow-up form', async () => {
    const h = harness(); h.setState({ ...h.state(), evidence: [{ sourceId: 's1', memberId: 'm1', text: '遇到阻塞' }] });
    h.api.open(); await settle(); await h.click('fact.prepare', { source: 's1' });
    assert.equal(h.calls.filter(c => c.payload?.op === 'commitment.add').length, 0);
    h.input('commitmentTitle', '确认后协调接口'); await h.click('commitment.add');
    const call = h.calls.find(c => c.payload?.op === 'commitment.add').payload;
    assert.deepEqual(call.sourceIds, ['s1']); assert.equal(call.confirmed, true); assert.equal(call.memberId, 'm1');
  });
  await test('weekly edits are preserved across tabs, and only explicit save persists them', async () => {
    const h = harness(); h.setState({ ...h.state(), weeklyDrafts: [{ id: 'd1', text: 'old', createdAt: 1 }] });
    h.api.open(); await settle(); await h.click('tab', { tab: 'weekly' }); h.page().listeners.input({ target: { dataset: { weekly: 'd1' }, value: 'new local text' } });
    await h.click('tab', { tab: 'today' }); await h.click('tab', { tab: 'weekly' }); assert(h.html().includes('new local text'));
    assert.equal(h.calls.filter(c => c.payload?.op === 'weekly.update').length, 0);
    await h.click('weekly.save', { id: 'd1' }); assert.equal(h.calls.find(c => c.payload?.op === 'weekly.update').payload.text, 'new local text');
  });
  await test('remote tools use approved IDs, support state feedback, and hide on navigation and close', async () => {
    const h = harness(); h.api.open(); await settle(); await h.click('web', { tool: 'weekly' });
    assert.equal(h.calls.find(c => c.channel === 'team:web-open').payload.id, 'weekly');
    h.listeners.get('team:web-state')({}, { id: 'weekly', phase: 'error', error: '加载失败' });
    assert.equal(h.page().querySelector('.tp-web-status').textContent, '加载失败');
    await h.click('web.retry'); assert.equal(h.calls.filter(c => c.channel === 'team:web-open').at(-1).payload.reload, true);
    await h.click('tab', { tab: 'members' }); assert.equal(h.calls.at(-1).channel, 'team:web-close');
    await h.click('web', { tool: 'https://bad.example' }); assert.equal(h.calls.filter(c => c.channel === 'team:web-open').length, 2);
    h.api.close(); assert.equal(h.calls.at(-1).channel, 'team:web-close'); assert.equal(h.api.isOpen(), false);
  });
  await test('a failed read exposes a recoverable error and retry recovers without reopening', async () => {
    const h = harness(); h.fail(); h.api.open(); await settle();
    assert(h.page().querySelector('.tp-feedback').innerHTML.includes('网络暂不可用'));
    await h.click('reload'); assert(h.html().includes('今日关注')); assert(!h.page().querySelector('.tp-feedback').innerHTML.includes('网络暂不可用'));
  });
  await test('historical analyses stay out of current attention and keep their original evidence', async () => {
    const h = harness(); h.setState({ ...h.state(), members: [{ id: 'm1', name: '成员', account: 'a' }], analyses: [{ id: 'a1', memberIds: ['m1'], historical: true, state: 'done', text: '旧结论', sourceIds: ['old'], evidence: [{ sourceId: 'old', text: '历史原文' }] }] });
    h.api.open(); await settle(); assert(!h.html().includes('旧结论'));
    await h.click('tab', { tab: 'members' }); assert(h.html().includes('历史 AI 分析')); assert(h.html().includes('历史原文')); assert(h.html().includes('不代表当前状态'));
  });
  await test('login loss clears visible records and disables local work mutations', async () => {
    const h = harness(); h.setState({ ...h.state(), commitments: [{ id: 'c1', title: 'private work', status: 'open' }] }); h.api.open(); await settle();
    h.setState({ ...h.state(), owner: null, available: false, commitments: [] });
    h.listeners.get('company-assistant:changed')(); await settle(); assert(!h.html().includes('private work'));
    await h.click('tab', { tab: 'weekly' }); assert.match(h.html(), /data-team="weekly.draft" disabled/);
    await h.click('tab', { tab: 'commitments' }); assert.match(h.html(), /data-team="commitment.add" disabled/);
  });
  await test('identity notifications hide old material synchronously, even when revalidation fails', async () => {
    const h = harness(); h.setState({ ...h.state(), commitments: [{ id: 'c1', title: 'private work', status: 'open' }] }); h.api.open(); await settle();
    h.fail(); h.listeners.get('company-assistant:changed')(); assert(!h.html().includes('private work'));
    await settle(); assert(!h.html().includes('private work')); assert(h.html().includes('已隐藏团队资料'));
    await h.click('reload'); assert(h.html().includes('private work'));
  });
  await test('every team mutation is bound to the verified account', async () => {
    const h = harness(); h.api.open(); await settle(); await h.click('analysis.sync'); await h.click('weekly.draft');
    for (const c of h.calls.filter(c => c.channel === 'team:call')) assert.equal(c.payload.expectedOwner, 'owner-a');
  });
  await test('same-owner state refresh preserves the unsaved private scope actually used for collection', async () => {
    const h = harness(); h.api.open(); await settle(); await h.click('tab', { tab: 'members' });
    h.input('scope', 'private'); await h.click('reload'); await h.click('refresh');
    assert.equal(h.calls.find(c => c.payload?.op === 'refresh').payload.scope, 'private');
    assert.match(h.html(), /value="private" selected/);
  });
  await test('saving scope clears the local draft, while a failed save preserves it and owner changes reset it', async () => {
    const h = harness(); h.api.open(); await settle(); await h.click('tab', { tab: 'members' });
    h.input('scope', 'private'); h.fail(); await h.click('settings.scope'); await h.click('reload'); await h.click('refresh');
    assert.equal(h.calls.filter(c => c.payload?.op === 'refresh').at(-1).payload.scope, 'private');
    h.setState({ ...h.state(), settings: { scope: 'private' } }); await h.click('settings.scope');
    h.setState({ ...h.state(), settings: { scope: 'all' } }); await h.click('reload'); await h.click('refresh');
    assert.equal(h.calls.filter(c => c.payload?.op === 'refresh').at(-1).payload.scope, 'all');
    h.input('scope', 'private'); h.setState({ ...h.state(), owner: 'owner-b' }); await h.click('reload'); await h.click('refresh');
    assert.equal(h.calls.filter(c => c.payload?.op === 'refresh').at(-1).payload.scope, 'all');
  });
  await test('communication preparation combines only this member current single-person analysis, original messages and open commitments without AI calls', async () => {
    const h = harness();
    const own = { sourceId: 'src-a', memberId: 'a', account: 'account-a', text: '成员A原文', sender: '甲', at: 1 };
    h.setState({ ...h.state(), members: [{ id: 'a', account: 'account-a', name: '甲' }, { id: 'b', account: 'account-b', name: '乙' }],
      lastRefresh: { at: 1, coverage: { status: 'partial', reasons: ['一个会话未取全'] } },
      evidence: [own, { sourceId: 'src-b', memberId: 'b', account: 'account-b', text: '其他成员秘密' }, { sourceId: 'wrong', memberId: 'a', account: 'account-b', text: '错误账号消息' }],
      analyses: [
        { id: 'single', memberIds: ['a'], state: 'done', text: '成员A最新分析', sourceIds: ['src-a'], evidence: [own] },
        { id: 'batch', memberIds: ['a', 'b'], state: 'done', text: '多人混合结论', sourceIds: [] },
        { id: 'past', memberIds: ['a'], state: 'done', historical: true, text: '过期分析', sourceIds: [] },
        { id: 'pending', memberIds: ['a'], state: 'running', text: '未完成分析', sourceIds: [] },
        { id: 'other', memberIds: ['b'], state: 'done', text: '其他成员分析', sourceIds: [] },
      ],
      commitments: [{ id: 'ca', title: '甲的未完成承诺', memberId: 'a', status: 'open', sourceIds: ['src-a'], evidence: [own] }, { id: 'cb', title: '乙的承诺', memberId: 'b', status: 'open' }, { id: 'done', title: '已完成旧承诺', memberId: 'a', status: 'done' }],
    });
    h.api.open(); await settle(); await h.click('tab', { tab: 'members' });
    const before = h.calls.length; await h.click('member.prepare', { id: 'a' });
    assert.equal(h.calls.length, before, 'opening the preparation view is local read-only');
    for (const text of ['甲 · 沟通准备', '甲的未完成承诺', '成员A最新分析', '成员A原文', 'src-a', '一个会话未取全']) assert(h.html().includes(text), text);
    for (const text of ['其他成员秘密', '错误账号消息', '多人混合结论', '过期分析', '未完成分析', '其他成员分析', '乙的承诺', '已完成旧承诺']) assert(!h.html().includes(text), text);
    await h.click('member.back'); assert(h.html().includes('已关注成员'));
  });
  await test('preparation with no member evidence remains explicit about insufficient coverage and resets on account change', async () => {
    const h = harness(); h.setState({ ...h.state(), members: [{ id: 'a', account: 'account-a', name: '甲' }], lastRefresh: { coverage: { status: 'complete' } }, analyses: [{ memberIds: ['a', 'b'], state: 'done', text: '团队发现' }] });
    h.api.open(); await settle(); await h.click('member.prepare', { id: 'a' });
    assert(h.html().includes('本次没有该成员可引用的原文')); assert(h.html().includes('还没有本次采集对应的单人分析')); assert(!h.html().includes('团队发现'));
    h.setState({ ...h.state(), owner: 'owner-b', members: [{ id: 'a', account: 'account-b', name: '新账号成员' }], analyses: [] }); await h.click('reload');
    assert(h.html().includes('已关注成员')); assert(!h.html().includes('· 沟通准备'));
  });
  await test('background company assistant sessions never navigate away from the team page', async () => {
    const fs = require('fs'), vm = require('vm'), path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
    const start = source.indexOf("ipcRenderer.on('session-created', ");
    const end = source.indexOf("\n});", start);
    const handlerText = source.slice(start + "ipcRenderer.on('session-created', ".length, end) + '\n}';
    for (const dormant of [false, true]) {
      let selected = 0, rendered = 0;
      const session = { id: 'assistant-1', purpose: 'company-assistant', kind: 'codeagent' };
      const handler = vm.runInNewContext('(' + handlerText + ')', {
        require: () => ({ isCodeAgentSession: () => false }), nativeSessionBootstrap: { record() {} },
        sessions: new Map(dormant ? [[session.id, { ...session, status: 'dormant' }]] : []), _pendingDormantResumes: new Map(),
        paintSidebarResumePending() {}, observeSessionRuntime() {}, RUNTIME_IDLE: 'idle', CONFIDENCE_AUTHORITATIVE: 'authoritative',
        sessionSplit: null, activeSessionId: session.id, selectSession: async () => { selected++; }, scheduleSessionListRender: () => { rendered++; },
        document: { body: { classList: { contains: () => true } } },
      });
      await handler(null, { session }); assert.equal(selected, 0); assert.equal(rendered, 1);
    }
  });
})();
