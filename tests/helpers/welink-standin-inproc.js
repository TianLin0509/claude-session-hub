'use strict';
// 单测用：在测试进程里直接执行假 welink-cli（tests/fixtures/welink-cli-standin.js），不再每条命令起一个子进程。
// 简报取数一次要查十几个会话、还要翻页，起子进程在全量测试并行时会拖到超时（2026-10-18 合并闸门两次超时）。
// 白名单照样先过 welink.js 的 checkArgs；假程序自己照常把每条命令记进 WELINK_STANDIN_LOG。
const fs = require('node:fs');
const path = require('node:path');
const { checkArgs } = require('../../core/company-assistant/welink');

const FILE = path.join(__dirname, '..', 'fixtures', 'welink-cli-standin.js');
let compiled = null;

function standinRunner(env) {
  if (!compiled) compiled = new Function('require', 'process', fs.readFileSync(FILE, 'utf8'));
  return async (args, opts = {}) => {
    const list = checkArgs(args, { allowSetup: !!opts.allowSetup, sendGroup: opts.sendGroup || '' });
    let stdout = '', stderr = '';
    const proc = { argv: [process.execPath, FILE, ...list], env, exitCode: 0,
      stdout: { write: s => { stdout += s; return true; } }, stderr: { write: s => { stderr += s; return true; } } };
    compiled(require, proc);
    // 扫码登录会在 2 秒后再输出一句：等它写完再返回，和子进程的行为一致。
    if (list[0] === 'auth' && list[1] === 'login') await new Promise(r => setTimeout(r, 2100));
    return { code: proc.exitCode || 0, stdout, stderr };
  };
}

module.exports = { standinRunner };
