'use strict';
// 2026-10-18 v2.1.9 发布验收卡住的那一轮（现场 D:\Temp\hub-restart-resume-03pDZw，发布交接「失败与处理 2」）：
// 机器负载重，公司通道第一次发出的提问粘贴进了 CodeAgent 输入框、回车没生效；3 分钟后通道判「没送达」重发，
// 又粘贴一遍、一个回车把两份一起提交——原生记录里只有一条用户消息，正文是同一段提问连写两遍。
// 之后远程重启、恢复会话发「继续」，CodeAgent 做完并写出口令，公司端却报「未能唯一核对本次请求对应的原生用户输入」，
// 回执一直没发回家里。夹具 tests/fixtures/company-bridge/20261018-restart-resume-doubled-prompt.jsonl 由现场原生记录
// 逐行保留结构生成（去掉请求快照等与归属无关的行、清空思考内容）；本轮的指纹、发出时间取自现场 assistant.sqlite。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { readCompanyReceipt, transcriptHasRequest, receiptPromptFingerprint, transcriptTurnFinished } = require('../core/company-bridge/receipt-reader');
const { CompanyBridge } = require('../core/company-bridge/company');
const { LiveHistory } = require('../core/hub-assistant/live-history');
const crypto = require('../core/company-bridge/crypto');

const FIXTURE = path.join(__dirname, 'fixtures', 'company-bridge', '20261018-restart-resume-doubled-prompt.jsonl');
const NATIVE_ID = '472fe85c-c68b-448e-be17-54e19ded51dd';
// 现场 assistant.sqlite 里 Q-1018-01 第 1 轮（resent=true，receiptIssue=未能唯一核对…）。
const EVIDENCE_ROUND = { round: 1, threadId: 'Q-1018-01', baseline: null, resent: true,
  promptFingerprint: 'f19435b9988de37ddf28183bd35059c444e97e22dfa5dafc37cf8af9c1156f0c',
  firstSentAt: 1792254338166, sentAt: 1792254518968, interruptedAt: 1792254544143, resumedAt: 1792254576816 };
const TOKEN = 'RESUME-E2E-OK-d39060';
const rows = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

test('现场记录：这一轮的用户消息是同一段提问连写两遍，单份正好是本轮发出的提问', () => {
  const user = rows(FIXTURE).find(row => row.type === 'user' && typeof row.message.content === 'string' && row.message.content.includes('成员请求'));
  const text = user.message.content;
  const head = text.slice(0, 40), second = text.indexOf(head, 1);
  assert.ok(second > 0, '正文里第二次出现开头');
  const copy = text.slice(0, second).trim();
  assert.equal(text, copy + '\n\n' + copy, '两份一字不差、中间隔一个空行');
  assert.equal(receiptPromptFingerprint(copy), EVIDENCE_ROUND.promptFingerprint, '单份就是通道存下指纹的那段提问');
  assert.notEqual(receiptPromptFingerprint(text), EVIDENCE_ROUND.promptFingerprint, '整条比对不上，这就是旧版卡住的原因');
});

test('现场记录：连写两遍的提问 + 重启后的「继续」，最终回答仍归本轮', () => {
  const meta = { ccSessionId: NATIVE_ID, transcriptPath: FIXTURE };
  const receipt = readCompanyReceipt(meta, EVIDENCE_ROUND);
  assert.equal(receipt.available, true, receipt.issue);
  assert.equal(receipt.userMessageId, '58f42e5a-891a-4c7b-9849-f583ad083838');
  assert.match(receipt.text, new RegExp('^\\s*' + TOKEN + '\\s*$', 'm'));
  assert.equal(receipt.records.length, 1, '只有恢复后写下的那一条最终回答');
  assert.equal(transcriptHasRequest(meta, EVIDENCE_ROUND), true, '重发前核对时也认得这条提问已送到');
  assert.equal(transcriptTurnFinished(meta), true, '记录最后是完整的回答');
});

