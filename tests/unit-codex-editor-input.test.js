'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CodexEditorInput, configureCodexEditorInput, atomicJson, readJson, editorShortcutKey } = require('../core/codex-editor-input');
const { run } = require('../core/codex-editor-helper');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-editor-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); // owned temp, no links
  const dir = path.join(root, 'bridge'); fs.mkdirSync(dir);
  atomicJson(path.join(dir, 'session.json'), {});
  const target = path.join(root, 'native.md'); fs.writeFileSync(target, 'existing draft');
  return { root, dir, target, bridge: new CodexEditorInput(dir, { platform: 'linux' }) };
}
const payload = ('中文🙂 first line\nsecond line\n').repeat(300) + 'END';
const frame = bridge => bridge.onOutput('\x1b[?2004l\x1b[?2004h\x1b[?2026hframe\x1b[?2026l');

test('Windows editor shortcut retains Ctrl and virtual G key without a submit event',()=>{
  assert.equal(editorShortcutKey('win32'),'\x1b[71;34;7;1;8;1_\x1b[71;34;7;0;8;1_');
  assert.equal(editorShortcutKey('linux'),'\x07');
  assert(!/[\r\n]/.test(editorShortcutKey('win32')));
});

test('complete Unicode body is loaded once and requires both the receipt and resumed native frame', async t => {
  const f = fixture(t), keys = []; let done = false;
  const loading = f.bridge.load(payload, key => keys.push(key)).then(value => { done = true; return value; });
  await run(f.dir, f.target);
  assert.equal(fs.readFileSync(f.target, 'utf8'), payload);
  await new Promise(r => setTimeout(r, 25)); assert.equal(done, false, 'file write is not CLI readiness');
  for (const byte of '\x1b[?2004l\x1b[?2004h\x1b[?2026hframe\x1b[?2026l') f.bridge.onOutput(byte);
  assert.equal(await loading, true); assert.deepEqual(keys, ['\x07'], 'bridge must never send Enter');
  assert.equal(f.bridge.lastTransfer.chars, payload.length);
  assert.equal(fs.existsSync(path.join(f.dir, 'request.json')), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'receipt.json')), false);
});

test('a redraw without native editor suspension and restoration cannot acknowledge input', async t => {
  const f = fixture(t);
  const loading = f.bridge.load(payload, () => {}, { timeoutMs: 60 });
  const check = assert.rejects(loading, /未确认/);
  await run(f.dir, f.target); f.bridge.onOutput('\x1b[?2026hframe\x1b[?2026l');
  await check; assert.equal(f.bridge.failed, true);
});

test('short messages, slash commands and explicit attachments retain the existing input route', async t => {
  const f = fixture(t), unexpected = () => { throw Error('must not write a key'); };
  for (const [text, options] of [['hello', {}], ['/review ' + payload, {}], [payload, { attachments: [{}] }]]) {
    assert.equal(await f.bridge.load(text, unexpected, options), false);
  }
});
test('assistant punctuation route preserves short quoted text without altering its body',async t=>{
  const f=fixture(t),text='记住“青桥企鹅”，保留‘原话’。';
  const loading=f.bridge.load(text,()=>{},{preservePunctuation:true});
  await run(f.dir,f.target);frame(f.bridge);assert.equal(await loading,true);assert.equal(fs.readFileSync(f.target,'utf8'),text);
});

test('expired handoffs reject late helpers, preserve the draft, and cannot load a later request', async t => {
  const f = fixture(t);
  await assert.rejects(f.bridge.load(payload, () => {}, { timeoutMs: 30 }), e => e.notSent === true);
  await assert.rejects(run(f.dir, f.target), /取消/);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'existing draft');
  await assert.rejects(f.bridge.load(payload, () => {}), /重开/);
});

