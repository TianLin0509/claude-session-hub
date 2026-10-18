'use strict';
// 修正公司个人账号的 CodeAgent 默认模型（远程维护 set-personal-model，2026-10-19 田哥明确授权：「授权你来做」）。
//
// 背景：公司个人账号只有 GLM-5.2-WX-Auto 权限，个人配置目录 settings.json 的 model 却是 deepseek-v4-flash-0731，
// 个人账号开出来的会话一启动就报「模型 … 不存在或配置有误」（2026-10-19 00:18 直查 errors 段原文）。
// 只能由对端经远程维护手动触发，Hub 不会自动改这份文件（号主自己日常用的配置）。
//
// 做法（只动 model 这一个键，其余内容原样保留）：
//   1. 目标模型必须在个人账号的权限清单里（「一键获取模型权限」的探测文件，没有时用配置文件里的账号清单）；撤销（restore）时用最近一次备份里的值；
//   2. 改前把原文件整份备份为 settings.json.hub-backup-<时间>（撤销时自己的备份带 -undo 后缀，撤销只认非 -undo 的，连点两次撤销结果一样）；
//   3. 先写临时文件再改名（失败重试一次）；写完回读核对：model 是目标值、其余键和原来一致；核对不过就用备份还原并报失败；
//   4. 只影响之后新开的会话：CodeAgent 开会话时读一次 settings.json，已在跑的会话不受影响。
// 个人账号目录落在号池目录里（配置异常）时拒绝，绝不改号池账号的目录。
const fs = require('fs');
const path = require('path');

const BACKUP_PREFIX = 'settings.json.hub-backup-';
const KEEP_BACKUPS = 10;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

