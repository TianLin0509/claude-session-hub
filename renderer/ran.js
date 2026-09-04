/* SuperRAN 工作台面板 —— Hub 第五主区视图，与 terminal / mr / chuxin / study 平级互斥。
 *
 * 内容是本机生成的静态 HTML（C:\VibeData\Artifacts\Reports\SuperRAN\tasks.html），
 * 由 SuperRAN 仓库的 scripts/superran_tasks.py 产出。这里只负责：
 *   1. 用 iframe 把它显示在主区
 *   2. 打开面板时后台重跑一次生成脚本，跑完自动刷新 iframe
 *
 * 刻意不做的事：不解析任务数据、不复制业务逻辑。数据口径只有 SuperRAN 那一份，
 * Hub 这边多写一份迟早会和它对不上。
 */
(function () {
  'use strict';

  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');

  const REPO = 'C:\\Vibe\\Wireless\\SuperRAN';
  const SCRIPT = path.join(REPO, 'scripts', 'superran_tasks.py');
  const PAGE = 'C:\\VibeData\\Artifacts\\Reports\\SuperRAN\\tasks.html';

  const state = { opened: false, building: false };
  let root = null;
  let frame = null;
  let statusEl = null;

  function buildSkeleton() {
    if (root) return;
    root = document.getElementById('ran-panel');
    if (!root) return;
    root.style.cssText =
      'display:none;flex-direction:column;flex:1;min-width:0;overflow:hidden';
    root.innerHTML =
      '<div class="ran-bar" style="display:flex;align-items:center;gap:12px;' +
      'padding:8px 14px;border-bottom:1px solid var(--border,#d2d2d7);flex:none">' +
      '<b style="font-size:13px">SuperRAN 工作台</b>' +
      '<span id="ran-status" style="font-size:12px;opacity:.65"></span>' +
      '<span style="flex:1"></span>' +
      '<button id="ran-refresh" class="btn-small" style="font-size:12px;' +
      'padding:4px 12px;cursor:pointer">刷新</button>' +
      '</div>' +
      '<iframe id="ran-frame" style="flex:1;width:100%;border:0;background:#fafafa">' +
      '</iframe>';
    frame = root.querySelector('#ran-frame');
    statusEl = root.querySelector('#ran-status');
    root.querySelector('#ran-refresh').addEventListener('click', () => rebuild(true));
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  function loadPage() {
    if (!frame) return;
    if (!fs.existsSync(PAGE)) {
      setStatus('还没生成过，正在生成…');
      return;
    }
    // 加时间戳绕开 iframe 缓存，否则重跑脚本后看到的还是旧页面
    frame.src = 'file:///' + PAGE.replace(/\\/g, '/') + '?t=' + Date.now();
  }

  function rebuild(manual) {
    if (state.building) return;
    if (!fs.existsSync(SCRIPT)) {
      setStatus('找不到 ' + SCRIPT + '（SuperRAN 仓库位置变了？）');
      return;
    }
    state.building = true;
    setStatus(manual ? '正在刷新…' : '正在取最新状态…');

    // --no-open：数据在 iframe 里看，不要再弹一个外部浏览器
    const p = spawn('python', [SCRIPT, '--no-open'], {
      cwd: REPO,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
      windowsHide: true,
    });
    let err = '';
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', (e) => {
      state.building = false;
      setStatus('生成失败：' + e.message);
    });
    p.on('close', (code) => {
      state.building = false;
      if (code === 0) {
        setStatus('更新于 ' + new Date().toLocaleTimeString('zh-CN'));
        loadPage();
      } else {
        setStatus('生成失败（退出码 ' + code + '）' + (err ? '：' + err.slice(0, 120) : ''));
        loadPage();          // 仍然把上一次的结果显示出来，总比空白强
      }
    });
  }

  function setPanelVisible(visible) {
    buildSkeleton();
    if (!root) return;
    state.opened = visible;

    const tp = document.getElementById('terminal-panel');
    const mrp = document.getElementById('meeting-room-panel');
    const homeButton = document.getElementById('btn-home');
    const ranButton = document.getElementById('btn-ran');

    root.style.display = visible ? 'flex' : 'none';
    if (ranButton) {
      ranButton.classList.toggle('active', visible);
      if (visible) ranButton.setAttribute('aria-current', 'page');
      else ranButton.removeAttribute('aria-current');
    }
    if (visible) {
      if (homeButton) {
        homeButton.classList.remove('active');
        homeButton.removeAttribute('aria-current');
      }
      if (window.__chuxinHide) window.__chuxinHide();
      if (window.__studyHide) window.__studyHide();
      if (tp) tp.style.display = 'none';
      if (mrp) mrp.style.display = 'none';
      loadPage();            // 先把上次的结果显示出来，别让人对着空白等
      rebuild(false);        // 再后台取最新
    }
  }

  window.__ranHide = function () { if (state.opened) setPanelVisible(false); };
  window.__ranShow = function () { setPanelVisible(true); };

  function bindEntry() {
    document.querySelectorAll('#btn-ran, [data-ran-entry]').forEach((b) => {
      b.addEventListener('click', () => setPanelVisible(true));
    });
  }

  function init() { buildSkeleton(); bindEntry(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
