'use strict';
// Register an already installed, isolated runtime; never installs into Hub.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error('Usage: node scripts/register-dsh-cli.js <absolute-runtime-directory>');
const { resolveDshCliRuntime } = require('../core/dsh-cli-profile');
resolveDshCliRuntime({ cliRoot: root });
const versions = {};
for (const [name, version] of [['@deepseek-ai/dsh', '0.2.1-rc.2'], ['@deepseek-harness-tui/dsh-tui', '0.16.1']]) {
  const actual = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  if (actual !== version) throw new Error(`Runtime version requires validation: ${name} ${actual}, expected ${version}`);
  versions[name] = actual;
}
const file = path.join(os.homedir(), '.dsh', 'hub-cli-runtime.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
if (fs.existsSync(file)) {
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (path.resolve(existing.root) !== path.resolve(root)) throw new Error('An existing runtime is registered; review before replacing it');
}
fs.writeFileSync(file, JSON.stringify({ root: path.resolve(root), versions }, null, 2) + '\n');
console.log(file);
