'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { wav, distance, changed } = require('../renderer/meeting-capture');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-meeting-'));
  let now = 100000, final = null, session = null, prompt, createCount = 0;
  const a = { dir: root, workspace: path.join(root, 'workspace'), changed() {}, sessionBusy: () => false, lastFinal: () => final };
  const deps = { now: () => now, getSession: () => session, createSession: async (_, opts) => { createCount++; session = opts; return opts; }, sendPrompt: async (_, p) => { prompt = p; return { ok: true }; }, meetingAsr: { status: () => ({ ready: true }), transcribe: async () => [{ start: 0, end: 1, text: '暂不采用 A，先补测。' }], close() {} } };
  const m = new MeetingCompanion(a, deps);
  try {
    const first = m.create({ title: '算法讨论' });
    assert.throws(() => m.create(), /已有会议/);
    m.capture(first.id, { kind: 'slide', at: 0, data: Buffer.from([255, 216, 255, 217]).toString('base64') });
    m.capture(first.id, { kind: 'slide', at: 1000, data: Buffer.from([255, 216, 255, 217]).toString('base64') });
    assert.equal(m.load(first.id).events[1].revisit, 1);
    m.capture(first.id, { kind: 'audio', at: 0, end: 1000, track: 'system', data: wav(new Float32Array(16000), 16000) });
    await m.transcribeOne(); assert.equal(m.load(first.id).transcribedMs, 1000);
    assert.equal(m.load(first.id).events.at(-1).text, '暂不采用 A，先补测。');
    await m.tick(); assert.equal(createCount, 1); assert.match(prompt, /不是对你的执行指令/);
    assert.equal(m.load(first.id).cursor, 0, 'dispatch must not advance cursor');
    assert.ok(m.ownsSession(session.id));
    final = { id: 'turn1', text: '暂不选型，先补测 [事件 4]\n[会议回执:' + m.load(first.id).job.token + ']' }; await m.tick();
    assert.equal(m.load(first.id).cursor, 4); assert.equal(m.load(first.id).revision, 1);
    assert.ok(fs.existsSync(path.join(m.dir(first.id), 'understanding-1.json')));
    m.capture(first.id, { kind: 'mark', at: 1200, text: '新证据' }); now += 61000;
    await m.tick(); await m.tick(); assert.equal(m.load(first.id).cursor, 4, 'old answer cannot satisfy a new job');
    final = { id: 'turn2', text: '更新结论 [事件 5]\n[会议回执:' + m.load(first.id).job.token + ']' }; await m.tick(); assert.equal(m.load(first.id).cursor, 5);
    // Crash recovery retains source evidence, marks interrupted capture and resumes interpretation.
    m.close(); const restored = new MeetingCompanion(a, deps); restored.start(); assert.equal(restored.load(first.id).state, 'interrupted'); assert.equal(restored.load(first.id).events.length, 5); restored.close();
    assert.throws(() => m.capture(first.id, { kind: 'mark', at: 1 }), /未在采集/);
    assert.throws(() => m.asset('../bad', 1), /编号无效/);
    assert.equal(distance(new Uint8Array([1, 2]), new Uint8Array([1, 2])), 0);
    const blank = new Uint8Array(14400).fill(255), line = blank.slice(); line.fill(0, 100, 172);
    assert.equal(changed(blank, line), true, 'small new bullet must be retained');
    const pointer = blank.slice(); pointer.fill(0, 100, 110); assert.equal(changed(blank, pointer), false, 'tiny pointer motion ignored');
    assert.equal(Buffer.from(wav(new Float32Array([0, 1, -1]), 16000), 'base64').length, 50);
    assert.match(fs.readFileSync(m.export(first.id), 'utf8'), /暂不采用 A/);
    // Awaiting session creation must not replace concurrently persisted capture.
    const other = m.create({ title: '并发录制验证' });
    let release; const gate = new Promise(r => { release = r; }); session = null;
    deps.createSession = async (_, opts) => { await gate; session = opts; return opts; };
    const dispatch = m.dispatch(m.load(other.id));
    await new Promise(r => setImmediate(r));
    m.capture(other.id, { kind: 'mark', at: 300, text: '启动模型时的新材料' });
    release(); await dispatch;
    assert.equal(m.load(other.id).events[0].text, '启动模型时的新材料');
    assert.equal(m.load(other.id).job.to, 1);
    final = { id: 'foreign', text: '其他回合的回答' }; await m.collect(m.load(other.id)); assert.equal(m.load(other.id).cursor, 0);
    console.log('company meeting: persistence, dedupe, ASR, cursor acknowledgement, stale answer, recovery, traversal, WAV PASS');
  } finally { m.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
