'use strict';
// 左侧栏分组入口（2026-10-24）真实隔离 Electron 验收：
//   规则 / 资源 / 账号 / 回顾 和 投研 / 学习 / 写作 / 无线 各收成一个入口，
//   悬停向右展开四个成员，选中谁进谁；成员按钮的 id 与原有接线不变。
// 只用隔离数据目录 + 独立 CDP 端口，不碰生产 Hub。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, waitFor, key } = require('./helpers/usage-refresh-fixture');

const stamp = Date.now();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rail-groups-'));
const dataDir = path.join(temp, 'data');
const out = path.resolve(__dirname, '../artifacts/20261024-rail-group-nav-dsh1', String(stamp));
fs.mkdirSync(out, { recursive: true });

const result = {
  passed: false,
  checks: [],
  out,
  boundary: '真实隔离 Electron + CDP；无生产数据、无外部模型调用',
};
let hub;
let c;
const check = (ok, label) => {
  assert(ok, label);
  result.checks.push(label);
  console.log('PASS ' + label);
};
const shot = async (name, clip) => {
  const args = { format: 'png' };
  if (clip) args.clip = { ...clip, scale: 2 };
  const img = await c.send('Page.captureScreenshot', args);
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(img.data, 'base64'));
};
// 把鼠标挪到某个元素中心（触发悬停态），返回该点。
const hover = async selector => {
  const point = await c.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('missing ' + ${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  return point;
};
const press = async point => {
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
};
const park = () => c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 400 });

