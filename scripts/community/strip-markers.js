'use strict';

// 剥离标记：主仓库里私人模块的接线点用成对标记包起来，社区版导出时整段删掉。
//
//   // @community-strip <原因>        <!-- @community-strip <原因> -->     /* @community-strip */
//   …私人版代码…
//   // @community-else                （可选）
//   // 社区版代码，私人版里只是注释
//   // @community-end
//
// 标记本身是注释，对私人版运行没有任何影响。不允许嵌套；else 段每行都必须是
// 同一种注释写法，导出时去掉注释符。格式不对直接报错，不猜。

const MARKER = /^([ \t]*)(?:\/\/|<!--|\/\*)\s*@community-(strip|else|end)\b.*$/;

function uncomment(line, file, lineNo) {
  const js = /^([ \t]*)\/\/ ?(.*)$/.exec(line);
  if (js) return js[1] + js[2];
  const html = /^([ \t]*)<!--\s?(.*?)\s?-->\s*$/.exec(line);
  if (html) return html[1] + html[2];
  const css = /^([ \t]*)\/\*\s?(.*?)\s?\*\/\s*$/.exec(line);
  if (css) return css[1] + css[2];
  throw new Error(`${file}:${lineNo} @community-else 段的每一行都必须是注释`);
}

function applyStripMarkers(text, file = '<text>') {
  if (!text.includes('@community-')) return { text, regions: 0 };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out = [];
  let state = 'keep';
  let openedAt = 0;
  let regions = 0;
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const marker = MARKER.exec(line);
    if (marker) {
      const kind = marker[2];
      if (kind === 'strip') {
        if (state !== 'keep') throw new Error(`${file}:${lineNo} 剥离标记不能嵌套（上一段始于第 ${openedAt} 行）`);
        state = 'strip'; openedAt = lineNo; regions += 1; return;
      }
      if (kind === 'else') {
        if (state !== 'strip') throw new Error(`${file}:${lineNo} @community-else 前没有 @community-strip`);
        state = 'else'; return;
      }
      if (state === 'keep') throw new Error(`${file}:${lineNo} @community-end 前没有 @community-strip`);
      state = 'keep'; return;
    }
    if (state === 'keep') out.push(line);
    else if (state === 'else') out.push(uncomment(line, file, lineNo));
  });
  if (state !== 'keep') throw new Error(`${file}:${openedAt} 剥离段没有 @community-end`);
  return { text: out.join(eol), regions };
}

module.exports = { applyStripMarkers };
