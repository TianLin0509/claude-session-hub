'use strict';
/**
 * 控件状态层 · 真实 Hub CDP 验证（2026-09-19）
 *
 * 单测只能对 controls.css 的源码做断言（不含布局属性、没有死选择器）。
 * 但「源码里没写 padding」不等于「排版真的没动」—— outline-offset 撑出滚动条、
 * position:relative 改变包含块、::after 影响 inline 基线，这些都会在真实
 * 渲染里挪东西，grep 看不出来。
 *
 * 所以这里在真实 Hub 里做两次测量：
 *   ① 正常加载 → 记录每个控件的 getBoundingClientRect
 *   ② 把 controls.css 这张 sheet disabled 掉 → 再测一次
 *   ③ 逐个比对，任何一个宽高差超过 0.5px 就失败
 *
 * 还要证明这一层不是空文件，分两步：
 *   - 开关探针：--ctl-disabled-opacity 全仓只在 controls.css 里定义，
 *     关掉必须读不到、恢复必须回来。它同时证明「开关真的有效」——
 *     否则两次测量都是开启状态，比对当然全绿，那是假通过。
 *   - 命中探针：拿一个真控件（.btn-options）看 position 有没有从
 *     static 变成 relative。文件被加载 ≠ 选择器匹配得上。
 *
 * 自包含：隔离 data dir + 隔离 home + 独立 CDP 端口 + 按 PID 清理。**不碰生产 Hub。**
 *
 * 用法：node tests/controls-layer-cdp-e2e.js
 */

const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { launchIsolatedHub, gracefulQuit, listCdpTargets, _waitMs } =
  require('./helpers/hub-launcher');

const PORT = 9372;
const DATA_DIR = path.join(os.tmpdir(), 'hub-controls-layer-e2e');

function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((ok, fail) => {
          pending.set(id, { ok, fail });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { ws.close(); },
    }));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (!msg.id || !pending.has(msg.id)) return;
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) fail(new Error(JSON.stringify(msg.error)));
      else ok(msg.result);
    });
  });
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error('page error: ' + JSON.stringify(res.exceptionDetails));
  }
  return res.result.value;
}

// 页面内用的公共片段：拿到 controls.css 那张 <link> 并切换启用状态。
//
// 必须是 <link> 而不是 @import 进来的表 —— 2026-09-19 实测：给 @import 得到的
// CSSStyleSheet 设 disabled=true 在 Chromium 里不起作用，两次测量拿到的都是
// 「开启」状态，比对当然全绿。那是个假通过，这个注释就是为了别再写回去。
const TOGGLE_FN = `
  function findControlsSheet() {
    return document.getElementById('controls-layer');
  }
`;

// 量所有可交互控件。范围故意放得比 controls.css 的名单大：
// 整屏的 button / [role=button] 都量，这样连「被这一层间接影响到的邻居」也盖住。
const MEASURE_FN = `
  function measureAll() {
    const nodes = document.querySelectorAll('button, [role="button"], .session-item, .mp-tab');
    const out = [];
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      out.push({
        key: (el.id || '') + '|' + (el.getAttribute('class') || '') + '|' + out.length,
        w: r.width, h: r.height, x: r.left, y: r.top,
      });
    }
    return out;
  }
`;

