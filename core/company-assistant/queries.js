'use strict';
const W = require('./welink');
const D = require('./data');

// 命令执行成功、业务成功、JSON 可读是三个条件。联系人成功码为 0，会议为 200。
async function readJson(run, args) {
  let result = await run(args);
  const checkExit = r => {
    if (r.code === null || r.code !== undefined && Number(r.code) !== 0) throw new Error(String(r.stderr || r.stdout || `查询退出码 ${r.code}`).trim());
  };
  checkExit(result);
  let data = W.parseJsonBig(result.stdout);
  if (data == null && !args.includes('--format')) {
    result = await run([...args, '--format', 'json']); checkExit(result); data = W.parseJsonBig(result.stdout);
  }
  if (!data || typeof data !== 'object') throw new Error(String(result.stderr || result.stdout || '查询没有返回 JSON').trim());
  const command = args.slice(0, 2).join(' ');
  const code = data.code ?? data.resultCode ?? data.error?.error_code;
  const allowed = command === 'contact detail' ? ['0'] : command === 'meeting query-list' ? ['200'] : ['0', '200'];
  if (code !== undefined && !allowed.includes(String(code))) throw new Error(String(data.message || data.resultContext || data.error?.error_msg || `查询业务码 ${code}`));
  return data;
}

function meetingArgs(now, page = 1, size = 100, range = null) {
  const begin = range?.start ?? Date.parse(D.dayKey(now) + 'T00:00:00+08:00');
  const end = (range?.end ?? begin + 86400000) - 1;
  return ['meeting', 'query-list', '--page', String(page), '--size', String(size), '--meeting-start-time', String(begin), '--meeting-end-time', String(end), '--type', '1', '--meeting-sort', 'asc'];
}

async function collectMeetings(runJson, now, { size = 100, maxPages = 30, range = null } = {}) {
  const found = new Map();
  const coverage = { status: 'partial', reason: 'page-limit', pages: 0, total: null, invalid: 0, scope: '指定日期范围内 type=1 的 WeLink 会议', queryType: '1' };
  let received = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const raw = await runJson('会议', meetingArgs(now, page, size, range));
    coverage.pages += 1;
    if (!raw) { coverage.reason = 'query-failed'; coverage.status = found.size ? 'partial' : 'failed'; break; }
    if (!Array.isArray(raw.data?.data)) { coverage.reason = 'invalid-shape'; coverage.status = found.size ? 'partial' : 'failed'; break; }
    const records = raw.data.data, rows = D.meetings(raw);
    const previous = found.size;
    // 完全相同记录的分页重叠可消除；同编号的不同实例/记录版本全部保留。
    for (const row of rows) found.set(row.sourceId, row);
    coverage.invalid += records.length - rows.length;
    coverage.timeUnknown = (coverage.timeUnknown || 0) + rows.filter(D.eventTimeUnknown).length;
    received += records.length;
    const total = Number(raw.data.total);
    if (raw.data.total != null && Number.isFinite(total) && total >= 0) coverage.total = total;
    if (coverage.total !== null && received >= coverage.total || records.length < size) {
      coverage.status = coverage.invalid || coverage.timeUnknown || coverage.total !== null && found.size < coverage.total ? 'partial' : 'complete';
      coverage.reason = coverage.timeUnknown ? 'unknown-time' : coverage.invalid ? 'invalid-record' : coverage.status === 'partial' ? 'early-end' : 'exhausted'; break;
    }
    if (records.length && found.size === previous) { coverage.reason = 'repeated-page'; break; }
  }
  coverage.reasonLabel = { 'page-limit': '会议超过本轮分页上限', 'query-failed': '会议查询失败，日历仍可补充', 'invalid-shape': '会议返回结构与已核对接口不一致',
    'invalid-record': '部分会议缺少时间或编号', 'unknown-time': '部分会议的时间或时区待核对', 'early-end': '会议列表少于接口报告的总数', 'repeated-page': '会议接口重复返回同一页', exhausted: '会议查询完成' }[coverage.reason];
  return { meetings: [...found.values()].sort((a, b) => a.start - b.start), coverage };
}

