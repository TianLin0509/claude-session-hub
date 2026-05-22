const fs = require('fs');
const path = require('path');

function readCssWithImports(filePath, seen = new Set()) {
  const resolved = path.resolve(filePath);
  if (seen.has(resolved)) return '';
  seen.add(resolved);

  const current = fs.readFileSync(resolved, 'utf8');
  const dir = path.dirname(resolved);
  const imports = [...current.matchAll(/@import\s+url\(['"]?([^'")]+)['"]?\);/g)]
    .map(match => path.resolve(dir, match[1]))
    .map(importPath => readCssWithImports(importPath, seen))
    .join('\n');

  return `${current}\n${imports}`;
}

module.exports = { readCssWithImports };
