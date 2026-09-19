'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}
const TYPE_GROUPS = { image: /\.(png|jpe?g|gif|webp|bmp|svg)$/i, document: /\.(md|txt|pdf|docx?|xlsx?|csv)$/i,
  slide: /\.(pptx?|odp)$/i, code: /\.(js|ts|jsx|tsx|py|go|rs|json|html|css|ps1|ya?ml|cpp|h)$/i };

function createFileManagerFeatures(o) {
  const { document: d, window: w, ipcRenderer: ipc, state, elements: el } = o;
  const selected = new Set();
  const entries = new Map();
  let anchor = '';
  let mode = 'tree';
  let sort = 'name';
  let descending = false;
  let type = 'all';
  let showHidden = true;
  let thumbnails = false;
  let results = null;
  let scanVersion = 0;
  let refreshing = false;
  let refreshTimer;
  let searchTimer;
  let menu;
  let history = [];
  let historyIndex = -1;
  let historyMoving = false;
  let jobsOpen = false;
  let favorites = [];
  const nodes = {};
  const storageKey = 'hub-file-manager-v2';

  function element(tag, className, text) {
    const node = d.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(text, title, action) {
    const node = element('button', '', text); node.type = 'button'; node.title = title;
    node.addEventListener('click', () => { Promise.resolve().then(action).catch(report); });
    return node;
  }
  function report(error) { o.setStatus(error.message || String(error), 'error', { sticky: true }); }
  async function invoke(channel, payload) {
    const r = await ipc.invoke(`file-manager:${channel}`, payload);
    if (!r || r.ok !== true) throw new Error(r?.error || '操作没有返回成功结果');
    return r;
  }
  function remember() {
    try { w.localStorage.setItem(storageKey, JSON.stringify({ sort, descending, type, showHidden, thumbnails, favorites, width: el.panel.style.width })); }
    catch (error) { report(new Error(`偏好未保存：${error.message}`)); }
  }
  function matchesType(entry) {
    return (showHidden || !entry.hidden) && (entry.type === 'directory' || type === 'all' || TYPE_GROUPS[type]?.test(entry.name));
  }
  function sortEntries(list) {
    return [...list].sort((a, b) => {
      const dir = Number(b.type === 'directory') - Number(a.type === 'directory');
      if (dir) return dir;
      const n = sort === 'size' ? (a.size ?? -1) - (b.size ?? -1) : sort === 'mtime' ? (a.mtimeMs ?? -1) - (b.mtimeMs ?? -1) : a.name.localeCompare(b.name, undefined, { numeric: true });
      return (descending ? -1 : 1) * (n || a.name.localeCompare(b.name));
    });
  }
  function decorateRow(row, node, entry) {
    entries.set(entry.path, entry);
    node.classList.toggle('selected', selected.has(entry.path));
    node.setAttribute('aria-selected', String(selected.has(entry.path)));
    node.draggable = entry.type === 'file';
    node.addEventListener('dragstart', event => {
      const paths = selected.has(entry.path) ? [...selected] : [entry.path];
      event.dataTransfer.setData('application/x-hub-files', JSON.stringify(paths));
      event.dataTransfer.setData('text/plain', paths.join('\n'));
      event.dataTransfer.effectAllowed = 'copy';
    });
    const name = node.querySelector('.fm-node-name');
    name.title = entry.path;
    if (entry.extension) {
      name.replaceChildren(element('span', 'fm-name-base', entry.name.slice(0, -entry.extension.length)), element('span', 'fm-name-extension', entry.name.slice(-entry.extension.length)));
    }
    const detail = element('span', 'fm-file-details');
    const size = element('span', 'fm-file-size', formatSize(entry.size));
    const time = element('time', 'fm-file-time', entry.mtimeMs ? new Date(entry.mtimeMs).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
    time.title = entry.mtimeMs ? new Date(entry.mtimeMs).toLocaleString('zh-CN') : entry.metadataError || '修改时间未知';
    detail.append(size, time); node.append(detail);
    const check = element('input', 'fm-select'); check.type = 'checkbox'; check.checked = selected.has(entry.path);
    check.setAttribute('aria-label', `选择 ${entry.name}`); check.dataset.filePath = entry.path;
    row.prepend(check);
    const more = button('⋯', `操作 ${entry.name}`, () => {
      if (!selected.has(entry.path)) { selected.clear(); selected.add(entry.path); o.renderTree(); }
      const rect = row.isConnected ? row.getBoundingClientRect() : el.tree.getBoundingClientRect();
      showMenu(rect.right - 16, rect.top, [...selected]);
    }); more.className = 'fm-more'; row.append(more);
    if (mode !== 'tree') {
      const relative = element('span', 'fm-relative', path.relative(state.root, entry.path));
      relative.title = entry.path; node.append(relative);
    }
    if (thumbnails && TYPE_GROUPS.image.test(entry.name) && entry.size <= 5 * 1024 * 1024) {
      const image = element('img', 'fm-thumbnail'); image.loading = 'lazy'; image.src = pathToFileURL(entry.path).href; image.alt = '';
      image.addEventListener('error', () => image.remove()); node.querySelector('.fm-node-icon').replaceChildren(image);
    }
  }
  function afterRender() {
    const chosen = [...selected].map(p => entries.get(p)).filter(Boolean);
    nodes.selection.textContent = chosen.length ? `已选 ${chosen.length} 项 · ${formatSize(chosen.reduce((sum, e) => sum + (e.size || 0), 0))}${chosen.some(e => e.type === 'directory') ? '（不含文件夹内容）' : ''}` : 'Ctrl / Shift 多选 · 右键操作';
    nodes.batch.disabled = !selected.size;
    nodes.path.value = state.root;
    nodes.back.disabled = historyIndex <= 0;
    nodes.forward.disabled = historyIndex >= history.length - 1;
    el.filter.placeholder = mode === 'tree' ? '筛选已加载的文件…' : mode === 'recent' ? '筛选最近修改的文件…' : '搜索项目内文件名或相对路径…';
    el.panel.classList.toggle('fm-wide', el.panel.getBoundingClientRect().width >= 520);
    if (!refreshTimer && o.isOpen()) refreshTimer = w.setTimeout(tick, 4000);
  }
  function renderResults() {
    if (mode === 'tree') return false;
    if (!results) el.tree.append(element('div', 'fm-tree-message', '正在扫描项目文件…'));
    else if (results.error) el.tree.append(element('div', 'fm-tree-message error', results.error));
    else {
      const filtered = results.entries.filter(matchesType);
      const list = sortEntries(filtered);
      list.forEach(entry => el.tree.append(o.makeTreeRow(entry, 0)));
      if (!list.length) el.tree.append(element('div', 'fm-tree-message', '没有匹配文件'));
      o.setStatus(`${list.length} 个结果${results.truncated ? ' · 扫描达到上限，结果不完整' : ''}${results.skipped?.length ? ` · 跳过 ${results.skipped.length} 项（依赖目录、链接或无权限）` : ''}`, results.truncated ? 'warning' : '', { sticky: true });
    }
    return true;
  }
  async function scan() {
    const id = ++scanVersion; const root = state.root; const query = state.query;
    results = null; o.renderTree();
    try {
      const result = await invoke('scan', { root, query, recent: mode === 'recent' });
      if (id !== scanVersion || root !== state.root || !o.isOpen()) return;
      results = result;
    } catch (error) { if (id !== scanVersion) return; results = { error: error.message }; }
    if (id === scanVersion) o.renderTree();
  }
  function searchChanged() {
    if (mode === 'tree') return false;
    ++scanVersion;
    w.clearTimeout(searchTimer); searchTimer = w.setTimeout(() => { void scan(); }, 250); return true;
  }
  async function refresh() {
    if (refreshing || !state.root || !o.isOpen()) return;
    if (mode !== 'tree') { await scan(); return; }
    refreshing = true;
    const generation = state.generation; const root = state.root;
    const scroll = el.tree.scrollTop;
    const focusedPath = d.activeElement?.closest('[data-fm-node]')?.dataset.path;
    try {
      const dirs = [root, ...state.expanded];
      let changed = false;
      // Refresh only directories actually displayed; preserve expansion and scroll.
      for (const directory of dirs) {
        const r = await ipc.invoke('file-manager:list-directory', { root, directory, limit: 3000 });
        if (generation !== state.generation || !o.isOpen()) return;
        const record = { loading: false, entries: r.entries || [], total: r.total || 0, truncated: !!r.truncated, error: r.ok ? '' : r.error || '读取失败' };
        if (JSON.stringify(state.cache.get(directory)) !== JSON.stringify(record)) { state.cache.set(directory, record); changed = true; }
      }
      if (changed) {
        const available = new Set([...state.cache.values()].flatMap(r => (r.entries || []).map(e => e.path)));
        for (const p of selected) if (!available.has(p)) selected.delete(p);
        o.renderTree();
        if (focusedPath) [...el.tree.querySelectorAll('[data-fm-node]')].find(n => n.dataset.path === focusedPath)?.focus({ preventScroll: true });
        el.tree.scrollTop = scroll;
      }
    } catch (error) { report(error); }
    finally { refreshing = false; }
  }
  async function tick() {
    refreshTimer = null;
    if (!o.isOpen()) return;
    if (!menu && !d.querySelector('.fm-dialog')) {
      if (mode === 'tree') await refresh();
      if (jobsOpen) await loadJobs().catch(report);
    }
    if (o.isOpen() && !refreshTimer) refreshTimer = w.setTimeout(tick, 4000);
  }
  function rootChanging(root) {
    ++scanVersion; results = null; selected.clear(); entries.clear(); mode = 'tree';
    if (nodes.mode) nodes.mode.value = mode;
    if (root && root !== history[historyIndex] && !historyMoving) { history = history.slice(0, historyIndex + 1); history.push(root); historyIndex = history.length - 1; }
    hideMenu();
  }
  async function navigate(root, moving = false) {
    historyMoving = moving;
    try { await o.setRoot({ cwd: root, label: path.basename(root) }); } finally { historyMoving = false; }
  }
  function handleClick(event, node) {
    if (event.target.closest('.fm-more')) return true;
    const checkbox = event.target.closest('.fm-select');
    const p = checkbox?.dataset.filePath || node?.dataset.path;
    if (!p) return false;
    if (checkbox || event.ctrlKey || event.metaKey || event.shiftKey) {
      event.preventDefault();
      if (event.shiftKey && anchor) {
        const list = [...el.tree.querySelectorAll('[data-fm-node]')].map(e => e.dataset.path);
        const a = list.indexOf(anchor); const b = list.indexOf(p);
        if (a >= 0 && b >= 0) list.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(v => selected.add(v));
        else selected.add(p);
      } else { if (selected.has(p)) selected.delete(p); else selected.add(p); anchor = p; }
      o.renderTree(); return true;
    }
    selected.clear(); selected.add(p); anchor = p; return false;
  }
  function hideMenu() { if (menu) menu.remove(); menu = null; }
  function dialog(title, fields = [], description = '', submit = '确定') {
    return new Promise(resolve => {
      const box = element('dialog', 'fm-dialog'); const form = element('form'); form.method = 'dialog';
      form.append(element('h3', '', title));
      if (description) form.append(element('p', '', description));
      const inputs = {};
      fields.forEach(field => {
        const label = element('label', '', field.label);
        const input = element(field.options ? 'select' : 'input');
        if (field.options) field.options.forEach(item => { const option = element('option', '', item.label); option.value = item.id; input.append(option); });
        else { input.type = 'text'; input.value = field.value || ''; }
        input.name = field.key; input.required = true; inputs[field.key] = input; label.append(input); form.append(label);
      });
      const actions = element('div', 'fm-dialog-actions');
      const cancel = button('取消', '', () => box.close());
      const yes = element('button', '', submit); yes.type = 'submit'; actions.append(cancel, yes); form.append(actions); box.append(form); d.body.append(box);
      let result = null;
      form.addEventListener('submit', event => { event.preventDefault(); result = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])); box.close(); });
      box.addEventListener('close', () => { box.remove(); resolve(result); }, { once: true });
      box.showModal(); (Object.values(inputs)[0] || yes).focus();
    });
  }
  async function action(name, paths, root) {
    const p = { root, paths };
    if (name.startsWith('copy-')) { await invoke('copy', { ...p, kind: name.slice(5) }); o.setStatus('已复制', 'success'); return; }
    if (name === 'preview') { const node = [...el.tree.querySelectorAll('[data-fm-node]')].find(n => n.dataset.path === paths[0]); if (node) await o.activateEntry(node); return; }
    if (name === 'external' || name === 'reveal') {
      const r = await ipc.invoke(name === 'external' ? 'open-path' : 'show-in-folder', paths[0]);
      if (typeof r === 'string' && r || r?.error) throw new Error(r.error || r); return;
    }
    if (name === 'conversation' || name === 'target-conversation') {
      let target;
      if (name === 'target-conversation') {
        const targets = o.listConversationTargets ? o.listConversationTargets() : [];
        if (!targets.length) throw new Error('没有可添加的已打开会话');
        const answer = await dialog('添加到指定会话', [{ key: 'target', label: '会话', options: targets }], '将绝对路径加入草稿，不自动发送。');
        if (!answer) return; target = answer.target;
      }
      if (!o.addToConversation) throw new Error('当前没有可用输入框');
      await o.addToConversation(paths, target); o.setStatus('文件路径已加入对话草稿，尚未发送', 'success'); return;
    }
    if (name === 'company' || name === 'chatgpt') {
      const answer = await dialog(name === 'company' ? '同步到公司' : '准备 ChatGPT 附件', [],
        `${paths.join('\n')}\n\n${name === 'company' ? '目标：固定公司收件箱。多个文件会打包交付。' : '目标：固定 ChatGPT 中转会话。最多 10 个文件，每个不超过 20 MiB；准备后在 ChatGPT 窗口确认发送。'}`, name === 'company' ? '开始同步' : '准备附件');
      if (!answer) return;
      await invoke('transfer', { ...p, target: name }); jobsOpen = true; nodes.jobs.hidden = false; await loadJobs(); return;
    }
    if (name === 'favorite') {
      for (const file of paths) { const existing = favorites.findIndex(f => f.path === file); if (existing >= 0) favorites.splice(existing, 1); else favorites.push({ path: file, type: entries.get(file)?.type || 'directory' }); }
      remember(); renderFavorites(); return;
    }
    if (name === 'properties') {
      o.setStatus('正在统计大小…', '', { sticky: true });
      const r = await invoke('operation', { ...p, action: 'properties' });
      await dialog('文件属性', [], `${paths.join('\n')}\n${r.files} 个文件 · ${formatSize(r.bytes)}${r.truncated || r.skipped.length ? '\n统计不完整：达到扫描上限或跳过链接/无权限目录' : ''}`); return;
    }
    let extra = {};
    if (name === 'rename' || name === 'mkdir') {
      const answer = await dialog(name === 'rename' ? '重命名' : '新建文件夹', [{ key: 'name', label: '名称', value: name === 'rename' ? path.basename(paths[0]) : '' }]);
      if (!answer) return; extra = answer;
    } else if (name === 'copy' || name === 'move') {
      const answer = await dialog(name === 'copy' ? '复制到' : '移动到', [{ key: 'destination', label: '目标目录（绝对路径）' }], '同名文件不覆盖。跨磁盘移动请使用复制到，再移至回收站。');
      if (!answer) return; extra = answer;
    } else if (name === 'trash') {
      if (!await dialog('移至回收站', [], paths.join('\n'), '移至回收站')) return;
    }
    const r = await ipc.invoke('file-manager:operation', { ...p, action: name, ...extra });
    await refresh();
    if (!r?.ok) throw new Error(r?.error || '操作失败');
    o.setStatus('操作完成', 'success');
  }
  function showMenu(x, y, paths) {
    hideMenu(); if (!paths.length) return;
    const root = state.root; const single = paths.length === 1; const entry = entries.get(paths[0]);
    menu = element('div', 'fm-context-menu'); menu.setAttribute('role', 'menu');
    const add = (id, label, enabled = true) => {
      const b = button(label, '', async () => { hideMenu(); await action(id, paths, root); }); b.dataset.fmAction = id; b.disabled = !enabled; b.setAttribute('role', 'menuitem'); menu.append(b);
    };
    const group = label => menu.append(element('div', 'fm-menu-group', label));
    group(single ? path.basename(paths[0]) : `已选 ${paths.length} 项`);
    add('preview', '在 Hub 中打开', single); add('external', '默认应用打开', single); add('reveal', '在资源管理器中定位', single);
    group('复制');
    add('copy-path', '复制绝对路径'); add('copy-relative', '复制相对路径'); add('copy-name', '复制文件名'); add('copy-files', '复制文件（可粘贴）');
    if (single && entry?.type === 'file') add('copy-content', '复制文本内容');
    if (single && TYPE_GROUPS.image.test(paths[0])) add('copy-image', '复制图片');
    group('对话与交付');
    add('conversation', '添加到当前对话（路径）'); add('target-conversation', '添加到指定会话…');
    add('chatgpt', '发送到 ChatGPT：准备附件…'); add('company', '同步到公司…');
    group('整理');
    add('favorite', '收藏 / 取消收藏'); add('rename', '重命名…', single);
    add('mkdir', '新建文件夹…', single && entry?.type === 'directory');
    add('copy', '复制到…'); add('move', '移动到…'); add('properties', '属性 / 计算大小'); add('trash', '移至回收站…');
    d.body.append(menu); menu.style.left = `${Math.max(4, Math.min(x, w.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, w.innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { hideMenu(); return; }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); const list = [...menu.querySelectorAll('button:not(:disabled)')]; const index = list.indexOf(d.activeElement);
        list[(index + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
      }
    });
  }
  function renderFavorites() {
    nodes.favorites.replaceChildren();
    for (const f of favorites) nodes.favorites.append(button(`★ ${path.basename(f.path)}`, f.path, async () => {
      if (f.type === 'directory') await navigate(f.path);
      else { const r = await ipc.invoke('show-in-folder', f.path); if (r?.error) throw new Error(r.error); }
    }));
    for (const name of ['artifacts', 'output']) nodes.favorites.append(button(name, `打开 ${name}`, () => navigate(path.join(state.root, name))));
    nodes.favorites.append(button('＋固定当前目录', '收藏当前目录', () => { if (!favorites.some(f => f.path === state.root)) favorites.push({ path: state.root, type: 'directory' }); remember(); renderFavorites(); }));
  }
  async function loadJobs() {
    const result = await invoke('jobs'); nodes.jobs.replaceChildren(element('strong', '', '交付记录'));
    const labels = { queued: '等待中', running: '处理中', completed: '已同步并验证', prepared: '附件已准备，请在 ChatGPT 窗口发送', failed: '失败', unknown: '结果待核实，请勿重复发送', cancelled: '已取消', resolved: '已由用户核实处理' };
    if (!result.jobs.length) nodes.jobs.append(element('p', '', '暂无交付记录'));
    for (const job of result.jobs) {
      const row = element('div', 'fm-job'); row.dataset.state = job.state;
      row.append(element('div', '', `${job.target === 'company' ? '公司' : 'ChatGPT'} · ${labels[job.state] || job.state}`), element('small', '', (job.paths || []).map(p => path.basename(p)).join('、')));
      if (job.error) row.append(element('p', 'fm-job-error', typeof job.error === 'string' ? job.error : JSON.stringify(job.error)));
      if (job.result?.skipped?.length) row.append(element('p', '', `已跳过：${job.result.skipped.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('、')}`));
      if (job.state === 'queued') row.append(button('取消', '', async () => { await invoke('cancel-transfer', { id: job.id }); await loadJobs(); }));
      if (job.state === 'failed') row.append(button('重试…', '', () => action(job.target, job.paths, job.root)));
      if (['unknown', 'prepared', 'completed'].includes(job.state)) row.append(button('已在目标端核实…', '', async () => {
        if (!await dialog('确认已核实', [], '请先检查目标端：附件是否已发送、文件是否已收到或残留草稿是否已处理。确认后解除本条记录的重复提交拦截，不会自动重发。', '已核实')) return;
        await invoke('resolve-transfer', { id: job.id }); await loadJobs();
      }));
      for (const [key, label] of [['direct_url', '下载文件'], ['inbox_url', '公司收件箱']]) {
        if (/^https?:\/\//.test(job.result?.[key] || '')) row.append(button(label, job.result[key], async () => { const r = await ipc.invoke('open-external-url', job.result[key]); if (!r?.success) throw new Error('打开链接失败'); }));
      }
      if (job.result?.direct_url) row.append(button('复制下载链接', '', () => { require('electron').clipboard.writeText(job.result.direct_url); }));
      nodes.jobs.append(row);
    }
  }
  function init() {
    try {
      const saved = JSON.parse(w.localStorage.getItem(storageKey) || '{}');
      sort = ['name', 'mtime', 'size'].includes(saved.sort) ? saved.sort : 'name'; descending = !!saved.descending;
      type = saved.type === 'all' || TYPE_GROUPS[saved.type] ? saved.type : 'all';
      favorites = Array.isArray(saved.favorites) ? saved.favorites.filter(f => f && path.isAbsolute(f.path || '')) : [];
      showHidden = saved.showHidden !== false; thumbnails = !!saved.thumbnails;
      if (saved.width && /^\d+px$/.test(saved.width)) { el.panel.style.width = saved.width; el.panel.style.flexBasis = saved.width; }
    } catch (error) { report(new Error('文件管理偏好读取失败，使用默认布局')); }
    const navigation = element('div', 'fm-navigation');
    nodes.back = button('←', '后退', () => { historyIndex--; return navigate(history[historyIndex], true); });
    nodes.forward = button('→', '前进', () => { historyIndex++; return navigate(history[historyIndex], true); });
    nodes.path = element('input'); nodes.path.setAttribute('aria-label', '目录路径');
    nodes.path.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') void navigate(nodes.path.value).catch(report); });
    navigation.append(nodes.back, nodes.forward, button('↑', '上级目录', () => navigate(path.dirname(state.root))), nodes.path);
    el.rootButton.after(navigation);
    const toolbar = element('div', 'fm-toolbar');
    function select(label, values, value, changed) {
      const s = element('select'); s.setAttribute('aria-label', label);
      values.forEach(([id, title]) => { const option = element('option', '', title); option.value = id; s.append(option); }); s.value = value;
      s.addEventListener('change', () => { Promise.resolve(changed(s.value)).catch(report); }); toolbar.append(s); return s;
    }
    nodes.mode = select('浏览范围', [['tree', '目录树'], ['recent', '最近修改'], ['search', '项目搜索']], mode, async value => {
      mode = value; selected.clear();
      if (mode === 'recent') { sort = 'mtime'; descending = true; nodes.sort.value = sort; }
      if (mode !== 'tree') await scan(); else o.renderTree();
    });
    nodes.sort = select('排序', [['name', '名称'], ['mtime', '修改时间'], ['size', '大小']], sort, value => { sort = value; descending = value !== 'name'; remember(); o.renderTree(); });
    toolbar.append(button('↕', '切换升序 / 降序', () => { descending = !descending; remember(); o.renderTree(); }));
    select('文件类型', [['all', '全部类型'], ['image', '图片'], ['document', '文档'], ['slide', '演示文稿'], ['code', '代码']], type, value => { type = value; remember(); o.renderTree(); });
    toolbar.append(button('隐藏项', '显示 / 隐藏点开头的文件', () => { showHidden = !showHidden; remember(); o.renderTree(); }), button('缩略图', '切换图片缩略图', () => { thumbnails = !thumbnails; remember(); o.renderTree(); }));
    el.filter.parentElement.after(toolbar);
    nodes.favorites = element('div', 'fm-favorites'); toolbar.after(nodes.favorites); renderFavorites();
    const selection = element('div', 'fm-selection'); nodes.selection = element('span');
    nodes.batch = button('操作 ▾', '批量操作', () => { const rect = nodes.batch.getBoundingClientRect(); showMenu(rect.left, rect.bottom, [...selected]); });
    selection.append(nodes.selection, nodes.batch, button('新建文件夹', '', () => action('mkdir', [state.root], state.root)), button('交付记录', '', async () => { jobsOpen = !jobsOpen; nodes.jobs.hidden = !jobsOpen; if (jobsOpen) await loadJobs(); }));
    el.tree.before(selection); el.tree.setAttribute('aria-multiselectable', 'true');
    const columns = element('div', 'fm-column-head');
    for (const [id, label] of [['name', '名称'], ['size', '大小'], ['mtime', '修改时间']]) columns.append(button(label, `按${label}排序`, () => {
      descending = sort === id ? !descending : id !== 'name'; sort = id; nodes.sort.value = id; remember(); o.renderTree();
    }));
    el.tree.before(columns);
    nodes.jobs = element('div', 'fm-jobs'); nodes.jobs.hidden = true; el.tree.after(nodes.jobs);
    if (w.ResizeObserver) new w.ResizeObserver(() => el.panel.classList.toggle('fm-wide', el.panel.getBoundingClientRect().width >= 520)).observe(el.panel);
    const footer = el.panel.querySelector('.file-manager-footer'); if (footer) footer.textContent = '文件路径可拖入对话 · 自动刷新保留位置';
    el.tree.addEventListener('contextmenu', event => {
      const node = event.target.closest('[data-fm-node]'); if (!node) return;
      event.preventDefault(); event.stopPropagation();
      if (!selected.has(node.dataset.path)) { selected.clear(); selected.add(node.dataset.path); o.renderTree(); }
      showMenu(event.clientX, event.clientY, [...selected]);
    });
    d.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) hideMenu(); });
    el.panel.addEventListener('keydown', event => {
      if (event.target.matches('input,select,textarea')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); el.tree.querySelectorAll('[data-fm-node]').forEach(n => selected.add(n.dataset.path)); o.renderTree(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selected.size) { event.preventDefault(); event.stopPropagation(); void action('copy-files', [...selected], state.root).catch(report); }
      if (event.key === 'F2' && selected.size === 1) { event.preventDefault(); void action('rename', [...selected], state.root).catch(report); }
    });
    const resize = element('div', 'fm-resize-handle'); resize.setAttribute('role', 'separator'); resize.setAttribute('aria-label', '调整文件面板宽度'); el.panel.prepend(resize);
    resize.addEventListener('pointerdown', event => {
      event.preventDefault(); resize.setPointerCapture(event.pointerId);
      const start = event.clientX; const width = el.panel.getBoundingClientRect().width;
      const move = e => { const value = Math.max(292, Math.min(w.innerWidth - 40, 900, width + start - e.clientX)); el.panel.style.width = `${value}px`; el.panel.style.flexBasis = `${value}px`; el.panel.classList.toggle('fm-wide', value >= 520); };
      const end = () => { resize.removeEventListener('pointermove', move); remember(); o.onLayoutChange(); };
      resize.addEventListener('pointermove', move); resize.addEventListener('pointerup', end, { once: true });
    });
  }
  function close() { hideMenu(); ++scanVersion; w.clearTimeout(refreshTimer); w.clearTimeout(searchTimer); refreshTimer = null; }
  return { init, close, rootChanging, refresh, decorateRow, sortEntries, matchesType, afterRender, renderResults, searchChanged, handleClick };
}

module.exports = { createFileManagerFeatures, formatSize };
