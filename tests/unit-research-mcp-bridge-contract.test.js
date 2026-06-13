'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'lindang-bridge.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
  } catch (e) {
    console.error('  FAIL ' + name);
    console.error(e.stack || e.message);
    process.exitCode = 1;
  }
}

console.log('--- research MCP bridge contract ---');

test('research-mcp spawn does not wrap uv in shell=true', () => {
  const fnStart = src.indexOf('function _runResearchMcp');
  assert.ok(fnStart > 0, 'missing _runResearchMcp');
  const fnBody = src.slice(fnStart, src.indexOf('function _depthArg', fnStart));
  assert.ok(fnBody.includes('spawn(RESEARCH_MCP_UV_BIN'), 'must spawn uv directly');
  assert.ok(!fnBody.includes('shell: true'), 'shell=true leaves uv/python children alive after timeout');
});

test('timeout kills the full Windows process tree', () => {
  assert.ok(src.includes("spawn('taskkill'"), 'must use taskkill on Windows');
  assert.ok(src.includes("'/T'"), 'taskkill must include /T');
  assert.ok(src.includes("'/F'"), 'taskkill must include /F');
  assert.ok(src.includes('_killProcessTree(child)'), 'timeout path must call process-tree killer');
});

test('core research tool timeouts stay inside MCP client budget', () => {
  assert.match(src, /'stock-static':\s*110000/);
  assert.match(src, /'stock-market':\s*110000/);
  assert.match(src, /'stock-news':\s*60000/);
  assert.ok(src.includes('120s'), 'timeout rationale should mention MCP client budget');
});
