const {
  PREVIEW_PATH_RE,
  collectPathCandidates,
  _cleanPathCandidate,
} = require('./path-candidates.js');

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
    const PATH_BOUNDARY_RE = /[^\\/:*?"<>|\r\n\s'"`]/;
    const isHeuristicCont = (prevLine, currentLine) => {
      if (!prevLine || !currentLine) return false;
      const cols = terminal.cols;
      const prevTrim = prevLine.translateToString(true);
      const prevLast = prevTrim[prevTrim.length - 1];
      const curRaw = currentLine.translateToString(false);
      const curTokenMatch = curRaw.match(/^\s*([^\s'"`<>|]+)/);
      const curFirst = curTokenMatch && curTokenMatch[1] ? curTokenMatch[1][0] : null;
      if (!(prevLast && curFirst
        && PATH_BOUNDARY_RE.test(prevLast)
        && PATH_BOUNDARY_RE.test(curFirst))) return false;

      if (prevTrim.length === cols) return true;

      const prevToken = (prevTrim.match(/[^\s'"`<>|]+$/) || [''])[0];
      const curToken = curTokenMatch && curTokenMatch[1] ? curTokenMatch[1] : '';
      if (!prevToken || !curToken) return false;
      const joined = _cleanPathCandidate(prevToken + curToken);
      if (!PREVIEW_PATH_RE.test(joined)) return false;

      const prevTokenLooksPath = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"<>|\r\n\s]+\\|~[\\/]|\.{1,2}[\\/]|.*[\\/])/.test(prevToken);
      const nearRightEdge = prevTrim.length >= Math.max(20, cols - 8);
      return !!(prevLine.isWrapped || prevTokenLooksPath || nearRightEdge);
    };

    terminal.registerLinkProvider({
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
        for (let i = groupIdx; ; i++) {
          const l = buf.getLine(i);
          if (!l) break;
          let heuristicCont = false;
          if (i > groupIdx) {
            const prev = buf.getLine(i - 1);
            heuristicCont = !l.isWrapped && isHeuristicCont(prev, l);
            if (!l.isWrapped && !heuristicCont) break;
          }
          const raw = l.translateToString(true);
          const prefixSkip = heuristicCont ? ((raw.match(/^\s+/) || [''])[0].length) : 0;
          const lt = prefixSkip ? raw.slice(prefixSkip) : raw;
          text += lt;
          lineWidths.push(lt.length);
          linePrefixSkips.push(prefixSkip);
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
            const startX = segStartOff - lineStart + 1 + prefixSkip;
            const endX = segEndOff - lineStart + 1 + prefixSkip;
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
                openPathInHub(fullPath, { cwd, requireExistsForRel: false });
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
    });
  }

  return registerLocalPathLinks;
}

module.exports = { createTerminalLinkRegistrar };