(async () => {
  try {
    hub = await launchIsolatedHub({ dataDir, port: await getFreePort(), label: 'rail-groups' });
    c = await connectFirstPage(hub);
    await c.send('Page.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(c, `document.querySelectorAll('#scene-rail .rail-group').length===2 && document.readyState==='complete'`);

    // 1. rail 上只剩一级入口；组成员平时不占位。
    const inventory = await c.eval(`(() => {
      const rail = document.getElementById('scene-rail');
      const railBox = rail.getBoundingClientRect();
      const entries = [...rail.querySelector('.rail-navigation').children]
        .filter(e => e.getClientRects().length)
        .map(e => (e.classList.contains('rail-group') ? e.querySelector('.rail-group-trigger').id : e.id));
      const members = [...document.querySelectorAll('#scene-rail .rail-group-menu .btn-shell-nav')]
        .map(e => ({ id: e.id, painted: e.getClientRects().length > 0 }));
      return { railWidth: railBox.width, entries, members, label: [...rail.querySelectorAll('.rail-navigation > .rail-group > .rail-group-trigger .btn-label')].map(e => e.textContent) };
    })()`);
    check(inventory.railWidth === 44, 'rail 仍是 44px（分组不改导航宽度）');
    result.entries = inventory.entries;
    check(JSON.stringify(inventory.entries) === JSON.stringify(['btn-home', 'btn-rail-group-rules', 'btn-assistant', 'btn-rail-group-applications', 'btn-ran', 'btn-cloud']),
      'rail 一级入口收敛为 6 个：主页 / 规则组 / 助理 / 应用组 / 开发 / 云端');
    check(JSON.stringify(inventory.label) === JSON.stringify(['规则', '投研']), '两个分组入口显示 规则 / 投研');
    check(inventory.members.length === 9 && inventory.members.every(m => !m.painted), '组成员（含隐藏的记忆）默认全部不渲染');
    await shot('rail-collapsed', { x: 0, y: 0, width: 320, height: 900 });

    // 2. 悬停规则组：向右展开，成员顺序与可访问名不变。
    const rulesTrigger = await hover('#btn-rail-group-rules');
    await waitFor(c, `!document.getElementById('rail-group-rules-menu').hidden`);
    const dock = await c.eval(`(() => {
      const rail = document.getElementById('scene-rail').getBoundingClientRect();
      const menu = document.getElementById('rail-group-rules-menu');
      const box = menu.getBoundingClientRect();
      const items = [...menu.querySelectorAll('.btn-shell-nav')].filter(e => e.getClientRects().length).map(e => {
        const b = e.getBoundingClientRect();
        const icon = e.querySelector('.btn-icon').getBoundingClientRect();
        const label = e.querySelector('.btn-label').getBoundingClientRect();
        return { id: e.id, label: e.querySelector('.btn-label').textContent, left: b.left, right: b.right,
          labelBelow: label.top >= icon.bottom - 1, fits: label.left >= b.left - 1 && label.right <= b.right + 1 };
      });
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height,
        railRight: rail.right, railTop: rail.top, railBottom: rail.bottom,
        expanded: document.getElementById('btn-rail-group-rules').getAttribute('aria-expanded'),
        viewport: { w: innerWidth, h: innerHeight }, footerTop: document.getElementById('hub-system-footer').getBoundingClientRect().top, items };
    })()`);
    result.dock = dock;
    check(dock.left >= dock.railRight && dock.left - dock.railRight <= 8, '展开条从 rail 右缘外侧滑出（水平向右）');
    check(dock.top >= 0 && dock.bottom <= dock.footerTop, '展开条完整落在可视区内（不被底栏截断）');
    check(dock.height >= 50 && dock.height <= 90 && dock.right - dock.left >= 200, '展开条是一条横向 dock（约 4×54px 宽）');
    check(JSON.stringify(dock.items.map(i => i.id)) === JSON.stringify(['btn-rules', 'btn-rail-capabilities', 'btn-rail-accounts', 'btn-rail-memo']), '规则组成员顺序：规则 / 资源 / 账号 / 回顾');
    check(JSON.stringify(dock.items.map(i => i.label)) === JSON.stringify(['规则', '资源', '账号', '回顾']), '成员短标签原样保留');
    check(dock.items.every(i => i.labelBelow && i.fits), '成员格沿用「图标在上、短标签在下」且不出格');
    check(dock.expanded === 'true', '入口 aria-expanded 同步为 true');
    // dock 与入口垂直居中（±半个入口高）
    const triggerBox = await c.eval(`(() => { const r = document.getElementById('btn-rail-group-rules').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
    check(Math.abs((dock.top + dock.bottom) / 2 - (triggerBox.top + triggerBox.bottom) / 2) <= 18, '展开条与入口垂直居中对齐');
    // rect 正确不等于画出来了：用 elementFromPoint 在 dock 的几个角上探针，确认那里命中的就是 dock 自己，
    // 没被 rail 的 overflow 裁掉、也没被会话侧栏盖住。
    const probe = await c.eval(`(() => {
      const menu = document.getElementById('rail-group-rules-menu');
      const r = menu.getBoundingClientRect();
      return [[r.left + 4, r.top + r.height / 2], [r.right - 4, r.top + 4], [r.right - 4, r.bottom - 4], [r.left + r.width / 2, r.bottom - 4]]
        .map(([x, y]) => { const hit = document.elementFromPoint(x, y); return { x: Math.round(x), y: Math.round(y), inside: !!hit && menu.contains(hit), hit: hit && (hit.id || hit.className) }; });
    })()`);
    result.probe = probe;
    check(probe.every(p => p.inside), '展开条整条真的画在可点区域（没被 rail overflow 裁掉或侧栏盖住）');
    await shot('dock-rules', { x: 0, y: Math.max(0, dock.top - 120), width: 420, height: 340 });

    // 3. 点「资源」：打开资源工作台，dock 收起，入口给出「组内有当前页」提示。
    const resourcePoint = await c.eval(`(() => { const r = document.getElementById('btn-rail-capabilities').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...resourcePoint });
    await press(resourcePoint);
    await waitFor(c, `!document.getElementById('hub-workspace').hidden && document.getElementById('hub-workspace').dataset.area === 'resources'`);
    await waitFor(c, `document.getElementById('rail-group-rules-menu').hidden`);
    check(await c.eval(`document.getElementById('btn-rail-group-rules').classList.contains('rail-group-current')`), '选完成员后，分组入口显示「组内有当前页」');
    check(await c.eval(`/当前：资源/.test(document.getElementById('btn-rail-group-rules').title) && /当前：资源/.test(document.getElementById('btn-rail-group-rules').getAttribute('aria-label'))`), '入口 title / aria-label 说清当前是组里的哪一项');
    check(await c.eval(`document.getElementById('hub-workspace').getBoundingClientRect().left >= document.getElementById('scene-rail').getBoundingClientRect().right`), '资源页仍从 rail 右边开始，没被 dock 挤动');
    await park();
    await shot('after-resource', { x: 0, y: 0, width: 1440, height: 900 });

    // 4. 键盘：入口上按 → 展开并把焦点送进第一个成员；Escape 收回并还焦点。
    await c.eval(`document.getElementById('btn-rail-group-applications').focus()`);
    await key(c, 'ArrowRight', 'ArrowRight', 39);
    await waitFor(c, `!document.getElementById('rail-group-applications-menu').hidden`);
    check(await c.eval(`document.activeElement.id === 'btn-research'`), '键盘 → 展开并把焦点送到第一个成员');
    const appsDock = await c.eval(`(() => { const m = document.getElementById('rail-group-applications-menu');
      const r = m.getBoundingClientRect(); const items = [...m.querySelectorAll('.btn-shell-nav')].filter(e => e.getClientRects().length).map(e => ({ id: e.id, label: e.querySelector('.btn-label').textContent }));
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, items, railRight: document.getElementById('scene-rail').getBoundingClientRect().right }; })()`);
    result.appsDock = appsDock;
    check(JSON.stringify(appsDock.items.map(i => i.id)) === JSON.stringify(['btn-research', 'btn-study', 'btn-writing', 'btn-wireless']), '应用组成员顺序：投研 / 学习 / 写作 / 无线');
    await shot('dock-apps-keyboard', { x: 0, y: Math.max(0, appsDock.top - 120), width: 420, height: 340 });
    await key(c, 'Escape', 'Escape', 27);
    await waitFor(c, `document.getElementById('rail-group-applications-menu').hidden`);
    check(await c.eval(`document.activeElement.id === 'btn-rail-group-applications'`), 'Escape 收回 dock 并把焦点还给入口');

    // 5. 移开鼠标后自动收起（不挂在屏幕上挡视线）。
    await hover('#btn-rail-group-rules');
    await waitFor(c, `!document.getElementById('rail-group-rules-menu').hidden`);
    await park();
    await waitFor(c, `document.getElementById('rail-group-rules-menu').hidden`, 5000);
    check(true, '鼠标离开后 dock 自动收起');

    // 6. 账号：第二个成员照常打开账号页（这条走 hub-workspaces 之外的原有接线）。
    await hover('#btn-rail-group-rules');
    await waitFor(c, `!document.getElementById('rail-group-rules-menu').hidden`);
    const accountPoint = await c.eval(`(() => { const r = document.getElementById('btn-rail-accounts').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...accountPoint });
    await press(accountPoint);
    await waitFor(c, `!document.getElementById('account-page').hidden && getComputedStyle(document.getElementById('account-page')).display !== 'none'`);
    await waitFor(c, `document.getElementById('rail-group-rules-menu').hidden`);
    check(await c.eval(`document.getElementById('btn-rail-group-rules').classList.contains('rail-group-current')`), '账号页打开后分组入口仍能指出当前项');
    await park();

    // 7. 长按排序仍能用：入口换成 .rail-group 容器后，拖动要整组搬，不能把成员从 dock 里拽出来。
    const assistantPoint = await c.eval(`(() => { const r = document.getElementById('btn-assistant').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...assistantPoint });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...assistantPoint });
    await _waitMs(700);
    await waitFor(c, `document.getElementById('scene-rail').classList.contains('rail-editing')`);
    const homePoint = await c.eval(`(() => { const r = document.getElementById('btn-home').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: homePoint.x, y: homePoint.y - 18, button: 'left', buttons: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: homePoint.x, y: homePoint.y - 18, button: 'left', clickCount: 1 });
    const afterDrag = await c.eval(`(() => ({
      first: [...document.querySelectorAll('.rail-navigation > .btn-shell-nav:not([hidden])')][0].id,
      saved: JSON.parse(localStorage.getItem('hub.navigationOrder.v1') || '[]'),
      groupIntact: document.querySelectorAll('#rail-group-rules-menu .btn-shell-nav').length,
      triggerIntact: !!document.querySelector('#rail-group-rules > .rail-group-trigger'),
      groupStillInRail: !!document.querySelector('.rail-navigation > #rail-group-rules'),
      menuHidden: document.getElementById('rail-group-rules-menu').hidden,
    }))()`);
    result.drag = afterDrag;
    check(afterDrag.first === 'btn-assistant' && afterDrag.saved[0] === 'btn-assistant', '长按拖动仍能调整一级入口顺序，并按顺序落盘');
    check(afterDrag.groupIntact === 5 && afterDrag.triggerIntact && afterDrag.groupStillInRail && afterDrag.menuHidden, '拖动只搬整个分组容器，成员仍留在 dock 里');
    await c.eval(`document.getElementById('nav-edit-done').click()`);
    await _waitMs(300);

    // 8. 深色主题 + 窄窗口：dock 用主题自己的浮层底色，位置仍完整落在可视区内。
    const originalTheme = await c.eval(`document.documentElement.dataset.theme || ''`);
    await c.eval(`document.documentElement.dataset.theme='dark'`);
    await hover('#btn-rail-group-rules');
    await waitFor(c, `!document.getElementById('rail-group-rules-menu').hidden`);
    const dark = await c.eval(`(() => {
      const menu = document.getElementById('rail-group-rules-menu');
      const cs = getComputedStyle(menu);
      const item = menu.querySelector('.btn-shell-nav .btn-label');
      return { bg: cs.backgroundColor, border: cs.borderTopColor, radius: cs.borderTopLeftRadius,
        labelColor: getComputedStyle(item).color, labelDisplay: getComputedStyle(item).display,
        railBg: getComputedStyle(document.getElementById('scene-rail')).backgroundColor };
    })()`);
    result.dark = dark;
    check(dark.bg !== 'rgba(0, 0, 0, 0)' && dark.bg !== dark.railBg, '深色主题下 dock 有自己的浮层底色（不是透明、不糊在 rail 上）');
    check(dark.labelColor !== dark.bg && dark.labelDisplay === 'block', '深色主题下成员短标签仍是可读的实色');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
    await _waitMs(300);
    const narrow = await c.eval(`(() => {
      const menu = document.getElementById('rail-group-rules-menu');
      const r = menu.getBoundingClientRect();
      const footer = document.getElementById('hub-system-footer').getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, footerTop: footer.top, w: innerWidth, h: innerHeight };
    })()`);
    result.narrow = narrow;
    check(narrow.left >= 44 && narrow.right <= narrow.w && narrow.top >= 0 && narrow.bottom <= narrow.footerTop,
      '窗口收到 1100×700 时，dock 仍完整落在 rail 右侧、底栏上方');
    await shot('dock-dark-narrow', { x: 0, y: Math.max(0, narrow.top - 100), width: 480, height: 320 });
    await c.eval(`document.documentElement.dataset.theme=${JSON.stringify(originalTheme || 'codex')}`);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await park();
    await _waitMs(200);

    // 9. 收起导航后的悬停预览：dock 开着时 rail 不能自己收掉。
    await c.eval(`document.getElementById('rail-pin').click()`);
    await waitFor(c, `document.getElementById('app-container').classList.contains('rail-hidden')`);
    // 先把指针挪到页面中间再回左边缘：取消固定时指针还停在 rail 上，此时 hover 会被抑制（原有行为）。
    await park();
    await _waitMs(200);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 300 });
    await waitFor(c, `document.getElementById('app-container').classList.contains('rail-preview')`);
    await hover('#btn-rail-group-rules');
    await waitFor(c, `!document.getElementById('rail-group-rules-menu').hidden`);
    const first = await c.eval(`(() => { const r = document.querySelector('#rail-group-rules-menu .btn-shell-nav').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...first });
    await _waitMs(500);
    check(await c.eval(`document.getElementById('app-container').classList.contains('rail-preview') && !document.getElementById('rail-group-rules-menu').hidden`),
      '悬停预览态下，鼠标移到 dock 上时 rail 和 dock 都保持展开');
    await shot('preview-dock', { x: 0, y: 120, width: 520, height: 420 });

    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    process.exitCode = 1;
    try { if (c) result.debug = await c.eval('({rail: !!document.getElementById("scene-rail"), groups: document.querySelectorAll(".rail-group").length, op: [...document.querySelectorAll(".rail-group-menu")].map(e => [e.id, e.hidden])})'); } catch {}
    try { if (c) await shot('failure'); } catch {}
  } finally {
    try {
      fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    } catch {}
    if (hub) {
      try { await gracefulQuit(hub); } catch (error) { result.teardownError = error.message; process.exitCode = 1; }
    }
  }
})();
