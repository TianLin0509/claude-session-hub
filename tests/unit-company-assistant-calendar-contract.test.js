'use strict';
// 共享设计任务书第 6 节 Q-1021-07 的合成契约回归，不替代公司安装后的实测。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readJson, meetingArgs, collectMeetings, collectCalendar } = require('../core/company-assistant/queries');
const D = require('../core/company-assistant/data');
const NOW = Date.parse('2026-10-21T12:00:00+08:00');
const RANGE = { start: Date.parse('2026-10-21T00:00:00+08:00'), end: Date.parse('2026-10-22T00:00:00+08:00') };
const arg = (args, key) => args[args.indexOf(key) + 1];
const event = i => ({ id: String(i), subject: '合成日程 ' + i, start: '2026-10-21T14:00:00+08:00', end: '2026-10-21T15:00:00+08:00' });

test('会议默认及过大分页参数都限制到真机上限 30，查询类型仍为 1', () => {
  for (const args of [meetingArgs(NOW), meetingArgs(NOW, 1, 100), meetingArgs(NOW, 1, '500')]) {
    assert.equal(arg(args, '--size'), '30');
    assert.equal(arg(args, '--type'), '1');
  }
});

test('调用者传 size=100 时，实际参数和满页判断均按 30，不能只取第一批 30 条', async () => {
  const rows = Array.from({ length: 35 }, (_, i) => event(i)), seen = [];
  const got = await collectMeetings(async (_label, args) => {
    seen.push(args);
    const page = Number(arg(args, '--page'));
    return { code: 200, data: { data: rows.slice((page - 1) * 30, page * 30), total: rows.length } };
  }, NOW, { size: 100 });
  assert.equal(seen.length, 2);
  assert.ok(seen.every(args => arg(args, '--size') === '30'));
  assert.equal(got.meetings.length, 35);
  assert.equal(got.coverage.instances, 35);
  assert.equal(got.coverage.status, 'complete');
});

test('日历成功退出的准确空结果文本只执行一次，并转换为空数组', async () => {
  let calls = 0;
  const result = await readJson(async () => { calls += 1; return { code: 0, stdout: 'No events found.\r\n', stderr: '' }; }, ['calendar', 'list']);
  assert.deepEqual(result, []);
  assert.equal(calls, 1);
});

test('空日历文字不能掩盖进程失败、缺失退出码或其他命令失败', async () => {
  for (const [command, code] of [
    [['calendar', 'list'], 1], [['calendar', 'list'], null], [['calendar', 'list'], undefined],
    [['mail', 'list'], 0], [['meeting', 'query-list'], 0],
  ]) await assert.rejects(readJson(async () => ({ code, stdout: 'No events found.', stderr: '' }), command));
});

test('日历未知文本和空结果后夹带错误仍失败，不能盲补不支持的 format 参数', async () => {
  for (const stdout of ['unexpected calendar response', 'No events found.\nError: synthetic failure']) {
    const calls = [];
    await assert.rejects(readJson(async args => { calls.push(args); return { code: 0, stdout, stderr: '' }; }, ['calendar', 'list']));
    assert.equal(calls.length, 1);
    assert.ok(calls.every(args => !args.includes('--format')));
  }
});

test('日历显式取 500 条、不带 format，结束日期不含当天且覆盖精确窗口', async () => {
  for (const range of [RANGE, { start: NOW, end: NOW + 3600000 }]) {
    let args;
    const got = await collectCalendar(async (_label, received) => { args = received; return []; }, range);
    assert.equal(arg(args, '--start'), '2026-10-21');
    assert.equal(arg(args, '--end'), '2026-10-22');
    assert.equal(arg(args, '--max'), '500');
    assert.ok(!args.includes('--format'));
    assert.equal(got.coverage.status, 'complete');
    assert.deepEqual(got.events, []);
  }
});

test('calendar list 的真实空文本经过 readJson 和 collectCalendar 后是零条成功', async () => {
  const calls = [];
  const got = await collectCalendar((_label, args) => readJson(async a => {
    calls.push(a); return { code: 0, stdout: 'No events found.', stderr: '' };
  }, args), RANGE);
  assert.equal(calls.length, 1);
  assert.deepEqual(got.events, []);
  assert.equal(got.coverage.status, 'complete');
  assert.equal(got.coverage.records, 0);
});

test('满 500 条日历即使没有更多页字段也标未取全；499 条可确认本次返回完成', async () => {
  const all = Array.from({ length: 500 }, (_, i) => event(i));
  for (const raw of [all, { items: all, total: 500 }]) {
    const got = await collectCalendar(async () => raw, RANGE);
    assert.equal(got.events.length, 500);
    assert.equal(got.coverage.status, 'partial');
    assert.equal(got.coverage.reason, 'result-limit');
    assert.match(got.coverage.reasonLabel, /500.*上限/);
  }
  const below = await collectCalendar(async () => all.slice(0, 499), RANGE);
  assert.equal(below.events.length, 499);
  assert.equal(below.coverage.status, 'complete');
});

test('已知日历错误结构、业务错误和更多页提示不能因为空结果兼容而放行', async () => {
  await assert.rejects(readJson(async () => ({ code: 0, stdout: JSON.stringify({ code: 400, message: { message: 'BAD_REQUEST' } }), stderr: '' }), ['calendar', 'list']), /400.*BAD_REQUEST/);
  const bad = await collectCalendar(async () => ({ unexpected: [] }), RANGE);
  assert.equal(bad.coverage.status, 'failed');
  const more = await collectCalendar(async () => ({ items: [event(1)], total: 2 }), RANGE);
  assert.equal(more.coverage.status, 'partial');
  assert.equal(more.coverage.reason, 'more-records');
});

test('两份 CLI 替身也限制会议 30 条，并按日历数组及准确空文本输出', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-calendar-contract-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const state = path.join(dir, 'state'), seed = path.join(dir, 'seed.json');
  fs.writeFileSync(state, 'ok'); fs.writeFileSync(path.join(dir, 'welink-exchange'), 'ok');
  fs.writeFileSync(seed, JSON.stringify({ day: '2026-10-21' }));
  const env = { ...process.env, TZ: 'Asia/Shanghai', WELINK_STANDIN_STATE: state, WELINK_RELIABILITY_SEED: seed };
  delete env.WELINK_STANDIN_LOG; delete env.WELINK_RELIABILITY_LOG;
  for (const name of ['welink-cli-standin.js', 'welink-cli-reliability.js']) {
    const fixture = path.join(__dirname, 'fixtures', name);
    const run = args => {
      const child = spawnSync(process.execPath, [fixture, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
      assert.equal(child.error, undefined, name + ': ' + child.error);
      assert.equal(child.status, 0, child.stderr);
      return child.stdout.trim();
    };
    const large = meetingArgs(NOW); large[large.indexOf('--size') + 1] = '100';
    const rejected = JSON.parse(run(large));
    assert.equal(String(rejected.code), '400');
    assert.equal(typeof rejected.message, 'object');
    assert.equal(rejected.message.message, 'BAD_REQUEST');
    const day = name.includes('reliability') ? '2026-10-21' : D.dayKey(Date.now());
    const end = D.dayKey(Date.parse(day + 'T00:00:00+08:00') + 86400000);
    const calendar = JSON.parse(run(['calendar', 'list', '--start', day, '--end', end, '--max', '500']));
    assert.ok(Array.isArray(calendar));
    assert.ok(calendar.length > 0);
    assert.equal(run(['calendar', 'list', '--start', '2000-01-01', '--end', '2000-01-02', '--max', '500']), 'No events found.');
  }
});
