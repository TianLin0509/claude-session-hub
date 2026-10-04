'use strict';
// 到点提醒：田哥说「下午三点叫我开会」时，助理会话调用 set_reminder 记下；到点由持有助理的 Hub 推送
// （手机通知 + 电脑提示 + 助理页对话）。Hub 关着时错过的提醒，下次启动 24 小时内补发并注明原定时间。
// 手机端另按时间设本地闹钟，App 在后台也能准时响。
const { randomUUID } = require('node:crypto');
const LATE_LIMIT = 24 * 3600000, CHECK_MS = 30000;

// 「2026-10-05 15:00」「2026-10-05T15:00」按北京时间理解；带时区的 ISO 照常解析。
function parseWhen(value, now = Date.now()) {
  const s = String(value || '').trim();
  let at = NaN;
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0));
  else if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) at = Date.parse(s);
  if (!Number.isFinite(at)) throw new Error('提醒时间请写成「2026-10-05 15:00」（北京时间）');
  if (at < now - 60000) throw new Error('提醒时间已经过去了');
  if (at > now + 366 * 86400000) throw new Error('提醒时间太远（一年以内）');
  return at;
}

class AssistantReminders {
  constructor({ store, onFire = () => {}, isOwner = () => true, now = () => Date.now() }) {
    this.store = store; this.onFire = onFire; this.isOwner = isOwner; this.now = now; this.timer = null;
  }
  list() { return (this.store.get('reminders') || []).slice(); }
  save(rows) { this.store.set('reminders', rows.filter(r => !r.firedAt || this.now() - r.firedAt < 7 * 86400000)); }
  add({ when, text, source = 'assistant' }) {
    const body = String(text || '').trim().slice(0, 200);
    if (!body) throw new Error('请写明提醒内容');
    const row = { id: randomUUID(), at: parseWhen(when, this.now()), text: body, source, createdAt: this.now() };
    this.save([...this.list(), row]); this.schedule();
    return row;
  }
  cancel(id) {
    const rows = this.list(), hit = rows.find(r => r.id === id && !r.firedAt);
    if (!hit) throw new Error('没有找到这条待提醒');
    this.save(rows.filter(r => r.id !== id)); this.schedule();
    return hit;
  }
  upcoming() { return this.list().filter(r => !r.firedAt).sort((a, b) => a.at - b.at); }
  // 到点（或补发）：只有持有助理的 Hub 触发，触发后标记，避免多个 Hub 重复提醒。
  fireDue() {
    if (!this.isOwner()) return [];
    const now = this.now(), rows = this.list(), fired = [];
    for (const r of rows) if (!r.firedAt && r.at <= now) {
      r.firedAt = now;
      if (now - r.at <= LATE_LIMIT) { r.late = now - r.at > 120000; fired.push(r); } else r.expired = true;
    }
    if (fired.length || rows.some(r => r.expired)) this.save(rows);
    for (const r of fired) { try { this.onFire(r); } catch (e) { console.warn('[assistant] reminder', e.message); } }
    return fired;
  }
  // 无论本次检查是否出错，都排好下一次，避免一次异常让之后的提醒全部失效；stop 后不再续排。
  schedule() {
    clearTimeout(this.timer); if (this.stopped) return;
    let wait = CHECK_MS;
    try { this.fireDue(); const next = this.upcoming()[0]; if (next) wait = Math.max(1000, Math.min(CHECK_MS, next.at - this.now())); }
    catch (e) { console.warn('[assistant] reminders', e.message); }
    this.timer = setTimeout(() => this.schedule(), wait); this.timer.unref?.();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}
module.exports = { AssistantReminders, parseWhen };