async function collectCalendar(runJson, range) {
  // calendar list 使用日期边界，至少覆盖到下一天；最终按精确窗口过滤。
  const start = D.dayKey(range.start), endDay = D.dayKey(range.end);
  const end = Date.parse(endDay + 'T00:00:00+08:00') < range.end ? D.dayKey(range.end + 86400000) : endDay;
  const raw = await runJson('日程', ['calendar', 'list', '--start', start, '--end', end, '--format', 'json']);
  if (!raw) return { events: [], coverage: { status: 'failed', reason: 'query-failed', reasonLabel: 'Exchange 日程查询失败' } };
  const records = D.recordsAt ? D.recordsAt(raw, ['events', 'items', 'value', 'calendars', 'data']) : recordsAt(raw);
  if (records === null) return { events: [], coverage: { status: 'failed', reason: 'invalid-shape', reasonLabel: '无法识别日程结构；不能当作没有日程' } };
  const all = D.calendarEvents(raw), invalid = records.length - all.length;
  const unknownTime = all.filter(D.eventTimeUnknown).length;
  const envelopes = [raw, raw.data, raw.result, raw.data?.result].filter(x => x && typeof x === 'object');
  const total = envelopes.map(x => x.total ?? x.count).find(x => x != null);
  const flag = x => x === true || x === 'true' || x === 1;
  const hasMore = envelopes.some(x => flag(x.hasMore) || flag(x.has_more) || x.nextLink || x.next_link || x.next_cursor || x['@odata.nextLink'])
    || total != null && (!Number.isFinite(Number(total)) || Number(total) > records.length);
  const coverage = { status: invalid || unknownTime || hasMore ? 'partial' : 'complete', records: records.length, invalid, unknownTime,
    reason: hasMore ? 'more-records' : invalid ? 'invalid-record' : unknownTime ? 'unknown-time' : 'exhausted',
    reasonLabel: hasMore ? '接口还有日程，分页协议尚未核实' : invalid ? `${invalid} 条日程无法解析` : unknownTime ? `${unknownTime} 条日程时间待核对` : '日程查询完成' };
  return { events: all.filter(x => D.eventInRange(x, range)), coverage };
}
function recordsAt(raw) {
  if (Array.isArray(raw)) return raw.every(x => x && typeof x === 'object') ? raw : null;
  if (!raw || typeof raw !== 'object') return null;
  for (const key of ['events', 'items', 'value', 'calendars', 'data']) if (raw[key] !== undefined) { const found = recordsAt(raw[key]); if (found !== null) return found; }
  return null;
}
function mailResult(raw) {
  if (!raw) return { mails: [], coverage: { status: 'failed', reason: 'query-failed', reasonLabel: '未读邮件查询失败' } };
  const locate = x => {
    if (Array.isArray(x)) return x;
    if (!x || typeof x !== 'object') return null;
    for (const key of ['mails', 'messages', 'items', 'value', 'data']) if (x[key] !== undefined) { const found = locate(x[key]); if (found !== null) return found; }
    return null;
  };
  const records = locate(raw);
  if (records === null) return { mails: [], coverage: { status: 'failed', reason: 'invalid-shape', reasonLabel: '未读邮件结构无法识别' } };
  const mails = D.mails(raw), total = raw.total ?? raw.data?.total;
  const limited = records.length >= 20 || raw.hasMore === true || raw.data?.hasMore === true || total != null && Number(total) > records.length;
  return { mails, coverage: { status: limited ? 'partial' : 'complete', records: records.length, limit: 20,
    reason: limited ? 'preview-limit' : 'exhausted', reasonLabel: limited ? `已取 ${records.length} 封；当前为未读预览，不能视为全部未读` : `取到 ${records.length} 封未读邮件` } };
}

module.exports = { readJson, meetingArgs, collectMeetings, collectCalendar, mailResult };
