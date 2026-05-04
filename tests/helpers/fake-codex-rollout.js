// Fake codex rollout writer — 单测辅助
//
// 用途：mimic codex CLI 写入 ~/.codex/sessions/YYYY/MM/DD/rollout-<sid>.jsonl 的行为。
// 单测把 fake rollout 写到 tmp 目录，**注入**到被测代码的 sessionsRoot（Phase 1
// B1.2 GREEN 时给 CodexTap 加 opts.sessionsRoot 入口），就能完全离线 / 不污染真实
// ~/.codex/sessions 跑单测。
//
// 设计原则：
//  - 不依赖 transcript-tap.js 内部实现
//  - 只产生 JSONL 字节（被测的 CodexTap 自己 tail / parse）
//  - 单 helper 一个 fixture 文件实例，方法链式 API
//
// 使用样例（伪代码，待 Phase 1 真实落地）：
//   const fr = new FakeCodexRollout({ sessionsRoot: tmpDir, cwd: '/work/proj' });
//   await fr.start();                              // 写 session_meta
//   await fr.writeAgentMessage('thinking out loud...');
//   await fr.writeTaskStarted();
//   await fr.writeAgentMessage('intermediate');
//   await fr.writeTaskComplete('final answer here', 1234);
//   const path = fr.rolloutPath;                    // 给被测 CodexTap 用
//   await fr.cleanup();

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class FakeCodexRollout {
  /**
   * @param {object} opts
   * @param {string} opts.sessionsRoot  base dir，默认 os.tmpdir()/fake-codex-sessions/
   * @param {string} opts.cwd           session_meta.cwd（用于绑定匹配）
   * @param {string} [opts.sid]         显式指定 sid（默认随机 UUID v7-like）
   * @param {Date}   [opts.startAt]     session_meta.timestamp（默认 now）
   * @param {string} [opts.cliVersion]  默认 "0.125.0"
   * @param {string} [opts.source]      "cli" | "mcp"，默认 "cli"
   */
  constructor(opts = {}) {
    if (!opts.cwd) throw new Error('FakeCodexRollout: cwd required');
    this.sessionsRoot = opts.sessionsRoot || path.join(os.tmpdir(), 'fake-codex-sessions');
    this.cwd = opts.cwd;
    this.sid = opts.sid || _generateSid();
    this.startAt = opts.startAt || new Date();
    this.cliVersion = opts.cliVersion || '0.125.0';
    this.source = opts.source || 'cli';

    const d = this.startAt;
    const dirParts = [
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ];
    this.dayDir = path.join(this.sessionsRoot, ...dirParts);
    const fname = `rollout-${_isoForFilename(d)}-${this.sid}.jsonl`;
    this.rolloutPath = path.join(this.dayDir, fname);

    this._stream = null;
    this._started = false;
  }

  // 创建目录 + 写 session_meta 首行
  async start({ baseInstructionsText = '' } = {}) {
    if (this._started) throw new Error('FakeCodexRollout: already started');
    await fs.promises.mkdir(this.dayDir, { recursive: true });
    this._stream = fs.createWriteStream(this.rolloutPath, { flags: 'w' });
    this._started = true;

    await this._writeLine({
      timestamp: this.startAt.toISOString(),
      type: 'session_meta',
      payload: {
        id: this.sid,
        timestamp: this.startAt.toISOString(),
        cwd: this.cwd,
        originator: 'codex_cli_rs',
        cli_version: this.cliVersion,
        source: this.source,
        model_provider: 'openai',
        base_instructions: { text: baseInstructionsText },
      },
    });
  }

  async writeTaskStarted({ at = new Date() } = {}) {
    this._ensureStarted();
    await this._writeLine({
      timestamp: at.toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started' },
    });
  }

  async writeAgentMessage(message, { at = new Date() } = {}) {
    this._ensureStarted();
    await this._writeLine({
      timestamp: at.toISOString(),
      type: 'event_msg',
      payload: { type: 'agent_message', message },
    });
  }

  async writeTaskComplete(lastAgentMessage, durationMs = 1000, { at = new Date() } = {}) {
    this._ensureStarted();
    await this._writeLine({
      timestamp: at.toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        last_agent_message: lastAgentMessage,
        duration_ms: durationMs,
      },
    });
  }

  // 模拟一个**仅 commentary 无 task_complete** 的 streaming 段（partial_commentary 场景）
  async writeStreamingOnly(messages, { startAt = new Date(), gapMs = 100 } = {}) {
    for (let i = 0; i < messages.length; i++) {
      const at = new Date(startAt.getTime() + i * gapMs);
      await this.writeAgentMessage(messages[i], { at });
    }
  }

  // 模拟一个**完整 turn**：agent_message * N + task_complete
  async writeFullTurn(commentaryMessages, finalMessage, { startAt = new Date(), gapMs = 100 } = {}) {
    await this.writeStreamingOnly(commentaryMessages, { startAt, gapMs });
    const finalAt = new Date(startAt.getTime() + commentaryMessages.length * gapMs);
    await this.writeTaskComplete(finalMessage, gapMs * (commentaryMessages.length + 1), { at: finalAt });
  }

  // 写一个原始 JSON 对象（高级用法）
  async writeRaw(obj) {
    this._ensureStarted();
    await this._writeLine(obj);
  }

  async close() {
    if (!this._stream) return;
    await new Promise((resolve) => this._stream.end(resolve));
    this._stream = null;
  }

  // 删除整个 sessionsRoot（小心：默认 tmpdir 内）
  async cleanup() {
    await this.close();
    if (this.sessionsRoot.startsWith(os.tmpdir())) {
      await fs.promises.rm(this.sessionsRoot, { recursive: true, force: true });
    } else {
      // 安全网：非 tmpdir 不让删
      throw new Error(`FakeCodexRollout.cleanup refused: sessionsRoot ${this.sessionsRoot} not under os.tmpdir()`);
    }
  }

  _ensureStarted() {
    if (!this._started) throw new Error('FakeCodexRollout: call start() first');
  }

  async _writeLine(obj) {
    const line = JSON.stringify(obj) + '\n';
    return new Promise((resolve, reject) => {
      this._stream.write(line, (err) => err ? reject(err) : resolve());
    });
  }
}

// ---------------------------------------------------------------------------
// helpers

function _generateSid() {
  // 8-4-4-4-12 hex（仿 UUID v7 形态，但不强求时序）
  const bytes = crypto.randomBytes(16).toString('hex');
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-${bytes.slice(12, 16)}-${bytes.slice(16, 20)}-${bytes.slice(20, 32)}`;
}

function _isoForFilename(d) {
  return d.toISOString().replace(/[:.]/g, '-').replace('Z', '').slice(0, 19);
}

module.exports = { FakeCodexRollout };
