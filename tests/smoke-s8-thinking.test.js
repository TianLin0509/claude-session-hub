// Spec 2 · S8 smoke test (grep-style assertion)
// renderTurnCard is file-scoped inside renderer.js (not exported, no jsdom),
// so this test asserts on the source text rather than executing the function.
//
// Run: node tests/smoke-s8-thinking.test.js
// Exits 0 on pass, 1 on fail.

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const STYLES = path.join(__dirname, '..', 'renderer', 'styles.css');

const src = fs.readFileSync(RENDERER, 'utf8');
const css = fs.readFileSync(STYLES, 'utf8');

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
  else console.log('  ok  -', msg);
}

console.log('S8 smoke: renderTurnCard thinking block');

// 1. <details class="turn-thinking"> template present in renderer.js
assert(
  /<details class="turn-thinking">/.test(src),
  'renderer.js contains <details class="turn-thinking"> template',
);

// 2. summary uses turn-thinking-summary class
assert(
  /class="turn-thinking-summary"/.test(src),
  'renderer.js contains class="turn-thinking-summary"',
);

// 3. body uses turn-thinking-body class
assert(
  /class="turn-thinking-body"/.test(src),
  'renderer.js contains class="turn-thinking-body"',
);

// 4. assistant-only guard: !isUser && turn.thinking checked
assert(
  /!isUser\s*&&\s*typeof turn\.thinking\s*===\s*['"]string['"]\s*&&\s*turn\.thinking\.length\s*>\s*0/.test(src),
  'renderer.js gates thinking on assistant role + non-empty string',
);

// 5. NO `open` attribute on the details (default collapsed)
const detailsTagMatch = src.match(/<details class="turn-thinking"[^>]*>/);
assert(
  detailsTagMatch && !/\bopen\b/.test(detailsTagMatch[0]),
  '<details> tag has no `open` attribute (default collapsed)',
);

// 6. Long thinking preview (>5KB) branch with first 200 chars label
assert(
  /turn\.thinking\.length\s*>\s*5120/.test(src) &&
    /前 200 字符/.test(src) &&
    /turn\.thinking\.slice\(0,\s*200\)/.test(src),
  'long-thinking branch (>5120) generates first-200-char preview label',
);

// 7. preview is HTML-escaped via escapeHtml()
assert(
  /escapeHtml\(previewRaw\)/.test(src),
  'preview text is HTML-escaped via escapeHtml(previewRaw)',
);

// 8. thinking goes through marked + DOMPurify (same pipeline as main body)
assert(
  /marked\.parse\(turn\.thinking/.test(src) &&
    /DOMPurify\.sanitize\(thinkingRaw/.test(src),
  'thinking content is marked-parsed and DOMPurify-sanitized',
);

// 9. CSS additions present
assert(/\.turn-thinking\b/.test(css), 'styles.css defines .turn-thinking');
assert(/\.turn-thinking-summary\b/.test(css), 'styles.css defines .turn-thinking-summary');
assert(/\.turn-thinking-body\b/.test(css), 'styles.css defines .turn-thinking-body');

// 10. CSS uses theme variables (not hardcoded colors for major surfaces)
const cssBlock = css.slice(css.indexOf('Spec 2 · S8'), css.indexOf('Spec 1 v0.9.0 · 工具调用块', css.indexOf('Spec 2 · S8')));
assert(
  /var\(--bg-secondary\)/.test(cssBlock) && /var\(--text-muted\)/.test(cssBlock) && /var\(--turn-body-fg\)/.test(cssBlock),
  'S8 CSS block uses theme variables (--bg-secondary, --text-muted, --turn-body-fg)',
);

if (failures.length) {
  console.log('\nFAIL:', failures.length, 'assertion(s) failed:');
  failures.forEach(f => console.log('  -', f));
  process.exit(1);
}
console.log('\nPASS: all S8 assertions hold.');
process.exit(0);
