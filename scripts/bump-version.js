#!/usr/bin/env node
'use strict';
/**
 * 版本号抬升 —— 由合并脚本调用，工作位不要手动跑。
 *
 * 为什么这件事必须在合并那一刻做：
 *   版本号写在三个地方，而这三行是**所有并行分支都要改的同三行**。
 *   两个群聊同时基于同一个主干开工，第二个合进来的必然遇到
 *   「数值和主干撞了」或「文本冲突」二选一 —— 而分支自己无从知道
 *   它会是第几个合进去的，那个信息只有合并那一刻才存在。
 *   合并本身是串行的（merge_task.py 拿着锁），所以把抬版本挪到那里，
 *   这个冲突就从「结构性必然」变成「不可能发生」。
 *
 * 为什么不用 JSON.parse + JSON.stringify 重写文件：
 *   package-lock.json 两万多行，重新序列化会改掉缩进/换行/键序，
 *   把一次改 3 行的提交变成改两万行，代码审查和合并冲突都没法看。
 *   所以这里按行做定点替换，除版本号那几行外一个字节都不动。
 *
 * 用法：
 *   node scripts/bump-version.js              # patch +1
 *   node scripts/bump-version.js --set 1.7.0  # 指定版本
 *   node scripts/bump-version.js --print      # 只打印当前版本，不改文件
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// 三处版本号的位置。package.json 一处，package-lock.json 两处
//（顶层 version 和 npm v2+ lockfile 的 packages[""] 根条目）。
// unit-hub-version-sync.test.js 守着这三处必须一致。
const TARGETS = [
  { file: 'package.json', paths: [['version']] },
  { file: 'package-lock.json', paths: [['version'], ['packages', '', 'version']] },
];

/**
 * 在 npm 风格的美化 JSON 文本里，按「键路径」定点替换字符串值。
 *
 * 只认「一行一个构造」的美化格式（npm 和 JSON.stringify(…, 2) 都是这样写的）。
 * 认不出目标路径时返回 null 而不是猜 —— 猜错会把某个依赖的 version 改掉，
 * 那是一种不会报错、只会在下次 npm ci 时爆炸的破坏。
 */
function setJsonPathString(text, targetPath, value) {
  const lines = text.split('\n');
  const stack = [];           // 当前所在的键路径；数组/匿名层压 null
  let replaced = 0;
  for (let i = 0; i < lines.length; i++) {
    const cr = lines[i].endsWith('\r') ? '\r' : '';
    const body = cr ? lines[i].slice(0, -1) : lines[i];
    const trimmed = body.trim();
    if (!trimmed) continue;

    if (/^[}\]],?$/.test(trimmed)) { stack.pop(); continue; }

    // `{` / `[` / `"key": {` / `"key": [` —— 行尾就是括号才算开层，
    // 免得把 `"a": "带 { 的字符串"` 当成开层。
    const open = /^(?:"((?:[^"\\]|\\.)*)"\s*:\s*)?[{[]$/.exec(trimmed);
    if (open) { stack.push(open[1] === undefined ? null : JSON.parse(`"${open[1]}"`)); continue; }

    const leaf = /^"((?:[^"\\]|\\.)*)"\s*:\s*(.*?)(,?)$/.exec(trimmed);
    if (!leaf) continue;
    if (stack.slice(1).includes(null)) continue;   // 路过数组，不是我们要的路径

    const key = JSON.parse(`"${leaf[1]}"`);
    const here = [...stack.slice(1), key];
    if (here.length !== targetPath.length || here.some((part, n) => part !== targetPath[n])) continue;
    if (!/^"(?:[^"\\]|\\.)*"$/.test(leaf[2])) {
      throw new Error(`${targetPath.join('.')} 不是字符串值，拒绝改写：${trimmed}`);
    }
    const indent = body.slice(0, body.length - body.trimStart().length);
    lines[i] = `${indent}"${leaf[1]}": ${JSON.stringify(value)}${leaf[3]}${cr}`;
    replaced++;
  }
  return replaced === 1 ? lines.join('\n') : null;
}

function readVersion(repo = REPO) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('package.json 里没有 version');
  return pkg.version;
}

/** 只抬 patch。主/次版本是人的决定，脚本不替人做。 */
function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!m) throw new Error(`版本号不是纯数字三段式，脚本不敢猜：${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * 把新版本写进三处。返回真正改过的文件列表。
 * 任何一处定位失败都整体抛错，不留「只改了一半」的状态 —— 那比不改更糟。
 */
function writeVersion(nextVersion, repo = REPO) {
  const staged = [];
  for (const target of TARGETS) {
    const file = path.join(repo, target.file);
    if (!fs.existsSync(file)) {
      if (target.file === 'package.json') throw new Error(`找不到 ${target.file}`);
      continue;   // lock 文件不是每个项目都有
    }
    let text = fs.readFileSync(file, 'utf8');
    for (const p of target.paths) {
      const next = setJsonPathString(text, p, nextVersion);
      if (next === null) throw new Error(`在 ${target.file} 里定位不到 ${p.join('.')}，没有改任何文件`);
      text = next;
    }
    staged.push({ file, text, name: target.file });
  }
  for (const item of staged) fs.writeFileSync(item.file, item.text, 'utf8');
  return staged.map(item => item.name);
}

function main(argv) {
  const args = argv.slice(2);
  const current = readVersion();
  if (args.includes('--print')) { process.stdout.write(current + '\n'); return 0; }
  const setIndex = args.indexOf('--set');
  const next = setIndex >= 0 ? String(args[setIndex + 1] || '').trim() : bumpPatch(current);
  if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`目标版本号非法：${next || '(空)'}`);
  const files = writeVersion(next);
  process.stdout.write(`版本号 ${current} → ${next}（${files.join('、')}）\n`);
  return 0;
}

if (require.main === module) {
  try { process.exit(main(process.argv)); }
  catch (error) { process.stderr.write('✗ ' + (error && error.message) + '\n'); process.exit(1); }
}

module.exports = { setJsonPathString, bumpPatch, readVersion, writeVersion, TARGETS };