async function main() {
  console.log('[controls-e2e] 启动隔离 Hub …');
  const hub = await launchIsolatedHub({
    dataDir: DATA_DIR,
    port: PORT,
    label: 'controls-layer',
  });
  console.log(`[controls-e2e] PID ${hub.pid} · CDP ${hub.port}`);

  let failures = [];
  try {
    const targets = await listCdpTargets(hub);
    const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
    if (!page) throw new Error('找不到 renderer 页面 target：' + JSON.stringify(targets.map(t => t.url)));

    const cdp = await openCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    // 渲染器要把侧栏、rail、toolbar 都铺开才有东西可量
    await _waitMs(2500);

    // ---- 0. 确认这一层真的被加载了 ----
    const sheetFound = await evaluate(cdp, `(() => { ${TOGGLE_FN}
      return !!findControlsSheet();
    })()`);
    if (!sheetFound) throw new Error('页面里找不到 <link id="controls-layer">');
    console.log('[controls-e2e] controls.css 已加载 ✓');

    // ---- 1. 开启状态下测量 ----
    const before = await evaluate(cdp, `(() => { ${MEASURE_FN} return measureAll(); })()`);
    console.log(`[controls-e2e] 量到 ${before.length} 个控件`);
    if (before.length < 12) throw new Error(`控件太少（${before.length}），界面可能还没渲染完`);

    // ---- 2. 证明这一层不是空文件：关掉后计算样式必须变 ----
    // 探针必须选「只有 controls.css 会设」的东西。第一版用了 .hub-pid 的
    // font-variant-numeric —— 那是个可继承属性，祖先早就设了 tabular-nums，
    // 关掉本层也不会变，于是探针恒等，什么都证明不了。改用本层独有的自定义属性：
    // --ctl-disabled-opacity 全仓只在 controls.css 里定义一次。
    const effect = await evaluate(cdp, `(async () => { ${TOGGLE_FN}
      const link = findControlsSheet();
      const read = () => getComputedStyle(document.documentElement)
        .getPropertyValue('--ctl-disabled-opacity').trim();
      // 不用 requestAnimationFrame：窗口被遮挡时 Chromium 会把它节流到不触发，
      // awaitPromise 于是永远挂着（2026-09-19 实测卡死 3 分钟）。setTimeout 不受影响。
      const frame = () => new Promise(r => setTimeout(r, 120));
      const on = read();
      link.disabled = true;  await frame();
      const off = read();
      link.disabled = false; await frame();
      const back = read();
      return { on, off, back };
    })()`);
    if (!effect.on) {
      failures.push('开启状态下读不到 --ctl-disabled-opacity —— 这一层没生效');
    } else if (effect.off !== '') {
      failures.push(`关掉 controls.css 后 --ctl-disabled-opacity 仍是 "${effect.off}" `
        + '—— 开关没起作用，下面的尺寸比对不可信');
    } else if (effect.back !== effect.on) {
      failures.push(`恢复后是 "${effect.back}"，没有回到 "${effect.on}"，测量状态被污染`);
    } else {
      console.log(`[controls-e2e] 开关验证 ✓ --ctl-disabled-opacity: "${effect.on}" → "" → "${effect.back}"`);
    }

    // ---- 2b. 证明规则真的命中了控件，而不只是"文件被加载了" ----
    // 自定义属性只能证明这张表在，证明不了选择器匹配得上。这里拿一个
    // 一定存在的真控件（rail 上的选项键）看命中区那条规则有没有落到它身上。
    //
    // 别换成 .btn-expand-sidebar：它被 toolbar.css 的 .app-toolbar
    // .btn-expand-sidebar (0,2,0) 压成 position:static，本来就不在命中区名单里。
    const hit = await evaluate(cdp, `(async () => { ${TOGGLE_FN}
      const link = findControlsSheet();
      const el = document.querySelector('.btn-options');
      if (!el) return { missing: true };
      const frame = () => new Promise(r => setTimeout(r, 120));
      const on = getComputedStyle(el).position;
      link.disabled = true;  await frame();
      const off = getComputedStyle(el).position;
      link.disabled = false; await frame();
      return { on, off };
    })()`);
    if (hit.missing) {
      failures.push('页面里找不到 .btn-options，无法验证选择器命中');
    } else if (hit.on !== 'relative' || hit.off === 'relative') {
      failures.push(`命中区规则没作用到 .btn-options 上：开=${hit.on} 关=${hit.off}`);
    } else {
      console.log(`[controls-e2e] 选择器命中 ✓ .btn-options position: "${hit.off}" → "${hit.on}"`);
    }

    // ---- 3. 关闭后再量，逐个比对 ----
    // 关掉之后必须等样式真正撤下去再量。link.disabled 的生效不是同步的：
    // 不等两帧就测，拿到的还是「开启」状态的排版，比对会假通过。
    // sheetOffAtMeasure 是这件事的自证 —— 量的那一刻自定义属性必须已经读不到。
    const afterRun = await evaluate(cdp, `(async () => { ${TOGGLE_FN} ${MEASURE_FN}
      const link = findControlsSheet();
      // 不用 requestAnimationFrame：窗口被遮挡时 Chromium 会把它节流到不触发，
      // awaitPromise 于是永远挂着（2026-09-19 实测卡死 3 分钟）。setTimeout 不受影响。
      const frame = () => new Promise(r => setTimeout(r, 120));
      const probe = () => getComputedStyle(document.documentElement)
        .getPropertyValue('--ctl-disabled-opacity').trim();
      link.disabled = true;  await frame();
      const sheetOffAtMeasure = probe() === '';
      const m = measureAll();
      link.disabled = false; await frame();
      return { m, sheetOffAtMeasure };
    })()`);
    if (!afterRun.sheetOffAtMeasure) {
      failures.push('第二次测量时 controls.css 其实还生效着 —— 比对结果不可信');
    }
    const after = afterRun.m;

    if (after.length !== before.length) {
      failures.push(`控件数量变了：开 ${before.length} / 关 ${after.length}`);
    } else {
      const moved = [];
      for (let i = 0; i < before.length; i++) {
        const a = before[i];
        const b = after[i];
        const d = Math.max(
          Math.abs(a.w - b.w), Math.abs(a.h - b.h),
          Math.abs(a.x - b.x), Math.abs(a.y - b.y),
        );
        if (d > 0.5) moved.push(`${a.key} 偏差 ${d.toFixed(2)}px`);
      }
      if (moved.length) {
        failures.push(`${moved.length} 个控件被挪动了：\n    ` + moved.slice(0, 12).join('\n    '));
      } else {
        console.log(`[controls-e2e] 尺寸/位置比对 ✓ ${before.length} 个控件逐像素相同`);
      }
    }

    // ---- 4. 页面无 JS 报错 ----
    const errs = await evaluate(cdp, `(window.__hubConsoleErrors || []).length`);
    if (typeof errs === 'number' && errs > 0) {
      console.log(`[controls-e2e] 提示：页面记录了 ${errs} 条错误（与本层不一定相关）`);
    }

    cdp.close();
  } finally {
    await gracefulQuit(hub);
    console.log('[controls-e2e] 隔离实例已退出');
  }

  if (failures.length) {
    console.error('\n✖ 失败：');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\n✔ 全部通过：controls.css 生效，且没有挪动任何控件。');
}

main().catch((err) => {
  console.error('✖ e2e 异常：', err);
  process.exit(1);
});
