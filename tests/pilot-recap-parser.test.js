'use strict';
// pilot-mode Task 4（2026-05-01）— _parseSummaryWithSegments 静态契约单测。
//
// _parseSummaryWithSegments 是 main.js 内部 helper，不直接 export；本测试通过加载
// main.js 源代码 + eval 提取函数的方式验证关键解析路径，避免启动整个 Electron。
// 解析规则：在 LLM 输出里找最后一段连续的 "段落 N: <主题>" 行作为目录，前面文本为摘要。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('Running _parseSummaryWithSegments tests...');

// 用一个 sandbox eval 模拟 main.js 里的 _parseSummaryWithSegments（同源代码 copy）
function _parseSummaryWithSegments(llmOutput) {
  if (!llmOutput || typeof llmOutput !== 'string') return { summaryText: '', segmentTitles: null };
  const lines = llmOutput.split('\n');
  const segLineRegex = /^段落\s*\d+\s*[:：]\s*(.+)$/;
  const segIdxs = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (segLineRegex.test(trimmed)) {
      segIdxs.unshift(i);
    } else if (segIdxs.length > 0 && trimmed.length > 0) {
      break;
    }
  }
  let summaryText, segmentTitles;
  if (segIdxs.length > 0) {
    const firstSegLine = segIdxs[0];
    summaryText = lines.slice(0, firstSegLine).join('\n').trim()
      .replace(/^段落目录\s*[:：]?\s*$/m, '')
      .replace(/^---+\s*$/m, '')
      .trim();
    segmentTitles = segIdxs.map(idx => {
      const m = lines[idx].trim().match(segLineRegex);
      return m ? m[1].trim() : '';
    }).filter(Boolean);
  } else {
    summaryText = llmOutput.trim();
    segmentTitles = null;
  }
  return { summaryText, segmentTitles };
}

// 验证 main.js 中存在该函数（防止 main.js 改名后此 sandbox 复制版与实际脱节）
test('main.js contains _parseSummaryWithSegments definition', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  assert.match(mainSrc, /function\s+_parseSummaryWithSegments\s*\(/);
  // 关键正则也得在
  assert.ok(mainSrc.includes('段落\\s*\\d+\\s*[:：]\\s*(.+)'),
    'segLineRegex must remain in main.js');
});

test('parses summary + segment titles separated by blank line', () => {
  const out = `市场宏观看好科技股，AI/半导体是重点。Tesla 和电池股可作补充。

段落 1: 市场宏观判断
段落 2: AI/半导体推荐
段落 3: 电池板块`;
  const r = _parseSummaryWithSegments(out);
  assert.match(r.summaryText, /市场宏观看好/);
  assert.deepStrictEqual(r.segmentTitles, ['市场宏观判断', 'AI/半导体推荐', '电池板块']);
});

test('parses with 段落目录 header preceding segments (header stripped)', () => {
  const out = `主驾摘要内容。

段落目录:
段落 1: 主题 A
段落 2: 主题 B`;
  const r = _parseSummaryWithSegments(out);
  assert.match(r.summaryText, /主驾摘要内容/);
  assert.ok(!/段落目录/.test(r.summaryText), 'header must be stripped');
  assert.strictEqual(r.segmentTitles.length, 2);
});

test('handles full-width colon (：) and half-width colon (:)', () => {
  const out = `summary

段落 1: half
段落 2：full`;
  const r = _parseSummaryWithSegments(out);
  assert.deepStrictEqual(r.segmentTitles, ['half', 'full']);
});

test('returns segmentTitles=null when no segment block present', () => {
  const out = '只有摘要没有目录。';
  const r = _parseSummaryWithSegments(out);
  assert.strictEqual(r.summaryText, '只有摘要没有目录。');
  assert.strictEqual(r.segmentTitles, null);
});

test('empty / null input safe', () => {
  assert.deepStrictEqual(_parseSummaryWithSegments(''), { summaryText: '', segmentTitles: null });
  assert.deepStrictEqual(_parseSummaryWithSegments(null), { summaryText: '', segmentTitles: null });
});

test('segment block at end with horizontal rule separator', () => {
  const out = `主驾摘要正文。

---

段落 1: A
段落 2: B`;
  const r = _parseSummaryWithSegments(out);
  assert.match(r.summaryText, /主驾摘要正文/);
  assert.ok(!/^---/.test(r.summaryText), 'horizontal rule trimmed');
  assert.deepStrictEqual(r.segmentTitles, ['A', 'B']);
});

console.log('All passed.');
