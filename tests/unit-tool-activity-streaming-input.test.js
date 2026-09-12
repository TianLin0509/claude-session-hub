'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeToolActivity } = require('../core/turn-presentation');

const detail = (name, input) => normalizeToolActivity({ name, input, status: 'running' }).detail;

test('a tool call still streaming its arguments shows the value, not a raw JSON prefix', () => {
  // Native Claude streams tool arguments as input_json_delta; mid-call the
  // input is an unterminated JSON string. Measured on a real engine run.
  assert.equal(detail('Read', '{"file_path": "C:\\\\Users\\\\lintian\\\\App'), 'C:\\Users\\lintian\\App');
  assert.equal(detail('Bash', '{"command": "npm te'), 'npm te');
  // A trailing lone escape from a cut-off delta must not break decoding.
  assert.equal(detail('Read', '{"file_path": "C:\\\\Users\\'), 'C:\\Users');
});

test('complete JSON string input names the same field an object input would', () => {
  assert.equal(detail('Read', '{"file_path": "C:\\\\work\\\\a.txt"}'), 'C:\\work\\a.txt');
  // Same precedence as an object input ({ pattern, path } also yields path), so
  // a string and an object argument never label the same call differently.
  assert.equal(detail('Grep', '{"pattern": "TODO", "path": "src"}'), 'src');
  assert.equal(detail('Grep', { pattern: 'TODO', path: 'src' }), 'src');
  assert.equal(detail('Grep', '{"pattern": "TODO"}'), 'TODO');
  assert.equal(detail('WebFetch', '{"url": "https://example.com"}'), 'https://example.com');
  // Object input keeps its existing behaviour.
  assert.equal(detail('Read', { file_path: 'C:\\work\\b.txt' }), 'C:\\work\\b.txt');
});

test('command strings keep their existing precedence and plain text stays as is', () => {
  assert.equal(detail('Bash', '{"command": "git status", "description": "check tree"}'), 'git status');
  assert.equal(detail('shell', '{"cmd": "ls -la"}'), 'ls -la');
  assert.equal(detail('Tool', 'plain text argument'), 'plain text argument');
});
