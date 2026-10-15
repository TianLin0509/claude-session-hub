'use strict';
// 家里联动单测用的两端夹具（2026-10-15，ask_home 测试抽出来用）：内存版通道服务、假会话、两端 Hub 服务和配对步骤。
// 语义同 tests/unit-company-bridge.test.js 里的那一份（那边原样保留，不改已有测试）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const BASE = 'https://relay.example.test/drop/tok/api';

// 内存版通道服务：语义与 relay_server.py 的 /bridge/<通道>/msg 一致（GET 不建通道、带代次）。
function fakeRelay() {
  const relay = { channels: new Map(), seen: new Map(), gate: false, offline: false, posts: 0, now: () => Date.now() };
  const headers = type => ({ get: k => (String(k).toLowerCase() === 'content-type' ? type : null) });
  relay.fetch = async (url, init = {}) => {
    if (relay.offline) throw new Error('ECONNRESET');
    const u = new URL(url);
    const m = u.pathname.match(/\/bridge\/([a-f0-9]{32})\/msg$/);
    const json = (status, body) => ({ ok: status < 400, status, type: 'basic', headers: headers('application/json'), text: async () => JSON.stringify(body) });
    if (!m) return json(404, { ok: false, error: { code: 'not_found' } });
    if ((init.method || 'GET') === 'POST') {
      relay.posts += 1;
      const ch = relay.channels.get(m[1]) || { next: 1, rows: [], epoch: Math.random().toString(16).slice(2, 10) };
      relay.channels.set(m[1], ch);
      const body = JSON.parse(init.body);
      const dup = ch.rows.find(r => r.mid === body.mid);
      if (dup) return json(200, { ok: true, seq: dup.seq, duplicate: true });
      const row = { seq: ch.next++, to: body.to, mid: body.mid, blob: body.blob };
      ch.rows.push(row);
      return json(200, { ok: true, seq: row.seq, duplicate: false });
    }
    const to = u.searchParams.get('to'), after = Number(u.searchParams.get('after')), who = u.searchParams.get('who');
    if (who) relay.seen.set(m[1], { ...(relay.seen.get(m[1]) || {}), [who]: new Date(relay.now()).toISOString() });
    const ch = relay.channels.get(m[1]);
    return json(200, { ok: true, messages: ch ? ch.rows.filter(r => r.to === to && r.seq > after).map(r => ({ seq: r.seq, blob: r.blob })) : [], seen: relay.seen.get(m[1]) || {}, more: false, epoch: ch ? ch.epoch : null });
  };
  return relay;
}

// 假会话：createSession 记下种类和参数；answer() 往某个会话的原生记录里添一条最终回答。
function sessions() {
  const s = { map: new Map(), busy: new Set(), finals: new Map(), sent: [], created: [], resumed: [], stored: new Map(), receipt: null, failCreate: new Set() };
  s.deps = {
    createSession: async (kind, opts) => {
      if (s.failCreate.has(kind)) throw new Error(kind + ' 启动失败');
      const x = { id: opts.id, kind, status: 'idle', title: opts.title, opts }; s.map.set(opts.id, x); s.created.push({ kind, opts }); return x;
    },
    sendPrompt: async (id, text) => { if (!s.map.has(id)) return { ok: false, notSent: true, error: 'closed' }; s.sent.push({ id, text }); return s.receipt || { ok: true }; },
    getSession: id => s.map.get(id) || null,
    getSessionMetadata: id => s.map.get(id) || s.stored.get(id) || null,
    resumeSession: async id => { const m = s.stored.get(id); if (m) { s.map.set(id, { ...m, status: 'idle' }); s.resumed.push(id); } },
    isAgentTurnActive: id => s.busy.has(id),
    readFinals: meta => s.finals.get(meta.id) || [],
  };
  s.answer = (id, text) => { const list = s.finals.get(id) || []; list.push({ id: id + '-f' + (list.length + 1), text }); s.finals.set(id, list); };
  s.sentTo = id => s.sent.filter(x => x.id === id);
  return s;
}

function rig(t, { homeDeps = {}, companyDeps = {} } = {}) {
  const { CompanyBridge } = require('../../core/company-bridge/company');
  const { HomeBridge } = require('../../core/company-bridge/home');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bridge-'));
  let home, company;
  t.after(() => { try { home.close(); company.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const relay = fakeRelay();
  const clock = { now: 1_800_000_000_000 };
  relay.now = () => clock.now;
  const hs = sessions(), cs = sessions();
  const notices = [];
  home = new HomeBridge({ dataDir: path.join(root, 'home'), noTimer: true, fetchImpl: relay.fetch, now: () => clock.now, relayBaseUrl: () => BASE.replace(/\/api$/, ''),
    onNotify: n => notices.push(n), getDefaults: kind => ({ model: kind + '-default', effort: 'high' }), ...hs.deps, ...homeDeps });
  company = new CompanyBridge({ dataDir: path.join(root, 'company'), noTimer: true, fetchImpl: relay.fetch, now: () => clock.now, fallbackCwd: root,
    isDirectory: () => true, onNotify: n => notices.push(n), nodeExecutable: process.execPath, ...cs.deps, ...companyDeps });
  return { root, relay, clock, hs, cs, home, company, notices };
}

async function pair(r) {
  const { code } = r.home.createPairing();
  await r.company.pair(code);
  await r.home.checkNow();
  await r.company.checkNow();
  await r.home.checkNow();
  await r.company.checkNow();
  await r.home.checkNow();
  assert.equal(r.home.status().link.state, 'paired');
  assert.equal(r.company.status().link.state, 'paired');
  return code;
}

module.exports = { BASE, fakeRelay, sessions, rig, pair };
