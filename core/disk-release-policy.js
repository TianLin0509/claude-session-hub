'use strict';

const os = require('os');
const path = require('path');
const AGE_MS = 48 * 60 * 60 * 1000;

function inside(root, target, allowRoot = false) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return (allowRoot || rel !== '') && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function defaultScopes({ dataDir, testRoot } = {}) {
  const home = os.homedir();
  const temporary = os.tmpdir();
  if (testRoot) {
    if (!dataDir || !inside(path.dirname(dataDir), testRoot) || !inside(temporary, testRoot)) {
      throw new Error('测试清理目录必须位于本次隔离测试范围内');
    }
    return [{ root: path.resolve(testRoot), mode: 'tests', label: '隔离测试目录' }];
  }
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    { root: temporary, mode: 'tests', label: '临时测试数据' },
    { root: path.join(process.env.SystemDrive || 'C:', 'VibeData', 'Temp'), mode: 'emulators', label: 'Android 临时测试设备' },
    { root: path.join(local, 'npm-cache', '_cacache'), mode: 'cache', label: 'npm 下载缓存', note: '保留已安装的程序；以后安装相同依赖时会重新下载。' },
    { root: path.join(local, 'pip', 'cache'), mode: 'cache', label: 'pip 下载缓存', note: '保留 Python 环境；以后安装相同依赖时会重新下载。' },
  ];
}

function testLabel(name) {
  if (/^hub-writing/.test(name)) return 'Hub 写作测试';
  if (/^hub-(orch|orchestrator)/.test(name)) return 'Hub 编排测试';
  if (/^hub-devflow/.test(name)) return 'Hub 开发流程测试';
  if (/^hub-answers/.test(name)) return 'Hub 回答展示测试';
  if (/^chuxin-/.test(name)) return '投研工具测试';
  if (/^assistant-/.test(name)) return 'Hub 助手测试';
  return 'Hub 临时测试';
}

function recognizedTest(name) {
  return /^(hub-|assistant-|chuxin-.*hub|claude-session-hub-)/i.test(name);
}

module.exports = { AGE_MS, inside, defaultScopes, recognizedTest, testLabel };
