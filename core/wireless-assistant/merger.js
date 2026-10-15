'use strict';
// 无线 Tab · SuperRAN 助理的审批合入一段（2026-10-15 田哥拍板）：审批人在协作台点「批准合入」后，
// 独立审查（换一个模型的新会话）和合入都由助理完成。这里只调用本机合并位脚本 review_merge.py：
// status 读协作台的代码交付记录，merge 跑完整测试、本地合并、推送阿里云并读回——确定性步骤，不调用模型。
// 凭据只在合并机自己的配置里，由脚本使用；Hub 不读不存。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');

function defaultScript(home = os.homedir()) {
  return process.env.CLAUDE_HUB_WIRELESS_REVIEW_MERGE || path.join(home, '.claude', 'skills', 'superran-review-merge', 'scripts', 'review_merge.py');
}

const ENV = () => ({ ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
const lastLine = text => String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || '';

// 协作台上的代码交付记录（PR 号、状态、候选与主干完整 SHA）。脚本报错如实抛出，由调用方显示原因。
function listTasks({ python = 'python', script, run = execFile, timeoutMs = 120000 }) {
  if (!script || !fs.existsSync(script)) return Promise.reject(new Error('本机没有合并位脚本 review_merge.py，自动审查与合入暂不可用'));
  return new Promise((resolve, reject) => {
    run(python, [script, 'status'], { cwd: path.dirname(script), timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: ENV() }, (error, stdout, stderr) => {
      if (error) { reject(new Error('读取代码交付记录失败：' + (lastLine(stderr) || error.message).slice(0, 300))); return; }
      try {
        const value = JSON.parse(stdout);
        if (!Array.isArray(value?.tasks)) throw new Error('返回内容不是交付记录');
        resolve(value);
      } catch (parse) { reject(new Error('代码交付记录无法解析：' + parse.message)); }
    });
  });
}

// 在途 PR 的候选各自改到的红档文件（v2.7.2 开工前避撞；只读，按候选缓存）。
function inflight({ python = 'python', script, run = execFile, timeoutMs = 180000 }) {
  if (!script || !fs.existsSync(script)) return Promise.reject(new Error('本机没有合并位脚本 review_merge.py'));
  return new Promise((resolve, reject) => {
    run(python, [script, 'inflight'], { cwd: path.dirname(script), timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: ENV() }, (error, stdout, stderr) => {
      if (error) { reject(new Error('读取在途改动失败：' + (lastLine(stderr) || error.message).slice(0, 300))); return; }
      try {
        const value = JSON.parse(stdout);
        if (!Array.isArray(value?.tasks)) throw new Error('返回内容不是在途记录');
        resolve(value);
      } catch (parse) { reject(new Error('在途改动无法解析：' + parse.message)); }
    });
  });
}

// 合入一个已批准的 PR：完整测试闸门约 15–30 分钟。输出全部写进日志文件，结束后解析最后的 JSON 回执。
// 连同完整测试闸门的子进程一起停（Windows 上只杀 python 会留下测试进程）。
function killTree(child) {
  if (!child?.pid || process.platform !== 'win32') { try { child?.kill?.(); } catch {} return; }
  try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch {}
}

function runMerge({ python = 'python', script, pr, candidate, logFile, spawnFn = spawn, timeoutMs = 90 * 60000, onChild }) {
  return new Promise(resolve => {
    let out = '', err = '', done = false, log = null, timer = null, child = null;
    const write = d => { if (!done && log) log.write(d); };
    const finish = value => { if (done) return; done = true; clearTimeout(timer); try { log?.end(); } catch {} resolve(value); };
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      log = fs.createWriteStream(logFile, { flags: 'a' });
      log.on('error', () => {});
      log.write(`\n=== ${new Date().toISOString()} merge PR #${pr} ${candidate}\n`);
      child = spawnFn(python, [script, 'merge', String(pr), '--candidate', candidate], { cwd: path.dirname(script), windowsHide: true, env: ENV() });
    } catch (error) { finish({ ok: false, error: '合并脚本没有启动：' + error.message }); return; }
    onChild?.(child);
    timer = setTimeout(() => { killTree(child); finish({ ok: false, error: '超过 ' + Math.round(timeoutMs / 60000) + ' 分钟还没合完，已停止' }); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', d => { out += d; write(d); });
    child.stderr?.on('data', d => { err += d; write(d); });
    child.on('error', e => finish({ ok: false, error: '合并脚本没有启动：' + e.message }));
    child.on('close', code => {
      let result = null;
      const at = out.lastIndexOf('\n{');
      try { result = JSON.parse((at >= 0 ? out.slice(at + 1) : out).trim()); } catch { result = null; }
      if (code === 0 && result) finish({ ok: true, result });
      else finish({ ok: false, code, error: (lastLine(err) || lastLine(out) || '合并脚本退出码 ' + code).slice(0, 300) });
    });
  });
}

module.exports = { defaultScript, listTasks, inflight, runMerge, killTree };
