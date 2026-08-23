const {
  collectPathCandidates,
  _cleanPathCandidate,
} = require('./path-candidates.js');

function _fallbackLineTextMetrics(text) {
  const startColumns = [];
  const endColumns = [];
  for (let index = 0; index < text.length; index += 1) {
    startColumns[index] = index + 1;
    endColumns[index] = index + 1;
  }
  return { startColumns, endColumns, usedColumns: text.length };
}

// xterm link ranges use terminal cells, not JavaScript UTF-16 offsets. Chinese
// glyphs are normally two cells, combining sequences can share one cell, and a
// surrogate pair may still occupy two cells. BufferCell is authoritative after
// ConPTY/xterm layout, so derive coordinates from it. The fallback keeps the
// old behavior for lightweight test doubles and older xterm line objects.
function _lineTextMetrics(line, text, cols) {
  text = String(text || '');
  if (!line || typeof line.getCell !== 'function') return _fallbackLineTextMetrics(text);
  const startColumns = [];
  const endColumns = [];
  let offset = 0;
  let usedColumns = 0;
  const maxCols = Math.max(0, Number(cols) || 0);
  for (let cellIndex = 0; cellIndex < maxCols && offset < text.length; cellIndex += 1) {
    const cell = line.getCell(cellIndex);
    if (!cell) continue;
    const rawWidth = typeof cell.getWidth === 'function' ? Number(cell.getWidth()) : 1;
    if (rawWidth === 0) continue;
    const width = Math.max(1, Number.isFinite(rawWidth) ? rawWidth : 1);
    let chars = typeof cell.getChars === 'function' ? String(cell.getChars() || '') : '';
    if (!chars) chars = text[offset] === ' ' ? ' ' : String.fromCodePoint(text.codePointAt(offset));
    if (!text.startsWith(chars, offset)) {
      // Defensive fallback for a future xterm normalization difference. Keep
      // progressing by one displayed code point instead of shifting all later
      // ranges or returning an invalid link.
      chars = String.fromCodePoint(text.codePointAt(offset));
    }
    const endX = cellIndex + width;
    for (let unit = 0; unit < chars.length && offset + unit < text.length; unit += 1) {
      startColumns[offset + unit] = cellIndex + 1;
      endColumns[offset + unit] = endX;
    }
    offset += chars.length;
    usedColumns = Math.max(usedColumns, endX);
  }
  if (offset < text.length) {
    let nextColumn = usedColumns + 1;
    for (; offset < text.length; offset += 1, nextColumn += 1) {
      startColumns[offset] = nextColumn;
      endColumns[offset] = nextColumn;
    }
    usedColumns = endColumns.at(-1) || usedColumns;
  }
  return { startColumns, endColumns, usedColumns };
}

// When a width-2 glyph cannot fit in the final remaining terminal cell,
// ConPTY emits one explicit blank cell and continues the glyph on the wrapped
// row. xterm preserves that blank in translateToString(true), even though it is
// layout padding rather than a real space in the path. Remove exactly that
// one-cell pattern; genuine spaces elsewhere (including "My Report") remain.
function _trimWideWrapPadding(line, nextLine, text, cols) {
  text = String(text || '');
  if (!text.endsWith(' ') || !nextLine || nextLine.isWrapped !== true) return text;
  if (!line || typeof line.getCell !== 'function' || typeof nextLine.getCell !== 'function') return text;
  const lastCell = line.getCell(Math.max(0, Number(cols) - 1));
  const nextCell = nextLine.getCell(0);
  const lastWidth = lastCell && typeof lastCell.getWidth === 'function' ? Number(lastCell.getWidth()) : 0;
  const lastChars = lastCell && typeof lastCell.getChars === 'function' ? String(lastCell.getChars() || '') : '';
  const nextWidth = nextCell && typeof nextCell.getWidth === 'function' ? Number(nextCell.getWidth()) : 0;
  if (lastWidth === 1 && !lastChars.trim() && nextWidth === 2) return text.slice(0, -1);
  return text;
}

