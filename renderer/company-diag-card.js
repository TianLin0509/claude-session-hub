'use strict';
// 「公司电脑状态」卡片（2026-10-18 直查，家里一端；公司一端见 core/company-bridge/hub-admin.js diag 与 diag.js）。
// 点「公司电脑状态」→ 经通道请公司 Hub 直接采集（不开 CodeAgent、不排队）→ 回报到了显示：电脑、内存去向（含残留进程）、
// 通道并行与队列、Hub 会话、进程前 20、号池、日志尾部。号身份已在公司那边换成「个人 / 号 1」，日志已脱敏。
function createCompanyDiagCard({ document, ipcRenderer, showMessage }) {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = at => at ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
  const gb = mbv => mbv == null ? '—' : mbv >= 1024 ? (mbv / 1024).toFixed(1) + ' GB' : Math.round(mbv) + ' MB';
  const dur = sec => sec == null ? '—' : sec < 90 ? Math.round(sec) + ' 秒' : sec < 5400 ? Math.round(sec / 60) + ' 分钟' : (sec / 3600).toFixed(1) + ' 小时';
  const ago = at => at ? dur((Date.now() - at) / 1000) + '前' : '—';
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke(channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  const PHASE = { running: '在跑', queued: '排队', replied: '已回执', failed: '没答上' };
  const STATE = { active: '开着', dormant: '休眠', closed: '已关闭' };
  const PURPOSE = { 'company-bridge': '特战通道', 'company-assistant': '助理' };
  const KIND = { codeagent: 'CodeAgent', hub: 'AI Hub', electron: 'Electron', node: 'Node' };
  let dialog = null, timer = null, waitingSince = 0, currentId = null, previous = null;

  const table = (head, rows) => rows.length ? `<table class="cl-diag-table"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
  const row = (k, v, r = '') => `<div class="wp-row"><span class="k">${esc(k)}</span><span class="v">${v}</span><span class="r">${r}</span></div>`;
  const failed = sec => sec && sec.error ? `<p class="wp-note warn">没采到：${esc(sec.error)}</p>` : '';
  const block = (title, inner) => inner ? `<section class="cl-diag-block"><h3>${esc(title)}</h3>${inner}</section>` : '';

  function machine(m) {
    if (!m) return '';
    if (m.error) return block('电脑', failed(m));
    const disks = (m.disks || []).map(d => d.error ? `${esc(d.drive)} ${esc(d.error)}` : `${esc(d.drive)} 剩 ${esc(d.freeGB)} GB / ${esc(d.totalGB)} GB（${esc(d.freePct)}%）`).join(' · ');
    return block('电脑', `<div class="wp-strip">${row('内存', `可用 <b>${esc(m.memory.freePct)}%</b>（${gb(m.memory.freeMB)} / ${gb(m.memory.totalMB)}），已用 ${esc(m.memory.usedPct)}%`)}
      ${row('CPU', `占用 ${esc(m.cpu.busyPct ?? '—')}%（0.5 秒采样）· ${esc(m.cpu.cores)} 核 · ${esc(m.cpu.model)}`)}
      ${row('开机', `${esc(m.uptimeHours)} 小时 · ${esc(m.os)}`)}${row('磁盘', disks || '—')}</div>`);
  }
  function processes(p) {
    if (!p) return '';
    if (p.error) return block('内存都去哪了', failed(p));
    const s = p.summary;
    const leftovers = table(['名称', 'PID', '内存', '启动于', '已运行', '父进程', '看起来是'], (p.leftovers || []).map(x => [esc(x.name), esc(x.pid), gb(x.memMB), time(x.startedAt),
      x.startedAt ? dur(Math.max(0, (p.sampledAt || Date.now()) - x.startedAt) / 1000) : '—',
      x.parentAlive ? '在' : '<span class="bad">已退出</span>', esc(x.hint || KIND[x.kind] || x.kind)]));
    const tops = table(['名称', 'PID', '内存', '启动于', '归属'], (p.top || []).map(x => [esc(x.name), esc(x.pid), gb(x.memMB), time(x.startedAt),
      [x.hubCore ? 'Hub 自身' : '', x.session ? '会话 ' + esc(x.session) : '', x.codeAgent ? 'CodeAgent' : '', x.leftover ? '<span class="bad">树外残留嫌疑</span>' : ''].filter(Boolean).join(' · ') || '其他']));
    return block('内存都去哪了', `<div class="wp-strip">${row('CodeAgent', `${esc(s.codeAgent.count)} 个进程，共 <b>${gb(s.codeAgent.memMB)}</b>（Hub 会话里 ${esc(s.codeAgent.inHub)} 个，Hub 进程树外 ${esc(s.codeAgent.outside)} 个）`)}
      ${row('Hub 自身', `${esc(s.hubSelf.count)} 个进程（主进程、界面、隐藏窗口），共 <b>${gb(s.hubSelf.memMB)}</b>`)}
      ${row('Hub 会话', `${esc(s.hubSessions.sessions)} 个会话的 ${esc(s.hubSessions.processes)} 个进程，共 ${gb(s.hubSessions.memMB)}`)}
      ${row('树外残留', s.leftovers.count ? `<span class="bad">${esc(s.leftovers.count)} 个</span>，共 ${gb(s.leftovers.memMB)}（不在当前 Hub 进程树里的 CodeAgent / Node / Electron，多半是重启残留）` : '没有')}
      ${s.otherHubs?.count ? row('别的 Hub', `${esc(s.otherHubs.count)} 个 Hub 主进程在当前 Hub 之外，名下 ${esc(s.otherHubs.processes)} 个进程共 ${gb(s.otherHubs.memMB)}（不算残留）`) : ''}
      ${row('全机', `${esc(p.total)} 个进程${p.hubFound ? '' : ' · <span class="bad">没在进程表里找到 Hub 主进程</span>'}`)}</div>
      ${leftovers ? '<h4>树外残留嫌疑</h4>' + leftovers : ''}${tops ? `<details class="cl-details"><summary>按内存排的前 ${(p.top || []).length} 个进程</summary>${tops}</details>` : ''}`);
  }
  function hub(h) {
    if (!h) return '';
    if (h.error) return block('通道并行与队列', failed(h));
    const par = h.parallel;
    const queue = table(['编号', '标题', '轮次', '状态', '已等 / 已跑', '排队原因', '会话', '记录最后写入'], (h.queue.threads || []).map(q => [esc(q.thread), esc(q.title || ''), esc(q.round ?? '—') + ' / ' + esc(q.rounds ?? '—'),
      esc(PHASE[q.phase] || q.phase) + (q.resumePending ? '（重启后待恢复）' : ''), q.phase === 'queued' ? dur(q.waitedSec) : dur(q.runningSec), esc(q.queueNote || (q.retryAt ? '等 CLI 就绪后重发' : '') || '—'),
      q.session ? `${q.sessionAlive ? '在' : '<span class="bad">不在</span>'} · ${q.sessionBusy ? '忙' : '闲'}` : '还没开', q.transcriptAt ? ago(q.transcriptAt) : '—']));
    const sessions = table(['标题', '用途', '状态', '最后活动', '号', 'PID', '内存'], (h.sessions.list || []).map(s => [esc(s.title || s.id), esc(PURPOSE[s.purpose] || s.purpose || s.kind),
      esc(STATE[s.state] || s.state) + (s.busy ? ' · 在忙' : ''), ago(s.lastActiveAt), esc(s.account || '—'), esc(s.pid ?? '—'), gb(s.memMB)]));
    const counts = Object.entries(h.sessions.byState || {}).map(([k, v]) => `${STATE[k] || k} ${v}`).join(' · ');
    return block('通道并行与队列', `<div class="wp-strip">${row('并行', par ? `现在最多同时 <b>${esc(par.cap)}</b> 个（受${esc(par.limitedBy)}限制）· 在跑 ${esc(par.working)} 个`
      : '算不出来', par ? `时段上限 ${esc(par.timeCap)} · 账号上限 ${esc(par.laneCap)} · 内存上限 ${esc(par.memCap ?? '不限')}` : '')}
      ${row('队列', `在跑 ${esc(h.queue.running)} 个 · 排队 ${esc(h.queue.queued)} 个${h.holdingDispatch ? ' · <span class="bad">等重启，暂停派发</span>' : ''}`)}
      ${row('公司 Hub', `v${esc(h.version || '?')} · 已运行 ${dur(h.uptimeSec ?? (h.uptimeMin || 0) * 60)} · PID ${esc(h.pid)}${h.care ? ` · 答完保温 ${esc(h.care.keepWarmMinutes)} 分钟` : ''}${h.adminJob && h.adminJob.phase ? ' · 远程指令 ' + esc(h.adminJob.phase) : ''}`)}
      ${h.processNote ? row('提示', esc(h.processNote)) : ''}</div>${queue || '<p class="wp-empty">通道里没有在跑或排队的问题。</p>'}`)
      + block('Hub 里的会话', sessions ? `<p class="wp-meta">${esc(h.sessions.total)} 个 · ${esc(counts)}（已关闭的会话不在内存里，不列出）</p>${sessions}` : '<p class="wp-empty">Hub 里没有打开的会话。</p>');
  }
  function pool(p) {
    if (!p) return '';
    if (p.error) return block('号池', failed(p));
    const rows = (p.accounts || []).map(a => [esc(a.alias), a.ready ? esc(a.state) : `<span class="bad">${esc(a.state)}</span>`, esc(a.activeSessions ?? '—'), esc(a.defaultModel || '—'),
      esc((a.models || []).length ? (a.models || []).join('、') : '—') + (a.duplicate ? '（和别的号重复）' : '') + (a.sameAsPersonal ? '（和个人账号是同一个号）' : '')]);
    return block('号池', `<p class="wp-meta">${p.usePool ? '通道开会话走号池' : '通道只用个人账号'} · 可用 ${esc(p.ready)} 个号</p>` + table(['号', '状态', '进行中', '默认模型', '模型'], rows));
  }
  function logs(l) {
    if (!l) return '';
    if (l.error) return block('日志', failed(l));
    if (l.omitted) return block('日志', `<p class="wp-note">${esc(l.note)}</p>`);
    return block('日志', (l.files || []).map(f => `<details class="cl-details"><summary>${esc(f.label)}${f.error ? ' · ' + esc(f.error) : ` · 最后 ${(f.lines || []).length} 行 · ${esc(f.sizeKB)} KB · 写于 ${ago(f.mtime)}`}</summary>${f.lines ? `<pre class="cl-diag-log">${esc(f.lines.join('\n'))}</pre>` : ''}</details>`).join(''));
  }

  function body(view) {
    const d = view.diag || {};
    const head = `<p class="wp-meta">编号 ${esc(view.id)} · 公司采集 ${((view.elapsedMs || 0) / 1000).toFixed(1)} 秒 · 发出后 ${esc(view.waitedSec ?? '—')} 秒收到 · ${time(view.receivedAt)}${view.bytes ? ` · ${(view.bytes / 1024).toFixed(1)} KB` : ''}</p>`
      + (view.summary ? `<p class="wp-note">${esc(view.summary)}</p>` : '')
      + (view.degraded?.length ? `<p class="wp-note warn">回报超过单条消息上限，已精简：${esc(view.degraded.join('；'))}</p>` : '')
      + (d.note ? `<p class="wp-note warn">${esc(d.note)}</p>` : '');
    return head + machine(d.machine) + processes(d.processes) + hub(d.hub) + pool(d.pool) + logs(d.logs);
  }
  function paint(html, { busy = false } = {}) {
    if (!dialog) return;
    dialog.querySelector('.cl-diag-body').innerHTML = html;
    const again = dialog.querySelector('[data-diag=again]');
    again.disabled = busy; again.textContent = busy ? '正在查看…' : '重新查看';
  }
  function waitingHtml(extra = '') {
    const sec = Math.round((Date.now() - waitingSince) / 1000);
    return `<div class="cl-diag-wait"><span class="wp-pill run">等待回报</span> 已请公司 Hub 直接采集，已等 ${sec} 秒（公司每 10–30 秒检查一次通道；不开 CodeAgent、不排队）。${extra}</div>`
      + (previous ? `<p class="wp-meta">下面是上一次（${time(previous.receivedAt)}）的结果：</p>` + body(previous) : '');
  }
  function stop() { clearInterval(timer); timer = null; }
  async function request() {
    stop();
    try { const last = await call('bridge:diag-result', {}); if (last.status === '已回报') previous = last; } catch { /* 没有上一份 */ }
    waitingSince = Date.now();
    paint(waitingHtml(), { busy: true });
    try { currentId = (await call('bridge:hub-admin', { op: 'diag' })).id; }
    catch (error) { paint(`<p class="wp-note warn">没发出去：${esc(error.message)}</p>` + (previous ? body(previous) : '')); return; }
    let inflight = false;
    timer = setInterval(async () => {
      if (!dialog || inflight) return;
      inflight = true;
      try {
        const view = await call('bridge:diag-result', { id: currentId });
        if (view.status === '已回报') { stop(); previous = null; paint(body(view)); return; }
        if (view.status !== '等待回报') { stop(); paint(`<p class="wp-note warn">${esc(view.status)}：${esc(view.note || view.error || '')}</p>` + (previous ? `<p class="wp-meta">上一次（${time(previous.receivedAt)}）的结果：</p>` + body(previous) : '')); return; }
        if (Date.now() - waitingSince > 120000) { stop(); paint(waitingHtml('<span class="bad">两分钟还没回报：公司 Hub 可能不在线，或版本较旧、还不支持直查。</span>')); return; }
        paint(waitingHtml(), { busy: true });
      } catch (error) { stop(); paint(`<p class="wp-note warn">${esc(error.message)}</p>`); }
      finally { inflight = false; }
    }, 2500);
  }
  function open() {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'hub-dialog cl-diag';
      dialog.innerHTML = '<h2>公司电脑状态</h2><p class="wp-hint">公司 Hub 直接读取电脑和自身状态后回报：秒级、不经 CodeAgent、不占并行名额。号身份显示为「个人 / 号 1」，日志已脱敏。</p>'
        + '<div class="cl-diag-body"></div><footer class="hub-dialog-actions"><button type="button" class="hub-button" data-diag="close">关闭</button><button type="button" class="hub-button hub-button-primary" data-diag="again">重新查看</button></footer>';
      dialog.addEventListener('click', e => {
        const act = e.target.closest('[data-diag]')?.dataset.diag;
        if (act === 'close') dialog.close();
        else if (act === 'again') void request();
      });
      dialog.addEventListener('close', () => { stop(); dialog.remove(); dialog = null; previous = null; });
      document.body.append(dialog);
      dialog.showModal();
    }
    void request().catch(error => showMessage?.(error.message));
  }
  return { open };
}
module.exports = { createCompanyDiagCard };
