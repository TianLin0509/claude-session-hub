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
  const KIND = { codeagent: 'CodeAgent', node: 'Node', 'electron-helper': '孤立的 Electron 子进程' };
  let dialog = null, timer = null, waitingSince = 0, currentId = null, previous = null, shown = null;

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
    const leftovers = table(['名称', 'PID', '内存', '启动于', '已运行', '看起来是', '能否结束'], (p.leftovers || []).map(x => [esc(x.name), esc(x.pid), gb(x.memMB), time(x.startedAt),
      x.startedAt ? dur(Math.max(0, (p.sampledAt || Date.now()) - x.startedAt) / 1000) : '—', esc(x.hint || KIND[x.kind] || x.kind), x.killable ? '<span class="bad">可结束</span>' : '仅嫌疑']));
    const others = table(['名称', '主进程 PID', '启动于', '名下进程', '整棵树内存', '状态'], (p.otherHubs || []).map(x => [esc(x.name), esc(x.pid), time(x.startedAt), esc(x.processes), gb(x.treeMemMB),
      x.idle ? '没有子进程也没有窗口（可能是没退出的旧主进程，不会被自动结束）' : x.hasWindow ? '开着窗口' : '在运行']));
    const tops = table(['名称', 'PID', '内存', '启动于', '归属'], (p.top || []).map(x => [esc(x.name), esc(x.pid), gb(x.memMB), time(x.startedAt),
      [x.hubCore ? 'Hub 自身' : '', x.session ? '会话 ' + esc(x.session) : '', x.codeAgent ? 'CodeAgent' : '', x.otherHub ? '别的 Hub' : '', x.killable ? '<span class="bad">残留·可结束</span>' : x.leftover ? '残留嫌疑' : ''].filter(Boolean).join(' · ') || '其他']));
    return block('内存都去哪了', `<div class="wp-strip">${row('CodeAgent', `${esc(s.codeAgent.count)} 个进程，共 <b>${gb(s.codeAgent.memMB)}</b>（Hub 会话里 ${esc(s.codeAgent.inHub)} 个，Hub 进程树外 ${esc(s.codeAgent.outside)} 个）`)}
      ${row('Hub 自身', `${esc(s.hubSelf.count)} 个进程（主进程、界面、隐藏窗口），共 <b>${gb(s.hubSelf.memMB)}</b>`)}
      ${row('Hub 会话', `${esc(s.hubSessions.sessions)} 个会话的 ${esc(s.hubSessions.processes)} 个进程，共 ${gb(s.hubSessions.memMB)}`)}
      ${row('残留嫌疑', s.leftovers.count ? `可能是重启残留（仅供参考）：${esc(s.leftovers.count)} 个，共 ${gb(s.leftovers.memMB)}；其中可结束 <b>${esc(s.leftovers.killable || 0)}</b> 个、${gb(s.leftovers.killableMemMB || 0)}` : '没有')
        + (p.rules ? `<div class="wp-meta">判定：不属于任何 Hub、父进程已不在且活了 ≥${esc(p.rules.suspectMinAgeMin)} 分钟，或命中已知残留形态，算嫌疑；其中的 CodeAgent / 已知形态且 ≥${esc(p.rules.killMinAgeMin)} 分钟，才算可结束。</div>` : '')}
      ${s.hubScripts?.count ? row('Hub 后台脚本', `浏览器守护、网页圆桌、更新脚本等 ${esc(s.hubScripts.count)} 个，共 ${gb(s.hubScripts.memMB)}（按设计脱离 Hub 运行，不算残留）`) : ''}
      ${s.otherHubs?.count ? row('别的 Hub', `${esc(s.otherHubs.count)} 个 Hub 主进程在当前 Hub 之外，连同名下共 ${esc(s.otherHubs.processes)} 个进程、${gb(s.otherHubs.memMB)}（另一个实例，不算残留）`) : ''}
      ${row('全机', `${esc(p.total)} 个进程${p.hubFound ? '' : ' · <span class="bad">没在进程表里找到 Hub 主进程</span>'}`)}</div>
      ${leftovers ? '<h4>残留嫌疑</h4>' + leftovers + (s.leftovers.killable ? `<div class="cl-diag-actions"><button type="button" class="hub-button" data-diag-act="kill-orphans">结束可结束的残留（${esc((p.leftovers || []).filter(x => x.killable).length)} 个）</button><span class="wp-meta">只按 PID 结束，动手前公司会重新核对，Hub 进程树永远不动</span></div>` : '') : ''}${others ? '<h4>别的 Hub（不算残留）</h4>' + others : ''}${tops ? `<details class="cl-details"><summary>按内存排的前 ${(p.top || []).length} 个进程</summary>${tops}</details>` : ''}`);
  }
  function hub(h) {
    if (!h) return '';
    if (h.error) return block('通道并行与队列', failed(h));
    const par = h.parallel;
    const queue = table(['编号', '标题', '轮次', '状态', '已等 / 已跑', '排队原因', '会话', '记录最后写入', ''], (h.queue.threads || []).map(q => [esc(q.thread), esc(q.title || ''), esc(q.round ?? '—') + ' / ' + esc(q.rounds ?? '—'),
      esc(PHASE[q.phase] || q.phase) + (q.resumePending ? '（重启后待恢复）' : ''), q.phase === 'queued' ? dur(q.waitedSec) : dur(q.runningSec), esc(q.queueNote || (q.retryAt ? '等 CLI 就绪后重发' : '') || '—'),
      q.session ? `${q.sessionAlive ? '在' : '<span class="bad">不在</span>'} · ${q.sessionBusy ? '忙' : '闲'}` : '还没开', q.transcriptAt ? ago(q.transcriptAt) : '—',
      q.phase === 'queued' ? `<button type="button" class="wp-link" data-diag-act="cancel-queued" data-thread="${esc(q.thread)}">取消</button>` : '']));
    const failedList = table(['编号', '标题', '轮次', '没答上的原因', '时间', ''], (h.failed || []).map(f => [esc(f.thread), esc(f.title || ''), esc(f.round ?? '—'), esc(f.error || ''), ago(f.failedAt),
      `<button type="button" class="wp-link" data-diag-act="retry" data-thread="${esc(f.thread)}">重试</button>`]));
    // 远程维护（三期）：休眠空闲通道会话、临时调并行档位
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('');
    const maintain = `<div class="cl-diag-actions"><button type="button" class="hub-button" data-diag-act="suspend-idle">让空闲的通道会话休眠</button>
      <span class="cl-diag-par">临时：内存保底 <select data-diag-p="memFloorPct">${opt([['', '不改'], [5, '5%'], [8, '8%'], [10, '10%'], [15, '15%'], [20, '20%']], 5)}</select>
      · 同时 <select data-diag-p="maxParallel">${opt([['', '不改'], [1, '1 个'], [2, '2 个'], [3, '3 个'], [4, '4 个'], [6, '6 个']], '')}</select>
      · 号池 <select data-diag-p="usePool">${opt([['', '不改'], ['off', '停用（只用个人账号）'], ['on', '启用']], '')}</select>
      · <select data-diag-p="restoreAfterHours">${opt([[1, '1 小时后恢复'], [2, '2 小时后恢复'], [4, '4 小时后恢复'], ['', '不自动恢复']], 2)}</select>
      <button type="button" class="hub-button" data-diag-act="set-parallel">调整</button></span></div>`;
    const sessions = table(['标题', '用途', '状态', '最后活动', '号', 'PID', '内存'], (h.sessions.list || []).map(s => [esc(s.title || s.id), esc(PURPOSE[s.purpose] || s.purpose || s.kind),
      esc(STATE[s.state] || s.state) + (s.busy ? ' · 在忙' : ''), ago(s.lastActiveAt), esc(s.account || '—'), esc(s.pid ?? '—'), gb(s.memMB)]));
    const counts = Object.entries(h.sessions.byState || {}).map(([k, v]) => `${STATE[k] || k} ${v}`).join(' · ');
    return block('通道并行与队列', `<div class="wp-strip">${row('并行', par ? `现在最多同时 <b>${esc(par.cap)}</b> 个（受${esc(par.limitedBy)}限制）· 在跑 ${esc(par.working)} 个`
      : '算不出来', par ? `时段上限 ${esc(par.timeCap)} · 账号上限 ${esc(par.laneCap)} · 内存上限 ${esc(par.memCap ?? '不限')}` : '')}
      ${row('队列', `在跑 ${esc(h.queue.running)} 个 · 排队 ${esc(h.queue.queued)} 个${h.holdingDispatch ? ' · <span class="bad">等重启，暂停派发</span>' : ''}`)}
      ${row('公司 Hub', `v${esc(h.version || '?')} · 已运行 ${dur(h.uptimeSec ?? (h.uptimeMin || 0) * 60)} · PID ${esc(h.pid)}${h.care ? ` · 答完保温 ${esc(h.care.keepWarmMinutes)} 分钟` : ''}${h.adminJob && h.adminJob.phase ? ' · 远程指令 ' + esc(h.adminJob.phase) : ''}`)}
      ${h.processNote ? row('提示', esc(h.processNote)) : ''}</div>${queue || '<p class="wp-empty">通道里没有在跑或排队的问题。</p>'}${failedList ? '<h4>最近没答上的问题</h4>' + failedList : ''}${maintain}`)
      + block('Hub 里的会话', sessions ? `<p class="wp-meta">${esc(h.sessions.total)} 个 · ${esc(counts)}（已关闭的会话不在内存里，不列出）</p>${sessions}` : '<p class="wp-empty">Hub 里没有打开的会话。</p>');
  }
  function pool(p) {
    if (!p) return '';
    if (p.error) return block('号池', failed(p));
    // 派活状态（额度感知，2026-10-18）：可用 / 避让中·原因·预计恢复，Credit；可远程暂停 / 恢复（二次确认）
    const dispatchCell = a => {
      const credit = a.credit ? `<div class="wp-meta">Credit 剩 ${esc(a.credit.remaining)}（${esc(a.credit.pct)}%${a.credit.bucket ? '，' + esc(a.credit.bucket) : ''}）</div>` : '';
      if (a.avoid) return `<span class="bad">避让中</span><div class="wp-meta">${esc(a.avoid.label || '')}${a.avoid.sample ? '：' + esc(a.avoid.sample) : ''}</div>${credit}`
        + `<button type="button" class="wp-link" data-diag-act="resume-account" data-account="${esc(a.alias)}">恢复派活</button>`;
      return `${a.ready ? '可用' : '—'}${credit}${a.ready ? `<button type="button" class="wp-link" data-diag-act="pause-account" data-account="${esc(a.alias)}">暂停派活</button>` : ''}`;
    };
    // 默认模型和权限不符（个人账号，2026-10-19）：写明 settings.json 里的值，给「改成 X」（远程维护 set-personal-model，二次确认）
    const mismatch = a => a.configMismatch ? `<div class="wp-meta"><span class="bad">${esc(a.configMismatch.note || '默认模型和权限不符')}</span></div>`
      + (a.configMismatch.suggest ? `<button type="button" class="wp-link" data-diag-act="set-personal-model" data-model="${esc(a.configMismatch.suggest)}" data-from="${esc(a.configMismatch.written || '')}">改成 ${esc(a.configMismatch.suggest)}</button>` : '') : '';
    // 撤销上一次远程修改（审核 2026-10-19 补的按钮，二次确认）：最近一次修改前的备份里是什么模型就改回什么
    const undo = a => a.lastBackup && (a.configModel == null || a.configModel !== (a.lastBackup.model || '')) ? `<div><button type="button" class="wp-link" data-diag-act="set-personal-model-restore" data-model="${esc(a.lastBackup.model || '')}" data-from="${esc(a.defaultModel || '')}">撤销上次修改（改回 ${esc(a.lastBackup.model || '未设置')}）</button></div>` : '';
    const probed = a => (a.modelsAuthoritative === false && (a.models || []).length ? '<div class="wp-meta">清单未经探测</div>' : '');
    const rows = (p.accounts || []).map(a => [esc(a.alias), a.ready ? esc(a.state) : `<span class="bad">${esc(a.state)}</span>`, dispatchCell(a), esc(a.activeSessions ?? '—'), esc(a.defaultModel || '—') + mismatch(a) + undo(a),
      esc((a.models || []).length ? (a.models || []).join('、') : '—') + probed(a) + (a.duplicate ? '（和别的号重复）' : '') + (a.sameAsPersonal ? '（和个人账号是同一个号）' : '')]);
    const pauseSel = `<span class="cl-diag-par">暂停时长 <select data-diag-p="pauseHours"><option value="1">1 小时</option><option value="2" selected>2 小时</option><option value="4">4 小时</option><option value="24">24 小时</option><option value="">直到手动恢复</option></select></span>`;
    return block('号池', `<p class="wp-meta">${p.usePool ? '通道开会话走号池' : '通道只用个人账号'} · 可用 ${esc(p.ready)} 个号${p.avoiding ? ` · <span class="bad">避让中 ${esc(p.avoiding)} 个</span>` : ''} · 通道挑号时跳过避让中的号</p>`
      + table(['号', '登录', '派活', '进行中', '默认模型', '模型'], rows) + `<div class="cl-diag-actions">${pauseSel}</div>`);
  }
  // 最近的 API 报错原文（errors 段，已脱敏）：核对额度报错的识别规则用
  function errorsBlock(e) {
    if (!e) return '';
    if (e.error) return block('API 报错', failed(e));
    const rows = table(['时间', '号', '来源', '会话', '命中规则', '原文（已脱敏）'], (e.list || []).map(x => [ago(x.at || x.seenAt), esc(x.account), esc(x.source) + (x.structured ? '（结构化）' : ''),
      esc(x.purpose) + ' ' + esc(x.session || ''), x.matched ? `<span class="bad">${esc(x.matched)}</span>` : '疑似', `<code>${esc(x.text)}</code>`]));
    return block('API 报错', `<p class="wp-meta">最近 ${esc((e.list || []).length)} 条（共记 ${esc(e.total)} 条）· 识别规则 ${esc((e.rules || []).map(r => r.id).join('、') || '无')}${e.guard === false ? ' · <span class="bad">公司关了额度识别</span>' : ''}${(e.ruleErrors || []).length ? ` · <span class="bad">写错的规则：${esc(e.ruleErrors.join('；'))}</span>` : ''}</p>`
      + (rows || '<p class="wp-empty">还没识别到 API 报错。</p>'));
  }
  // ---- 二期：CodeAgent、仿真、功能 ----
  const okErr = (okAt, err) => `${okAt ? '最近成功 ' + time(okAt) : '还没成功过'}${err ? ` · <span class="bad">最近错误：${esc(err)}</span>` : ''}`;
  // 个人账号配置目录（2026-10-19）：从哪来、settings.json 写的模型、是否和号池号的目录重叠、继承来的配置目录已忽略（都不带路径）
  const DIR_SOURCE = { 'hub-env': '由 AI_HUB_CODEAGENT_CONFIG_DIR 指定', 'hub-config': 'Hub 设置里指定', default: '默认 ~/.cac', 'ignored-inherited-env': '默认 ~/.cac',
    'codeagent-env': '取自 Hub 继承的 CODEAGENT3_CONFIG_DIR（旧版行为）' };
  const ORIGIN = { 'user-env': '用户级环境变量里设了它', 'system-env': '系统级环境变量里设了它', 'process-only': '不是用户级或系统级环境变量，是启动 Hub 的那个进程带进来的', unknown: '没查到来源' };
  function personalDir(p) {
    const parts = [esc(DIR_SOURCE[p.configSource] || p.configSource || '未知')];
    if (p.configModel != null) parts.push('settings.json 的 model：' + (p.configModel ? esc(p.configModel) : '没写'));
    if (p.inPool) parts.push(`<span class="bad">和${esc(p.inPoolAlias || '号池')}的目录重叠</span>`);
    else if (p.inPool === false) parts.push('不在号池目录里');
    const i = p.inheritedConfigDir;
    if (i) {
      const inside = i.startedInside ? [i.startedInside.hubSession ? 'Hub 的环境里有 Hub 会话标记' : '', i.startedInside.codeagent ? 'Hub 的环境里有 CodeAgent 启动器标记' : ''].filter(Boolean) : [];
      parts.push(`<span class="bad">${esc(i.note || '继承的配置目录已忽略')}</span>（${i.inPool ? `它指向${esc(i.inPoolAlias || '号池')}的目录` : '它不在号池目录里'}；${esc(ORIGIN[i.origin] || ORIGIN.unknown)}${inside.length ? '；' + esc(inside.join('、')) + '，说明 Hub 是从某个会话里启动的' : ''}）`);
    }
    return parts.join(' · ');
  }
  function codeagent(c) {
    if (!c) return '';
    if (c.error) return block('CodeAgent', failed(c));
    const p = c.personal;
    const quota = table(['号', '剩余额度', '档位', '读自会话', '读数时间'], (c.quota || []).map(q => [esc(q.account), `<b>${esc(q.pct)}%</b>（${esc(q.remaining)}${q.total ? ' / ' + esc(q.total) : ''}）`, esc(q.bucket || ''), esc(q.session), ago(q.sessionActiveAt)]));
    return block('CodeAgent', `<div class="wp-strip">${row('版本', c.version ? 'v' + esc(c.version) : `<span class="bad">没读到：${esc(c.versionError || '')}</span>`)}
      ${row('个人账号', p ? `${p.ready ? esc(p.state) : `<span class="bad">${esc(p.state)}</span>`}${p.expiresAt ? ' · 登录到期 ' + time(p.expiresAt) : ''}${p.defaultModel ? ' · 默认模型 ' + esc(p.defaultModel) : ''}` : esc(c.loginError || '读不到'))}
      ${p ? row('个人配置目录', personalDir(p)) : ''}
      ${row('号池', `${esc(c.pool.total)} 个号，可用 ${esc(c.pool.ready)} 个${c.pool.needLogin ? `，<span class="bad">${esc(c.pool.needLogin)} 个需要重新登录</span>` : ''}`)}
      ${row('额度', (c.quota || []).length ? `读了 ${esc(c.quotaScreens.read)} 个会话屏幕` : esc(c.quotaNote || '没读到'))}
      ${Array.isArray(c.avoid) ? row('避让中', c.avoid.length ? c.avoid.map(a => `<span class="bad">${esc(a.account)}</span> ${esc(a.label || '')}`).join('；') : '没有') : ''}</div>${quota}`);
  }
  function airview(a) {
    if (!a) return '';
    if (a.error) return block('仿真', failed(a));
    const procRow = x => [esc(x.name), esc(x.pid), gb(x.memMB), time(x.startedAt), x.startedAt ? dur(Math.max(0, Date.now() - x.startedAt) / 1000) : '—',
      x.session ? '会话 ' + esc(x.session) : x.hub ? 'Hub' : '其他', esc(x.hint || '')];
    const head = ['名称', 'PID', '内存', '启动于', '已运行', '归属', '看起来是'];
    // 按内存排，前 8 个直接显示，其余折叠
    const procs = Array.isArray(a.processes) && a.processes.length ? table(head, a.processes.slice(0, 8).map(procRow))
      + (a.processes.length > 8 ? `<details class="cl-details"><summary>其余 ${a.processes.length - 8} 个</summary>${table(head, a.processes.slice(8).map(procRow))}</details>` : '') : '';
    const dirs = (a.dirs || []).map(d => `${esc(d.dir)}：${d.error ? `<span class="bad">${esc(d.error)}</span>` : `${esc(d.files)} 个结果文件${d.truncated ? '（没扫完）' : ''}`}`).join('<br>');
    const files = table(['目录', '文件（相对路径）', '大小', '修改时间'], (a.recent || []).map(f => [esc(f.dir), esc(f.rel), f.sizeKB >= 1024 ? (f.sizeKB / 1024).toFixed(1) + ' MB' : esc(f.sizeKB) + ' KB', ago(f.mtime)]));
    return block('仿真', `${a.processes?.error ? `<p class="wp-note warn">进程没采到：${esc(a.processes.error)}</p>` : procs || '<p class="wp-empty">没有在跑的 Python / MATLAB / AirView 进程。</p>'}
      <div class="wp-strip">${row('结果目录', dirs || '设置里没有配置目录')}${a.filesError ? row('提示', `<span class="bad">${esc(a.filesError)}</span>`) : ''}${a.scanned != null ? row('扫描', `看了 ${esc(a.scanned)} 个条目，用时 ${esc(a.scanMs)} 毫秒${a.truncated ? '（达到上限，没扫完）' : ''}；只看文件名、大小、修改时间${a.note ? '；' + esc(a.note) : ''}`) : ''}</div>
      ${files ? `<h4>最近更新的结果文件（前 ${(a.recent || []).length} 个）</h4>${files}` : ''}`);
  }
  function features(f) {
    if (!f) return '';
    if (f.error) return block('功能', failed(f));
    const line = (name, x, extra = '') => !x ? '' : x.error ? row(name, `<span class="bad">没读到：${esc(x.error)}</span>`) : x.note ? row(name, esc(x.note)) : row(name, okErr(x.lastSuccessAt, x.lastError) + extra);
    return block('功能', `<div class="wp-strip">${line('论坛', f.forum, f.forum && !f.forum.note && !f.forum.error ? ` · 今天${f.forum.today ? '已取' : '还没取'}${f.forum.syncing ? ' · 正在取' : ''}` : '')}
      ${line('简报', f.brief, f.brief?.login && !f.brief.login.ok ? ' · <span class="bad">WeLink 没登录</span>' : '')}
      ${line('手机对话', f.phone, f.phone && !f.phone.note && !f.phone.error ? (f.phone.active ? ' · 开着' : ' · 没开') : '')}
      ${line('桌宠形象', f.pet, f.pet?.downloaded?.length ? ` · 已下载 ${f.pet.downloaded.map(r => esc(r.name)).join('、')}` : '')}</div>`);
  }  function logs(l) {
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
    return head + machine(d.machine) + processes(d.processes) + hub(d.hub) + codeagent(d.codeagent) + pool(d.pool) + errorsBlock(d.errors) + airview(d.airview) + features(d.features) + logs(d.logs);
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
        if (view.status === '已回报') { stop(); previous = null; shown = view; paint(body(view)); return; }
        if (view.status !== '等待回报') { stop(); paint(`<p class="wp-note warn">${esc(view.status)}：${esc(view.note || view.error || '')}</p>` + (previous ? `<p class="wp-meta">上一次（${time(previous.receivedAt)}）的结果：</p>` + body(previous) : '')); return; }
        if (Date.now() - waitingSince > 120000) { stop(); paint(waitingHtml('<span class="bad">两分钟还没回报：公司 Hub 可能不在线，或版本较旧、还不支持直查。</span>')); return; }
        paint(waitingHtml(), { busy: true });
      } catch (error) { stop(); paint(`<p class="wp-note warn">${esc(error.message)}</p>`); }
      finally { inflight = false; }
    }, 2500);
  }
  // ---- 远程维护（三期）：按钮 → 二次确认 → hub-admin op:'act' → 等回报 → 顶部横条显示结果和前后对比 ----
  const ACT_LABEL = { 'suspend-idle': '让空闲的通道会话休眠', 'kill-orphans': '结束残留进程', 'set-parallel': '临时调整并行档位', 'cancel-queued': '取消排队中的问题', retry: '重试失败的问题',
    'pause-account': '暂停派活给一个号', 'resume-account': '恢复派活给一个号', 'set-personal-model': '修改个人账号默认模型', 'set-personal-model-restore': '撤销个人账号默认模型的上次修改' };
  function banner(html, tone = '') {
    const el = dialog?.querySelector('.cl-diag-act-result');
    if (!el) return;
    el.hidden = !html; el.className = 'cl-diag-act-result' + (tone ? ' ' + tone : ''); el.innerHTML = html;
    if (html) el.scrollIntoView({ block: 'nearest' }); // 按钮多在卡片下半，结果横条在顶上：滚过去让人看见
  }
  function actDetail(v) {
    const a = v.act || {};
    const mem = a.before?.freeMB != null && a.after?.freeMB != null && !/可用内存/.test(v.note || '') ? `可用内存 ${esc(a.before.freeMB)} → ${esc(a.after.freeMB)} MB` : '';
    const list = a.results ? a.results.map(x => `PID ${esc(x.pid)}：${x.ok ? (x.already ? '已经不在了' : x.confirmed === false ? '已发出结束请求、未确认退出' : '已结束') : esc(x.why || '没动')}`).join('；')
      : a.suspended ? [...a.suspended.map(x => `${esc(x.thread)} 已休眠`), ...(a.skipped || []).map(x => `${esc(x.thread)} 没动（${esc(x.why)}）`)].join('；') : '';
    return [mem, list].filter(Boolean).join('<br>');
  }
  async function maintain(action, el) {
    const params = {};
    let confirmText = '';
    if (action === 'kill-orphans') {
      const targets = (shown?.diag?.processes?.leftovers || []).filter(x => x.killable).map(x => ({ pid: x.pid, startedAt: x.startedAt, name: x.name, memMB: x.memMB }));
      if (!targets.length) return banner('这份结果里没有可结束的残留。', 'warn');
      params.targets = targets.map(({ pid, startedAt }) => ({ pid, startedAt }));
      confirmText = `结束公司电脑上的这 ${targets.length} 个残留进程？\n${targets.map(x => `PID ${x.pid}  ${x.name}  ${gb(x.memMB)}`).join('\n')}\n\n公司会按 PID 结束，动手前重新核对（启动时间对不上、又属于某个 Hub 的都不动）。`;
    } else if (action === 'suspend-idle') confirmText = '让公司电脑上答完空着的通道会话立即休眠？人自己开的会话不动，休眠的会话追问时会自动恢复。';
    else if (action === 'set-parallel') {
      for (const k of ['memFloorPct', 'maxParallel', 'restoreAfterHours']) { const v = dialog.querySelector(`[data-diag-p=${k}]`)?.value; if (v) params[k] = Number(v); }
      // 闲时上限取「忙时、闲时」两者较大的：只改忙时，晚上和周末不生效，所以两个一起改
      if (params.maxParallel) params.maxParallelIdle = params.maxParallel;
      const pool = dialog.querySelector('[data-diag-p=usePool]')?.value;
      if (pool) params.usePool = pool === 'on';
      const parts = [params.memFloorPct ? `「内存保底」改成 ${params.memFloorPct}%` : '', params.maxParallel ? `同时处理改成 ${params.maxParallel} 个（忙时、闲时都改）` : '',
        pool ? (params.usePool ? '通道恢复使用号池' : '通道停用号池、只用个人账号') : ''].filter(Boolean);
      if (!parts.length) return banner('没有选要调整的项。', 'warn');
      confirmText = `临时把公司${parts.join('、')}，${params.restoreAfterHours ? params.restoreAfterHours + ' 小时后自动恢复原值' : '不自动恢复'}？`;
    } else if (action === 'pause-account' || action === 'resume-account') {
      params.account = el?.dataset.account || '';
      const hours = dialog.querySelector('[data-diag-p=pauseHours]')?.value;
      if (action === 'pause-account' && hours) params.hours = Number(hours);
      confirmText = action === 'pause-account'
        ? `暂停公司把新问题派给「${params.account}」${params.hours ? `，${params.hours} 小时后自动恢复` : '，直到手动恢复'}？通道新开会话和换号重做都不再挑它；已在跑的会话不受影响。`
        : `恢复公司派活给「${params.account}」？如果它的额度其实还没恢复，撞到报错会再自动避让。`;
    } else if (action === 'set-personal-model') {
      params.model = el?.dataset.model || '';
      if (!params.model) return banner('没有可改成的模型。', 'warn');
      confirmText = `把公司个人账号的默认模型从「${el?.dataset.from || '未设置'}」改成「${params.model}」？`
        + '\n\n只改公司个人配置目录 settings.json 里的 model 一项，改前自动备份、写后核对，可用 set-personal-model restore 撤销；只影响之后新开的会话，已在跑的会话不动。';
    } else if (action === 'set-personal-model-restore') {
      params.restore = true;
      confirmText = `撤销上一次对公司个人账号默认模型的修改，改回「${el?.dataset.model || '未设置'}」？`
        + '\n\n用最近一次修改前的备份里的值，只改 settings.json 里的 model 一项，改前同样备份；只影响之后新开的会话，已在跑的会话不动。';
    } else {
      params.thread = el?.dataset.thread || '';
      confirmText = action === 'cancel-queued' ? `取消排队中的问题 ${params.thread}？提问的会话会收到「被对端取消」。` : `重试问题 ${params.thread}？`;
    }
    if (!window.confirm(confirmText)) return;
    dialog.querySelectorAll('[data-diag-act]').forEach(b => { b.disabled = true; });
    banner(`<span class="wp-pill run">执行中</span> 已请公司 Hub ${esc(ACT_LABEL[action])}，等回报……`);
    try {
      // 「撤销上次修改」是 set-personal-model 带 restore:true
      const { id } = await call('bridge:hub-admin', { op: 'act', action: action === 'set-personal-model-restore' ? 'set-personal-model' : action, params });
      const start = Date.now();
      for (;;) {
        await new Promise(r => setTimeout(r, 2500));
        if (!dialog) return;
        const v = await call('bridge:act-result', { id });
        if (v.status === '等待回报') { if (Date.now() - start > 120000) { banner('两分钟还没回报：公司 Hub 可能不在线。', 'warn'); return; } continue; }
        const ok = v.status === '已执行' && v.act && v.act.ok !== false;
        banner(`<b>${esc(v.note || v.status)}</b>${actDetail(v) ? '<div class="wp-meta">' + actDetail(v) + '</div>' : ''}<div class="wp-meta">点「重新查看」看最新状态（30 秒内只能查一次）。</div>`, ok ? 'ok' : 'warn');
        return;
      }
    } catch (error) { banner('没做成：' + esc(error.message), 'warn'); }
    finally { dialog?.querySelectorAll('[data-diag-act]').forEach(b => { b.disabled = false; }); }
  }
  function open() {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'hub-dialog cl-diag';
      dialog.innerHTML = '<h2>公司电脑状态</h2><p class="wp-hint">公司 Hub 直接读取电脑和自身状态后回报：秒级、不经 CodeAgent、不占并行名额。号身份显示为「个人 / 号 1」，日志已脱敏。</p>'
        + '<div class="cl-diag-act-result" hidden></div><div class="cl-diag-body"></div><footer class="hub-dialog-actions"><button type="button" class="hub-button" data-diag="close">关闭</button><button type="button" class="hub-button hub-button-primary" data-diag="again">重新查看</button></footer>';
      dialog.addEventListener('click', e => {
        const maint = e.target.closest('[data-diag-act]');
        if (maint) { void maintain(maint.dataset.diagAct, maint); return; }
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
