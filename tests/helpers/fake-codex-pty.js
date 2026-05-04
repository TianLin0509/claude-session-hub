// Fake codex PTY — 单测辅助
//
// 用途：mimic node-pty spawn 出来的 codex CLI 进程的 stdout/stderr 字节流，
// 给 Phase 2（发送闭环）的 detectCodexAck / detectCodexStuck / parseEcho 单测吃。
//
// 设计原则：
//  - 不真起子进程，全内存模拟
//  - 提供 EventEmitter 接口让被测代码 .on('data', ...) 监听
//  - 提供 .write(input) 接口模拟用户输入回环
//  - 提供脚本化播放：emitAck() / emitStuckSilence() / emitEchoOnly() 等
//
// **B0.2/B0.3 真实采样后**：在 fixture .bin 文件里录制真实字节序列，
// 本 helper 提供 .replayFixture(path) 方法直接回放，单测就能跑真信号。

const { EventEmitter } = require('events');

class FakeCodexPty extends EventEmitter {
  constructor() {
    super();
    this._writeLog = [];   // 记录被测代码 .write 进来的所有字节
    this._closed = false;
  }

  // 被测代码调 .write(prompt + '\r') 给 codex
  write(data) {
    if (this._closed) throw new Error('FakeCodexPty: already closed');
    this._writeLog.push(typeof data === 'string' ? data : data.toString('utf8'));
  }

  // 单测脚本调：模拟 codex 输出 N 字节
  emit_data(bytes) {
    if (this._closed) return;
    this.emit('data', typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8'));
  }

  // 模拟 codex 收到 prompt 后正常 ack（粗略：echo prompt + 立即触发 spinner / status line）
  // **真实信号待 B0.2 录制后替换**
  emitAck(prompt) {
    // 假定 codex echo 用户输入（与 Claude/DS/GLM 通用）
    this.emit_data(`${prompt}\r\n`);
    // 假定 ack 信号：codex 状态行变更（如 "thinking..." 或 spinner）
    this.emit_data('\x1b[2K\rthinking...\r\n');
  }

  // 模拟 codex 卡住：发出后 N 毫秒内无任何回响
  // 单测里通常配合 jest.useFakeTimers() 跳过等待时间
  emitStuckSilence(durationMs = 5000) {
    // 空操作 — 静默就是 stuck 的信号
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  // 模拟 echo-only（用户输入回显但 codex 还没开始处理）
  emitEchoOnly(prompt) {
    this.emit_data(`${prompt}\r\n`);
  }

  // 回放预录的 fixture .bin（B0.2 真实采样后用）
  async replayFixture(fixturePath, { speedMultiplier = 1, timing = null } = {}) {
    const fs = require('fs').promises;
    const buf = await fs.readFile(fixturePath);
    if (timing && Array.isArray(timing)) {
      // timing: [{ offset_bytes, delay_ms }, ...]
      let cursor = 0;
      for (const seg of timing) {
        const chunk = buf.slice(cursor, seg.offset_bytes);
        if (chunk.length) this.emit_data(chunk);
        cursor = seg.offset_bytes;
        await _sleep(seg.delay_ms / speedMultiplier);
      }
      const tail = buf.slice(cursor);
      if (tail.length) this.emit_data(tail);
    } else {
      // 无 timing 文件 → 一次性 dump
      this.emit_data(buf);
    }
  }

  close() {
    this._closed = true;
    this.emit('exit', { exitCode: 0, signal: null });
  }

  // 单测断言用：取被测代码已写入的所有字节（拼成字符串）
  getWriteLog() {
    return this._writeLog.join('');
  }

  // 检查被测代码是否已发送过某个子串（用于 enter_only/rewrite_full 判定测试）
  hasWritten(substr) {
    return this.getWriteLog().includes(substr);
  }
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { FakeCodexPty };
