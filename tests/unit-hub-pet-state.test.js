'use strict';
// 桌宠纯逻辑：姿态映射、开口频率、安静模式、气泡排队、活泼档闲聊。
const assert = require('node:assert/strict');
const test = require('node:test');
const { SpeechQueue, chatterFor, decidePose, localDateKey, speakGate, MAX_PER_HOUR, SHOW_MS } = require('../core/hub-pet/state');

const at = (h, m = 0) => new Date(2026, 9, 16, h, m, 0).getTime();

test('姿态优先级：全屏躲边 > 开口欢呼 > 助理忙 > 打盹 > 累 > 待机', () => {
  const base = { now: at(10), idleSec: 0 };
  assert.equal(decidePose(base), 'idle');
  assert.equal(decidePose({ ...base, quotaLow: true }), 'tired');
  assert.equal(decidePose({ ...base, idleSec: 600, quotaLow: true }), 'sleep');
  assert.equal(decidePose({ ...base, idleSec: 599 }), 'idle');
  assert.equal(decidePose({ ...base, idleSec: 900, assistantBusy: true }), 'typing');
  assert.equal(decidePose({ ...base, assistantBusy: true, speaking: true }), 'happy');
  assert.equal(decidePose({ ...base, assistantBusy: true, speaking: true, fullscreen: true }), 'peek');
});

test('19:00 后、7:00 前打盹；夜里被点一下醒一分钟', () => {
  assert.equal(decidePose({ now: at(18, 59) }), 'idle');
  assert.equal(decidePose({ now: at(19, 0) }), 'sleep');
  assert.equal(decidePose({ now: at(6, 30) }), 'sleep');
  assert.equal(decidePose({ now: at(7, 0) }), 'idle');
  assert.equal(decidePose({ now: at(21), pettedAt: at(21) - 30000 }), 'idle');
  assert.equal(decidePose({ now: at(21), pettedAt: at(21) - 61000 }), 'sleep');
  assert.equal(decidePose({ now: at(21), assistantBusy: true }), 'typing');
});

test('开口闸门：安静档、安静一小时、今天别说话、全屏、打盹、每小时 3 次', () => {
  const now = at(10);
  const ok = s => speakGate(s, { now, pose: 'idle' }, []);
  assert.deepEqual(ok({ mode: 'gentle' }), { ok: true, reason: '' });
  assert.equal(ok({ mode: 'quiet' }).reason, 'quiet-mode');
  assert.equal(ok({ mode: 'gentle', quietUntil: now + 1 }).reason, 'quiet-hour');
  assert.equal(ok({ mode: 'gentle', quietUntil: now - 1 }).ok, true);
  assert.equal(ok({ mode: 'gentle', silentDate: localDateKey(now) }).reason, 'silent-today');
  assert.equal(ok({ mode: 'gentle', silentDate: '2026-10-15' }).ok, true);
  assert.equal(speakGate({ mode: 'lively' }, { now, pose: 'idle', fullscreen: true }, []).reason, 'fullscreen');
  assert.equal(speakGate({ mode: 'lively' }, { now, pose: 'sleep' }, []).reason, 'sleeping');
  const three = [now - 3000, now - 2000, now - 1000];
  assert.equal(speakGate({ mode: 'lively' }, { now, pose: 'idle' }, three).reason, 'hourly-cap');
  assert.equal(speakGate({ mode: 'lively' }, { now, pose: 'idle' }, [now - 3600001, now - 2000, now - 1000]).ok, true);
});

