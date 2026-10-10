#!/usr/bin/env node
'use strict';

// 把主仓库的某个提交导出成公开社区版源码树。
//
//   node scripts/community/export-community.js --out <空目录> [--ref <提交|WORKTREE>] [--version 0.2.0]
//
// 流程（任何一步失败都不留半成品在目标目录里当作可用结果）：
//   1. 取源：默认把 <ref> 这个提交检出到暂存目录，只含已提交内容。之后的清单、覆盖文件
//      全部从暂存目录读取，不读当前工作区，所以同一个完整 SHA 永远导出同一份内容。
//      --ref WORKTREE 只用于开发迭代：取已跟踪文件与未忽略的新文件的当前内容，
//      有任何未提交改动（含未跟踪文件）都如实标记 upstreamDirty。
//   2. 按 community/manifest.json 的 include 取文件，再按 drop 删掉私人模块。
//   3. 处理剥离标记：`@community-strip … @community-end` 整段删除，
//      其中 `@community-else` 之后的注释行去掉注释符保留（私人版里它们只是注释）。
//   4. 注释与文案脱敏（manifest.scrub），再用 community/overlay 覆盖（公开文档、安装器、
//      同接口空桩、社区测试）。
//   5. 写 community-edition.json 与 package 元数据。
//   6. 闸门：剥离标记必须全部处理掉、全部 JS 通过语法检查、相对 require 与页面引用都能解析、
//      身份与私人服务的泄露规则零命中。闸门不过就以非 0 退出。
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');
const { applyStripMarkers } = require('./strip-markers');
const { scanTree } = require('./leak-rules');

const ROOT = path.resolve(__dirname, '..', '..');
// 导出程序本身（这三个文件）按当前运行的版本执行；报告里写明它们是否与被导出的提交一致。
const EXPORTER_FILES = ['scripts/community/export-community.js', 'scripts/community/strip-markers.js', 'scripts/community/leak-rules.js'];
// 覆盖文件里的版本占位符，导出时替换成本次发行版本（安装器默认版本、文档里的安装命令）。
const VERSION_TOKENS = {
  '@@COMMUNITY_TAG@@': v => `v${v.edition}`,
  '@@COMMUNITY_VERSION@@': v => v.edition,
  '@@UPSTREAM_VERSION@@': v => v.upstream,
};
const TEXT_EXT = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.md', '.ps1', '.bat', '.cmd', '.py', '.yml', '.yaml', '.txt', '.svg', '.toml']);

function parseArgs(argv) {
  const args = { ref: 'HEAD', out: null, version: null, keepStaging: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--out') args.out = argv[++i];
    else if (key === '--ref') args.ref = argv[++i];
    else if (key === '--version') args.version = argv[++i];
    else if (key === '--target') args.target = argv[++i];
    else if (key === '--all-leaks') args.allLeaks = true;
    else if (key === '--help' || key === '-h') args.help = true;
    else throw new Error(`未知参数：${key}`);
  }
  return args;
}

function git(args, root = ROOT) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function toPosix(p) { return p.split(path.sep).join('/'); }

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; }
      else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function matcher(patterns) {
  const regs = (patterns || []).map(globToRegExp);
  return file => regs.some(re => re.test(file));
}