function stamp(now) {
  const d = new Date(Number(now) + 8 * 3600000); // 北京时间，便于人看
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`;
}
function parseSettings(raw) {
  if (raw == null || !String(raw).trim()) return {};
  const v = JSON.parse(String(raw).replace(/^﻿/, ''));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('settings.json 不是对象');
  return v;
}
const modelOf = obj => (typeof obj.model === 'string' ? obj.model : undefined);
const withoutModel = obj => { const { model, ...rest } = obj; void model; return JSON.stringify(rest); };

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// 个人账号的权限清单（和号表同一口径）
function allowedModels({ dataDir, personalDir, fsModule = fs }) {
  const pool = require('./codeagent-pool');
  const known = pool.accountModels(personalDir, fsModule, dataDir ? pool.personalModelsFile(dataDir) : null);
  return (known.models || []).slice();
}

function listBackups(personalDir, fsModule = fs) {
  let names = [];
  try { names = fsModule.readdirSync(personalDir).filter(n => n.startsWith(BACKUP_PREFIX)); } catch { names = []; }
  return names.sort(); // 时间戳定长，按名字排就是按时间排
}

function atomicWrite(file, text, fsModule) {
  const tmp = `${file}.hub-model-${process.pid}-${Date.now()}.tmp`;
  fsModule.writeFileSync(tmp, text, 'utf8');
  try {
    try { fsModule.renameSync(tmp, file); }
    catch { fsModule.renameSync(tmp, file); } // Windows 上 CodeAgent 或杀毒正读着时偶尔失败：重试一次
  } catch (error) {
    try { fsModule.unlinkSync(tmp); } catch { /* 临时文件已不在 */ }
    throw error;
  }
}

// 返回 { ok, changed, before, after, backup, verified, rolledBack?, error?, allowed }；参数或前提不对直接抛错（调用方回报原因）。
function setPersonalModel({ dataDir, personalDir, model = '', restore = false, now = Date.now(), fsModule = fs } = {}) {
  if (!personalDir) throw new Error('读不到个人账号的配置目录');
  if (dataDir && inside(personalDir, require('./codeagent-pool').poolRoot(dataDir))) {
    throw new Error('个人账号的配置目录落在号池目录里，这不是个人账号的目录，不改');
  }
  const file = path.join(personalDir, 'settings.json');
  let raw = null;
  try { raw = fsModule.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('读不了 settings.json：' + error.message); }
  let current;
  try { current = parseSettings(raw); } catch (error) { throw new Error('settings.json 不是有效的 JSON，没改：' + error.message); }
  const before = modelOf(current);
  const allowed = allowedModels({ dataDir, personalDir, fsModule });

  let target, restoredFrom = null;
  if (restore) {
    const backups = listBackups(personalDir, fsModule).filter(n => !n.endsWith('-undo'));
    if (!backups.length) throw new Error('没有可以撤销的备份（还没用 set-personal-model 改过）');
    restoredFrom = backups[backups.length - 1];
    let saved;
    try { saved = parseSettings(fsModule.readFileSync(path.join(personalDir, restoredFrom), 'utf8')); }
    catch (error) { throw new Error(`备份 ${restoredFrom} 读不了：${error.message}`); }
    target = modelOf(saved);
  } else {
    const want = String(model || '').trim();
    if (!MODEL_ID.test(want)) throw new Error('model 要是模型名（如 GLM-5.2-WX-Auto）');
    if (!allowed.length) throw new Error('个人账号的模型权限清单未知（先在「账号与号池」里获取模型权限），不改');
    target = allowed.find(m => m.toLowerCase() === want.toLowerCase());
    if (!target) throw new Error(`${want} 不在个人账号的权限清单里，可选：${allowed.join('、')}`);
  }
  if (target === before) {
    return { ok: true, changed: false, before: before ?? '', after: target ?? '', backup: null, verified: true, allowed, restoredFrom };
  }

  // 1. 整份备份（原来没有文件就记成 {}，撤销时等于去掉 model）
  const backup = BACKUP_PREFIX + stamp(now) + (restore ? '-undo' : '');
  const backupText = raw == null ? '{}\n' : raw;
  fsModule.writeFileSync(path.join(personalDir, backup), backupText, 'utf8');
  // 2. 只改 model 这一个键
  const next = { ...current };
  if (target === undefined) delete next.model; else next.model = target;
  atomicWrite(file, JSON.stringify(next, null, 2) + '\n', fsModule);
  // 3. 回读核对：model 是目标值，其余键和原来一致
  let verified = false, why = '';
  try {
    const back = parseSettings(fsModule.readFileSync(file, 'utf8'));
    verified = modelOf(back) === target && withoutModel(back) === withoutModel(current);
    if (!verified) why = `回读到的 model 是 ${modelOf(back) ?? '（空）'}${withoutModel(back) === withoutModel(current) ? '' : '，且其他内容也不一致'}`;
  } catch (error) { why = '回读失败：' + error.message; }
  if (!verified) {
    let rolledBack = false;
    try {
      if (raw == null) fsModule.rmSync(file, { force: true });
      else atomicWrite(file, raw, fsModule);
      rolledBack = true;
    } catch (error) { why += `；从备份还原也失败了（${error.message}），备份在 ${backup}`; }
    return { ok: false, changed: false, before: before ?? '', after: before ?? '', backup, verified: false, rolledBack,
      error: `写入后核对不一致（${why}）${rolledBack ? '，已从备份还原' : ''}`, allowed, restoredFrom };
  }
  // 4. 备份只留最近 10 份（修改的和撤销的分开算，撤销用的那份不会被撤销备份挤掉）
  const all = listBackups(personalDir, fsModule);
  for (const group of [all.filter(n => !n.endsWith('-undo')), all.filter(n => n.endsWith('-undo'))]) {
    for (const old of group.slice(0, Math.max(0, group.length - KEEP_BACKUPS))) { try { fsModule.rmSync(path.join(personalDir, old), { force: true }); } catch { /* 删不掉下次再删 */ } }
  }
  return { ok: true, changed: true, before: before ?? '', after: target ?? '', backup, verified: true, allowed, restoredFrom };
}

module.exports = { setPersonalModel, allowedModels, listBackups, BACKUP_PREFIX, KEEP_BACKUPS };