test('现场一轮走通道收回执：回执发回家里，不再报「未能唯一核对」', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dup-request-'));
  const file = path.join(root, NATIVE_ID + '.jsonl');
  fs.copyFileSync(FIXTURE, file);
  const meta = { id: '63618c52-cee1-41c2-b0ef-61e2489fadce', kind: 'codeagent', ccSessionId: NATIVE_ID, transcriptPath: file, status: 'idle' };
  const secret = crypto.newSecret(), gen = 'evidence-gen', live = new LiveHistory();
  const company = new CompanyBridge({ dataDir: root, noTimer: true, now: () => EVIDENCE_ROUND.resumedAt + 120000,
    getSession: id => id === meta.id ? meta : null,
    sendPrompt: async () => { throw new Error('不应重发'); },
    readFinals: source => live.read({ ...source, kind: 'claude' }).records,
    readReceipt: (source, round) => readCompanyReceipt(source, round),
    fetchImpl: async () => { throw Error('Network forbidden'); } });
  company.link.saveConfig({ state: 'paired', gen, secret, baseUrl: 'https://fixture.invalid/api' });
  company.link.flush = async () => {};
  t.after(() => { company.store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const { threadId, ...round } = EVIDENCE_ROUND;
  company.saveThread({ id: threadId, gen, title: '重启恢复测试', sessionId: meta.id, createdAt: round.firstSentAt, everAnswered: false,
    rounds: [{ ...round, question: '（现场问题）', receivedAt: round.firstSentAt - 4000 }] });
  await company.collect(company.thread(threadId));
  const r = company.thread(threadId).rounds[0];
  assert.equal(r.receiptIssue ?? null, null);
  assert.equal(company.thread(threadId).state, 'replied');
  const replies = (company.store.get('outbox') || []).filter(x => x.type === 'reply').map(x => crypto.open(crypto.derive(secret), 'home', x.blob));
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, new RegExp('^\\s*' + TOKEN + '\\s*$', 'm'));
});

// ---- 同一段提问分成两条用户消息（补发的那份单独提交了）：归属看最后一份 ----
function transcript(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dup-rows-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'native.jsonl');
  let serial = 0, parent = null, at = BASE;
  const add = (type, content, extras = {}) => {
    const row = { type, uuid: 'row-' + (++serial), parentUuid: parent, sessionId: 'native', timestamp: new Date(at += 1000).toISOString(),
      message: type === 'assistant' ? { role: 'assistant', id: 'msg-' + serial, stop_reason: extras.stop || 'end_turn', content: Array.isArray(content) ? content : [{ type: 'text', text: content }] }
        : { role: 'user', content }, ...(extras.row || {}) };
    fs.appendFileSync(file, JSON.stringify(row) + '\n'); parent = row.uuid; return row;
  };
  return { file, add, meta: { ccSessionId: 'native', transcriptPath: file } };
}
// 记录时间放在真实「现在」之前：transcriptHasRequest 先按文件修改时间筛掉发送前就没动过的记录文件。
const BASE = Date.now() - 3600000;
const PROMPT = '## 成员请求（编号 Q-DUP-01）\n\n请查一下 HARQ 合并方式，只回答结论。';
const request = { round: 1, threadId: 'Q-DUP-01', baseline: null, sentAt: BASE, promptFingerprint: receiptPromptFingerprint(PROMPT) };
const toolUse = id => [{ type: 'tool_use', id, name: 'Bash', input: { command: 'dir' } }];

test('同一段提问被单独提交了两次：第一份没答完，回执取第二份之后的回答', t => {
  const x = transcript(t);
  x.add('user', PROMPT); x.add('assistant', toolUse('tu-1'), { stop: 'tool_use' });
  x.add('user', [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }]);
  const second = x.add('user', PROMPT);
  x.add('assistant', '结论：Chase 合并。');
  const receipt = readCompanyReceipt(x.meta, request);
  assert.equal(receipt.available, true, receipt.issue);
  assert.equal(receipt.userMessageId, second.uuid);
  assert.equal(receipt.text, '结论：Chase 合并。');
});

