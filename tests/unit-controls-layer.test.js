'use strict';

// 控件状态层（renderer/styles/controls.css）的源码守卫。
//
// 这一层存在的前提是「只改外观、不挪排版」：它统一了 Hub 里散落各处的
// focus / active / disabled 状态，但不许碰任何参与布局的属性。这个承诺
// 一旦被破坏，症状是整屏控件位移几个像素 —— 肉眼很难发现，但会把
// sidebar 的行高、toolbar 的换行、composer 的对齐一起带歪。
//
// 所以这里守四件事：
//   ① 它是 index.html 里最后一张样式表（排在 memory-panel.css 等之后才压得住）；
//   ② 它没被退回成 styles.css 里的 @import（那样既压不住别人，disabled 开关
//      在 Chromium 里也失效，会让 CDP 的开/关比对变成假通过）；
//   ③ 文件里没有任何一条布局属性；
//   ④ 选择器里出现的每个类名/ID 在 renderer 的其他文件里真的存在
//      —— 防止写出 .sidebar-usage 这种拼错的死选择器（本层开发时真踩过）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const RENDERER = path.join(__dirname, '..', 'renderer');
const CONTROLS = path.join(RENDERER, 'styles', 'controls.css');

const read = (p) => fs.readFileSync(p, 'utf8');

