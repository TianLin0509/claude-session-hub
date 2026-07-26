const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

assert.ok(
  /bar\.addEventListener\('wheel'[\s\S]{0,2200}getTerminalViewport\(cached\)/.test(rendererSrc),
  'floating input wheel handler must resolve the active xterm viewport',
);
assert.ok(
  /bar\.addEventListener\('wheel'[\s\S]{0,2200}markCodexUserScrollIntent\(sessionId,\s*cached,\s*\{\s*detachFromBottom:\s*e\.deltaY\s*<\s*0\s*\}\)/.test(rendererSrc),
  'floating input wheel-up must detach Codex bottom following before stream writes can pin it',
);
assert.ok(
  /bar\.addEventListener\('wheel'[\s\S]{0,2200}vp\.dispatchEvent\(new WheelEvent\('wheel'/.test(rendererSrc),
  'floating input wheel events must be forwarded to xterm so the viewport actually scrolls',
);
assert.ok(
  /targetInput[\s\S]{0,600}canScrollInput[\s\S]{0,120}return;/.test(rendererSrc),
  'multiline floating input should keep its own wheel scroll while it can scroll',
);

console.log('codex floating input wheel contract ok');