test('两份都答了：只回最后一份之后的回答（不把同一答案发两遍）；中途「继续」仍归最后一份', t => {
  const x = transcript(t);
  x.add('user', PROMPT); x.add('assistant', '第一遍：Chase 合并。');
  x.add('user', PROMPT); x.add('assistant', toolUse('tu-2'), { stop: 'tool_use' });
  x.add('user', '继续'); x.add('assistant', '第二遍：Chase 合并（已核对）。');
  const receipt = readCompanyReceipt(x.meta, request);
  assert.equal(receipt.available, true, receipt.issue);
  assert.equal(receipt.text, '第二遍：Chase 合并（已核对）。');
});

test('最后一份还没有回答（会话停了）：退回同一段重复里更早那份的回答', t => {
  const x = transcript(t);
  x.add('user', PROMPT); x.add('assistant', '第一遍：Chase 合并。');
  x.add('user', PROMPT);
  const receipt = readCompanyReceipt(x.meta, request);
  assert.equal(receipt.available, true, receipt.issue);
  assert.equal(receipt.text, '第一遍：Chase 合并。');
});

test('两份之间夹了别的真实提问：只认最后一份，插话的回答不串进回执', t => {
  const x = transcript(t);
  x.add('user', PROMPT); x.add('assistant', '第一遍：Chase 合并。');
  x.add('user', '顺便看看 RLC 分段上限'); x.add('assistant', 'RLC 分段上限是 16。');
  const last = x.add('user', PROMPT);
  let receipt = readCompanyReceipt(x.meta, request);
  assert.equal(receipt.available, false, '最后一份还没答，不拿插话或更早的回答充数');
  x.add('assistant', '第二遍：Chase 合并。');
  receipt = readCompanyReceipt(x.meta, request);
  assert.equal(receipt.userMessageId, last.uuid);
  assert.equal(receipt.text, '第二遍：Chase 合并。');
});

test('连写多遍才算重复：多遍后面还带了别的内容的，不算本轮', t => {
  const x = transcript(t);
  x.add('user', PROMPT + '\n\n' + PROMPT + '\n\n' + PROMPT);
  x.add('assistant', '三遍也认：Chase 合并。');
  assert.equal(readCompanyReceipt(x.meta, request).text, '三遍也认：Chase 合并。');
  const y = transcript(t);
  y.add('user', PROMPT + '\n\n' + PROMPT + '\n另外再查一下 RLC');
  y.add('assistant', '这是另一个问题的回答');
  assert.equal(readCompanyReceipt(y.meta, request).available, false);
  assert.equal(transcriptHasRequest(y.meta, request), false);
});

test('重发前核对从第一次发出算起：第一份慢慢落进记录也算送到了', t => {
  const x = transcript(t);
  x.add('user', PROMPT);
  const late = { ...request, firstSentAt: request.sentAt, sentAt: request.sentAt + 10 * 60000 };
  assert.equal(transcriptHasRequest(x.meta, late), true);
});