test('气泡一次一句：排队、8 秒收成小圆点、同一 id 只收一次', () => {
  let t = at(10);
  const q = new SpeechQueue({ now: () => t });
  const open = () => ({ ok: true });
  assert.equal(q.push({ id: 'a', kind: 'brief', title: '早上好', text: '完整简报' }), true);
  assert.equal(q.push({ id: 'a', kind: 'brief', title: '重复' }), false);
  assert.equal(q.push({ id: 'b', kind: 'meeting-prep', title: '14:00 评审准备好了' }), true);
  assert.equal(q.push({ id: 'c', title: '' }), false, '没有标题的不说');
  q.tick(open);
  assert.equal(q.snapshot().bubble.id, 'a');
  assert.equal(q.snapshot().pending, 1);
  t += SHOW_MS - 1; q.tick(open);
  assert.equal(q.snapshot().bubble.id, 'a', '8 秒内还在说');
  t += 1; q.tick(open);
  assert.equal(q.snapshot().bubble.id, 'b', '一句收起后才说下一句');
  assert.equal(q.snapshot().dots, 1);
  t += SHOW_MS; q.tick(open);
  assert.equal(q.snapshot().bubble, null);
  assert.equal(q.snapshot().dots, 2);
  const dots = q.takeDots();
  assert.deepEqual(dots.map(d => d.id), ['b', 'a'], '最新的在前');
  assert.equal(dots[1].text, '完整简报');
  assert.equal(q.snapshot().dots, 0);
});

test('不能开口时直接进小圆点；每小时最多说 3 句', () => {
  let t = at(10);
  const q = new SpeechQueue({ now: () => t });
  const gate = spokenAt => speakGate({ mode: 'gentle' }, { now: t, pose: 'idle' }, spokenAt);
  for (let i = 0; i < 5; i++) {
    q.push({ id: 'n' + i, title: '提醒 ' + i });
    q.tick(gate);
    t += SHOW_MS + 10;
    q.tick(gate);
  }
  assert.equal(q.spokenAt.length, MAX_PER_HOUR);
  assert.equal(q.snapshot().dots, 5, '说过的和没说的都留在小圆点里');
  t += 3600000;
  q.push({ id: 'later', title: '一小时后' });
  q.tick(gate);
  assert.equal(q.snapshot().bubble.id, 'later', '过了一小时又能说');

  const quiet = new SpeechQueue({ now: () => t });
  quiet.push({ id: 'x', title: '安静时' });
  quiet.tick(spokenAt => speakGate({ mode: 'quiet' }, { now: t, pose: 'idle' }, spokenAt));
  assert.equal(quiet.snapshot().bubble, null);
  assert.equal(quiet.snapshot().dots, 1);
});

test('点气泡提前收起并取出内容；下一句随后接上', () => {
  let t = at(10);
  const q = new SpeechQueue({ now: () => t });
  q.push({ id: 'a', title: 'A', text: 'A 的正文', sessionId: 's1' });
  q.push({ id: 'b', title: 'B' });
  q.tick(() => ({ ok: true }));
  const item = q.takeCurrent();
  assert.equal(item.text, 'A 的正文');
  assert.equal(item.sessionId, 's1');
  q.tick(() => ({ ok: true }));
  assert.equal(q.snapshot().bubble.id, 'b');
  assert.equal(q.snapshot().dots, 0, '点开看过的不再进小圆点');
});

test('活泼档：早上问候一次、离开半小时回来打招呼、久坐 90 分钟提醒；温和档不闲聊', () => {
  const track = {};
  assert.equal(chatterFor('gentle', { now: at(9), idleSec: 0 }, {}), null);
  const greet = chatterFor('lively', { now: at(9), idleSec: 0 }, track);
  assert.match(greet.title, /早上好/);
  assert.equal(chatterFor('lively', { now: at(9, 1), idleSec: 0 }, track), null, '一天只问候一次');
  chatterFor('lively', { now: at(10), idleSec: 1900 }, track);
  assert.match(chatterFor('lively', { now: at(10, 1), idleSec: 5 }, track).title, /欢迎回来/);
  let last = null;
  for (let m = 2; m <= 95; m++) { const c = chatterFor('lively', { now: at(10, m), idleSec: 5 }, track); if (c) last = c; }
  assert.match(last.title, /一个半小时/);
});
