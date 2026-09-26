'use strict';
// config.toml may spell the key bare or quoted — both are valid TOML. A rewrite on 2026-09-25
// quoted it, the bare-only match fell back to [".git"], and the Hub misread which AGENTS.md
// files Codex injects. Runs against a throw-away home, never the user's real config.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

function withConfig(t, toml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-markers-'));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), toml, 'utf8');
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home; process.env.HOME = home;
  t.after(() => { Object.assign(process.env, saved); fs.rmSync(home, { recursive: true, force: true }); });
  return require('../core/prompt-inspect').readCodexRootMarkers();
}
for (const [label, line] of [
  ['bare', 'project_root_markers = [".git", ".vibe-root"]'],
  ['double-quoted', '"project_root_markers" = [".git", ".vibe-root"]'],
  ['single-quoted', "'project_root_markers' = ['.git', '.vibe-root']"],
]) {
  test(`root markers are read when the key is ${label}`, t => {
    const r = withConfig(t, `model = "gpt"\n${line}\n`);
    assert.equal(r.configured, true);
    assert.deepEqual(r.markers, ['.git', '.vibe-root']);
  });
}
test('a missing key still falls back to Codex default', t => {
  assert.deepEqual(withConfig(t, 'model = "gpt"\n'), { markers: ['.git'], configured: false });
});
