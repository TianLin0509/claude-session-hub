'use strict';
/**
 * 主题适配扫描器 —— 找「Hub 换了皮肤但组件没跟上」的地方。
 *
 * 起因（2026-08-27）：浅色主题下启动中心整片发灰。根因是共用的全屏遮罩用了
 * `::before { background: rgba(scrim,.55); z-index: -1 }`——`z-index:-1` 的子元素画在
 * **父元素自己的背景之上**，于是遮罩把面板底色一起压暗了。深色主题下遮罩与面板同色，
 * 完全看不出来；一换浅色就露馅。这类问题靠截图一张张找太慢，所以固化成扫描器。
 *
 * 它报两类：
 *   dark-surface —— 有效背景仍是深色的大面（本该跟着主题变浅）
 *   ghost-text   —— 文字与其背景对比度 < 3:1（浅底浅字 / 深底深字）
 * 终端、代码块、工具结果是**有意**恒深的（见 base.css 的 --machine-*），整棵子树跳过。
 *
 * 用法（必须对隔离实例跑，别碰生产 Hub）：
 *   1) 起隔离 Hub：
 *      $env:CLAUDE_HUB_DATA_DIR="<临时目录>"
 *      & "<...>
ode_modules\electron\dist\electron.exe" "<hub 目录>" --remote-debugging-port=9344
 *   2) node tools/theme-adaptation-scan.js                    # 扫当前屏
 *      node tools/theme-adaptation-scan.js --theme codex      # 先切皮肤再扫
 *      node tools/theme-adaptation-scan.js --click btn-new    # 先点开某个面板再扫
 *
 * 输出里的 onScreen 一定要看：面板没打开时报「0 问题」是假干净。
 */

const http = require('http');

const PORT = process.env.HUB_CDP_PORT || 9344;
const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const theme = argOf('--theme');
const clickId = argOf('--click');

const SCAN = `// 未适配面检测器：在浅色主题下跑，找出「主题变了但组件没跟上」的地方。
// 两类问题：
//   dark-surface —— 有效背景仍是深色（本该跟着主题变浅的面）
//   ghost-text   —— 文字与其背景对比度 < 3:1（浅底浅字 / 深底深字）
// 终端、代码块、工具结果是有意恒深的，整棵子树跳过。
(() => {
  const MACHINE_SEL = '.xterm, .tc-result, .code-block-wrap, pre, .terminal-container, .minimap, .hub-machine';
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const rootBg = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };

  function effBg(el) {
    let acc = null, n = el;
    while (n && n.nodeType === 1) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0) { acc = acc ? over(acc, bg) : bg; if (acc.a >= 0.999) return acc; }
      n = n.parentElement;
    }
    return acc ? over(acc, rootBg) : rootBg;
  }
  function ownText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length > 1) return n.textContent.trim().slice(0, 30);
    return null;
  }
  function label(el) {
    const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + String(cls).trim().split(/\s+/).slice(0, 3).join('.') : '');
  }

  const darkSurfaces = [], ghost = [];
  const seenD = new Set(), seenG = new Set();

  for (const el of document.querySelectorAll('*')) {
    if (el.closest(MACHINE_SEL)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.12) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 14) continue;

    // 1) 自己画了一层深色背景
    const own = parse(cs.backgroundColor);
    if (own && own.a > 0.5) {
      const flat = own.a >= 0.999 ? own : over(own, effBg(el.parentElement || document.body));
      // 品牌实色按钮/徽章本来就该是深的，不算未适配：只看『别的内容坐在上面』的大面
      const isControl = /^(button|a|i|em|b|strong|code|kbd)$/.test(el.tagName.toLowerCase());
      // 遮罩层本来就该是深的
      const isScrim = /overlay|scrim|mask|backdrop/i.test(label(el));
      if (lum(flat) < 0.35 && !isControl && !isScrim && r.width * r.height > 9000) {
        const k = label(el);
        if (!seenD.has(k)) { seenD.add(k); darkSurfaces.push({ el: k, bg: cs.backgroundColor, area: Math.round(r.width) + 'x' + Math.round(r.height) }); }
      }
    }

    // 2) 文字与背景撞在一起
    const t = ownText(el);
    if (t) {
      const fg = parse(cs.color);
      if (fg && fg.a > 0.05) {
        const bg = effBg(el);
        const cr = ratio(over(fg, bg), bg);
        if (cr < 3.0) {
          const k = label(el) + '|' + cs.color;
          if (!seenG.has(k)) { seenG.add(k); ghost.push({ el: label(el), ratio: Math.round(cr * 100) / 100, color: cs.color, bg: 'rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(',') + ')', text: t }); }
        }
      }
    }
  }
  ghost.sort((a, b) => a.ratio - b.ratio);
  // 把「此刻屏幕上真有什么」一起报出来：面板没打开时报 0 问题是假干净，必须能看出来。
  const onScreen = [];
  for (const el of document.querySelectorAll('div,section,aside,nav')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 260 || r.height < 160) continue;
    onScreen.push(label(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  return JSON.stringify({
    theme: document.documentElement.getAttribute('data-theme'),
    onScreen: onScreen.slice(0, 8),
    darkSurfaces: darkSurfaces.slice(0, 16),
    darkCount: darkSurfaces.length,
    ghost: ghost.slice(0, 16),
    ghostCount: ghost.length,
  }, null, 1);
})()`;

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getJson('/json/list');
  const page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url)) || targets.find(t => t.type === 'page');
  if (!page) throw new Error('CDP 上找不到 Hub 页面，隔离实例起来了吗？');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });

  if (theme) {
    await evaluate(`(()=>{const b=document.querySelector('#options-theme-picker [data-theme-id="${theme}"]');`
      + `if(b){b.click();return 'clicked';}document.documentElement.setAttribute('data-theme','${theme}');return 'attr';})()`);
    await new Promise(r => setTimeout(r, 600));
  }
  if (clickId) {
    await evaluate(`(()=>{const e=document.getElementById('${clickId}');if(!e)return 'missing';e.click();return 'ok';})()`);
    await new Promise(r => setTimeout(r, 800));
  }

  const r = await evaluate(SCAN);
  if (r.exceptionDetails) {
    console.error('扫描脚本抛错:', JSON.stringify(r.exceptionDetails).slice(0, 400));
    process.exit(1);
  }
  const d = JSON.parse(r.result.value);
  console.log('主题: ' + d.theme);
  console.log('屏上: ' + ((d.onScreen || []).slice(0, 5).join(' | ') || '(只有主界面)'));
  console.log('深色面 ' + d.darkCount + ' 处 · 幽灵文字 ' + d.ghostCount + ' 处');
  for (const x of d.darkSurfaces) console.log('  [面] ' + x.el + '  ' + x.bg + '  ' + x.area);
  for (const x of d.ghost) console.log('  [字] ' + x.ratio + '  ' + x.el + '  ' + x.color + ' on ' + x.bg + '  「' + x.text + '」');
  ws.close();
  process.exit(d.darkCount + d.ghostCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(2); });
