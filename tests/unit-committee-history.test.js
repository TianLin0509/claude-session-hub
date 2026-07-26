'use strict';
/**
 * 投委会历史持久化单测（第二轮 task#15）。save/list/get + 倒序 + 摘要轻量 + 容错。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require(path.join(__dirname, '..', 'core', 'committee-history.js'));

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(' FAIL ' + m); } else { console.log('  ok   ' + m); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'committee-hist-'));

// save + get（含每幕 speeches）
const id1 = h.saveRecord(tmp, {
  meetingId: 'm1', startedAt: 1000, endedAt: 2000,
  stocks: [{ code: '', name: '长川科技' }], rounds: 2, chair: 'Claude',
  acts: [{ act: '建库', speeches: [{ label: 'DeepSeek', text: '技术面：MA20 多头' }] }],
  boards: { rows: [] }, chairReport: { degraded: false },
});
ok(id1 === 'm1-2000', 'saveRecord 返回 id = meetingId-endedAt');
const got = h.getRecord(tmp, id1);
ok(got && got.acts[0].speeches[0].text === '技术面：MA20 多头', 'getRecord 取回完整（含每幕发言原文）');

// 第二场（更晚）→ list 倒序 + 摘要轻量
h.saveRecord(tmp, {
  meetingId: 'm2', startedAt: 3000, endedAt: 4000,
  stocks: [{ code: '688256', name: '寒武纪' }], rounds: 3, chair: 'Claude',
  acts: [{ act: '点评', speeches: [{ label: 'X', text: 'y' }] }], chairReport: { degraded: true },
});
const list = h.listRecords(tmp, 50);
ok(list.length === 2, 'listRecords 两场');
ok(list[0].id === 'm2-4000' && list[1].id === 'm1-2000', 'listRecords 按 endedAt 倒序（新→旧）');
ok(list[0].stocks[0].name === '寒武纪' && list[0].degraded === true, 'list 摘要含 stocks + degraded 标记');
ok(list[0].acts === undefined, 'list 摘要不带重的 acts（轻量）');

// 容错
ok(h.getRecord(tmp, '不存在') === null, 'getRecord 不存在返 null');
ok(h.saveRecord(tmp, null) === null, 'saveRecord null 返 null 不崩');
ok(h.listRecords(path.join(tmp, '没建过的子目录')).length === 0, 'listRecords 目录不存在返空数组');
fs.writeFileSync(path.join(tmp, 'committee-history', 'bad.json'), '{坏 json', 'utf8');
ok(h.listRecords(tmp).length === 2, 'listRecords 跳过坏 JSON 文件不崩');

console.log('\n' + (fails === 0 ? '=== committee-history 全绿 ===' : '=== ' + fails + ' FAILED ==='));
process.exit(fails === 0 ? 0 : 1);
