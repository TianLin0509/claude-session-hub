'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_EXTENSIONS = new Set([
  '.bat', '.cjs', '.cmd', '.css', '.html', '.js', '.json', '.mjs',
  '.ps1', '.py', '.sh', '.ts', '.tsx',
]);

const EXCLUDED_DIRECTORIES = new Set([
  '.arena', '.git', '.playwright-cli', '.pytest_cache', 'artifacts',
  'dist', 'node_modules', 'output',
]);

const RULES = [
  {
    id: 'sync-fs',
    severity: 'high',
    pattern: /\b(?:readFileSync|writeFileSync|appendFileSync|copyFileSync|openSync|readSync|writeSync|statSync|readdirSync|renameSync|unlinkSync|mkdirSync)\s*\(/g,
    note: 'Synchronous filesystem work can block an Electron main or renderer thread.',
  },
  {
    id: 'sync-child-process',
    severity: 'high',
    pattern: /\b(?:execFileSync|execSync|spawnSync)\s*\(/g,
    note: 'Synchronous child-process work blocks the caller until the process exits.',
  },
  {
    id: 'unbounded-loop',
    severity: 'critical',
    pattern: /\b(?:while\s*\(\s*(?:true|1)\s*\)|for\s*\(\s*;;\s*\))/g,
    note: 'An unbounded loop needs a proved asynchronous wait or explicit termination bound.',
  },
  {
    id: 'dynamic-buffer-allocation',
    severity: 'high',
    pattern: /\bBuffer\.alloc\s*\((?!\s*\d+\s*\))/g,
    note: 'Dynamic Buffer allocation may scale with transcript, PTY, or file size.',
  },
  {
    id: 'repeating-timer',
    severity: 'medium',
    pattern: /\bsetInterval\s*\(/g,
    note: 'Repeating timers require lifecycle cleanup and overlap protection.',
  },
  {
    id: 'file-watch',
    severity: 'medium',
    pattern: /\b(?:fs\.)?watch\s*\(/g,
    note: 'File watchers require deduplication, cleanup, and bounded callbacks.',
  },
  {
    id: 'full-dom-replacement',
    severity: 'medium',
    pattern: /\.innerHTML\s*=/g,
    note: 'Full DOM replacement in a hot event path can cause layout and listener churn.',
  },
  {
    id: 'session-list-render',
    severity: 'medium',
    pattern: /\brenderSessionList\s*\(/g,
    note: 'Sidebar rebuilds should be coalesced and proportional to changed rows.',
  },
  {
    id: 'json-parse',
    severity: 'info',
    pattern: /\bJSON\.parse\s*\(/g,
    note: 'Large JSON/JSONL parsing belongs off latency-sensitive threads.',
  },
  {
    id: 'event-listener',
    severity: 'info',
    pattern: /\b(?:addEventListener|ipcRenderer\.on|ipcMain\.on|\.on)\s*\(/g,
    note: 'Listeners need a clear owner and cleanup path when their scope is repeatable.',
  },
];

function normalizeRelative(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function classifyScope(relativePath) {
  if (relativePath === 'main.js' || relativePath === 'main-bootstrap.js'
      || /^(?:core|main|renderer|scripts)\//.test(relativePath)) return 'runtime';
  if (/^tests\//.test(relativePath) || relativePath === 'test-e2e.js') return 'test';
  if (/^tools\//.test(relativePath)) return 'tool';
  return 'operational';
}

function discoverSourceFiles(root) {
  const out = [];
  const visit = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      out.push(absolutePath);
    }
  };
  visit(root);
  return out.sort((a, b) => normalizeRelative(root, a).localeCompare(normalizeRelative(root, b)));
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function snippetAt(text, offset) {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const end = text.indexOf('\n', offset);
  return text.slice(start, end < 0 ? text.length : end).trim().slice(0, 220);
}

function scanFile(root, absolutePath) {
  const relativePath = normalizeRelative(root, absolutePath);
  const content = fs.readFileSync(absolutePath, 'utf8');
  const findings = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(content); match; match = rule.pattern.exec(content)) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        line: lineNumberAt(content, match.index),
        snippet: snippetAt(content, match.index),
        note: rule.note,
      });
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
    }
  }
  return {
    path: relativePath,
    scope: classifyScope(relativePath),
    bytes: Buffer.byteLength(content),
    lines: content === '' ? 0 : content.split(/\r?\n/).length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    scanned: true,
    findings: findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule)),
  };
}

function scanRepository(rootDir) {
  const root = path.resolve(rootDir);
  const files = discoverSourceFiles(root).map((filePath) => scanFile(root, filePath));
  const countsByScope = {};
  const countsBySeverity = {};
  for (const file of files) {
    countsByScope[file.scope] = (countsByScope[file.scope] || 0) + 1;
    for (const finding of file.findings) {
      countsBySeverity[finding.severity] = (countsBySeverity[finding.severity] || 0) + 1;
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    summary: {
      filesDiscovered: files.length,
      filesScanned: files.filter((file) => file.scanned).length,
      totalLines: files.reduce((sum, file) => sum + file.lines, 0),
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      countsByScope,
      countsBySeverity,
    },
    rules: RULES.map(({ id, severity, note }) => ({ id, severity, note })),
    files,
  };
}

function toMarkdown(report) {
  const lines = [
    '# AI HUB performance audit coverage',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Root: \`${report.root}\``,
    `- Files discovered/scanned: ${report.summary.filesDiscovered}/${report.summary.filesScanned}`,
    `- Lines: ${report.summary.totalLines}`,
    `- Scope counts: ${JSON.stringify(report.summary.countsByScope)}`,
    `- Finding counts: ${JSON.stringify(report.summary.countsBySeverity)}`,
    '',
    '## File coverage',
    '',
    '| File | Scope | Lines | SHA-256 | Findings |',
    '|---|---:|---:|---|---:|',
  ];
  for (const file of report.files) {
    lines.push(`| \`${file.path}\` | ${file.scope} | ${file.lines} | \`${file.sha256.slice(0, 16)}\` | ${file.findings.length} |`);
  }
  lines.push('', '## Heuristic findings', '');
  for (const file of report.files.filter((item) => item.findings.length > 0)) {
    lines.push(`### ${file.path}`, '');
    for (const finding of file.findings) {
      lines.push(`- ${finding.severity} \`${finding.rule}\` L${finding.line}: \`${finding.snippet.replace(/`/g, '\\`')}\``);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = { root: path.resolve(__dirname, '..'), output: null, format: 'json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = path.resolve(argv[++i]);
    else if (argv[i] === '--output') args.output = path.resolve(argv[++i]);
    else if (argv[i] === '--format') args.format = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!['json', 'markdown'].includes(args.format)) throw new Error(`Unsupported format: ${args.format}`);
  return args;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = scanRepository(args.root);
    const rendered = args.format === 'markdown' ? toMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) {
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      fs.writeFileSync(args.output, rendered, 'utf8');
      console.log(JSON.stringify({ ok: true, output: args.output, summary: report.summary }));
    } else {
      process.stdout.write(rendered);
    }
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  EXCLUDED_DIRECTORIES,
  RULES,
  SOURCE_EXTENSIONS,
  classifyScope,
  discoverSourceFiles,
  scanRepository,
  toMarkdown,
};
