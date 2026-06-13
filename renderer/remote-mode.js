'use strict';

// 远程 Hub 模式 UI（公司电脑侧瘦客户端视图）。
// 与 main process 的 mobile/remote-client 通过 IPC 通信：
//   invoke: remote-get-status / remote-pair / remote-refresh / remote-new-session /
//           remote-send-input / remote-send-command / remote-set-target-hub / hub-update-check / hub-update-apply
//   事件:   'remote-event' { kind, payload }（status / hub-list / session-list / turn /
//           hub-snapshot / hub-delta / ...）
//
// 左侧列表两个分组：
//   🖥 桌面会话 —— 家里 Hub 侧栏的真实 session/meeting（HUB_SNAPSHOT 卡片），
//                 发消息走 HUB_COMMAND 定向投递，回复走 HUB_DELTA 增量
//   📱 远程会话 —— 移动通道自有会话（与手机 PWA 共用），发消息走 PWA_INPUT
//
// 视图切换：打开时隐藏 terminal-panel + meeting-room-panel；点击左侧本地会话自动退出。

if (typeof document !== 'undefined') {
  (() => {
    const { ipcRenderer } = require('electron');

    const panel = document.getElementById('remote-panel');
    const btnRemote = document.getElementById('btn-remote-hub');
    const statusDot = document.getElementById('remote-status-dot');
    if (!panel || !btnRemote) return;

    // ---------- 状态 ----------
    let visible = false;
    let status = { configured: false, state: 'disconnected', connState: null, hubs: [] };
    let mobileSessions = [];
    let desktopCards = [];
    // selected: { type: 'desktop'|'mobile', id, targetType, targetId, title }
    let selected = null;
    const turnsByKey = new Map(); // 'd:<cardId>' | 'm:<sessionId>' -> [{role, content, ts, model, pending?}]
    const seenSeq = new Set();      // mobile turn 去重（重连回灌）
    const seenDeltaSeq = new Set(); // desktop delta 去重

    const keyOf = (sel) => (sel ? `${sel.type === 'desktop' ? 'd' : 'm'}:${sel.id}` : null);

    // ---------- DOM 构建 ----------
    panel.innerHTML = `
      <div class="rp-setup" id="rp-setup" style="display:none">
        <div class="rp-setup-card">
          <div class="rp-setup-title">🌐 远程 Hub 模式</div>
          <div class="rp-setup-sub">本 Hub 作为瘦客户端，经 VPS 中继操作另一台 Hub 上的 AI 会话。<br>在家里 Hub 所在机器上查看配对 PIN（设置了固定 PIN 则直接输入）。</div>
          <label class="rp-field"><span>网关地址</span><input id="rp-gateway" type="text" value="https://lthub.xyz:8443" spellcheck="false"></label>
          <label class="rp-field"><span>直连 IP（可选，绕过 CDN 更稳）</span><input id="rp-direct-ip" type="text" value="138.128.192.245" spellcheck="false"></label>
          <label class="rp-field"><span>设备名</span><input id="rp-device-name" type="text" value="company-hub" spellcheck="false"></label>
          <label class="rp-field"><span>配对 PIN（6 位数字）</span><input id="rp-pin" type="text" maxlength="6" inputmode="numeric" spellcheck="false"></label>
          <button class="rp-pair-btn" id="rp-pair-btn">配对并连接</button>
          <div class="rp-setup-msg" id="rp-setup-msg"></div>
        </div>
      </div>
      <div class="rp-main" id="rp-main" style="display:none">
        <div class="rp-header">
          <span class="rp-conn" id="rp-conn"><span class="rp-conn-dot"></span><span class="rp-conn-text">连接中…</span></span>
          <select class="rp-hub-select" id="rp-hub-select" title="目标 Hub"></select>
          <button class="rp-hdr-btn" id="rp-refresh" title="刷新会话与桌面卡片">↻</button>
          <button class="rp-hdr-btn rp-new-btn" id="rp-new-session" title="在远端 Hub 新建独立远程会话">＋ 新建远程会话</button>
          <span class="rp-hdr-spacer"></span>
          <span class="rp-update-info" id="rp-update-info"></span>
          <button class="rp-hdr-btn" id="rp-update" title="从 VPS 检查并应用 Hub 更新（自动重启）">⟳ 检查更新</button>
          <button class="rp-hdr-btn" id="rp-repair" title="重新配对">⚙</button>
        </div>
        <div class="rp-body">
          <div class="rp-sessions" id="rp-sessions"></div>
          <div class="rp-chat">
            <div class="rp-chat-toolbar" id="rp-chat-toolbar" style="display:none">
              <span class="rp-ct-title" id="rp-ct-title"></span>
              <button class="rp-hdr-btn" id="rp-mirror-toggle" title="终端镜像：像坐在家里电脑前一样直接操作这个会话的终端">⌨ 终端镜像</button>
            </div>
            <div class="rp-timeline" id="rp-timeline"><div class="rp-empty">选择左侧会话开始</div></div>
            <div class="rp-mirror" id="rp-mirror" style="display:none"></div>
            <div class="rp-input-row" id="rp-input-row">
              <textarea class="rp-input" id="rp-input" rows="2" placeholder="发送到远端 Hub…（Enter 发送，Shift+Enter 换行）"></textarea>
              <button class="rp-send-btn" id="rp-send" title="发送">▶</button>
            </div>
          </div>
        </div>
      </div>`;

    const $ = (id) => document.getElementById(id);

    // ---------- 终端镜像（Phase 2）----------
    // attach 语义（类 tmux）：打开镜像 = 订阅家里该会话的 PTY 字节流 + 远端 PTY
    // 跟随本端 xterm 尺寸；按键直通。关闭即退订，家里端不受影响继续跑。
    let mirror = { term: null, sessionId: null, open: false };

    function openMirror() {
      if (!selected || selected.type !== 'desktop' || selected.targetType !== 'session') return;
      closeMirror();
      const { Terminal } = require('@xterm/xterm');
      const { FitAddon } = require('@xterm/addon-fit');
      $('rp-timeline').style.display = 'none';
      $('rp-input-row').style.display = 'none';
      const host = $('rp-mirror');
      host.style.display = 'block';
      host.innerHTML = '';
      const term = new Terminal({ fontSize: 13, scrollback: 5000, fontFamily: 'Consolas, "Courier New", monospace' });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      try { fit.fit(); } catch {}
      mirror = { term, sessionId: selected.targetId, open: true };
      term.onData((d) => {
        if (!mirror.open) return;
        ipcRenderer.invoke('remote-pty-input', {
          sessionId: mirror.sessionId,
          dataB64: Buffer.from(d, 'utf8').toString('base64'),
        }).catch(() => {});
      });
      // E2E/调试句柄
      window.__rpTerm = term;
      window.__rpTermSend = (s) => ipcRenderer.invoke('remote-pty-input', {
        sessionId: mirror.sessionId,
        dataB64: Buffer.from(s, 'utf8').toString('base64'),
      });
      ipcRenderer.invoke('remote-pty-subscribe', { sessionId: mirror.sessionId }).catch(() => {});
      ipcRenderer.invoke('remote-pty-resize', { sessionId: mirror.sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
      const tg = $('rp-mirror-toggle');
      if (tg) tg.textContent = '📇 卡片视图';
      term.focus();
    }

    function closeMirror() {
      if (mirror.open) {
        ipcRenderer.invoke('remote-pty-unsubscribe', { sessionId: mirror.sessionId }).catch(() => {});
        try { mirror.term.dispose(); } catch {}
      }
      mirror = { term: null, sessionId: null, open: false };
      const host = $('rp-mirror');
      if (host) { host.style.display = 'none'; host.innerHTML = ''; }
      const tl = $('rp-timeline');
      if (tl) tl.style.display = '';
      const ir = $('rp-input-row');
      if (ir) ir.style.display = '';
      const tg = $('rp-mirror-toggle');
      if (tg) tg.textContent = '⌨ 终端镜像';
      try { delete window.__rpTerm; delete window.__rpTermSend; } catch {}
    }

    // ---------- 视图切换 ----------
    function openPanel() {
      visible = true;
      panel.style.display = 'flex';
      const tp = document.getElementById('terminal-panel');
      const mr = document.getElementById('meeting-room-panel');
      if (tp) tp.style.display = 'none';
      if (mr) mr.style.display = 'none';
      render();
      ipcRenderer.invoke('remote-refresh').catch(() => {});
    }

    function closePanel() {
      if (!visible) return;
      closeMirror();
      visible = false;
      panel.style.display = 'none';
      const tp = document.getElementById('terminal-panel');
      if (tp) tp.style.display = '';
    }

    btnRemote.addEventListener('click', () => (visible ? closePanel() : openPanel()));
    const sessionList = document.getElementById('session-list');
    if (sessionList) sessionList.addEventListener('click', () => closePanel(), true);

    // ---------- 渲染 ----------
    function render() {
      if (!visible) {
        renderStatusDot();
        return;
      }
      $('rp-setup').style.display = status.configured ? 'none' : 'flex';
      $('rp-main').style.display = status.configured ? 'flex' : 'none';
      if (status.configured) {
        renderConn();
        renderHubSelect();
        renderLists();
        renderToolbar();
        if (!mirror.open) renderTimeline();
      }
      renderStatusDot();
    }

    function renderToolbar() {
      const bar = $('rp-chat-toolbar');
      if (!bar) return;
      const mirrorable = selected && selected.type === 'desktop' && selected.targetType === 'session';
      bar.style.display = mirrorable ? 'flex' : 'none';
      if (mirrorable) $('rp-ct-title').textContent = selected.title || '';
    }

    function renderStatusDot() {
      if (!statusDot) return;
      const ok = status.configured && status.state === 'connected' && status.connState === 'ok';
      statusDot.className = 'remote-status-dot' + (ok ? ' on' : (status.configured ? ' warn' : ''));
    }

    function renderConn() {
      const el = $('rp-conn');
      const dot = el.querySelector('.rp-conn-dot');
      const text = el.querySelector('.rp-conn-text');
      if (status.state !== 'connected') {
        dot.className = 'rp-conn-dot off';
        text.textContent = status.state === 'connecting' ? '连接网关中…' : '未连接';
      } else if (status.connState === 'ok') {
        dot.className = 'rp-conn-dot on';
        text.textContent = '链路正常';
      } else if (status.connState === 'hub-off') {
        dot.className = 'rp-conn-dot warn';
        text.textContent = '远端 Hub 离线';
      } else {
        dot.className = 'rp-conn-dot warn';
        text.textContent = status.connState || '状态未知';
      }
    }

    function renderHubSelect() {
      const sel = $('rp-hub-select');
      const hubs = status.hubs || [];
      sel.innerHTML = '';
      for (const h of hubs) {
        const opt = document.createElement('option');
        opt.value = h.hubId;
        opt.textContent = `${h.hostname || '?'} · ${h.friendlyName || h.pid}`;
        if (h.hubId === status.targetHubId) opt.selected = true;
        sel.appendChild(opt);
      }
      if (!hubs.length) {
        const opt = document.createElement('option');
        opt.textContent = '（无在线 Hub）';
        sel.appendChild(opt);
      }
    }

    function makeCard(item, type) {
      const card = document.createElement('div');
      const isActive = selected && selected.type === type && selected.id === item.id;
      card.className = 'rp-session-card' + (isActive ? ' active' : '');
      card.innerHTML = `<div class="rp-sc-title"></div><div class="rp-sc-meta"></div><div class="rp-sc-preview"></div>`;
      card.querySelector('.rp-sc-title').textContent = item.title || String(item.id).slice(0, 12);
      let meta;
      if (type === 'desktop') {
        meta = item.targetType === 'meeting'
          ? `群聊 · ${item.subSessionCount || 0} 成员`
          : (item.kind || 'session');
      } else {
        meta = `${item.kind || 'claude'}${item.pinned ? ' · 📌' : ''}`;
      }
      card.querySelector('.rp-sc-meta').textContent = meta;
      const pv = card.querySelector('.rp-sc-preview');
      if (type === 'desktop' && item.preview) pv.textContent = item.preview.slice(0, 60);
      else pv.remove();
      card.addEventListener('click', () => {
        closeMirror();
        selected = type === 'desktop'
          ? { type, id: item.id, targetType: item.targetType, targetId: item.targetId, title: item.title }
          : { type, id: item.id, targetType: 'mobile', targetId: item.id, title: item.title };
        render();
      });
      return card;
    }

    function renderLists() {
      const box = $('rp-sessions');
      box.innerHTML = '';

      const dLabel = document.createElement('div');
      dLabel.className = 'rp-group-label';
      dLabel.textContent = `🖥 桌面会话（家里 Hub 实况 ${desktopCards.length}）`;
      box.appendChild(dLabel);
      if (!desktopCards.length) {
        const e = document.createElement('div');
        e.className = 'rp-group-empty';
        e.textContent = '暂无卡片，点 ↻ 刷新';
        box.appendChild(e);
      }
      for (const c of desktopCards) box.appendChild(makeCard(c, 'desktop'));

      const mLabel = document.createElement('div');
      mLabel.className = 'rp-group-label';
      mLabel.textContent = `📱 远程会话（独立于桌面 ${mobileSessions.length}）`;
      box.appendChild(mLabel);
      for (const s of mobileSessions) box.appendChild(makeCard(s, 'mobile'));
    }

    function renderTimeline() {
      const tl = $('rp-timeline');
      tl.innerHTML = '';
      if (!selected) {
        tl.innerHTML = '<div class="rp-empty">选择左侧会话开始<br>🖥 桌面会话 = 直接操作家里 Hub 的现有会话<br>📱 远程会话 = 给公司用的独立会话</div>';
        return;
      }
      const turns = turnsByKey.get(keyOf(selected)) || [];
      if (!turns.length) {
        const hint = selected.type === 'desktop'
          ? '已连到家里 Hub 的这个会话。发消息会直接进入它（家里屏幕同步可见）；它的新回复会实时出现在这里。'
          : '还没有消息，发一句试试';
        tl.innerHTML = `<div class="rp-empty">${hint}</div>`;
        return;
      }
      for (const t of turns) {
        const item = document.createElement('div');
        item.className = `rp-turn ${t.role === 'user' ? 'user' : 'assistant'}${t.pending ? ' pending' : ''}`;
        const meta = document.createElement('div');
        meta.className = 'rp-turn-meta';
        const time = t.ts ? new Date(t.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
        meta.textContent = t.role === 'user' ? `我 · ${time}` : `${t.model || 'assistant'} · ${time}`;
        const body = document.createElement('div');
        body.className = 'rp-turn-body';
        body.textContent = t.content || '';
        item.appendChild(meta);
        item.appendChild(body);
        tl.appendChild(item);
      }
      tl.scrollTop = tl.scrollHeight;
    }

    function appendTurn(key, turn) {
      if (!turnsByKey.has(key)) turnsByKey.set(key, []);
      turnsByKey.get(key).push(turn);
      if (visible && selected && keyOf(selected) === key) renderTimeline();
    }

    // ---------- 行为 ----------
    $('rp-pair-btn').addEventListener('click', async () => {
      const msgEl = $('rp-setup-msg');
      msgEl.textContent = '配对中…';
      msgEl.className = 'rp-setup-msg';
      const result = await ipcRenderer.invoke('remote-pair', {
        gatewayUrl: $('rp-gateway').value.trim(),
        directIp: $('rp-direct-ip').value.trim(),
        deviceName: $('rp-device-name').value.trim() || 'company-hub',
        pin: $('rp-pin').value.trim(),
      });
      if (result.ok) {
        msgEl.textContent = '配对成功，连接中…';
        msgEl.className = 'rp-setup-msg ok';
      } else {
        msgEl.textContent = `配对失败：${result.error}`;
        msgEl.className = 'rp-setup-msg err';
      }
    });

    $('rp-refresh').addEventListener('click', () => ipcRenderer.invoke('remote-refresh').catch(() => {}));

    $('rp-update').addEventListener('click', async () => {
      const btn = $('rp-update');
      const info = $('rp-update-info');
      btn.disabled = true;
      info.textContent = '检查中…';
      try {
        const r = await ipcRenderer.invoke('hub-update-check');
        if (!r.ok) { info.textContent = `检查失败: ${r.error}`; return; }
        if (!r.updateAvailable) { info.textContent = `已是最新 v${r.current}`; return; }
        if (r.needsFullPackage) { info.textContent = `v${r.latest} 含依赖变更，需重新下载完整包`; return; }
        if (!window.confirm(`发现新版本 v${r.latest}（当前 v${r.current}）。\n${r.notes || ''}\n\n现在更新并自动重启 Hub？`)) {
          info.textContent = `v${r.latest} 可用（未更新）`;
          return;
        }
        info.textContent = `下载并应用 v${r.latest} 中…`;
        const a = await ipcRenderer.invoke('hub-update-apply');
        info.textContent = a.ok ? '更新完成，重启中…' : `更新失败: ${a.error}`;
      } catch (e) {
        info.textContent = `更新异常: ${e.message}`;
      } finally {
        btn.disabled = false;
      }
    });

    $('rp-repair').addEventListener('click', () => {
      closeMirror();
      status = { ...status, configured: false };
      render();
    });

    $('rp-mirror-toggle').addEventListener('click', () => {
      if (mirror.open) closeMirror();
      else openMirror();
    });

    $('rp-hub-select').addEventListener('change', (e) => {
      closeMirror();
      desktopCards = [];
      selected = null;
      ipcRenderer.invoke('remote-set-target-hub', { hubId: e.target.value })
        .then(() => ipcRenderer.invoke('remote-refresh'))
        .catch(() => {});
    });

    $('rp-new-session').addEventListener('click', async () => {
      const btn = $('rp-new-session');
      btn.disabled = true;
      btn.textContent = '创建中…';
      try {
        const result = await ipcRenderer.invoke('remote-new-session', { kind: 'claude', title: `远程 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` });
        if (result.ok && result.session) {
          selected = { type: 'mobile', id: result.session.id, targetType: 'mobile', targetId: result.session.id, title: result.session.title };
        }
        ipcRenderer.invoke('remote-refresh').catch(() => {});
      } finally {
        btn.disabled = false;
        btn.textContent = '＋ 新建远程会话';
        render();
      }
    });

    async function sendCurrent() {
      const input = $('rp-input');
      const content = input.value.trim();
      if (!content || !selected) return;
      input.value = '';
      const key = keyOf(selected);
      appendTurn(key, { role: 'user', content, ts: Date.now() });
      let result;
      if (selected.type === 'desktop') {
        result = await ipcRenderer.invoke('remote-send-command', {
          targetType: selected.targetType,
          targetId: selected.targetId,
          content,
        });
      } else {
        result = await ipcRenderer.invoke('remote-send-input', { sessionId: selected.id, content });
      }
      if (!result.ok) {
        appendTurn(key, { role: 'assistant', content: `⚠ 发送失败：${result.error || '未连接'}`, ts: Date.now() });
      }
    }
    $('rp-send').addEventListener('click', sendCurrent);
    $('rp-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrent();
      }
    });

    // ---------- main process 事件 ----------
    ipcRenderer.on('remote-event', (_e, { kind, payload }) => {
      switch (kind) {
        case 'status':
          status = payload;
          render();
          return;
        case 'session-list':
          mobileSessions = payload;
          if (selected && selected.type === 'mobile' && !mobileSessions.some((s) => s.id === selected.id)) selected = null;
          if (visible) render();
          return;
        case 'hub-snapshot': {
          if (!payload) return;
          desktopCards = Array.isArray(payload.cards) ? payload.cards : [];
          if (selected && selected.type === 'desktop' && !desktopCards.some((c) => c.id === selected.id)) selected = null;
          if (visible) render();
          return;
        }
        case 'hub-delta': {
          const d = payload;
          if (typeof d.seq === 'number') {
            const k = `${d.seq}:${d.ts || ''}`;
            if (seenDeltaSeq.has(k)) return;
            seenDeltaSeq.add(k);
          }
          if (d.card && d.card.id) {
            const idx = desktopCards.findIndex((c) => c.id === d.card.id);
            if (idx >= 0) desktopCards[idx] = d.card;
            else desktopCards.unshift(d.card);
          }
          if (d.op === 'turn' && d.turn && d.turn.sessionId) {
            appendTurn(`d:${d.turn.sessionId}`, {
              role: d.turn.role || 'assistant',
              content: d.turn.content,
              ts: d.turn.ts,
              model: d.turn.model,
            });
          }
          if (visible) renderLists();
          return;
        }
        case 'turn': {
          const t = payload;
          if (typeof t.seq === 'number') {
            if (seenSeq.has(t.seq)) return;
            seenSeq.add(t.seq);
          }
          appendTurn(`m:${t.sessionId}`, { role: t.role || 'assistant', content: t.content, ts: t.ts, model: t.model });
          return;
        }
        case 'pty-snapshot':
        case 'pty-data': {
          const m = payload;
          if (mirror.open && mirror.term && m.sessionId === mirror.sessionId && m.dataB64) {
            mirror.term.write(Buffer.from(m.dataB64, 'base64').toString('utf8'));
          }
          return;
        }
        case 'pty-ack': {
          const a = payload;
          if (!a.ok) console.warn('[remote-mirror] pty-ack failed:', a.action, a.error);
          return;
        }
        case 'session-created':
          ipcRenderer.invoke('remote-refresh').catch(() => {});
          return;
        case 'auth-failed':
          status = { ...status, configured: false };
          if (visible) {
            render();
            const msgEl = $('rp-setup-msg');
            if (msgEl) { msgEl.textContent = '设备凭证失效，请重新配对'; msgEl.className = 'rp-setup-msg err'; }
          }
          return;
        default:
          return;
      }
    });

    // ---------- 初始化 ----------
    ipcRenderer.invoke('remote-get-status').then((s) => {
      status = s;
      render();
    }).catch(() => {});
  })();
}
