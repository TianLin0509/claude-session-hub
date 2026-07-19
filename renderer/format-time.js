function formatAbsoluteTime(ts, now = new Date(), options = {}) {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === now.getFullYear();
  const sameDay = sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const clock = `${hh}:${mm}${options && options.includeSeconds ? `:${ss}` : ''}`;
  if (sameDay) return clock;
  if (sameYear) return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
}

module.exports = { formatAbsoluteTime };
