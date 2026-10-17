'use strict';
// 公司端判「没答上」之前先看 CodeAgent 的原生记录还在不在写（2026-10-17）。
// 事故：Q-1017-17 / Q-1017-21 的 CodeAgent 在跑十几分钟的 AirView 编译与仿真，公司 Hub 的会话表里却查不到这个会话，
// 发出 10 分钟就判了「会话已关闭，没有读到回答」；用户在公司电脑上看到两个会话都还在运行。
const test = require('node:test');
const assert = require('node:assert/strict');
const { rig, pair } = require('./helpers/company-bridge-rig');

const ask = (r, sid, question) => r.home.invoke({ name: 'ask_company', callerSessionId: sid, arguments: { question } });

async function sentToCompany(t, mtime) {
  const r = rig(t, { companyDeps: { transcriptMtime: () => mtime.value } });
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const { thread } = await ask(r, 'h', '请复制场景、改两个参数并跑 0.5 s 短仿真');
  await r.company.checkNow();
  const sid = r.cs.created[0].opts.id;
  // 会话从公司 Hub 的会话表里消失，但原生记录还在（transcriptPath 指向它）。
  r.cs.stored.set(sid, { ...r.cs.map.get(sid), transcriptPath: 'C:/codeagent/' + sid + '.jsonl' });
  r.cs.map.delete(sid);
  return { r, thread, sid };
}

test('会话不在会话表里但记录 1 分钟前还在写：过了 10 分钟也不判关闭，答完照常送回', async t => {
  const mtime = { value: 0 };
  const { r, thread, sid } = await sentToCompany(t, mtime);
  r.clock.now += 11 * 60000; mtime.value = r.clock.now - 60000;
  await r.company.checkNow();
  assert.ok(!r.company.thread(thread).rounds[0].error, '记录还在更新，不该判失败');
  r.clock.now += 25 * 60000; mtime.value = r.clock.now - 30000;   // 发出 36 分钟，过了 30 分钟的停摆线
  await r.company.checkNow();
  assert.ok(!r.company.thread(thread).rounds[0].error, '超过 30 分钟但记录仍在写，也不判停摆');
  r.cs.answer(sid, '跑完了：Geometry 中位 4.1 dB');
  await r.company.checkNow(); await r.home.checkNow();
  assert.match(r.home.thread(thread).rounds[0].reply, /Geometry 中位 4\.1 dB/);
});

test('会话不在、记录 10 分钟以上没动：照旧判「会话已关闭」', async t => {
  const mtime = { value: 0 };
  const { r, thread } = await sentToCompany(t, mtime);
  mtime.value = r.clock.now;
  r.clock.now += 11 * 60000;
  await r.company.checkNow();
  assert.match(r.company.thread(thread).rounds[0].error || '', /会话已关闭/);
});

test('记录一直在写也有上限：发出 3 小时后照旧判失败，避免永远挂着', async t => {
  const mtime = { value: 0 };
  const { r, thread } = await sentToCompany(t, mtime);
  r.clock.now += 3 * 60 * 60000 + 60000; mtime.value = r.clock.now - 1000;
  await r.company.checkNow();
  assert.ok(r.company.thread(thread).rounds[0].error, '超过 3 小时上限要判失败');
});
