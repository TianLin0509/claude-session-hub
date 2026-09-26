'use strict';
// 2026-09-26 用户截图：Claude（PTY）卡片里「进展显示在结果的下方」。
// 两个成因：① 首屏只挂一轮的最后几张卡，实时刷新拿回整轮后把本轮更早的进展
// 追加到结果之后；② 全量加载还在离屏 staging 里时，PTY CLI 的终端输出触发的
// 增量刷新看不到 staging，同一批卡挂两份。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { placeNewCardsInSnapshotOrder } = require('../renderer/card-snapshot-order');

function fakeContainer(ids) {
  const box = { cards: [] };
  const card = id => ({ id, get nextElementSibling() { const i = box.cards.indexOf(this); return box.cards[i + 1] || null; } });
  box.cards = ids.map(card);
  box.append = id => { const c = card(id); box.cards.push(c); return c; };
  box.insertBefore = (node, ref) => { box.cards.splice(box.cards.indexOf(node), 1); box.cards.splice(box.cards.indexOf(ref), 0, node); };
  box.find = id => box.cards.find(c => c.id === id) || null;
  box.order = () => box.cards.map(c => c.id).join(' ');
  return box;
}

test('earlier progress of the same turn lands before the result, not under it', () => {
  // 首屏：P7 P8 结果 F 活动 A；刷新带回整轮 P1..P8 F A，新卡先被追加到末尾。
  const box = fakeContainer(['P7', 'P8', 'F', 'A']);
  const before = new Set(['P7', 'P8', 'F', 'A']);
  for (const id of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) box.append(id);
  const snapshot = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'F', 'A'];
  assert.equal(placeNewCardsInSnapshotOrder(box, snapshot, before, box.find), 6);
  assert.equal(box.order(), snapshot.join(' '));
});

test('genuinely newer cards stay at the end; gaps are filled in place; existing cards never move', () => {
  const box = fakeContainer(['U', 'P1', 'P3', 'X']);          // X 不在快照里（例如乐观卡），位置不动
  const before = new Set(['U', 'P1', 'P3', 'X']);
  box.append('P2'); box.append('F');
  assert.equal(placeNewCardsInSnapshotOrder(box, ['U', 'P1', 'P2', 'P3', 'F'], before, box.find), 1);
  assert.equal(box.order(), 'U P1 P2 P3 X F');
});

test('already ordered pages are left untouched', () => {
  const box = fakeContainer(['P1', 'P2', 'F']);
  assert.equal(placeNewCardsInSnapshotOrder(box, ['P1', 'P2', 'F'], new Set(['P1', 'P2']), box.find), 0);
  assert.equal(box.order(), 'P1 P2 F');
});

test('renderer wires snapshot placement into incremental loads and serializes them behind full loads', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const wrapperAt = src.indexOf('async function loadSessionHistoryToOverlay(');
  const wrapper = src.slice(wrapperAt, src.indexOf('async function loadSessionHistoryToOverlayUnserialized(', wrapperAt));
  assert.match(wrapper, /opts\.incremental === true \|\| opts\.older[\s\S]{0,120}await pending/, 'incremental / older loads wait for an in-flight full load');
  assert.match(wrapper, /fullLoads\.set\(sessionId, run\)[\s\S]{0,120}finally \{ if \(fullLoads\.get\(sessionId\) === run\) fullLoads\.delete/, 'the full-load marker is always released');
  assert.doesNotMatch(src, /async function _loadSessionHistoryToOverlay\b/, 'window._loadSessionHistoryToOverlay is the public alias; a same-named top-level function would be overwritten by it');
  assert.match(src, /loadLane !== 'full' && window\._cardLoadSeqBySid\.get\(sessionId\)\.full !== fullSeqAtStart/, 'a full load started later invalidates earlier incremental results');
  assert.match(src, /const cardIdsBeforeMount = incremental && !opts\.older/, 'placement only applies to incremental refreshes');
  assert.match(src, /placeNewCardsInSnapshotOrder\(container, turns\.map/, 'incremental refresh places new cards in snapshot order');
  const tc = src.slice(src.indexOf("ipcRenderer.on('turn-complete-event'"));
  assert.match(tc.slice(0, 6000), /_cardFullLoadBySid\?\.has\(hubSessionId\)\) \{ scheduleBackfill\(\); return; \}/, 'turn-complete does not mount beside a full load still in staging');
});
