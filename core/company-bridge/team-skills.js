'use strict';
// 特战队团队版 skill（2026-10-18）：随 Hub 打包，只在用邀请码接入的家里电脑上装，装到 Claude 与 Codex 共用的两个目录。
// 只新增不覆盖：目标不存在才装；有本模块写的标记、且 SKILL.md 自装上后没被改过，才随 Hub 升级；其余（自己写的同名 skill、改过的）原样保留。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const SOURCE_ROOT = path.join(__dirname, 'team-skills');
const MARK = '.ai-hub-team-skill.json';
const hash = text => createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

function bundled(sourceRoot = SOURCE_ROOT) {
  let names = [];
  try { names = fs.readdirSync(sourceRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch {}
  return names.map(name => ({ name, text: readText(path.join(sourceRoot, name, 'SKILL.md')) })).filter(s => s.text);
}

// known：以前在这台电脑上装过的位置（Hub 记着）。用户自己删掉的不再装回去。
function installTeamSkills({ homeDir = os.homedir(), sourceRoot = SOURCE_ROOT, now = Date.now, known = [] } = {}) {
  const report = { installed: [], updated: [], kept: [], unchanged: [], removed: [], errors: [] };
  const knownSet = new Set(known);
  const roots = ['.claude', '.agents'].map(x => path.join(homeDir, x, 'skills'));
  for (const skill of bundled(sourceRoot)) {
    const want = hash(skill.text);
    for (const root of roots) {
      const dir = path.join(root, skill.name), file = path.join(dir, 'SKILL.md'), markFile = path.join(dir, MARK);
      const where = path.join(path.basename(path.dirname(root)), 'skills', skill.name);
      try {
        let exists = false; try { fs.lstatSync(dir); exists = true; } catch {}
        if (!exists && knownSet.has(where)) { report.removed.push(where); continue; }
        if (!exists) {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, skill.text, 'utf8');
          fs.writeFileSync(markFile, JSON.stringify({ name: skill.name, sha256: want, installedAt: new Date(now()).toISOString() }), 'utf8');
          report.installed.push(where); continue;
        }
        const mark = readJson(markFile), current = readText(file);
        if (!mark || current == null || hash(current) !== mark.sha256) { report.kept.push(where); continue; } // 不是 Hub 装的，或装上后被改过
        if (mark.sha256 === want) { report.unchanged.push(where); continue; }
        fs.writeFileSync(file, skill.text, 'utf8');
        fs.writeFileSync(markFile, JSON.stringify({ ...mark, sha256: want, updatedAt: new Date(now()).toISOString() }), 'utf8');
        report.updated.push(where);
      } catch (error) { report.errors.push(`${where}：${error.message}`); }
    }
  }
  return report;
}

module.exports = { installTeamSkills, bundled, MARK };