/** 去掉 /* *​/ 注释，避免注释里的文字被当成声明或选择器。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('controls.css 是 index.html 里最后一张样式表', () => {
  const html = read(path.join(RENDERER, 'index.html'));
  const sheets = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)]
    .map((m) => m[1]);

  assert.ok(sheets.includes('styles/controls.css'),
    'index.html 没有引入 controls.css');
  assert.equal(sheets[sheets.length - 1], 'styles/controls.css',
    `controls.css 必须是最后一张样式表，实际最后一张是 ${sheets[sheets.length - 1]}。`
    + '它统一 focus/active/disabled，而 memory-panel.css / file-manager-panel.css '
    + '里各自写着同名状态规则 —— 排在它们前面就会被压掉。');
});

test('controls.css 不能退回 styles.css 的 @import', () => {
  // @import 进来的表排在宿主表的位置（styles.css 在 index.html 第 10 行），
  // 压不住后面十几张独立 <link>；而且 @import 表的 disabled 开关在 Chromium
  // 里无效，CDP 的开/关两次测量会变成两次「开」的假通过。
  const manifest = read(path.join(RENDERER, 'styles.css'));
  assert.ok(!manifest.includes('controls.css'),
    'styles.css 又把 controls.css @import 回去了 —— 见本文件头注释的原因');
});

test('controls.css 不含任何参与布局的属性', () => {
  const css = stripComments(read(CONTROLS));

  // 会挪动排版的属性。inset 不在其中：它只用在绝对定位的 ::after 命中区上，
  // 那个伪元素不参与布局。position 也允许 —— relative 不改变盒子尺寸。
  const BANNED = [
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'border', 'border-width', 'border-top-width', 'border-right-width',
    'border-bottom-width', 'border-left-width', 'border-style',
    'font-size', 'font-family', 'font-weight', 'line-height', 'letter-spacing',
    'gap', 'row-gap', 'column-gap', 'display', 'flex', 'flex-basis',
    'grid-template-columns', 'grid-template-rows', 'white-space', 'box-sizing',
  ];

  const offenders = [];
  // 只看声明块内部，逐条取属性名。
  for (const block of css.matchAll(/\{([^}]*)\}/g)) {
    for (const decl of block[1].split(';')) {
      const name = decl.split(':')[0].trim().toLowerCase();
      if (!name) continue;
      if (BANNED.includes(name)) offenders.push(name);
    }
  }

  assert.deepEqual(offenders, [],
    `controls.css 出现了会挪动排版的属性：${[...new Set(offenders)].join(', ')}。`
    + '这一层的全部价值建立在"尺寸不变"上，要改几何请改对应的布局文件。');
});

test('禁用态只有一个不透明度来源', () => {
  const css = stripComments(read(CONTROLS));

  assert.ok(/--ctl-disabled-opacity\s*:/.test(css),
    'controls.css 必须定义 --ctl-disabled-opacity');

  // 除了变量定义那一处，opacity 一律通过变量取值，不许再出现字面量。
  const literals = [...css.matchAll(/(?<!-)\bopacity\s*:\s*([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((v) => !v.startsWith('var('));

  assert.deepEqual(literals, [],
    `禁用态出现了字面量 opacity：${literals.join(', ')}。`
    + '全仓原本有 10 个不同的值，这一层的目的就是把它们收成一个变量。');
});

test('选择器里的类名和 ID 在 renderer 里真的存在', () => {
  const css = stripComments(read(CONTROLS));

  // 收集 controls.css 用到的类名与 ID（跳过伪类/伪元素/属性选择器）
  const tokens = new Set();
  for (const block of css.split('}')) {
    const selectorPart = block.split('{')[0];
    if (!selectorPart || selectorPart.includes('@')) continue;
    for (const m of selectorPart.matchAll(/[.#]([A-Za-z][\w-]*)/g)) tokens.add(m[0]);
  }
  assert.ok(tokens.size > 10, '没解析出选择器，正则可能写坏了');

  // 在 renderer 下除 controls.css 外的所有 css / js / html 里找证据
  const haystack = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'vendor' || entry.name === 'assets') continue;
        walk(full);
        continue;
      }
      if (full === CONTROLS) continue;
      if (/\.(css|js|html)$/.test(entry.name)) haystack.push(read(full));
    }
  };
  walk(RENDERER);
  const corpus = haystack.join('\n');

  const dead = [...tokens].filter((t) => !corpus.includes(t.slice(1)));
  assert.deepEqual(dead, [],
    `controls.css 里这些选择器在 renderer 中不存在，是死选择器：${dead.join(', ')}`);
});

test('命中区名单里的控件，全仓不能有别的 position 声明或 ::after 规则', () => {
  // 这条守的是一个真的踩过的坑（2026-09-19）：
  // .btn-expand-sidebar 被 toolbar.css 的 .app-toolbar .btn-expand-sidebar (0,2,0)
  // 压成 position:static，于是本层的 position:relative 无效，而 ::after 照样生成 ——
  // 一个绝对定位、inset:-3px 的伪元素找不到自己的包含块，就会去挂最近的定位祖先，
  // 变成一大块看不见的点击遮罩盖在界面上。CDP 的尺寸比对抓不到它（伪元素不在
  // querySelectorAll 的结果里），所以必须在源码层拦。
  const css = stripComments(read(CONTROLS));

  // 从 controls.css 里反查命中区名单：带 inset: -3px 的那条规则
  const hitBlock = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find((m) => /inset\s*:\s*-3px/.test(m[2]));
  assert.ok(hitBlock, '找不到命中区规则（inset: -3px），选择器或数值被改过？');

  const hitClasses = [...hitBlock[1].matchAll(/\.([A-Za-z][\w-]*)::after/g)].map((m) => m[1]);
  assert.ok(hitClasses.length > 3, `命中区名单只解析出 ${hitClasses.length} 个，正则可能写坏了`);

  // 扫 renderer 下除 controls.css 外的所有 CSS，按规则块（可跨行）解析
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'vendor' || entry.name === 'assets') continue;
        walk(full);
        continue;
      }
      if (full === CONTROLS || !entry.name.endsWith('.css')) continue;
      const other = stripComments(read(full));
      for (const m of other.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const [, selector, body] = m;
        for (const cls of hitClasses) {
          // 注意用 String.raw：普通模板串里的 \b 会变成退格符（U+0008），
          // 正则就永远匹配不上 —— 这条守卫第一版就是这么静默失效的。
          const used = new RegExp(String.raw`\.` + cls + String.raw`(?![\w-])`).test(selector);
          if (!used) continue;
          if (/(?<![-\w])position\s*:/.test(body)) {
            offenders.push(`${entry.name} 给 .${cls} 写了 position`);
          }
          const pseudoRe = new RegExp(
            String.raw`\.` + cls + String.raw`(?![\w-])[^,{]*::?(after|before)(?![\w-])`);
          if (pseudoRe.test(selector)) {
            offenders.push(`${entry.name} 给 .${cls} 写了伪元素`);
          }
        }
      }
    }
  };
  walk(RENDERER);

  assert.deepEqual([...new Set(offenders)], [],
    '命中区名单和别处的样式冲突了：\n  ' + [...new Set(offenders)].join('\n  ')
    + '\n把这个类从 controls.css 的命中区名单里去掉（:active/:focus-visible/:disabled 可以留）。');
});
