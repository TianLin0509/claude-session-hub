'use strict';
// 助理页（左侧「助理」）：田哥与助理这个个体之间的全部往来——电脑或手机说的话、千问/DeepSeek 快答、
// 助理会话（Claude 等）的回答、提醒——都在这一条对话里。助理会话内部过程留在工作台的会话里，这里只放结论。
// 2026-10-04 田哥确认：助理 Tab 是虚拟的「助理」，不是某个 CLI 会话的另一个视图。
function createAssistantPage({ document, window, ipcRenderer, openSession, closeOtherPanels = () => {}, showMessage, onOpenChange = () => {} }) {
  let page = null, entries = [], desk = null, frontDesk = null, profile = null, sending = false;
  const TZ = 'Asia/Shanghai';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = at => new Date(at).toLocaleTimeString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const ymd = at => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(at)).map(x => [x.type, +x.value]));
  const day = at => {
    const d = ymd(at), t = ymd(Date.now()), diff = Math.round((Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(d.year, d.month - 1, d.day)) / 86400000);
    return diff === 0 ? '今天' : diff === 1 ? '昨天' : `${d.month}月${d.day}日`;
  };
  const seconds = ms => ms == null ? '' : ms < 10000 ? (ms / 1000).toFixed(1) + ' 秒' : Math.round(ms / 1000) + ' 秒';
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke(channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'assistant-page'; page.id = 'assistant-page'; page.hidden = true; page.setAttribute('aria-label', '助理');
    page.innerHTML = `<header class="ap-head">
        <img class="ap-avatar" src="assets/assistant/penguin.png" alt="">
        <div class="ap-title"><h1>助理</h1><p class="ap-sub"></p></div>
        <button type="button" class="ap-chip" data-ap="front" aria-label="回答方式"></button>
        <button type="button" class="ap-chip" data-ap="engine" aria-label="助理会话设置"></button>
        <button type="button" class="ap-more" data-ap="more" aria-label="更多">···</button>
      </header>
      <div class="ap-scroll"><div class="ap-list"></div></div>
      <form class="ap-composer"><textarea rows="1" placeholder="和助理说…（Enter 发送，Shift+Enter 换行）" aria-label="和助理说"></textarea><button type="submit" aria-label="发送">发送</button></form>`;
    document.body.append(page);
    page.addEventListener('click', event => { const b = event.target.closest('[data-ap]'); if (b) void action(b.dataset.ap, b).catch(e => showMessage?.(e.message)); });
    const input = page.querySelector('textarea');
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); page.querySelector('form').requestSubmit(); } });
    page.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault(); const text = input.value.trim(); if (!text || sending) return;
      sending = true; input.value = ''; input.style.height = 'auto'; paintComposer();
      try { await call('assistant:ask', { text }); } catch (error) { input.value = text; showMessage?.('没有发出去：' + error.message); }
      finally { sending = false; paintComposer(); void refreshDesk(); }
    });
  }
  function place() {
    if (!page || page.hidden) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), panel = document.getElementById('terminal-panel');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = panel ? window.innerHeight - panel.getBoundingClientRect().bottom : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
  }
  function paintHead() {
    if (!page) return;
    const fd = frontDesk, p = profile;
    const engine = p ? [p.kindLabel, p.label].filter(Boolean).join(' ') : '助理会话';
    page.querySelector('[data-ap="front"]').textContent = (fd ? fd.label : '回答方式') + ' ▾';
    page.querySelector('[data-ap="engine"]').textContent = engine + ' ▾';
    page.querySelector('.ap-sub').textContent = fd?.mode === 'cli' ? `每条都交给助理会话（${engine}）` : `简单问题${fd ? fd.modelLabel : '快答'}当场答，工作和难题交给 ${engine}`;
  }
  function paintComposer() { if (page) page.querySelector('.ap-composer button').disabled = sending; }
  function render() {
    if (!page) return;
    const list = page.querySelector('.ap-list'), scroll = page.querySelector('.ap-scroll');
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    const answered = new Set(entries.filter(e => e.role !== 'user').map(e => e.id));
    if (!entries.length) {
      list.innerHTML = `<div class="ap-empty"><img src="assets/assistant/penguin.png" alt=""><h2>田哥，我在。</h2><p>电脑上在下面输入，或用手机找我。我们之间的对话都会留在这里。</p></div>`;
      return;
    }
    let lastDay = '', html = '';
    for (const e of entries) {
      const d = day(e.at); if (d !== lastDay) { html += `<div class="ap-day">${esc(d)}</div>`; lastDay = d; }
      if (e.role === 'user') {
        const from = e.source === 'hub' ? '电脑' : e.input === 'voice' ? '手机语音' + (e.durationMs ? ' ' + Math.round(e.durationMs / 1000) + '″' : '') : '手机';
        html += `<div class="ap-msg me"><div class="ap-bubble">${esc(e.text)}</div><div class="ap-cap">${esc(from)} · ${time(e.at)}</div></div>`;
      } else if (e.role === 'assistant') {
        const who = e.lane === 'notice' ? '提醒 · ' + (e.by || '') : (e.by || '') + (e.ms != null ? ' · ' + seconds(e.ms) : '');
        html += `<div class="ap-msg ai ${e.lane === 'fast' ? 'fast' : e.lane === 'notice' ? 'notice' : 'session'}"><div class="ap-bubble">${esc(e.text)}</div><div class="ap-cap">${esc(who)} · ${time(e.at)}</div></div>`;
      } else html += `<div class="ap-note">${esc(e.text)}</div>`;
    }
    const waiting = entries.filter(e => e.role === 'user' && !answered.has(e.id) && Date.now() - e.at < 1800000);
    if (waiting.length) html += `<div class="ap-msg ai typing"><div class="ap-bubble"><span></span><span></span><span></span></div><div class="ap-cap">${esc(desk?.waiting || desk?.queued ? '助理会话处理中' : '正在回答')}</div></div>`;
    list.innerHTML = html;
    if (atBottom || !list.dataset.painted) { scroll.scrollTop = scroll.scrollHeight; list.dataset.painted = '1'; }
  }
  async function refreshDesk() { try { desk = (await call('assistant:dialog-log', { limit: 1 })).desk; } catch {} render(); }
  async function load() {
    const [log, fd, prof] = await Promise.all([call('assistant:dialog-log', { limit: 300 }), call('assistant:front-desk'), call('assistant:phone-profile').catch(() => null)]);
    entries = log.entries || []; desk = log.desk; frontDesk = fd.current; setProfile(prof);
    paintHead(); render();
  }
  function setProfile(prof) {
    if (!prof?.current) return;
    const kind = (prof.kinds || []).find(k => k.kind === prof.current.kind);
    profile = { ...prof.current, kindLabel: kind?.label || prof.current.kind, catalog: prof.kinds || [] };
  }
  // 小菜单：回答方式、助理会话设置、更多。同一时间只开一个。
  function menu(anchor, html, onPick) {
    document.querySelector('.ap-menu')?.remove();
    const m = document.createElement('div'); m.className = 'ap-menu'; m.dataset.for = anchor.dataset.ap || ''; m.innerHTML = html;
    const r = anchor.getBoundingClientRect(); m.style.top = r.bottom + 6 + 'px'; m.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    m.addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b) { e.stopPropagation(); void onPick(b.dataset.pick, m).catch(err => showMessage?.(err.message)); } });
    document.body.append(m); return m;
  }
  async function action(name, button) {
    // 再点同一个按钮收起菜单。
    const opened = document.querySelector('.ap-menu'); if (opened && opened.dataset.for === name) { opened.remove(); return; }
    if (name === 'front') {
      const info = await call('assistant:front-desk'); const c = info.current, mark = on => on ? '<i>✓</i>' : '';
      menu(button, `<div class="ap-menu-title">回答方式</div>`
        + info.models.map(x => `<button type="button" data-pick="api|${esc(x.id)}">快速回答 · ${esc(x.label)}${mark(c.mode === 'api' && c.model === x.id)}</button>`).join('')
        + `<button type="button" data-pick="cli|">全部交给助理会话${mark(c.mode === 'cli')}</button><p class="ap-menu-hint">${esc(info.modes.find(x => x.id === c.mode)?.hint || '')}</p>`,
        async (pick, m) => { const [mode, model] = pick.split('|'); m.remove(); const r = await call('assistant:set-front-desk', { mode, ...(model ? { model } : {}) }); frontDesk = r.frontDesk; paintHead(); });
    } else if (name === 'engine') {
      if (!profile) setProfile(await call('assistant:phone-profile'));
      const p = profile, opts = (list, cur, label = x => x) => list.map(x => `<option value="${esc(x.id ?? x)}"${(x.id ?? x) === cur ? ' selected' : ''}>${esc(label(x))}</option>`).join('');
      const EFF = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', minimal: '最低', none: '不思考', ultra: '极限' };
      const m = menu(button, `<div class="ap-menu-title">助理会话</div><p class="ap-menu-hint">难题、工作和 Hub 状态由它处理</p>
        <label>引擎<select data-f="kind">${opts(p.catalog.map(k => ({ id: k.kind, label: k.label })), p.kind, x => x.label)}</select></label>
        <label>模型<select data-f="model"></select></label><label>思考深度<select data-f="effort"></select></label>
        <div class="ap-menu-row"><button type="button" data-pick="session">打开助理会话</button><button type="button" class="primary" data-pick="save">保存</button></div>`,
        async (pick, menuEl) => {
          if (pick === 'session') { menuEl.remove(); await openSession(); return; }
          const v = f => menuEl.querySelector(`[data-f="${f}"]`).value;
          const btn = menuEl.querySelector('.primary'); btn.disabled = true; btn.textContent = '切换中…';
          try { await call('assistant:set-profile', { kind: v('kind'), model: v('model'), ...(v('effort') ? { effort: v('effort') } : {}) }); setProfile(await call('assistant:phone-profile')); paintHead(); menuEl.remove(); }
          catch (error) { btn.disabled = false; btn.textContent = '保存'; throw error; }
        });
      const fill = keep => {
        const k = p.catalog.find(x => x.kind === m.querySelector('[data-f="kind"]').value) || p.catalog[0];
        const models = (k?.models || []).map(x => typeof x === 'string' ? { id: x, label: x } : x);
        const model = keep && models.some(x => x.id === p.model) ? p.model : (models.some(x => x.id === k?.defaultModel) ? k.defaultModel : models[0]?.id);
        m.querySelector('[data-f="model"]').innerHTML = opts(models, model, x => x.label || x.id);
        const effs = () => { const mm = models.find(x => x.id === m.querySelector('[data-f="model"]').value); return mm?.efforts || k?.efforts || []; };
        const paintEff = keepEff => { const list = effs(), cur = keepEff && list.includes(p.effort) ? p.effort : list.includes(k?.defaultEffort) ? k.defaultEffort : list[0]; const sel = m.querySelector('[data-f="effort"]'); sel.innerHTML = opts(list, cur, x => EFF[x] || x); sel.closest('label').hidden = !list.length; };
        paintEff(keep); m.querySelector('[data-f="model"]').onchange = () => paintEff(false);
      };
      fill(true); m.querySelector('[data-f="kind"]').onchange = () => fill(false);
    } else if (name === 'more') {
      menu(button, `<button type="button" data-pick="session">打开助理会话（工作台）</button><button type="button" data-pick="phone">手机连接</button><button type="button" data-pick="memory">助理记忆</button><button type="button" data-pick="workbench">工作档案</button><button type="button" data-pick="rotate">新开助理（换班）</button>`,
        async (pick, m) => {
          m.remove();
          if (pick === 'session') return openSession();
          if (pick === 'phone') return require('./assistant-phone').openPhone({ document, ipcRenderer });
          if (pick === 'memory') return call('assistant:open-memory');
          if (pick === 'workbench') return call('assistant:open-workbench');
          if (pick === 'rotate') { await call('assistant:rotate-now'); showMessage?.('已换成新的助理会话，旧会话保留为「已换班」。'); }
        });
    }
  }
  const onResize = () => place();
  async function open() {
    build(); closeOtherPanels(); window.__assistantHide?.();
    page.hidden = false; document.body.classList.add('assistant-page-open'); onOpenChange(true); place();
    window.addEventListener('resize', onResize);
    // 后台预热助理会话：第一条难题交过去时不用再等它冷启动。不切换当前画面。
    void ipcRenderer.invoke('assistant:ensure-session').catch(() => {});
    try { await load(); } catch (error) { showMessage?.('助理记录读取失败：' + error.message); }
    page.querySelector('textarea').focus();
  }
  function close() {
    if (!page || page.hidden) return;
    page.hidden = true; document.body.classList.remove('assistant-page-open'); document.querySelector('.ap-menu')?.remove();
    window.removeEventListener('resize', onResize); onOpenChange(false);
  }
  document.addEventListener('click', e => { if (!e.target.closest('.ap-menu,[data-ap]')) document.querySelector('.ap-menu')?.remove(); if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-assistant)')) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelector('.ap-menu')?.remove(); });
  ipcRenderer.on('assistant:dialog', (_e, entry) => { if (!entry) return; entries.push(entry); if (page && !page.hidden) { if (entry.role !== 'user') void refreshDesk(); else render(); } });
  ipcRenderer.on('assistant:front-desk', (_e, current) => { frontDesk = current; paintHead(); });
  return { open, close, isOpen: () => !!page && !page.hidden };
}
module.exports = { createAssistantPage };