function createTerminalLinkRegistrar({ getCwd, openPathInHub, onContextMenu }) {
  const activeLinkGroups = new Map();

  function registerLinkInGroup(fullPath, link) {
    let set = activeLinkGroups.get(fullPath);
    if (!set) { set = new Set(); activeLinkGroups.set(fullPath, set); }
    set.add(link);
  }

  function unregisterLinkFromGroup(fullPath, link) {
    const set = activeLinkGroups.get(fullPath);
    if (!set) return;
    set.delete(link);
    if (set.size === 0) activeLinkGroups.delete(fullPath);
  }

  function setGroupUnderline(fullPath, value) {
    const set = activeLinkGroups.get(fullPath);
    if (!set) return;
    for (const link of set) {
      if (link.decorations) link.decorations.underline = value;
    }
  }

  function registerLocalPathLinks(terminal, sessionId) {
    // A visual wrap often lands exactly after '/', '\\', '?', '&' or '='.
    // Those are valid URL/path continuation characters; rejecting them before
    // the shared candidate parser sees the joined token splits valid links.
    const LINK_BOUNDARY_RE = /[^\r\n\s'"`<>|]/;
    const isHeuristicCont = (prevLine, currentLine) => {
      if (!prevLine || !currentLine) return false;
      const cols = terminal.cols;
      const prevTrim = _trimWideWrapPadding(
        prevLine,
        currentLine,
        prevLine.translateToString(true),
        cols,
      );
      const prevMetrics = _lineTextMetrics(prevLine, prevTrim, cols);
      const prevLast = prevTrim[prevTrim.length - 1];
      const curRaw = currentLine.translateToString(false);
      const curTokenMatch = curRaw.match(/^\s*([^\s'"`<>|]+)/);
      const curFirst = curTokenMatch && curTokenMatch[1] ? curTokenMatch[1][0] : null;
      if (!(prevLast && curFirst
        && LINK_BOUNDARY_RE.test(prevLast)
        && LINK_BOUNDARY_RE.test(curFirst))) return false;

      if (prevMetrics.usedColumns >= cols) return true;

      const prevToken = (prevTrim.match(/[^\s'"`<>|]+$/) || [''])[0];
      const curToken = curTokenMatch && curTokenMatch[1] ? curTokenMatch[1] : '';
      if (!prevToken || !curToken) return false;
      const joined = _cleanPathCandidate(prevToken + curToken);
      const cwd = typeof getCwd === 'function' ? getCwd(sessionId) : null;
      if (collectPathCandidates(joined, cwd).length === 0) return false;

      const nearRightEdge = prevMetrics.usedColumns >= Math.max(20, cols - 8);
      // Without xterm's isWrapped flag, proximity to the right edge is the
      // evidence that this was a visual wrap. A path-looking token alone is not
      // enough: otherwise the next independent output line gets swallowed into
      // a perfectly valid but incorrect URL/path.
      return nearRightEdge;
    };

    const provider = {
      provideLinks(lineNumber, callback) {
        const buf = terminal.buffer.active;
        const line = buf.getLine(lineNumber - 1);
        if (!line) { callback(undefined); return; }

        let groupIdx = lineNumber - 1;
        while (groupIdx > 0) {
          const cur = buf.getLine(groupIdx);
          if (cur && cur.isWrapped) { groupIdx--; continue; }
          const prev = buf.getLine(groupIdx - 1);
          if (isHeuristicCont(prev, cur)) { groupIdx--; continue; }
          break;
        }
        const groupLine = groupIdx + 1;

        let text = '';
        const lineWidths = [];
        const linePrefixSkips = [];
        const lineColumnMaps = [];
        for (let i = groupIdx; ; i++) {
          const l = buf.getLine(i);
          if (!l) break;
          let heuristicCont = false;
          if (i > groupIdx) {
            const prev = buf.getLine(i - 1);
            heuristicCont = !l.isWrapped && isHeuristicCont(prev, l);
            if (!l.isWrapped && !heuristicCont) break;
          }
          const nextLine = buf.getLine(i + 1);
          const raw = _trimWideWrapPadding(
            l,
            nextLine,
            l.translateToString(true),
            terminal.cols,
          );
          const metrics = _lineTextMetrics(l, raw, terminal.cols);
          const prefixSkip = heuristicCont ? ((raw.match(/^\s+/) || [''])[0].length) : 0;
          const lt = prefixSkip ? raw.slice(prefixSkip) : raw;
          text += lt;
          lineWidths.push(lt.length);
          linePrefixSkips.push(prefixSkip);
          lineColumnMaps.push({
            startColumns: metrics.startColumns.slice(prefixSkip),
            endColumns: metrics.endColumns.slice(prefixSkip),
          });
        }

        const cwd = typeof getCwd === 'function' ? getCwd(sessionId) : null;
        // CLI 与卡片共用同一解析器，避免双反斜杠/空格/drive-relative
        // 只在某一视图被修复、另一视图继续失效。
        const candidates = collectPathCandidates(text, cwd);

        const links = [];
        for (const c of candidates) {
          let cum = 0;
          for (let i = 0; i < lineWidths.length; i++) {
            const lineStart = cum;
            const lineEnd = cum + lineWidths[i];
            cum = lineEnd;
            if (c.end < lineStart || c.start >= lineEnd) continue;
            const yLine = groupLine + i;
            if (yLine !== lineNumber) continue;
            const segStartOff = Math.max(c.start, lineStart);
            const segEndOff = Math.min(c.end, lineEnd - 1);
            const prefixSkip = linePrefixSkips[i] || 0;
            const localStart = segStartOff - lineStart;
            const localEnd = segEndOff - lineStart;
            const columnMap = lineColumnMaps[i];
            const startX = columnMap.startColumns[localStart]
              || localStart + 1 + prefixSkip;
            const endX = columnMap.endColumns[localEnd]
              || localEnd + 1 + prefixSkip;
            const fullPath = c.openPath;
            const linkObj = {
              range: {
                start: { x: startX, y: yLine },
                end: { x: endX, y: yLine },
              },
              text: fullPath,
              decorations: { pointerCursor: true, underline: true },
              activate: async (event) => {
                if (event && event.button === 2 && typeof onContextMenu === 'function') {
                  onContextMenu(fullPath, event.clientX, event.clientY);
                  return;
                }
                return openPathInHub(fullPath, { cwd, requireExistsForRel: false });
              },
              hover: () => setGroupUnderline(fullPath, true),
              leave: () => setGroupUnderline(fullPath, true),
            };
            linkObj.dispose = () => unregisterLinkFromGroup(fullPath, linkObj);
            registerLinkInGroup(fullPath, linkObj);
            links.push(linkObj);
          }
        }
        callback(links.length > 0 ? links : undefined);
      },
    };
    terminal.registerLinkProvider(provider);
    return provider;
  }

  return registerLocalPathLinks;
}

module.exports = { createTerminalLinkRegistrar, _lineTextMetrics, _trimWideWrapPadding };
