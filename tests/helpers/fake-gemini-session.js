// Fake gemini session writer — 单测辅助
//
// 用途：mimic gemini CLI 写入 ~/.gemini/tmp/<projectHash>/chats/session-<ts>-<8hex>.jsonl
// 的行为。单测把 fake session 写到 tmp 目录，注入 GeminiTap 的 opts.tmpRoot，就能完全
// 离线 / 不污染真实 ~/.gemini 跑单测。
//
// 与 fake-codex-rollout 镜像，但 gemini 的目录结构是 <projectHash> 而不是日期树：
//   <tmpRoot>/<projectHash>/
//     .project_root         # 内容：cwd 字符串（GeminiTap 反查 cwd → projectHash）
//     chats/
//       session-<isoTs>-<8hex>.jsonl
//
// JSONL 首行含 sessionId（GeminiTap 用做权威 chatId），后续是 type:"gemini" content 行。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class FakeGeminiSession {
  /**
   * @param {object} opts
   * @param {string} opts.tmpRoot       注入到 GeminiTap 的 tmpRoot（默认 tmpdir/fake-gemini-tmp）
   * @param {string} opts.cwd           写入 .project_root 的目录路径（GeminiTap 用此匹配）
   * @param {string} [opts.projectHash] 默认随机 16 hex
   * @param {string} [opts.sessionId]   默认随机 UUID
   * @param {Date}   [opts.startAt]
   */
  constructor(opts = {}) {
    if (!opts.cwd) throw new Error('FakeGeminiSession: cwd required');
    this.tmpRoot = opts.tmpRoot || path.join(os.tmpdir(), 'fake-gemini-tmp');
    this.cwd = opts.cwd;
    this.projectHash = opts.projectHash || crypto.randomBytes(8).toString('hex');
    this.sessionId = opts.sessionId || _uuid();
    this.startAt = opts.startAt || new Date();

    this.projectDir = path.join(this.tmpRoot, this.projectHash);
    this.chatsDir = path.join(this.projectDir, 'chats');
    const eightHex = this.sessionId.replace(/-/g, '').slice(0, 8);
    const fname = `session-${_isoForFilename(this.startAt)}-${eightHex}.jsonl`;
    this.sessionPath = path.join(this.chatsDir, fname);

    this._stream = null;
    this._started = false;
  }

  async start() {
    if (this._started) throw new Error('FakeGeminiSession: already started');
    await fs.promises.mkdir(this.chatsDir, { recursive: true });
    await fs.promises.writeFile(path.join(this.projectDir, '.project_root'), this.cwd, 'utf8');
    this._stream = fs.createWriteStream(this.sessionPath, { flags: 'w' });
    this._started = true;

    await this._writeLine({
      sessionId: this.sessionId,
      startTime: this.startAt.toISOString(),
      projectHash: this.projectHash,
    });
  }

  async writeUserMessage(text, { at = new Date() } = {}) {
    this._ensureStarted();
    await this._writeLine({
      type: 'user',
      content: text,
      timestamp: at.getTime(),
    });
  }

  async writeGeminiContent(text, { at = new Date(), tokens = null, model = 'gemini-2.5-flash' } = {}) {
    this._ensureStarted();
    const obj = {
      type: 'gemini',
      content: text,
      timestamp: at.getTime(),
      model,
    };
    if (tokens) obj.tokens = tokens;
    await this._writeLine(obj);
  }

  async writeFullTurn(text, { at = new Date(), totalTokens = 100 } = {}) {
    await this.writeGeminiContent(text, {
      at,
      tokens: { input: 50, output: 50, total: totalTokens, cached: 0, thoughts: 0, tool: 0 },
    });
  }

  async writeRaw(obj) {
    this._ensureStarted();
    await this._writeLine(obj);
  }

  async close() {
    if (!this._stream) return;
    await new Promise((resolve) => this._stream.end(resolve));
    this._stream = null;
  }

  async cleanup() {
    await this.close();
    if (this.tmpRoot.startsWith(os.tmpdir())) {
      await fs.promises.rm(this.tmpRoot, { recursive: true, force: true });
    } else {
      throw new Error(`FakeGeminiSession.cleanup refused: tmpRoot ${this.tmpRoot} not under os.tmpdir()`);
    }
  }

  _ensureStarted() {
    if (!this._started) throw new Error('FakeGeminiSession: call start() first');
  }

  async _writeLine(obj) {
    const line = JSON.stringify(obj) + '\n';
    return new Promise((resolve, reject) => {
      this._stream.write(line, (err) => err ? reject(err) : resolve());
    });
  }
}

function _uuid() {
  const b = crypto.randomBytes(16).toString('hex');
  return `${b.slice(0,8)}-${b.slice(8,12)}-${b.slice(12,16)}-${b.slice(16,20)}-${b.slice(20,32)}`;
}

function _isoForFilename(d) {
  return d.toISOString().replace(/[:.]/g, '-').replace('Z', '').slice(0, 19);
}

module.exports = { FakeGeminiSession };