test('stale receipts and concurrent handoffs cannot satisfy the active message', async t => {
  const f = fixture(t);
  atomicJson(path.join(f.dir, 'receipt.json'), { id: 'old', ok: true });
  const loading = f.bridge.load(payload, () => {}, { timeoutMs: 40 });
  const checked = assert.rejects(loading, /未确认/);
  await assert.rejects(f.bridge.load(payload, () => {}), /另一条/);
  frame(f.bridge); await checked;
});

test('native image drafts are preserved and an explicit failure reaches the sender', async t => {
  const f = fixture(t); fs.writeFileSync(f.target, '[Image #1] inspect this');
  const loading = f.bridge.load(payload, () => {});
  const checked = assert.rejects(loading, /已有图片/);
  await assert.rejects(run(f.dir, f.target), /已有图片/);
  await checked;
  assert.equal(fs.readFileSync(f.target, 'utf8'), '[Image #1] inspect this');
});

test('closing the session cancels pending input, cleans its files, and never sends Enter', async t => {
  const f = fixture(t), keys = [];
  const loading = f.bridge.load(payload, key => keys.push(key));
  const checked = assert.rejects(loading, /会话已关闭/);
  f.bridge.dispose(); await checked;
  assert.deepEqual(keys, ['\x07']); assert.equal(fs.existsSync(f.dir), false);
});

test('a damaged payload is rejected before overwriting the native editor buffer', async t => {
  const f = fixture(t);
  const loading = f.bridge.load(payload, () => {});
  const checked = assert.rejects(loading, /内容校验失败/);
  const file = path.join(f.dir, 'request.json'), request = readJson(file);
  atomicJson(file, { ...request, text: 'truncated' });
  await assert.rejects(run(f.dir, f.target), /内容校验失败/); await checked;
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'existing draft');
});

test('lost temporary storage cannot throw out of session exit or hide the not-sent result', async t => {
  const f = fixture(t);
  const loading = f.bridge.load(payload, () => {});
  const checked = assert.rejects(loading, e => e.notSent === true && /会话已关闭/.test(e.message));
  fs.rmSync(f.dir, { recursive: true, force: true });
  assert.doesNotThrow(() => f.bridge.dispose());
  await checked;
});

test('custom keymaps opt out and per-session editor wrapping does not edit user configuration', t => {
  const f = fixture(t), home = path.join(f.root, 'home'); fs.mkdirSync(home);
  const config = path.join(home, 'config.toml'); fs.writeFileSync(config, '[tui.keymap.global]\nopen_external_editor="ctrl-e"\n');
  const env = { CODEX_HOME: home, VISUAL: 'original -w' };
  assert.equal(configureCodexEditorInput(env, { dataDir: f.root, cwd: f.root, platform: 'win32' }), null);
  assert.equal(env.VISUAL, 'original -w');
  fs.writeFileSync(config, 'model="test"\n');
  const bridge = configureCodexEditorInput(env, { dataDir: f.root, cwd: f.root, platform: 'win32' });
  assert.equal(readJson(path.join(bridge.directory, 'session.json')).visual, 'original -w');
  assert.equal(fs.readFileSync(config, 'utf8'), 'model="test"\n'); bridge.dispose();
});

test('manual editor invocation delegates with the original environment and propagates failures', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), script = path.join(f.root, 'editor.cjs'), receipt = path.join(f.root, 'manual.json');
  fs.writeFileSync(script, 'const fs=require("fs");fs.writeFileSync(process.argv[2],JSON.stringify({target:process.argv[3],visual:process.env.VISUAL,node:process.env.ELECTRON_RUN_AS_NODE}));');
  const command = '"' + process.execPath + '" "' + script + '" "' + receipt + '"';
  atomicJson(path.join(f.dir, 'session.json'), { visual: command, runAsNode: '1' });
  await run(f.dir, f.target);
  assert.deepEqual(readJson(receipt), { target: f.target, visual: command, node: '1' });
  fs.writeFileSync(script, 'process.exit(7)');
  await assert.rejects(run(f.dir, f.target), /退出码：7/);
});
