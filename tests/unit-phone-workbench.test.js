'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { PhoneChannel } = require('../core/hub-phone/channel'), { seal, open, credentials } = require('../core/hub-phone/crypto');
function setup() {
 const c = credentials(), s = { credentials: c, enabled: true, cursor: 0, created: 1, inbox: [], outbox: [], notices: [], phoneCaps: ['workbench'] }, calls = [], remote = [], revisions = { value: 1 };
 let refreshes = 0, actions = 0;
 const assistant = { store: { get: () => revisions.value }, workbench: { snapshot: () => ({ day: '2026-10-07', sessionSnapshotAt: 1, sessions: [] }), refresh: () => { refreshes++; return { day: '2026-10-07', sessionSnapshotAt: 99, sessions: [] }; }, action: () => { actions++; }, context: ref => { if (ref.id === 'missing') throw Error('所选会话已不存在'); return '精确原会话=' + ref.id + '\n'; } },
  overview: () => ({ status: 'idle' }), notifications: () => ({ notifications: [] }), ensureSession: async () => ({ ok: true, sessionId: 'assistant' }), send: async r => { calls.push(r); return { receipt: { receipt: { status: 'confirmed' } } }; }, readLiveFinal: () => ({ records: [] }) };
 const channel = new PhoneChannel({ assistant, journal: { state: s, change: fn => fn(s) }, transcribe: async () => '请看进展' });
 channel.request = async route => route === '/poll' ? { messages: remote.splice(0) } : { ok: true };
 let seq = 0; const incoming = value => { const id = crypto.randomUUID(); remote.push({ seq: ++seq, id, payload: seal(c.key, c.channel, id, 'phone', value) }); return id; };
 const packets = type => s.outbox.map(r => open(c.key, c.channel, r.id, 'hub', r.payload)).filter(r => r.type === type);
 return { channel, s, calls, assistant, incoming, packets, revisions, refreshes: () => refreshes, actions: () => actions };
}
test('only explicit refresh reads state; normal channel ticks reuse a versioned snapshot', async () => {
 const x = setup(); await x.channel.tick(); await x.channel.tick(); assert.equal(x.refreshes(), 0); assert.equal(x.packets('workbench').length, 1);
 x.incoming({ type: 'workbench_get' }); await x.channel.tick(); assert.equal(x.refreshes(), 1); assert.equal(x.calls.length, 0); assert.equal(x.packets('workbench').at(-1).sessionSnapshotAt, 99);
});
test('workbench controls apply immediately while the assistant is busy, without dispatching CLI text', async () => {
 const x = setup(); x.assistant.overview = () => ({ status: 'running' }); x.incoming({ type: 'workbench_action', action: 'confirm', day: '2026-10-07' }); await x.channel.tick(); assert.equal(x.actions(), 1); assert.equal(x.calls.length, 0);
 x.incoming({ type: 'workbench_action', action: 'delete_all' }); await x.channel.tick(); assert.equal(x.actions(), 1); assert.equal(x.packets('status').at(-1).state, 'rejected');
});
test('old phones never get new workbench message types', async () => { const x = setup(); x.s.phoneCaps = []; await x.channel.tick(); assert.equal(x.packets('workbench').length, 0); });
for (const type of ['text', 'voice_message']) test(type + ' carries exact selected-session context to the assistant and bypasses fast replies', async () => {
 const x = setup(); x.channel.fastLane = { eligible: () => true, answer: () => { throw Error('must not call fast lane'); } };
 x.incoming({ type, ...(type === 'text' ? { text: '请看进展' } : { pcm: 'AQI=' }), context: { kind: 'session', id: 's1' } }); await x.channel.tick(); assert.equal(x.calls.length, 1); assert.match(x.calls[0].text, /精确原会话=s1\n请看进展/);
});