function collectSource(ref, staging, root = ROOT) {
  if (ref === 'WORKTREE') {
    const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root).split('\0').filter(Boolean);
    for (const file of files) {
      const source = path.join(root, file);
      let stat;
      try { stat = fs.lstatSync(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile()) continue;
      const target = path.join(staging, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    // 未跟踪文件同样会进入导出，所以脏状态必须把它们算进去。
    return { commit: git(['rev-parse', 'HEAD'], root).trim(), dirty: git(['status', '--porcelain', '--untracked-files=normal'], root).trim() !== '' };
  }
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`], root).trim();
  // 用一份临时 index 把该提交检出到暂存目录：只用 git 自己，不依赖 tar（Git Bash 里的
  // GNU tar 会把 C: 当成远程主机）；仓库自己的 index、HEAD 和工作区都不受影响。
  const indexFile = path.join(os.tmpdir(), `ai-hub-community-${process.pid}-${Date.now()}.index`);
  try {
    execFileSync('git', ['--work-tree', staging, 'checkout', commit, '--', '.'], {
      cwd: root, env: { ...process.env, GIT_INDEX_FILE: indexFile }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
  return { commit, dirty: false };
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(toPosix(path.relative(base, full)));
  }
  return out;
}

function copyFileInto(sourceRoot, file, targetRoot) {
  const target = path.join(targetRoot, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, file), target);
}

function isText(file) { return TEXT_EXT.has(path.extname(file).toLowerCase()); }

function applyScrub(text, rules) {
  let out = text;
  for (const rule of rules) out = out.replace(new RegExp(rule.pattern, rule.flags || 'g'), rule.replace);
  return out;
}

// 相对 require / import 能否解析；页面里的 <script src> / <link href> 是否存在。
function checkReferences(outDir, files) {
  const problems = [];
  const exists = rel => fs.existsSync(path.join(outDir, rel));
  const resolveModule = (fromFile, spec) => {
    const base = toPosix(path.normalize(path.join(path.dirname(fromFile), spec)));
    const candidates = [base, base + '.js', base + '.json', base + '.cjs', base + '/index.js'];
    return candidates.some(exists);
  };
  const requireRe = /(?:require\(\s*|from\s+|import\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g;
  for (const file of files.filter(f => /\.(c|m)?js$/.test(f))) {
    // 注释里的用法示例不算依赖。
    const text = fs.readFileSync(path.join(outDir, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    let match;
    while ((match = requireRe.exec(text))) {
      if (!resolveModule(file, match[2])) problems.push({ file, missing: match[2] });
    }
  }
  for (const file of files.filter(f => f.endsWith('.html'))) {
    const text = fs.readFileSync(path.join(outDir, file), 'utf8');
    const refRe = /<(?:script|link)\b[^>]*?\b(?:src|href)="([^"#?:]+)"/g;
    let match;
    while ((match = refRe.exec(text))) {
      const rel = toPosix(path.normalize(path.join(path.dirname(file), match[1])));
      if (rel.startsWith('node_modules/')) continue; // 依赖由 npm 安装，不在导出树里
      if (!exists(rel)) problems.push({ file, missing: match[1] });
    }
  }
  return problems;
}

// 与 node --check 等价的 CommonJS 语法检查，在同一进程里编译，不为每个文件起子进程。
function checkSyntax(outDir, files) {
  const problems = [];
  for (const file of files.filter(f => /\.(c)?js$/.test(f))) {
    const source = fs.readFileSync(path.join(outDir, file), 'utf8').replace(/^#!.*/, '');
    try {
      new vm.Script(`(function (exports, require, module, __filename, __dirname) {${source}\n})`, { filename: file });
    } catch (error) {
      problems.push({ file, error: String(error && error.message || error) });
    }
  }
  return problems;
}

function updatePackage(outDir, manifest, versions) {
  const pkgPath = path.join(outDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const meta = manifest.package || {};
  pkg.name = meta.name || 'ai-hub-community';
  pkg.version = versions.edition;
  if (meta.description) pkg.description = meta.description;
  if (meta.license) pkg.license = meta.license;
  if (meta.repository) pkg.repository = meta.repository;
  if (meta.engines) pkg.engines = meta.engines;
  pkg.scripts = { ...(meta.scripts || {}) };
  pkg.build = pkg.build || {};
  if (meta.build) {
    for (const [key, value] of Object.entries(meta.build)) {
      pkg.build[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? { ...(pkg.build[key] || {}), ...value } : value;
    }
  }
  if (Array.isArray(pkg.build.files) && !pkg.build.files.includes('community-edition.json')) pkg.build.files.push('community-edition.json');
  // 追加的打包过滤（例如排除依赖自带的构建源码，缩短解压后的路径）。
  for (const pattern of meta.buildFilesAppend || []) {
    if (Array.isArray(pkg.build.files) && !pkg.build.files.includes(pattern)) pkg.build.files.push(pattern);
  }
  delete pkg.author;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  const lockPath = path.join(outDir, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.name = pkg.name;
    lock.version = pkg.version;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].name = pkg.name;
      lock.packages[''].version = pkg.version;
      if (pkg.license) lock.packages[''].license = pkg.license;
      if (pkg.engines) lock.packages[''].engines = pkg.engines;
    }
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  }
}

// 导出程序文件与被导出提交里的同名文件是否一致。不一致说明是用别的版本的规则导出的，
// 报告里写明，由维护者判断；WORKTREE 模式下没有可比对的提交，记为 null。
function exporterProvenance(ref, commit, root) {
  if (ref === 'WORKTREE' || path.resolve(root) !== ROOT) return { matchesExportedCommit: null, differs: [] };
  const differs = [];
  for (const rel of EXPORTER_FILES) {
    let committed = null;
    try { committed = git(['show', `${commit}:${rel}`], root); } catch {}
    const running = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (committed === null || committed.replace(/\r\n/g, '\n') !== running.replace(/\r\n/g, '\n')) differs.push(rel);
  }
  return { matchesExportedCommit: differs.length === 0, differs };
}

function applyVersionTokens(text, versions) {
  let out = text;
  for (const [token, value] of Object.entries(VERSION_TOKENS)) out = out.split(token).join(value(versions));
  return out;
}

// 发行目标：默认是公开社区版；--target <名> 读 community/targets/<名>/target.json，
// 在社区版覆盖文件之后再叠一层该目标的 overlay，并把仓库地址换成目标仓库（例如公司版）。
const COMMUNITY_REPO = 'TianLin0509/ai-hub-community';
function exportCommunity({ ref = 'HEAD', out, version = null, root = ROOT, target = null } = {}) {
  if (!out) throw new Error('需要 --out <目录>');
  const outDir = path.resolve(out);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`目标目录不是空的：${outDir}（导出从不覆盖已有内容）`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-community-src-'));
  try {
    const source = collectSource(ref, staging, root);
    // 清单和覆盖文件都来自被导出的快照本身，不读当前工作区。
    const communityDir = path.join(staging, 'community');
    const manifestPath = path.join(communityDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`被导出的提交里没有 community/manifest.json：${source.commit}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const upstreamVersion = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8')).version;
    let targetSpec = null;
    if (target) {
      if (!/^[a-z0-9-]+$/.test(target)) throw new Error(`发行目标名称无效：${target}`);
      const specPath = path.join(communityDir, 'targets', target, 'target.json');
      if (!fs.existsSync(specPath)) throw new Error(`被导出的提交里没有发行目标：${target}`);
      targetSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(String(targetSpec.repo || ''))) throw new Error('target.json 缺少有效的 repo');
    }
    const versions = { edition: version || (targetSpec && targetSpec.version) || manifest.version, upstream: upstreamVersion };
    if (!versions.edition) throw new Error('缺少社区版版本号（manifest.version 或 --version）');
    let imageShrink = null;

    const include = matcher(manifest.include);
    const drop = matcher(manifest.drop);
    const all = listFiles(staging);
    const selected = all.filter(file => include(file) && !drop(file));
    const dropped = all.filter(file => include(file) && drop(file));
    fs.mkdirSync(outDir, { recursive: true });
    const stripReport = [];
    for (const file of selected) {
      if (!isText(file)) { copyFileInto(staging, file, outDir); continue; }
      let text = fs.readFileSync(path.join(staging, file), 'utf8');
      const stripped = applyStripMarkers(text, file);
      if (stripped.regions) stripReport.push({ file, regions: stripped.regions });
      text = applyScrub(stripped.text, manifest.scrub || []);
      const target = path.join(outDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
    }
    const overlayDir = path.join(communityDir, 'overlay');
    const overlay = fs.existsSync(overlayDir) ? listFiles(overlayDir) : [];
    for (const file of overlay) {
      if (!isText(file)) { copyFileInto(overlayDir, file, outDir); continue; }
      const target = path.join(outDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, applyVersionTokens(fs.readFileSync(path.join(overlayDir, file), 'utf8'), versions), 'utf8');
    }
    const targetOverlayDir = targetSpec ? path.join(communityDir, 'targets', target, 'overlay') : null;
    const targetOverlay = targetOverlayDir && fs.existsSync(targetOverlayDir) ? listFiles(targetOverlayDir) : [];
    for (const file of targetOverlay) {
      if (!isText(file)) { copyFileInto(targetOverlayDir, file, outDir); continue; }
      const dest = path.join(outDir, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, applyVersionTokens(fs.readFileSync(path.join(targetOverlayDir, file), 'utf8'), versions), 'utf8');
    }

    // 发行包里的大图缩到界面实际需要的尺寸（2026-10-10：38 张 1254px 的 PNG 占了 app.asar 的 34 MB，
    // 界面只按 24-168px 显示）。只改导出结果，主仓库保留原图。
    const shrink = manifest.shrinkImages && Object.keys(manifest.shrinkImages).length ? manifest.shrinkImages : null;
    if (shrink) {
      if (process.platform !== 'win32') throw new Error('shrinkImages 需要在 Windows 上导出（用 System.Drawing 缩图）');
      const rules = Object.entries(shrink).map(([dir, max]) => `${dir}=${Number(max)}`).join(';');
      const run = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'shrink-images.ps1'), '-Root', outDir, '-Rules', rules], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
      const line = String(run.stdout || '').trim().split(/\r?\n/).pop() || '';
      if (run.status !== 0 || !/^\d+\|\d+\|\d+$/.test(line)) throw new Error(`缩图失败：${(run.stderr || run.stdout || '').trim().slice(0, 500)}`);
      const [count, before, after] = line.split('|').map(Number);
      imageShrink = { count, beforeBytes: before, afterBytes: after };
    }

    fs.writeFileSync(path.join(outDir, 'community-edition.json'), JSON.stringify({
      edition: 'community', ...(targetSpec ? { target, repo: targetSpec.repo, ...(targetSpec.features ? { features: targetSpec.features } : {}) } : {}), version: versions.edition, upstreamVersion: versions.upstream,
      upstreamCommit: source.commit, upstreamDirty: source.dirty,
    }, null, 2) + '\n', 'utf8');
    updatePackage(outDir, manifest, versions);
    if (targetSpec && targetSpec.repo !== COMMUNITY_REPO) {
      for (const file of listFiles(outDir).filter(isText)) {
        const full = path.join(outDir, file);
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes(COMMUNITY_REPO)) fs.writeFileSync(full, text.split(COMMUNITY_REPO).join(targetSpec.repo), 'utf8');
      }
    }

    const files = listFiles(outDir);
    const leftover = files.filter(isText).filter(file => /@community-(?:strip|else|end)\b|@@COMMUNITY_[A-Z]+@@/.test(fs.readFileSync(path.join(outDir, file), 'utf8')));
    const references = checkReferences(outDir, files);
    const syntax = checkSyntax(outDir, files);
    const hits = scanTree(outDir, files);
    const leaks = hits.filter(hit => hit.severity !== 'residue');
    const residue = hits.filter(hit => hit.severity === 'residue');
    // 公开库自带的通用审计（真实用户目录、账号文件、密钥形态）也必须在导出树上通过。
    const audit = spawnSync(process.execPath, [path.join(outDir, 'scripts', 'audit-public.js')], {
      cwd: outDir, encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GIT_DIR: path.join(outDir, '.no-git') },
    });
    let publicAudit;
    try { publicAudit = JSON.parse(audit.stdout); } catch { publicAudit = { ok: false, failures: [{ rule: 'audit did not run', detail: String(audit.stderr || audit.error || '').slice(0, 400) }] }; }
    const report = {
      ok: !leftover.length && !references.length && !syntax.length && !leaks.length && publicAudit.ok === true,
      out: outDir, ref, upstreamCommit: source.commit, upstreamDirty: source.dirty,
      exporter: exporterProvenance(ref, source.commit, root),
      edition: versions.edition, upstreamVersion: versions.upstream,
      counts: { upstreamFiles: all.length, exported: files.length, dropped: dropped.length, overlay: overlay.length, strippedFiles: stripReport.length },
      leftoverMarkers: leftover, unresolvedReferences: references, syntaxErrors: syntax, leaks,
      residue: { count: residue.length, files: [...new Set(residue.map(hit => hit.file))].length, hits: residue },
      publicAudit: { ok: publicAudit.ok === true, failures: publicAudit.failures || [] },
      ...(imageShrink ? { imageShrink } : {}),
    };
    return report;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('node scripts/community/export-community.js --out <空目录> [--ref <提交|WORKTREE>] [--version x.y.z]');
      process.exit(0);
    }
    const report = exportCommunity(args);
    const all = args.allLeaks;
    const brief = { ...report, leaks: all ? report.leaks : report.leaks.slice(0, 80), leakCount: report.leaks.length,
      residue: all ? report.residue : { count: report.residue.count, files: report.residue.files } };
    console.log(JSON.stringify(brief, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(`[export-community] ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { exportCommunity, globToRegExp, checkReferences };