// ---- 发送结果未知、记录文件不在：重发前先查一遍，已经落进记录（换了记录文件）的不重发 ----
test('发送未确认且绑定的记录文件不在：同目录记录里已有这条提问就不重发；确实没有才重发', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dup-resend-'));
  let now = 1_800_000_000_000, landed = true;
  const meta = { id: 'sess', status: 'idle', transcriptPath: path.join(root, 'bound.jsonl') };
  const company = new CompanyBridge({ dataDir: root, noTimer: true, now: () => now,
    getSession: id => id === 'sess' ? meta : null, readFinals: () => [], fileExists: () => false,
    transcriptHasRequest: () => landed, sendPrompt: async () => ({ ok: true }), fetchImpl: async () => { throw Error('offline'); } });
  company.link.saveConfig({ state: 'paired', gen: 'g', secret: crypto.newSecret(), baseUrl: 'https://fixture.invalid/api' });
  t.after(() => { company.close(); fs.rmSync(root, { recursive: true, force: true }); });
  company.saveThread({ id: 'Q-SLOW', gen: 'g', title: 'x', sessionId: 'sess', createdAt: now,
    rounds: [{ round: 1, question: 'q', receivedAt: now, sentAt: now, firstSentAt: now, sendUncertain: true }] });
  now += 4 * 60000;
  await company.collect(company.thread('Q-SLOW'));
  let r = company.thread('Q-SLOW').rounds[0];
  assert.equal(r.resent ?? null, null, '提问已在记录里：只是慢，不重发');
  assert.equal(r.landed, true); assert.ok(r.sentAt);
  company.saveThread({ id: 'Q-LOST', gen: 'g', title: 'y', sessionId: 'sess', createdAt: now,
    rounds: [{ round: 1, question: 'q', receivedAt: now, sentAt: now, firstSentAt: now, sendUncertain: true }] });
  landed = false; now += 4 * 60000;
  await company.collect(company.thread('Q-LOST'));
  r = company.thread('Q-LOST').rounds[0];
  assert.equal(r.resent, true); assert.equal(r.sentAt, null, '确实没收到：回到排队重发');
  assert.match(fs.readFileSync(path.join(root, 'logs', 'company-bridge.log'), 'utf8'), /resend Q-LOST#1/);
});

// ---- 本机会话重启前是不是已经答完（hub-admin.js 恢复时不补「继续」） ----
test('transcriptTurnFinished：最后一条有效记录是完整回答才算答完', t => {
  const cases = [
    ['回答完', x => { x.add('user', '问题'); x.add('assistant', '答案'); }, true],
    ['答完后又有斜杠命令回显、系统行', x => { x.add('user', '问题'); x.add('assistant', '答案'); x.add('user', '<local-command-stdout>Set model</local-command-stdout>');
      fs.appendFileSync(x.file, JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: 'native' }) + '\n'); }, true],
    ['停在工具调用', x => { x.add('user', '问题'); x.add('assistant', toolUse('tu'), { stop: 'tool_use' }); }, false],
    ['停在工具结果', x => { x.add('user', '问题'); x.add('assistant', toolUse('tu'), { stop: 'tool_use' }); x.add('user', [{ type: 'tool_result', tool_use_id: 'tu', content: '' }]); }, false],
    ['被打断', x => { x.add('user', '问题'); x.add('assistant', toolUse('tu'), { stop: 'tool_use' }); x.add('user', '[Request interrupted by user for tool use]'); }, false],
    ['答完后又来了新提问', x => { x.add('user', '问题'); x.add('assistant', '答案'); x.add('user', '再问一个'); }, false],
    ['答完后有排队中的输入', x => { x.add('user', '问题'); x.add('assistant', '答案');
      fs.appendFileSync(x.file, JSON.stringify({ type: 'attachment', sessionId: 'native', attachment: { type: 'queued_command', prompt: '<task-notification>' } }) + '\n'); }, false],
    ['只有空正文的 end_turn', x => { x.add('user', '问题'); x.add('assistant', ''); }, false],
    ['旁支记录不算', x => { x.add('user', '问题'); x.add('assistant', '答案'); x.add('assistant', toolUse('side'), { stop: 'tool_use', row: { isSidechain: true } }); }, true],
  ];
  for (const [label, build, expected] of cases) {
    const x = transcript(t); build(x);
    assert.equal(transcriptTurnFinished(x.meta), expected, label);
  }
  assert.equal(transcriptTurnFinished({ transcriptPath: path.join(os.tmpdir(), 'no-such-' + Date.now() + '.jsonl') }), null);
  assert.equal(transcriptTurnFinished({}), null);
});
