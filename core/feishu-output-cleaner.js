'use strict';

function stripAnsi(str) {
  return String(str || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '');
}

function isCodexStatusNoiseLine(line) {
  const s = String(line || '').trim();
  if (!s) return true;
  if (/^[-\\|/\s]+$/.test(s)) return true;
  if (/^>\s*Improve documentation in @filename\s*$/i.test(s)) return true;
  if (/Use\s+\/skills\b/i.test(s)) return true;
  if (/\bContext\s+\d+%?\s+left\b/i.test(s)) return true;
  if (/\bgpt-\d[\w.-]*\b/i.test(s) && /\b(?:low|medium|high|xhigh)\b/i.test(s)) return true;
  if (/^\s*(?:Esc|Ctrl\+C|Enter)\b/i.test(s)) return true;
  if (/^\s*(?:cwd|workdir|working directory)\s*[:=]/i.test(s)) return true;
  if (/^[~.\\\/]*claude-session-hub\s*$/i.test(s)) return true;
  return false;
}

function cleanCodexOutput(text, maxChars = 1400) {
  const raw = stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw
    .split('\n')
    .map(line => line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trimEnd());

  const kept = [];
  for (const line of lines) {
    if (isCodexStatusNoiseLine(line)) continue;
    if (kept.length && kept[kept.length - 1] === line) continue;
    kept.push(line);
  }

  let clean = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return '';
  if (clean.length > maxChars) clean = clean.slice(clean.length - maxChars).trimStart();
  return clean;
}

function compactForCard(text, maxChars = 1400) {
  const clean = cleanCodexOutput(text, maxChars);
  if (!clean) return '';
  const lines = clean.split('\n');
  if (lines.length <= 18) return clean;
  return lines.slice(0, 16).join('\n') + '\n...';
}

module.exports = {
  stripAnsi,
  cleanCodexOutput,
  compactForCard,
  isCodexStatusNoiseLine,
};
