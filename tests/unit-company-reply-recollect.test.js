'use strict';
// 读回答与补收（2026-10-21 同事公司 Hub 3.0.1 日志：20 轮 7 轮没答上、补收 5 次 0 次取回）。夹具原生记录覆盖：
//   1. 工具调用前后都有文字 → 回执全取（以前只取最后一次工具调用之后的 end_turn 正文）；超长从前面截并注明；
//   2. hook 没绑定会话身份（transcriptPath 为空）→ 按问题文本在号的配置目录 projects\<工作目录 slug> 里找到记录照常回执；
//   3. 休眠后恢复的 CLI 换了记录文件（绑定的旧文件里没有新回答）→ 同目录新文件里按问题找到；
//   4. Hub 重启后：重启前答完的自动补收；没答完的标「Hub 重启打断，回答没写完」；家里补收按问题定位，确实没有才说没有。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyBridge } = require('../core/company-bridge/company');
const { LiveHistory } = require('../core/hub-assistant/live-history');
const { findRoundAnswer, readCompanyReceipt } = require('../core/company-bridge/receipt-reader');
const crypto = require('../core/company-bridge/crypto');

const MIN = 60000;
const slug = cwd => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');

// bound：会话身份是否已由 hook 绑定（有 ccSessionId + transcriptPath）。
function rig(t, { bound = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-company-reply-'));
  const configDir = path.join(root, 'cac'), cwd = path.join(root, 'work');
  const bucket = path.join(configDir, 'projects', slug(cwd));
  fs.mkdirSync(bucket, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const nativeId = 'native-company';
  const box = { file: path.join(bucket, nativeId + '.jsonl'), nativeId };
  const meta = { id: 'company-session', kind: 'codeagent', cwd, codeagentConfigDir: configDir, status: 'idle',
    ...(bound ? { ccSessionId: nativeId, transcriptPath: box.file } : {}) };
  const secret = crypto.newSecret(), gen = 'local-test-generation';
  const clock = { now: 1_800_000_000_000 };
  let serial = 0, parent = null, live = new LiveHistory();
  const rows = [];
  // 记录文件的修改时间跟着假时钟走（找记录按「发送之后改过」筛文件）。
  const touch = file => { const s = clock.now / 1000; fs.utimesSync(file, s, s); };
  const append = (row, file = box.file) => { rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n'); touch(file); if (row.uuid) parent = row.uuid; return row; };
  const row = (type, content, extras = {}, file = box.file) => append({ type, uuid: 'row-' + (++serial), parentUuid: parent,
    sessionId: box.nativeId, timestamp: new Date(clock.now += 1000).toISOString(),
    message: { role: type, ...(type === 'assistant' ? { id: 'message-' + serial, stop_reason: 'end_turn' } : {}),
      content: type === 'assistant' ? [{ type: 'text', text: content }] : content }, ...extras }, file);
  // 工具调用前写的文字：同一条消息里先文字后工具调用，stop_reason=tool_use；随后是工具结果。
  const toolText = (text, file = box.file) => {
    const id = 'tu-' + (serial + 1);
    row('assistant', text, { message: { id: 'tool-msg-' + (serial + 1), stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id, name: 'Grep', input: {} }] } }, file);
    row('user', [{ type: 'tool_result', tool_use_id: id, content: 'GDlScheduler.cc:120' }], {}, file);
  };
  row('user', '上轮问题'); row('assistant', '上轮答复，不应回传');
  const notices = [], sent = [];
  let open = true;
  const deps = { dataDir: root, noTimer: true, now: () => clock.now,
    getSession: id => (open && id === meta.id ? meta : null),
    getSessionMetadata: id => (id === meta.id ? meta : null),
    sendPrompt: async (_id, text) => { sent.push(text); row('user', text); return { ok: true }; },
    readFinals: source => { const r = live.read({ ...source, kind: 'claude' }); return r && r.available ? r.records : []; },
    readReceipt: (source, round) => readCompanyReceipt(source, round),
    onNotify: notice => notices.push(notice), fetchImpl: async () => { throw Error('Network forbidden'); } };
  const box2 = { company: null };
  const make = () => { const c = new CompanyBridge(deps); c.link.flush = async () => {}; return c; };
  box2.company = make();
  box2.company.link.saveConfig({ state: 'paired', gen, secret, baseUrl: 'https://fixture.invalid/api' });
  t.after(() => { try { box2.company.store.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const id = 'Q-LOCAL-REPLY';
  box2.company.saveThread({ id, gen, title: '读回答测试', sessionId: meta.id, createdAt: clock.now, everAnswered: true,
    rounds: [{ round: 2, question: '请回答本轮验收问题', receivedAt: clock.now }] });
  const outbox = () => (box2.company.store.get('outbox') || []).map(x => ({ type: x.type, ...crypto.open(crypto.derive(secret), 'home', x.blob) }));
  return {
    root, meta, box, bucket, rows, row, toolText, append, touch, sent, notices, clock,
    get company() { return box2.company; },
    read: () => box2.company.thread(id), id,
    dispatch: () => box2.company.dispatch(box2.company.thread(id)),
    collect: () => box2.company.collect(box2.company.thread(id)),
    elapse: ms => { clock.now += ms; },
    cold: () => { live = new LiveHistory(); },
    setOpen: v => { open = v; },
    // 模拟 Hub 重启：关掉旧进程的数据库连接，同一数据目录新建公司一端（新的 bootAt）。
    restart: () => { box2.company.store.close(); clock.now += 1000; box2.company = make(); live = new LiveHistory(); return box2.company; },
    replies: () => outbox().filter(x => x.type === 'reply'),
    statuses: () => outbox().filter(x => x.type === 'status'),
  };
}

test('回执全取：工具调用前写的结论和最后的正文按顺序拼接', async t => {
  const x = rig(t); await x.dispatch();
  x.toolText('结论一：调度入口在 GDlScheduler。'); x.toolText('结论二：参数默认值是 4。');
  x.row('assistant', '最终：两项都已核实。');
  await x.collect();
  assert.equal(x.replies()[0].text, '结论一：调度入口在 GDlScheduler。\n\n结论二：参数默认值是 4。\n\n最终：两项都已核实。');
  assert.equal(x.read().state, 'replied');
});

test('回执全取：最终正文之后又写的过程文字（还没收尾）不算进本轮', async t => {
  const x = rig(t); await x.dispatch();
  x.toolText('前面的结论。'); x.row('assistant', '最终正文。');
  x.row('assistant', '后台仍在查', { message: { id: 'working', stop_reason: 'tool_use', content: [{ type: 'text', text: '后台仍在查' }] } });
  await x.collect();
  assert.equal(x.replies()[0].text, '前面的结论。\n\n最终正文。');
});

test('回执超过 4 万字：从前面截过程文字并注明，结论完整保留', async t => {
  const x = rig(t); await x.dispatch();
  x.toolText('过程'.repeat(15000)); x.toolText('中段'.repeat(8000));
  const tail = '最终结论：' + '结'.repeat(1000);
  x.row('assistant', tail);
  await x.collect();
  const text = x.replies()[0].text;
  assert.ok(text.length <= 40000, `总长 ${text.length}`);
  assert.match(text, /^（这一轮的回答共 \d+ 字，超过 40000 字上限：前面 \d+ 字的过程文字截掉了/);
  assert.ok(text.endsWith(tail), '最后的结论完整');
  assert.match(text, /中段/);
});

test('hook 没绑定会话身份：按问题文本在号的配置目录里找到记录，照常回执（以前 30 分钟后报「会话停下了，但一直没读到回答」）', async t => {
  const x = rig(t, { bound: false }); await x.dispatch();
  assert.equal(x.read().state, 'running');
  x.toolText('先查到了入口。'); x.row('assistant', 'HARQ 合并方式是 Chase 合并。');
  // 刚发出 3 分钟内照旧等（hook 可能还没到）
  await x.collect(); assert.equal(x.replies().length, 0);
  x.elapse(4 * MIN);
  await x.collect();
  assert.equal(x.replies().length, 1);
  assert.equal(x.replies()[0].text, '先查到了入口。\n\nHARQ 合并方式是 Chase 合并。');
  assert.equal(x.replies()[0].meta.foundBy, 'question');
  assert.ok(!x.read().rounds[0].error);
});

test('hook 没绑定、回答还在写：不判失败，等写完再回执', async t => {
  const x = rig(t, { bound: false }); await x.dispatch();
  x.toolText('正在查。');
  x.elapse(25 * MIN); x.touch(x.box.file); // 记录还在写
  await x.collect();
  assert.equal(x.replies().length, 0); assert.ok(!x.read().rounds[0].error);
  x.row('assistant', '查完了。'); x.elapse(1 * MIN);
  await x.collect();
  assert.equal(x.replies()[0].text, '正在查。\n\n查完了。');
});

test('休眠恢复后 CLI 换了记录文件：绑定的旧文件没有新回答，同目录新文件里按问题找到', async t => {
  const x = rig(t); await x.dispatch();
  // 恢复的 CLI 新开了一个记录文件（新的原生 id），带着这一轮的提问、写出回答
  const question = x.rows.at(-1);
  const newFile = path.join(x.bucket, 'native-resumed.jsonl');
  x.box.nativeId = 'native-resumed';
  x.append({ ...question, sessionId: 'native-resumed' }, newFile);
  x.row('assistant', '恢复后写的回答。', {}, newFile);
  x.elapse(4 * MIN);
  await x.collect();
  assert.equal(x.replies().length, 1);
  assert.equal(x.replies()[0].text, '恢复后写的回答。');
});

test('Hub 重启后：重启前已答完、还没送回的轮次自动按问题补收（Q-1020-06 的情形）', async t => {
  const x = rig(t, { bound: false }); await x.dispatch();
  x.toolText('前半段结论。'); x.row('assistant', '后半段结论。');
  x.elapse(1 * MIN);
  x.setOpen(false); // 重启后会话没打开
  const again = x.restart();
  await again.collect(again.thread(x.id));
  assert.equal(x.replies().length, 1);
  assert.equal(x.replies()[0].text, '前半段结论。\n\n后半段结论。');
  assert.equal(x.replies()[0].meta.restartRecovered, true);
  assert.equal(again.thread(x.id).state, 'replied');
});

test('Hub 重启后：重启前没答完的轮次标失败，写明「Hub 重启打断，回答没写完」', async t => {
  const x = rig(t); await x.dispatch();
  x.toolText('查了一半。');
  x.elapse(1 * MIN); x.setOpen(false);
  const again = x.restart();
  await again.collect(again.thread(x.id));
  assert.equal(x.replies().length, 0);
  const round = again.thread(x.id).rounds[0];
  assert.match(round.error, /^Hub 重启打断，回答没写完/);
  assert.ok(x.statuses().some(s => s.state === 'error' && /Hub 重启打断，回答没写完/.test(s.note)));
});

test('Hub 重启后：重启前已收到的轮次不受影响，新进程新发出的轮次不走重启补收', async t => {
  const x = rig(t); await x.dispatch();
  x.row('assistant', '正常答完。'); await x.collect();
  assert.equal(x.replies().length, 1);
  const again = x.restart();
  again.saveThread({ ...again.thread(x.id), rounds: [...again.thread(x.id).rounds, { round: 3, question: '下一轮', receivedAt: x.clock.now }] });
  x.elapse(1000);
  await again.dispatch(again.thread(x.id));
  await again.collect(again.thread(x.id));
  assert.equal(x.replies().length, 1, '没答之前不回执');
  assert.ok(!again.thread(x.id).rounds[1].error);
});

test('家里补收（Hub 重启后、轮次已判没答上）：按问题从记录取回全部回答', async t => {
  const x = rig(t, { bound: false }); await x.dispatch();
  x.toolText('第一段。'); x.row('assistant', '第二段。');
  x.company.patchRound(x.read(), 2, { error: '会话已关闭，没有读到回答', failedAt: x.clock.now });
  x.setOpen(false); const again = x.restart();
  await again.recollect({ thread: x.id, round: 2, gen: again.thread(x.id).gen });
  assert.equal(x.replies().length, 1);
  assert.match(x.replies()[0].text, /^（补收：按这一轮的问题在公司会话记录里找到的回答，原样取回。）\n\n第一段。\n\n第二段。$/);
  assert.equal(again.thread(x.id).state, 'replied');
});

test('家里补收：绑定的记录能逐条核对时取这一轮全部回答', async t => {
  const x = rig(t); await x.dispatch();
  x.toolText('第一段。'); x.row('assistant', '第二段。');
  x.company.patchRound(x.read(), 2, { error: '会话停下了，但一直没读到回答', failedAt: x.clock.now });
  await x.company.recollect({ thread: x.id, round: 2 });
  assert.match(x.replies()[0].text, /按这一轮的问题在公司会话记录里核对到的回答[\s\S]*第一段。\n\n第二段。$/);
});

test('家里补收：问题在记录里、回答没写完 → 如实说没写完，不说「没有新回答」', async t => {
  const x = rig(t); await x.dispatch();
  x.toolText('查了一半。');
  x.company.patchRound(x.read(), 2, { error: '会话已关闭，没有读到回答', failedAt: x.clock.now });
  x.setOpen(false);
  await x.company.recollect({ thread: x.id, round: 2 });
  assert.equal(x.replies().length, 0);
  const note = x.statuses().at(-1).note;
  assert.match(note, /找到了这一轮的问题，但回答没写完（之后写了 \d+ 字、没有最终回答）/);
  assert.doesNotMatch(note, /没有新的回答/);
});

test('家里补收：确实没有回答（问题也不在记录里）才说「这一轮发出之后没有新的回答」', async t => {
  const x = rig(t);
  // 发出了但提问没写进记录（例如发给了已退出的 CLI）
  x.elapse(10000);
  x.company.patchRound(x.read(), 2, { sentAt: x.clock.now, firstSentAt: x.clock.now, promptFingerprint: 'not-in-record', error: '会话已关闭，没有读到回答' });
  await x.company.recollect({ thread: x.id, round: 2 });
  assert.equal(x.replies().length, 0);
  assert.match(x.statuses().at(-1).note, /补收不到：公司会话里这一轮发出之后没有新的回答/);
});

test('findRoundAnswer：同一提问出现在新旧两个记录里（恢复带着历史），取答完的那份；别的轮次的提问不算', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-find-round-'));
  try {
    const cwd = path.join(root, 'w'), cfg = path.join(root, 'cfg'), dir = path.join(cfg, 'projects', slug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const at = Date.parse('2026-10-20T08:52:00Z');
    const line = (o, i) => JSON.stringify({ uuid: 'u' + i, sessionId: 's', timestamp: new Date(at + i * 1000).toISOString(), ...o });
    const q = { type: 'user', message: { role: 'user', content: '## 家里的问题（编号 Q-1020-06，第 1 轮）\n看一下' } };
    const other = { type: 'user', message: { role: 'user', content: '## 家里的问题（编号 Q-1020-07，第 1 轮）\n别的' } };
    const a = (text, stop = 'end_turn') => ({ type: 'assistant', message: { id: 'm' + text, stop_reason: stop, content: [{ type: 'text', text }] } });
    fs.writeFileSync(path.join(dir, 'old.jsonl'), [line(q, 1)].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'new.jsonl'), [line(q, 1), line(a('答完了'), 2), line(other, 3), line(a('别的回答'), 4)].join('\n') + '\n');
    const found = findRoundAnswer({ cwd, codeagentConfigDir: cfg }, { threadId: 'Q-1020-06', round: 1, sentAt: at });
    assert.equal(found.finished, true); assert.equal(found.text, '答完了'); assert.equal(path.basename(found.file), 'new.jsonl');
    assert.equal(findRoundAnswer({ cwd, codeagentConfigDir: cfg }, { threadId: 'Q-1020-09', round: 1, sentAt: at }), null);
    // 不知道记录在哪（没有绑定、也没有配置目录）：不下结论
    assert.equal(findRoundAnswer({ cwd }, { threadId: 'Q-1020-06', round: 1, sentAt: at }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
