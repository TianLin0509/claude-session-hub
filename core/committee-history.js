'use strict';
/**
 * 投委会历史持久化（第二轮 task#15）——「过往投委会」的存储层。
 *
 * 每场投委会闭庭后，conductor 把完整 record（标的/轮次/主席/每幕各委员发言/双榜/主席报告/起止时间）
 * 落到 <dataDir>/committee-history/<id>.json。前端固定按钮 → list 取摘要列表 → get 取单场详情
 * （含五幕 speeches，供 tab 回看每个 AI 的具体表现）。纯文件层、无状态，容错铁律：任一步失败返空/不崩。
 */
const fs = require('fs');
const path = require('path');

function _dir(dataDir) { return path.join(dataDir, 'committee-history'); }
function _safe(id) { return String(id == null ? '' : id).replace(/[^\w.-]/g, '_'); }

/** 存一场投委会，返回 id（失败返 null 不崩）。 */
function saveRecord(dataDir, record) {
  try {
    if (!record) return null;
    const dir = _dir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const id = record.id || `${record.meetingId || 'm'}-${record.endedAt || Date.now()}`;
    const file = path.join(dir, `${_safe(id)}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...record, id }, null, 2), 'utf8');
    return id;
  } catch (e) { return null; }
}

/** 历史摘要列表（按结束时间倒序，默认最多 50 场；不读重的 acts，只回摘要字段）。 */
function listRecords(dataDir, limit = 50) {
  try {
    const dir = _dir(dataDir);
    if (!fs.existsSync(dir)) return [];
    const items = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return {
          id: j.id, meetingId: j.meetingId,
          startedAt: j.startedAt || 0, endedAt: j.endedAt || 0,
          stocks: Array.isArray(j.stocks) ? j.stocks : [],
          rounds: j.rounds, chair: j.chair || '',
          degraded: !!(j.chairReport && j.chairReport.degraded),
        };
      } catch { return null; }
    }).filter(Boolean);
    items.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    return items.slice(0, Math.max(1, limit));
  } catch (e) { return []; }
}

/** 取单场完整 record（含五幕 speeches）。无则返 null。 */
function getRecord(dataDir, id) {
  try {
    const file = path.join(_dir(dataDir), `${_safe(id)}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return null; }
}

module.exports = { saveRecord, listRecords, getRecord };
