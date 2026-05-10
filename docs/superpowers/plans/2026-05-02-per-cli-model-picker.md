# Per-CLI Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hub's terminal-header model badge picker per-CLI: Claude family stays in-place via `/model <id>\r`, Codex/Gemini switches model by killing + respawning the session with `--model <new>` while preserving yolo mode and conversation context.

**Architecture:** Two-path dispatch keyed on `session.kind`. Claude family reuses the existing inline `/model <id>\r` PTY path. Codex/Gemini route through a new `respawn-with-model` IPC that closes the old PTY and spawns a fresh one with `--model <new> --resume <existing-sid/chatId>`. Yolo flags (`--approval-mode yolo` / `--dangerously-bypass-approvals-and-sandbox`) stay hardcoded in spawn cmd builder. Pure-function refactor extracts `buildSpawnCmd(kind, opts)` so unit tests can lock the yolo invariant. Conversation context preserved via existing resume-meta plumbing (`codexSid` / `geminiChatId` / `geminiProjectHash` / `geminiProjectRoot`).

**Tech Stack:** Node.js + Electron + CommonJS (existing Hub codebase). Tests are plain Node + `assert` (no test runner). New module `core/model-options.js` shared between renderer + tests. Spec doc: `docs/superpowers/specs/2026-05-01-per-cli-model-picker-design.md`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `core/model-options.js` | **CREATE** | Single source of truth for per-CLI model lists + helper predicates (`modelOptionsFor`, `canRespawnWithResume`). Required by both renderer.js and unit tests. |
| `core/session-manager.js` | MODIFY | Extract `buildSpawnCmd(kind, opts)` pure function (lines ~290-490). Add `--model` passthrough in Codex resume branch. |
| `main.js` | MODIFY | Add `tryRespawnWithModel(sessionId, modelId, deps)` helper + `ipcMain.handle('respawn-with-model', ...)` thin wrapper. Emit `session-respawned` / `session-respawn-failed` events. |
| `renderer/renderer.js` | MODIFY | Replace hardcoded `MODEL_OPTIONS` (lines 2598-2607) with `require('../core/model-options.js')`. Refactor `attachModelPickerHandler` (line 2611) and `showModelPicker` (line 2625) for kind-based gate + dispatch. Add `session-respawned` / `session-respawn-failed` IPC listeners. |
| `tests/unit-model-options.test.js` | **CREATE** | Validates `MODEL_OPTIONS_BY_KIND` shape, `modelOptionsFor` aliasing, `canRespawnWithResume` predicate. |
| `tests/unit-build-spawn-cmd.test.js` | **CREATE** | Locks yolo invariant for codex/gemini fresh + resume; locks `--model` passthrough behavior. |
| `tests/unit-respawn-with-model.test.js` | **CREATE** | Validates `tryRespawnWithModel` helper's gating logic with mocked deps (kind not respawnable, in-meeting, no codexSid, no geminiChatId, valid path). |

Each task below produces a self-contained commit. Run unit tests via `node tests/<name>.test.js`. The codebase has no test runner — tests are plain Node scripts that exit non-zero on assertion failure.

---

## Task 1: Create `core/model-options.js` (data + helpers)

**Files:**
- Create: `core/model-options.js`
- Create: `tests/unit-model-options.test.js`

- [ ] **Step 1.1: Write the failing test**

Create `tests/unit-model-options.test.js`:

```js
'use strict';
const assert = require('assert');
const {
  MODEL_OPTIONS_BY_KIND,
  modelOptionsFor,
  canRespawnWithResume,
} = require('../core/model-options.js');

function testClaudeListShape() {
  const opts = MODEL_OPTIONS_BY_KIND.claude;
  assert.ok(Array.isArray(opts) && opts.length === 6, 'claude must have 6 models');
  assert.strictEqual(opts[0].id, 'claude-opus-4-7[1m]');
  assert.strictEqual(opts[0].label, 'Opus 4.7 (1M context)');
  assert.ok(opts.every(o => typeof o.id === 'string' && typeof o.label === 'string'));
  console.log('  ✓ testClaudeListShape');
}

function testCodexListShape() {
  const opts = MODEL_OPTIONS_BY_KIND.codex;
  assert.strictEqual(opts.length, 3);
  assert.deepStrictEqual(opts.map(o => o.id), ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex']);
  console.log('  ✓ testCodexListShape');
}

function testGeminiListShape() {
  const opts = MODEL_OPTIONS_BY_KIND.gemini;
  assert.strictEqual(opts.length, 3);
  assert.strictEqual(opts[0].id, 'gemini-3-pro-preview');
  assert.strictEqual(opts[0].label, 'Gemini 3.1 Pro');
  console.log('  ✓ testGeminiListShape');
}

function testDeepSeekAndGlmListShape() {
  assert.strictEqual(MODEL_OPTIONS_BY_KIND.deepseek.length, 2);
  assert.strictEqual(MODEL_OPTIONS_BY_KIND.glm.length, 3);
  assert.strictEqual(MODEL_OPTIONS_BY_KIND.deepseek[0].id, 'deepseek-v4-pro');
  assert.strictEqual(MODEL_OPTIONS_BY_KIND.glm[0].id, 'glm-5.1');
  console.log('  ✓ testDeepSeekAndGlmListShape');
}

function testModelOptionsForResumeAlias() {
  assert.strictEqual(modelOptionsFor('claude-resume'), MODEL_OPTIONS_BY_KIND.claude,
    'claude-resume must alias to claude list (same reference)');
  console.log('  ✓ testModelOptionsForResumeAlias');
}

function testModelOptionsForUnknownKind() {
  assert.deepStrictEqual(modelOptionsFor('powershell'), []);
  assert.deepStrictEqual(modelOptionsFor(undefined), []);
  console.log('  ✓ testModelOptionsForUnknownKind');
}

function testCanRespawnClaude() {
  assert.strictEqual(canRespawnWithResume({ kind: 'claude' }), true,
    'claude does not need resume meta (in-place /model)');
  console.log('  ✓ testCanRespawnClaude');
}

function testCanRespawnCodexNeedsSid() {
  assert.strictEqual(canRespawnWithResume({ kind: 'codex', codexSid: null }), false);
  assert.strictEqual(canRespawnWithResume({ kind: 'codex', codexSid: 'abc-123' }), true);
  console.log('  ✓ testCanRespawnCodexNeedsSid');
}

function testCanRespawnGeminiNeedsChatId() {
  assert.strictEqual(canRespawnWithResume({ kind: 'gemini', geminiChatId: null }), false);
  assert.strictEqual(canRespawnWithResume({ kind: 'gemini', geminiChatId: 'uuid-xxx' }), true);
  console.log('  ✓ testCanRespawnGeminiNeedsChatId');
}

console.log('Running model-options tests...');
testClaudeListShape();
testCodexListShape();
testGeminiListShape();
testDeepSeekAndGlmListShape();
testModelOptionsForResumeAlias();
testModelOptionsForUnknownKind();
testCanRespawnClaude();
testCanRespawnCodexNeedsSid();
testCanRespawnGeminiNeedsChatId();
console.log('All passed.');
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `node tests/unit-model-options.test.js`
Expected: FAIL with `Error: Cannot find module '../core/model-options.js'`

- [ ] **Step 1.3: Implement `core/model-options.js`**

Create `core/model-options.js`:

```js
'use strict';

// Single source of truth for the per-CLI model picker. The renderer's badge
// dropdown and Hub's respawn-with-model IPC both consume this list; keeping
// it in /core/ instead of inside renderer.js makes it require()-able from
// unit tests (renderer.js is loaded as a CommonJS-script in Electron and is
// hard to import in isolation).

const CLAUDE_MODELS = [
  { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M context)' },
  { id: 'claude-opus-4-7',     label: 'Opus 4.7' },
  { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M context)' },
  { id: 'claude-opus-4-6',     label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6',   label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5',    label: 'Haiku 4.5' },
];

const MODEL_OPTIONS_BY_KIND = {
  claude: CLAUDE_MODELS,
  codex: [
    { id: 'gpt-5.5',       label: 'GPT-5.5' },
    { id: 'gpt-5.4',       label: 'GPT-5.4' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  ],
  gemini: [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-2.5-pro',       label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash',     label: 'Gemini 2.5 Flash' },
  ],
  deepseek: [
    { id: 'deepseek-v4-pro',   label: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  ],
  glm: [
    { id: 'glm-5.1',     label: 'GLM 5.1' },
    { id: 'glm-4.6',     label: 'GLM 4.6' },
    { id: 'glm-4.5-air', label: 'GLM 4.5 Air' },
  ],
};

// claude-resume reuses the same CLI binary as claude → reuse the model list
// (same reference, not a copy — tests assert ===).
function modelOptionsFor(kind) {
  if (kind === 'claude-resume') return MODEL_OPTIONS_BY_KIND.claude;
  return MODEL_OPTIONS_BY_KIND[kind] || [];
}

// Codex/Gemini respawn requires a resume-meta key so the new PTY can rejoin
// the original conversation. Claude family does in-place /model and does not
// need this gate.
function canRespawnWithResume(session) {
  if (!session) return false;
  if (session.kind === 'codex')  return !!session.codexSid;
  if (session.kind === 'gemini') return !!session.geminiChatId;
  return true; // claude / claude-resume / deepseek / glm — in-place path
}

module.exports = { MODEL_OPTIONS_BY_KIND, modelOptionsFor, canRespawnWithResume };
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `node tests/unit-model-options.test.js`
Expected: 9 `✓` lines + `All passed.` exit code 0.

- [ ] **Step 1.5: Commit**

```bash
git add core/model-options.js tests/unit-model-options.test.js
git commit -m "feat(model-picker): add core/model-options.js with per-CLI model lists"
```

---

## Task 2: Extract `buildSpawnCmd(kind, opts)` pure function (refactor)

This task is a behavior-preserving refactor. The goal is to make the cmd-string assembly testable so Task 3 can prove the yolo invariant doesn't regress.

**Files:**
- Modify: `core/session-manager.js` — extract `buildSpawnCmd` from inline cmd assembly inside `createSession` (Claude branch ~line 290, Gemini ~338, Codex ~374, DeepSeek ~421, GLM ~458)
- Create: `tests/unit-build-spawn-cmd.test.js`

- [ ] **Step 2.1: Write the failing test (locks current behavior)**

Create `tests/unit-build-spawn-cmd.test.js`:

```js
'use strict';
const assert = require('assert');
const { buildSpawnCmd } = require('../core/session-manager.js');

// Helper: assert cmd ends with the canonical PTY terminator the existing
// spawn writer uses to fire the command at session bootstrap.
function endsWithCRLF(cmd) {
  assert.ok(cmd.endsWith('\r\n'), `cmd must end with \\r\\n, got: ${JSON.stringify(cmd)}`);
}

// === Claude family ===

function testClaudeFreshDefaultsToOpus47_1M() {
  const cmd = buildSpawnCmd('claude', {});
  assert.ok(cmd.includes(' claude --model claude-opus-4-7[1m]'),
    `claude fresh must default to opus-4-7[1m], got: ${cmd}`);
  endsWithCRLF(cmd);
  console.log('  ✓ testClaudeFreshDefaultsToOpus47_1M');
}

function testClaudeResumeWithSessionId() {
  const cmd = buildSpawnCmd('claude', { resumeCCSessionId: 'abc-123' });
  assert.ok(cmd.includes(' claude --resume abc-123'));
  assert.ok(!cmd.includes('--model'), 'resume should NOT add --model (inherits transcript model)');
  console.log('  ✓ testClaudeResumeWithSessionId');
}

function testClaudeResumeKindUsesPicker() {
  const cmd = buildSpawnCmd('claude-resume', {});
  assert.ok(cmd.includes(' claude --resume'));
  assert.ok(!cmd.includes('--resume '), 'no specific id → bare --resume opens picker');
  console.log('  ✓ testClaudeResumeKindUsesPicker');
}

// === Gemini — yolo invariant ===

function testGeminiFreshHasYoloAndModel() {
  const cmd = buildSpawnCmd('gemini', { model: 'gemini-2.5-flash' });
  assert.ok(cmd.includes('--approval-mode yolo'), 'YOLO INVARIANT: gemini fresh');
  assert.ok(cmd.includes('--model gemini-2.5-flash'));
  endsWithCRLF(cmd);
  console.log('  ✓ testGeminiFreshHasYoloAndModel');
}

function testGeminiFreshDefaultModel() {
  const cmd = buildSpawnCmd('gemini', {});
  assert.ok(cmd.includes('--model gemini-2.5-flash'),
    'default gemini model is gemini-2.5-flash when opts.model omitted');
  console.log('  ✓ testGeminiFreshDefaultModel');
}

function testGeminiResumeWithChatIdHasYoloAndModel() {
  const chatId = '3eab55d9-8019-4485-a47e-07f93e288be5';
  const cmd = buildSpawnCmd('gemini', {
    useResume: true,
    geminiChatId: chatId,
    model: 'gemini-3-pro-preview',
  });
  assert.ok(cmd.includes('--approval-mode yolo'), 'YOLO INVARIANT: gemini resume');
  assert.ok(cmd.includes('--model gemini-3-pro-preview'));
  assert.ok(cmd.includes(`--resume ${chatId}`));
  console.log('  ✓ testGeminiResumeWithChatIdHasYoloAndModel');
}

function testGeminiResumeNoChatIdFallsBackToLatest() {
  const cmd = buildSpawnCmd('gemini', { useResume: true, model: 'gemini-2.5-pro' });
  assert.ok(cmd.includes('--resume latest'));
  assert.ok(cmd.includes('--approval-mode yolo'));
  console.log('  ✓ testGeminiResumeNoChatIdFallsBackToLatest');
}

// === Codex — yolo invariant + --model passthrough (Task 3 enables this) ===

function testCodexFreshHasBypassFlag() {
  const cmd = buildSpawnCmd('codex', {});
  assert.ok(cmd.includes('--dangerously-bypass-approvals-and-sandbox'),
    'YOLO INVARIANT: codex fresh');
  assert.ok(cmd.includes('--model gpt-5.5'), 'default codex model is gpt-5.5');
  endsWithCRLF(cmd);
  console.log('  ✓ testCodexFreshHasBypassFlag');
}

function testCodexFreshHonorsOptsModel() {
  const cmd = buildSpawnCmd('codex', { model: 'gpt-5.4' });
  assert.ok(cmd.includes('--model gpt-5.4'),
    'opts.model must override default in fresh codex spawn');
  assert.ok(cmd.includes('--dangerously-bypass-approvals-and-sandbox'));
  console.log('  ✓ testCodexFreshHonorsOptsModel');
}

function testCodexResumeWithSidHasBypassFlag() {
  const cmd = buildSpawnCmd('codex', { useResume: true, codexSid: 'sid-xyz' });
  assert.ok(cmd.includes('codex resume sid-xyz'),
    'precise resume by codexSid');
  assert.ok(cmd.includes('--dangerously-bypass-approvals-and-sandbox'),
    'YOLO INVARIANT: codex resume by sid');
  console.log('  ✓ testCodexResumeWithSidHasBypassFlag');
}

function testCodexResumeLastFallback() {
  const cmd = buildSpawnCmd('codex', { useResume: true });
  assert.ok(cmd.includes('codex resume --last'));
  assert.ok(cmd.includes('--dangerously-bypass-approvals-and-sandbox'));
  console.log('  ✓ testCodexResumeLastFallback');
}

function testCodexResumeAcceptsModelOverride() {
  // This will FAIL until Task 3 is implemented. Marker test for now.
  const cmd = buildSpawnCmd('codex', {
    useResume: true,
    codexSid: 'sid-xyz',
    model: 'gpt-5.4',
  });
  assert.ok(cmd.includes('--model gpt-5.4'),
    'codex resume must pass --model when opts.model present (Task 3 enables)');
  console.log('  ✓ testCodexResumeAcceptsModelOverride');
}

// === DeepSeek / GLM ===

function testDeepSeekFreshHasBypassPermissions() {
  const cmd = buildSpawnCmd('deepseek', { model: 'deepseek-v4-pro' });
  assert.ok(cmd.includes(' claude --model deepseek-v4-pro'),
    'deepseek wraps claude CLI with model override');
  assert.ok(cmd.includes('--permission-mode bypassPermissions'),
    'deepseek must bypass permissions');
  console.log('  ✓ testDeepSeekFreshHasBypassPermissions');
}

function testGlmFreshHasBypassPermissions() {
  const cmd = buildSpawnCmd('glm', { model: 'glm-4.6' });
  assert.ok(cmd.includes(' claude --model glm-4.6'));
  assert.ok(cmd.includes('--permission-mode bypassPermissions'));
  console.log('  ✓ testGlmFreshHasBypassPermissions');
}

console.log('Running buildSpawnCmd tests...');
testClaudeFreshDefaultsToOpus47_1M();
testClaudeResumeWithSessionId();
testClaudeResumeKindUsesPicker();
testGeminiFreshHasYoloAndModel();
testGeminiFreshDefaultModel();
testGeminiResumeWithChatIdHasYoloAndModel();
testGeminiResumeNoChatIdFallsBackToLatest();
testCodexFreshHasBypassFlag();
testCodexFreshHonorsOptsModel();
testCodexResumeWithSidHasBypassFlag();
testCodexResumeLastFallback();
// testCodexResumeAcceptsModelOverride();  // ENABLED in Task 3
testDeepSeekFreshHasBypassPermissions();
testGlmFreshHasBypassPermissions();
console.log('All passed.');
```

Note: `testCodexResumeAcceptsModelOverride` is COMMENTED OUT — it gets enabled in Task 3 once the passthrough is added. Keeping its definition + comment makes the diff there minimal.

- [ ] **Step 2.2: Run test to verify it fails**

Run: `node tests/unit-build-spawn-cmd.test.js`
Expected: FAIL with `TypeError: buildSpawnCmd is not a function` (because session-manager.js doesn't export it yet).

- [ ] **Step 2.3: Extract `buildSpawnCmd` from `createSession`**

Open `core/session-manager.js`. The existing `createSession` (around line 177-490+) inline-builds `cmd` strings inside five branches: Claude (line ~290), Gemini (~338), Codex (~374), DeepSeek (~421), GLM (~458).

Add this pure function at module scope **before** the `class SessionManager` declaration (around line 147, after `isCodexApiBackend`):

```js
// Pure cmd-string builder, extracted from createSession so unit tests can lock
// the YOLO invariant for codex/gemini and the --model passthrough behavior.
// Keeping the same string layout (incl. leading space and trailing \r\n) lets
// us drop this back into createSession without changing PTY bootstrap timing.
//
// CONTRACT: opts mirrors createSession's opts (resumeCCSessionId, useContinue,
// useResume, codexSid, geminiChatId, model, codexInstructionFile, ...). Returns
// the exact byte sequence the existing pty.write() emits at boot.
function buildSpawnCmd(kind, opts) {
  opts = opts || {};
  const isClaude = kind === 'claude' || kind === 'claude-resume';
  const isGemini = kind === 'gemini' || kind === 'gemini-resume';
  const isCodex  = kind === 'codex'  || kind === 'codex-resume';
  const isDeepSeek = kind === 'deepseek' || kind === 'deepseek-resume';
  const isGlm    = kind === 'glm'    || kind === 'glm-resume';

  let cmd;

  if (isClaude) {
    if (opts.resumeCCSessionId) {
      cmd = ` claude --resume ${opts.resumeCCSessionId}`;
    } else if (opts.useContinue) {
      cmd = ' claude --continue';
    } else if (kind === 'claude-resume') {
      cmd = ' claude --resume';
    } else {
      cmd = ' claude --model claude-opus-4-7[1m]';
    }
    if (opts.appendSystemPromptFile) {
      cmd += ` --append-system-prompt-file "${opts.appendSystemPromptFile.replace(/\\/g, '\\\\')}"`;
    }
    if (opts.mcpConfigFile) {
      cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
    }
  } else if (isGemini) {
    cmd = ' gemini --approval-mode yolo';
    cmd += ` --model ${opts.model || 'gemini-2.5-flash'}`;
    if (opts.useResume) {
      if (opts.geminiChatId && opts.geminiChatId.length > 8) {
        cmd += ` --resume ${opts.geminiChatId}`;
      } else {
        cmd += ' --resume latest';
      }
    }
  } else if (isCodex) {
    if (opts.useResume && opts.codexSid) {
      cmd = ` codex resume ${opts.codexSid} --dangerously-bypass-approvals-and-sandbox`;
    } else if (opts.useResume) {
      cmd = ' codex resume --last --dangerously-bypass-approvals-and-sandbox';
    } else {
      cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${opts.model || 'gpt-5.5'}`;
      if (opts.codexInstructionFile) {
        cmd += ` -c "model_instructions_file=${opts.codexInstructionFile.replace(/\\/g, '\\\\')}"`;
      }
    }
  } else if (isDeepSeek) {
    if (opts.resumeCCSessionId) {
      cmd = ` claude --resume ${opts.resumeCCSessionId} --permission-mode bypassPermissions`;
    } else if (opts.useContinue) {
      cmd = ' claude --continue --permission-mode bypassPermissions';
    } else {
      cmd = ` claude --model ${opts.model || 'deepseek-v4-pro'} --permission-mode bypassPermissions`;
    }
  } else if (isGlm) {
    if (opts.resumeCCSessionId) {
      cmd = ` claude --resume ${opts.resumeCCSessionId} --permission-mode bypassPermissions`;
    } else if (opts.useContinue) {
      cmd = ' claude --continue --permission-mode bypassPermissions';
    } else {
      // GLM_MODEL is the runtime fallback; in tests opts.model takes precedence.
      cmd = ` claude --model ${opts.model || 'glm-5.1'} --permission-mode bypassPermissions`;
    }
  } else {
    cmd = '';
  }

  if (cmd) cmd += '\r\n';
  return cmd;
}
```

Note on GLM default: the runtime spawn path uses `opts.model || GLM_MODEL` where `GLM_MODEL` is loaded from hub-config. For the pure builder we hard-code `'glm-5.1'` as the test-time default; the runtime call site (Step 2.4) still passes `opts.model || GLM_MODEL` so behavior in production is unchanged.

- [ ] **Step 2.4: Replace inline cmd assembly with `buildSpawnCmd` calls**

In `createSession`, **replace** the five inline cmd-building blocks with calls to `buildSpawnCmd`. The replacement must preserve every line that's NOT cmd-string assembly (the `pty.write(cmd)` debounce/safetyTimer plumbing stays).

For each branch, the change is:
- Delete the lines that build `let cmd = ...` through `cmd += '\r\n';`
- Replace with one line: `const cmd = buildSpawnCmd(kind, opts);` (use the appropriate kind variable — Claude branch already has `kind`)

Specifically:

In the Claude branch (around line 290-311 of session-manager.js), replace:
```js
let cmd;
if (opts.resumeCCSessionId) {
  cmd = ` claude --resume ${opts.resumeCCSessionId}`;
} else if (opts.useContinue) {
  cmd = ' claude --continue';
} else if (kind === 'claude-resume') {
  cmd = ' claude --resume';
} else {
  cmd = ' claude --model claude-opus-4-7[1m]';
}
if (opts.appendSystemPromptFile) {
  cmd += ` --append-system-prompt-file "${opts.appendSystemPromptFile.replace(/\\/g, '\\\\')}"`;
}
if (opts.mcpConfigFile) {
  cmd += ` --mcp-config "${opts.mcpConfigFile.replace(/\\/g, '\\\\')}"`;
}
cmd += '\r\n';
```
with:
```js
const cmd = buildSpawnCmd(kind, opts);
```

In the Gemini branch (around line 337-349), replace the `let cmd = ' gemini --approval-mode yolo'; ... cmd += '\r\n';` block with:
```js
const cmd = buildSpawnCmd(kind, opts);
```

In the Codex branch (around line 374-396), replace the `let cmd; if (opts.useResume && opts.codexSid) ... cmd += '\r\n';` block with:
```js
const cmd = buildSpawnCmd(kind, opts);
```

In the DeepSeek branch (around line 421-433), same replacement:
```js
const cmd = buildSpawnCmd(kind, opts);
```

In the GLM branch (around line 458-467), the runtime needs `GLM_MODEL`:
```js
const cmd = buildSpawnCmd(kind, { ...opts, model: opts.model || GLM_MODEL });
```

This special-cases GLM at the call site so production retains `GLM_MODEL` config-loaded default while the pure builder stays trivial.

- [ ] **Step 2.5: Export `buildSpawnCmd`**

In `core/session-manager.js` line 858 (existing `module.exports`), add `buildSpawnCmd`:

```js
module.exports = { SessionManager, readTranscriptTail, dismissCodexUpdatePrompt, clearSessionManagerConfigCache, buildSpawnCmd };
```

- [ ] **Step 2.6: Run test to verify it passes**

Run: `node tests/unit-build-spawn-cmd.test.js`
Expected: 13 `✓` lines (excluding `testCodexResumeAcceptsModelOverride` which is commented out) + `All passed.`

If a test fails, the refactor changed behavior — re-read the original branch and fix the builder until it matches byte-for-byte.

- [ ] **Step 2.7: Smoke-test the Hub still boots**

Per `claude-session-hub/CLAUDE.md` rule #2 (node_modules-risk smoke test), verify the refactor didn't break Hub startup:

```bash
cd /c/Users/lintian/claude-session-hub
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

Expected: see `[hub] hook server listening on 127.0.0.1:` line (Hub started successfully). Kill the process when seen — it's a smoke test, not a real session.

- [ ] **Step 2.8: Commit**

```bash
git add core/session-manager.js tests/unit-build-spawn-cmd.test.js
git commit -m "refactor(session-manager): extract buildSpawnCmd pure function + lock yolo invariant"
```

---

## Task 3: Codex resume passes `--model` through

This is the only behavior change in `core/session-manager.js`. After this, `codex resume <sid> --dangerously-bypass-approvals-and-sandbox --model <new>` becomes the respawn cmd for Codex model switching.

**Files:**
- Modify: `core/session-manager.js` — `buildSpawnCmd` codex branch
- Modify: `tests/unit-build-spawn-cmd.test.js` — uncomment `testCodexResumeAcceptsModelOverride`

- [ ] **Step 3.1: Uncomment the test that fails**

In `tests/unit-build-spawn-cmd.test.js`, find the line:
```js
// testCodexResumeAcceptsModelOverride();  // ENABLED in Task 3
```
Change to:
```js
testCodexResumeAcceptsModelOverride();
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `node tests/unit-build-spawn-cmd.test.js`
Expected: FAIL on `testCodexResumeAcceptsModelOverride` with assertion `codex resume must pass --model when opts.model present`.

- [ ] **Step 3.3: Implement `--model` passthrough in Codex resume branch**

In `core/session-manager.js` `buildSpawnCmd` (Codex branch), update the two resume sub-branches:

Replace:
```js
} else if (isCodex) {
  if (opts.useResume && opts.codexSid) {
    cmd = ` codex resume ${opts.codexSid} --dangerously-bypass-approvals-and-sandbox`;
  } else if (opts.useResume) {
    cmd = ' codex resume --last --dangerously-bypass-approvals-and-sandbox';
  } else {
    cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${opts.model || 'gpt-5.5'}`;
    if (opts.codexInstructionFile) {
      cmd += ` -c "model_instructions_file=${opts.codexInstructionFile.replace(/\\/g, '\\\\')}"`;
    }
  }
}
```

With:
```js
} else if (isCodex) {
  if (opts.useResume && opts.codexSid) {
    cmd = ` codex resume ${opts.codexSid} --dangerously-bypass-approvals-and-sandbox`;
    if (opts.model) cmd += ` --model ${opts.model}`;
  } else if (opts.useResume) {
    cmd = ' codex resume --last --dangerously-bypass-approvals-and-sandbox';
    if (opts.model) cmd += ` --model ${opts.model}`;
  } else {
    cmd = ` codex --dangerously-bypass-approvals-and-sandbox --model ${opts.model || 'gpt-5.5'}`;
    if (opts.codexInstructionFile) {
      cmd += ` -c "model_instructions_file=${opts.codexInstructionFile.replace(/\\/g, '\\\\')}"`;
    }
  }
}
```

The two `if (opts.model) cmd += ...` lines are the only adds. They're conditional — old call sites that don't pass `opts.model` get the unchanged behavior (no `--model` in resume cmd), preserving backward compat.

- [ ] **Step 3.4: Run test to verify it passes**

Run: `node tests/unit-build-spawn-cmd.test.js`
Expected: 14 `✓` lines + `All passed.` All previous tests still green (regression check).

- [ ] **Step 3.5: Commit**

```bash
git add core/session-manager.js tests/unit-build-spawn-cmd.test.js
git commit -m "feat(session-manager): codex resume accepts --model passthrough"
```

---

## Task 4: `tryRespawnWithModel` helper in main.js

Wraps the gating + close + create + emit flow as a pure-ish function with injectable deps so unit tests don't need a running Electron app.

**Files:**
- Modify: `main.js` — add `tryRespawnWithModel(sessionId, modelId, deps)` near the existing IPC handlers
- Create: `tests/unit-respawn-with-model.test.js`

- [ ] **Step 4.1: Write the failing test**

Create `tests/unit-respawn-with-model.test.js`:

```js
'use strict';
const assert = require('assert');

// Extract the pure helper from main.js without importing electron — copy the
// helper into a tiny shim file when first running, OR test the export from
// main.js if main.js exports it. We chose the latter: main.js exports
// `tryRespawnWithModel` (Task 4 implementation) at module scope.
//
// Loading main.js requires Electron's runtime (it imports `electron`). To keep
// this a true unit test, we use proxyquire-style require by stubbing electron
// before requiring the helper. Since we don't have proxyquire, we extract just
// the helper to its own module: `core/respawn-with-model.js`. main.js requires
// from there. This mirrors how the codebase already separates pure logic into
// /core/.

const { tryRespawnWithModel } = require('../core/respawn-with-model.js');

// Mock dep factory.
function makeDeps(overrides = {}) {
  const events = [];
  return {
    getSessionInfo: overrides.getSessionInfo || (() => ({
      id: 'sess-1', kind: 'gemini', cwd: 'C:/test', meetingId: null,
      title: 'Gemini 1', userRenamed: false,
    })),
    getResumeMeta: overrides.getResumeMeta || (() => ({
      codexSid: null,
      geminiChatId: 'uuid-abc-123',
      geminiProjectHash: 'hash-x',
      geminiProjectRoot: 'C:/test',
    })),
    closeSession: overrides.closeSession || ((sid) => events.push({ type: 'close', sid })),
    createSession: overrides.createSession || ((kind, opts) => {
      events.push({ type: 'create', kind, opts });
      return { id: 'new-sid', kind, currentModel: { id: opts.model } };
    }),
    registerSessionForTap: overrides.registerSessionForTap || ((s) => events.push({ type: 'register', sid: s.id })),
    sendToRenderer: overrides.sendToRenderer || ((channel, payload) => events.push({ type: 'emit', channel, payload })),
    _events: events,
  };
}

async function testRejectsUnknownSession() {
  const deps = makeDeps({ getSessionInfo: () => null });
  const res = await tryRespawnWithModel('missing', 'gpt-5.4', deps);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'session-not-found');
  assert.strictEqual(deps._events.length, 0, 'no side effects');
  console.log('  ✓ testRejectsUnknownSession');
}

async function testRejectsClaudeKind() {
  const deps = makeDeps({ getSessionInfo: () => ({ id: 's', kind: 'claude' }) });
  const res = await tryRespawnWithModel('s', 'claude-sonnet-4-6', deps);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'kind-not-respawnable');
  console.log('  ✓ testRejectsClaudeKind');
}

async function testRejectsInMeeting() {
  const deps = makeDeps({
    getSessionInfo: () => ({ id: 's', kind: 'gemini', meetingId: 'meet-1' }),
  });
  const res = await tryRespawnWithModel('s', 'gemini-2.5-pro', deps);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'in-meeting');
  console.log('  ✓ testRejectsInMeeting');
}

async function testRejectsCodexWithoutSid() {
  const deps = makeDeps({
    getSessionInfo: () => ({ id: 's', kind: 'codex', meetingId: null }),
    getResumeMeta: () => ({ codexSid: null }),
  });
  const res = await tryRespawnWithModel('s', 'gpt-5.4', deps);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'no-codex-sid');
  console.log('  ✓ testRejectsCodexWithoutSid');
}

async function testRejectsGeminiWithoutChatId() {
  const deps = makeDeps({
    getSessionInfo: () => ({ id: 's', kind: 'gemini', meetingId: null }),
    getResumeMeta: () => ({ geminiChatId: null }),
  });
  const res = await tryRespawnWithModel('s', 'gemini-2.5-pro', deps);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'no-gemini-chat-id');
  console.log('  ✓ testRejectsGeminiWithoutChatId');
}

async function testHappyPathGemini() {
  const deps = makeDeps();
  const res = await tryRespawnWithModel('sess-1', 'gemini-3-pro-preview', deps);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.newSessionId, 'new-sid');

  const close = deps._events.find(e => e.type === 'close');
  assert.ok(close && close.sid === 'sess-1', 'must close old session');

  const create = deps._events.find(e => e.type === 'create');
  assert.ok(create, 'must create new session');
  assert.strictEqual(create.kind, 'gemini');
  assert.strictEqual(create.opts.model, 'gemini-3-pro-preview');
  assert.strictEqual(create.opts.useResume, true);
  assert.strictEqual(create.opts.geminiChatId, 'uuid-abc-123');
  assert.strictEqual(create.opts.cwd, 'C:/test');
  assert.strictEqual(create.opts.title, 'Gemini 1');

  const reg = deps._events.find(e => e.type === 'register');
  assert.ok(reg && reg.sid === 'new-sid');

  const emit = deps._events.find(e => e.type === 'emit' && e.channel === 'session-respawned');
  assert.ok(emit, 'must emit session-respawned');
  assert.strictEqual(emit.payload.oldSessionId, 'sess-1');
  assert.strictEqual(emit.payload.newSession.id, 'new-sid');

  console.log('  ✓ testHappyPathGemini');
}

async function testHappyPathCodex() {
  const deps = makeDeps({
    getSessionInfo: () => ({ id: 'sess-c', kind: 'codex', cwd: 'C:/work', meetingId: null, title: 'Codex 1', userRenamed: false }),
    getResumeMeta: () => ({ codexSid: 'sid-xyz', geminiChatId: null }),
  });
  const res = await tryRespawnWithModel('sess-c', 'gpt-5.4', deps);
  assert.strictEqual(res.ok, true);

  const create = deps._events.find(e => e.type === 'create');
  assert.strictEqual(create.opts.codexSid, 'sid-xyz');
  assert.strictEqual(create.opts.model, 'gpt-5.4');
  assert.strictEqual(create.opts.useResume, true);
  console.log('  ✓ testHappyPathCodex');
}

async function testCreateThrowsEmitsRespawnFailed() {
  const deps = makeDeps({
    createSession: () => { throw new Error('pty-spawn-failed'); },
  });
  const res = await tryRespawnWithModel('sess-1', 'gemini-2.5-pro', deps);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'respawn-failed');
  assert.ok(/pty-spawn-failed/.test(res.errorDetail || ''));

  const fail = deps._events.find(e => e.type === 'emit' && e.channel === 'session-respawn-failed');
  assert.ok(fail, 'must emit session-respawn-failed when createSession throws');
  assert.strictEqual(fail.payload.oldSessionId, 'sess-1');
  console.log('  ✓ testCreateThrowsEmitsRespawnFailed');
}

(async () => {
  console.log('Running tryRespawnWithModel tests...');
  await testRejectsUnknownSession();
  await testRejectsClaudeKind();
  await testRejectsInMeeting();
  await testRejectsCodexWithoutSid();
  await testRejectsGeminiWithoutChatId();
  await testHappyPathGemini();
  await testHappyPathCodex();
  await testCreateThrowsEmitsRespawnFailed();
  console.log('All passed.');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `node tests/unit-respawn-with-model.test.js`
Expected: FAIL with `Cannot find module '../core/respawn-with-model.js'`.

- [ ] **Step 4.3: Implement `core/respawn-with-model.js`**

Create `core/respawn-with-model.js`:

```js
'use strict';

// Pure helper for the model-switch respawn flow used by Codex/Gemini sessions.
// Lives in /core/ (not main.js) so unit tests can require() it without pulling
// in the electron runtime. main.js wires it to the IPC handler in Task 5.
//
// deps shape:
//   getSessionInfo(sid) → { id, kind, cwd, meetingId, title, userRenamed } | null
//   getResumeMeta(sid)  → { codexSid, geminiChatId, geminiProjectHash, geminiProjectRoot }
//   closeSession(sid)   → void
//   createSession(kind, opts) → SessionInfo
//   registerSessionForTap(session) → void
//   sendToRenderer(channel, payload) → void
//
// Result shape:
//   { ok: true, newSessionId } on success
//   { ok: false, error, errorDetail? } on rejection / failure

async function tryRespawnWithModel(sessionId, modelId, deps) {
  const old = deps.getSessionInfo(sessionId);
  if (!old) return { ok: false, error: 'session-not-found' };
  if (old.kind !== 'codex' && old.kind !== 'gemini') {
    return { ok: false, error: 'kind-not-respawnable' };
  }
  if (old.meetingId) return { ok: false, error: 'in-meeting' };

  const meta = deps.getResumeMeta(sessionId) || {};
  if (old.kind === 'codex' && !meta.codexSid) {
    return { ok: false, error: 'no-codex-sid' };
  }
  if (old.kind === 'gemini' && !meta.geminiChatId) {
    return { ok: false, error: 'no-gemini-chat-id' };
  }

  // Note: closeSession runs BEFORE createSession. If createSession throws, the
  // old session is already gone; renderer must reconcile via session-respawn-failed.
  deps.closeSession(sessionId);

  const opts = {
    model: modelId,
    useResume: true,
    cwd: old.cwd,
    title: old.title,
    userRenamed: old.userRenamed,
    codexSid: meta.codexSid || null,
    geminiChatId: meta.geminiChatId || null,
    geminiProjectHash: meta.geminiProjectHash || null,
    geminiProjectRoot: meta.geminiProjectRoot || null,
  };

  let newSession;
  try {
    newSession = deps.createSession(old.kind, opts);
  } catch (e) {
    deps.sendToRenderer('session-respawn-failed', {
      oldSessionId: sessionId,
      error: String(e && e.message || e),
    });
    return { ok: false, error: 'respawn-failed', errorDetail: String(e && e.message || e) };
  }

  deps.registerSessionForTap(newSession);
  deps.sendToRenderer('session-respawned', {
    oldSessionId: sessionId,
    newSession,
  });
  return { ok: true, newSessionId: newSession.id };
}

module.exports = { tryRespawnWithModel };
```

- [ ] **Step 4.4: Run test to verify it passes**

Run: `node tests/unit-respawn-with-model.test.js`
Expected: 8 `✓` lines + `All passed.`

- [ ] **Step 4.5: Commit**

```bash
git add core/respawn-with-model.js tests/unit-respawn-with-model.test.js
git commit -m "feat(respawn): add tryRespawnWithModel helper with full unit coverage"
```

---

## Task 5: Wire `respawn-with-model` IPC in main.js

**Files:**
- Modify: `main.js` — add IPC handler near the existing `create-session` handler (line ~470)

- [ ] **Step 5.1: Locate `lastPersistedSessions` and `sessionManager` setup in main.js**

Read main.js lines 470-490 (existing `ipcMain.handle('create-session', ...)`) and lines 2080-2105 (`persist-sessions` handler that mutates `lastPersistedSessions`). Confirm:
- `lastPersistedSessions` is in scope at the top of main.js (declared around line 2028)
- `sessionManager` instance is in scope (used by `create-session`)
- `sendToRenderer(channel, payload)` exists (used elsewhere by main.js)

These are the deps for `tryRespawnWithModel`.

- [ ] **Step 5.2: Add the IPC handler**

In `main.js`, immediately after the existing `ipcMain.handle('create-session', ...)` block (line ~481), add:

```js
const { tryRespawnWithModel } = require('./core/respawn-with-model.js');

ipcMain.handle('respawn-with-model', async (_e, { sessionId, modelId } = {}) => {
  if (!sessionId || !modelId) {
    return { ok: false, error: 'session-not-found' };
  }
  return await tryRespawnWithModel(sessionId, modelId, {
    getSessionInfo: (sid) => {
      // sessionManager exposes raw entries via .sessions Map; the renderer-facing
      // info object lives at entry.info. We surface only the fields the helper needs.
      const entry = sessionManager.sessions.get(sid);
      if (!entry) return null;
      const info = entry.info;
      return {
        id: info.id,
        kind: info.kind,
        cwd: info.cwd,
        meetingId: info.meetingId,
        title: info.title,
        userRenamed: !!info.userRenamed,
      };
    },
    getResumeMeta: (sid) => {
      // Resume meta lives in lastPersistedSessions (transcript-tap session-bound
      // events populate it). Look up by hubId.
      const persisted = lastPersistedSessions.find(s => s.hubId === sid);
      if (!persisted) return {};
      return {
        codexSid: persisted.codexSid || null,
        geminiChatId: persisted.geminiChatId || null,
        geminiProjectHash: persisted.geminiProjectHash || null,
        geminiProjectRoot: persisted.geminiProjectRoot || null,
      };
    },
    closeSession: (sid) => sessionManager.closeSession(sid),
    createSession: (kind, opts) => sessionManager.createSession(kind, opts),
    registerSessionForTap: (s) => registerSessionForTap(s),
    sendToRenderer: (channel, payload) => sendToRenderer(channel, payload),
  });
});
```

- [ ] **Step 5.3: Smoke-test the Hub still boots**

```bash
cd /c/Users/lintian/claude-session-hub
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

Expected: `[hub] hook server listening on 127.0.0.1:` line. Kill the test process when seen.

- [ ] **Step 5.4: Commit**

```bash
git add main.js
git commit -m "feat(main): wire respawn-with-model IPC handler"
```

---

## Task 6: Renderer picker reform

Replace hardcoded `MODEL_OPTIONS` with the per-CLI module + add gate (kind / meetingId / canRespawn) + dispatch (in-place vs respawn).

**Files:**
- Modify: `renderer/renderer.js` — lines 2598-2659 (`MODEL_OPTIONS`, `attachModelPickerHandler`, `showModelPicker`, `closeModelPicker`)

- [ ] **Step 6.1: Replace `MODEL_OPTIONS` constant with module require**

In `renderer/renderer.js`, find lines 2597-2607:
```js
// ---- Model picker dropdown ----
// Hub surfaces a short curated list of models that map to Claude Code's `/model`
// slash command. Keep this list in sync with Claude Code's supported IDs.
const MODEL_OPTIONS = [
  { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M context)' },
  { id: 'claude-opus-4-7',     label: 'Opus 4.7' },
  { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M context)' },
  { id: 'claude-opus-4-6',     label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6',   label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5',    label: 'Haiku 4.5' },
];
```

Replace with:
```js
// ---- Model picker dropdown ----
// Per-CLI model lists + gate predicates live in core/model-options.js so unit
// tests can require() them without spinning up Electron. See spec
// docs/superpowers/specs/2026-05-01-per-cli-model-picker-design.md for the
// rationale around in-place (Claude family) vs respawn (Codex/Gemini) paths.
const { modelOptionsFor, canRespawnWithResume } = require('../core/model-options.js');
```

- [ ] **Step 6.2: Update `attachModelPickerHandler` to gate before opening**

Find the existing `attachModelPickerHandler` (around line 2611):
```js
function attachModelPickerHandler(badgeEl, sessionId) {
  if (!badgeEl || badgeEl._modelPickerBound) return;
  badgeEl._modelPickerBound = true;
  badgeEl.classList.add('clickable');
  badgeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openModelPicker && openModelPicker.badge === badgeEl) {
      closeModelPicker();
      return;
    }
    showModelPicker(badgeEl, sessionId);
  });
}
```

Replace with:
```js
function attachModelPickerHandler(badgeEl, sessionId) {
  if (!badgeEl || badgeEl._modelPickerBound) return;
  badgeEl._modelPickerBound = true;
  badgeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const session = sessions.get(sessionId);
    if (!session) return;

    // Gate: unknown CLI kind has no list (e.g., powershell tabs).
    const opts = modelOptionsFor(session.kind);
    if (!opts.length) return;

    // Gate: in-meeting sessions are read-only for model switching (T7 spec).
    if (session.meetingId) {
      console.warn('[model-picker] disabled inside meeting:', sessionId);
      return;
    }

    // Gate: codex/gemini need resume meta; without it we cannot respawn safely.
    if (!canRespawnWithResume(session)) {
      console.warn('[model-picker] no resume meta for', session.kind, sessionId);
      return;
    }

    badgeEl.classList.add('clickable');
    if (openModelPicker && openModelPicker.badge === badgeEl) {
      closeModelPicker();
      return;
    }
    showModelPicker(badgeEl, sessionId);
  });
}
```

Note: `badgeEl.classList.add('clickable')` moves inside the handler (after gates pass) so badges on un-pickable sessions don't get the hover affordance. To revert affordance when a session loses pickability (e.g., enters meeting), the `updateActiveModelBadge` (line 2576+) call already re-runs `attachModelPickerHandler` per render, so the next click attempt re-evaluates gates.

- [ ] **Step 6.3: Update `showModelPicker` to consume per-kind list + dispatch**

Find `showModelPicker` (line 2625-2652). Replace the body with:

```js
function showModelPicker(badgeEl, sessionId) {
  closeModelPicker();
  const session = sessions.get(sessionId);
  if (!session) return;
  const options = modelOptionsFor(session.kind);
  if (!options.length) return;

  const isRespawn = session.kind === 'codex' || session.kind === 'gemini';
  const currentId = session.currentModel ? (session.currentModel.id || '') : '';
  const menu = document.createElement('div');
  menu.className = 'model-picker-menu';

  options.forEach((opt) => {
    const item = document.createElement('div');
    item.className = 'model-picker-item';
    item.dataset.modelId = opt.id;
    if (opt.id === currentId) item.classList.add('current');
    item.innerHTML = `<span class="model-picker-check">${opt.id === currentId ? '✓' : ''}</span><span class="model-picker-label">${escapeHtml(opt.label)}</span><span class="model-picker-id">${escapeHtml(opt.id)}</span>`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      // No-op when picking the current model.
      if (opt.id === currentId) { closeModelPicker(); return; }

      // Optimistic update — badge flips immediately. statusline / spawn
      // callback will re-confirm within seconds (R1 in spec §3).
      session.currentModel = { id: opt.id, displayName: opt.label };
      updateActiveModelBadge();

      if (isRespawn) {
        ipcRenderer.invoke('respawn-with-model', { sessionId, modelId: opt.id });
      } else {
        ipcRenderer.send('terminal-input', { sessionId, data: `/model ${opt.id}\r` });
      }
      closeModelPicker();
    });
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  const rect = badgeEl.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';
  const onDocClick = (e) => { if (!menu.contains(e.target)) closeModelPicker(); };
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
  openModelPicker = { el: menu, badge: badgeEl, onDocClick };
}
```

`closeModelPicker` (line 2654-2659) stays unchanged.

- [ ] **Step 6.4: Smoke-test the Hub still boots**

```bash
cd /c/Users/lintian/claude-session-hub
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

Expected: hook server listening line.

- [ ] **Step 6.5: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(renderer): per-CLI model picker with kind-based dispatch"
```

---

## Task 7: Renderer event handlers for `session-respawned` / `session-respawn-failed`

These IPC events come from the `tryRespawnWithModel` helper (Task 4) when the Codex/Gemini path fires. The renderer must replace the old session in `sessions` Map and `sessionOrder` Array, swap active session if the old one was active, and clean up local terminal/buffer state.

**Files:**
- Modify: `renderer/renderer.js` — add IPC listeners near other `ipcRenderer.on(...)` listeners (around line 2507 area)

- [ ] **Step 7.1: Locate existing IPC listener block + helpers**

Search `renderer/renderer.js` for `ipcRenderer.on('session-` patterns. The renderer already handles `session-created`, `session-closed`, etc. New listeners should sit alongside them.

Also identify the helper that destroys local session state (xterm dispose + DOM cleanup). Search for `destroySessionLocal` or the body of the `session-closed` handler.

- [ ] **Step 7.2: Add the listeners**

Insert these two listeners next to the existing `session-closed` handler in `renderer/renderer.js`:

```js
// Codex/Gemini model switch: main.js closes the old PTY then creates a new one
// with --model <new>. Renderer must swap the Map entry, the sessionOrder slot,
// and (if active) the active session — without a tab-position jump.
ipcRenderer.on('session-respawned', (_e, { oldSessionId, newSession }) => {
  const oldEntry = sessions.get(oldSessionId);
  if (!oldEntry) {
    // No local entry — main probably closed before renderer ever rendered the
    // old session. Just register the new one as a fresh session.
    sessions.set(newSession.id, { ...newSession, _tokenSamples: [] });
    if (typeof sessionOrder !== 'undefined') sessionOrder.push(newSession.id);
    renderSessionList();
    return;
  }

  // Capture position so the new session lands in the same sidebar slot.
  const idx = (typeof sessionOrder !== 'undefined') ? sessionOrder.indexOf(oldSessionId) : -1;
  const wasActive = activeSessionId === oldSessionId;

  // Tear down old session's xterm/DOM (mirrors the cleanup that 'session-closed'
  // does). If the codebase already has a helper, prefer that — search for the
  // session-closed handler body and call the same path.
  try {
    if (oldEntry.term && typeof oldEntry.term.dispose === 'function') oldEntry.term.dispose();
  } catch {}
  sessions.delete(oldSessionId);
  if (idx >= 0) sessionOrder.splice(idx, 1);

  // Insert new session at the same position to avoid tab visual jump.
  const merged = { ...newSession, _tokenSamples: [] };
  sessions.set(newSession.id, merged);
  if (idx >= 0) sessionOrder.splice(idx, 0, newSession.id);
  else sessionOrder.push(newSession.id);

  if (wasActive) {
    activeSessionId = newSession.id;
    // Re-render the active session header/terminal mount point.
    if (typeof renderActiveSession === 'function') renderActiveSession();
  }
  renderSessionList();
});

ipcRenderer.on('session-respawn-failed', (_e, { oldSessionId, error }) => {
  // closeSession already fired in main → old entry is orphaned locally too.
  // Show the user what happened and clean up so they're not stuck on a dead tab.
  console.error('[respawn] failed for', oldSessionId, error);
  const oldEntry = sessions.get(oldSessionId);
  if (oldEntry) {
    try { if (oldEntry.term && typeof oldEntry.term.dispose === 'function') oldEntry.term.dispose(); } catch {}
    sessions.delete(oldSessionId);
    if (typeof sessionOrder !== 'undefined') {
      const i = sessionOrder.indexOf(oldSessionId);
      if (i >= 0) sessionOrder.splice(i, 1);
    }
    if (activeSessionId === oldSessionId) {
      activeSessionId = sessionOrder.length ? sessionOrder[0] : null;
      if (typeof renderActiveSession === 'function') renderActiveSession();
    }
  }
  // User-visible alert. Hub doesn't expose a structured toast API yet, so use
  // a window.alert for now (visible + blocking ensures the user notices).
  // If toast helpers land later, swap for showToast(...).
  alert(`切模型失败：${error}\n会话已关闭，请重新创建。`);
  renderSessionList();
});
```

The `oldEntry.term?.dispose()` mirrors the typical xterm cleanup pattern used elsewhere in renderer.js. If the codebase already centralizes session destroy in a helper, replace the inline disposal with that helper call (search for `dispose` calls inside the `session-closed` handler).

- [ ] **Step 7.3: Smoke-test the Hub still boots**

```bash
cd /c/Users/lintian/claude-session-hub
timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
```

Expected: hook server line.

- [ ] **Step 7.4: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(renderer): handle session-respawned/failed IPC events"
```

---

## Task 8: End-to-end manual verification

Per the design doc (§7.2), the user explicitly chose manual verification over automated E2E. This task is a checklist for the user to run before merging.

**Files:** none (verification only)

- [ ] **Step 8.1: Start an isolated Hub instance**

Per `claude-session-hub/CLAUDE.md` §"并行测试 Hub 实例" template A:

```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-modelpicker-verify"
cd C:\Users\lintian\claude-session-hub
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9221
```

The isolated Hub should boot in 2-4s. Do NOT touch the production Hub via desktop shortcut.

- [ ] **Step 8.2: Verify Claude in-place switch**

1. In the test Hub, click the "Claude" button to spawn a Claude session.
2. Wait for the model badge to show "Opus 4.7 (1M context)".
3. Click the badge → picker should drop down with all 6 Claude models.
4. Click "Sonnet 4.6".
5. Expected: badge flips to "Sonnet 4.6" immediately. PTY shows `/model claude-sonnet-4-6` near the bottom. After ~2-5 seconds the statusline confirms (no flicker).

- [ ] **Step 8.3: Verify DeepSeek + GLM in-place switch**

Repeat 8.2 for DeepSeek (default V4 Pro → click "DS V4 Flash") and GLM (default → click "GLM 4.6"). Expected: same in-place behavior, PTY shows `/model deepseek-v4-flash` / `/model glm-4.6`.

- [ ] **Step 8.4: Verify Gemini respawn + context preservation**

1. Spawn a fresh Gemini session.
2. After it boots and authenticates (~5-10s), type a prompt: `请记住数字 42`. Wait for Gemini's reply.
3. Click the model badge → picker should show the 3 Gemini models.
4. Click "Gemini 3.1 Pro".
5. Expected:
   - Badge flips to "Gemini 3.1 Pro" immediately.
   - The session tab briefly shows reconnection (~1-3s) — terminal clears, then Gemini banner re-renders with the new model in its status bar.
   - Tab stays in the same sidebar position (no jump).
   - **No "Allow ...?" prompt appears** — yolo mode is preserved.
6. Type: `我刚让你记住的数字是几`.
7. Expected: Gemini's reply contains `42`. Conversation context is preserved across the model switch.

If the badge stays "stuck" on the optimistic value past 15 seconds, something failed. Open DevTools (Ctrl+Shift+I in test Hub) → Console → look for `[respawn]` errors.

- [ ] **Step 8.5: Verify Codex respawn + context preservation**

Same as 8.4 but for Codex:
1. Spawn fresh Codex (default GPT-5.5).
2. Send a message: `记住数字 17`.
3. Click badge → click "GPT-5.4".
4. Expected: tab reconnects without "Allow ...?" prompt. PTY shows the cmd `codex resume <sid> --dangerously-bypass-approvals-and-sandbox --model gpt-5.4`.
5. Send: `刚才我让你记什么数字`.
6. Expected: reply contains `17`.

- [ ] **Step 8.6: Verify same-model click is no-op**

In any session, click the badge → click the currently-selected model. Expected: menu closes, no IPC fires (DevTools Network tab has no `respawn-with-model` invoke; PTY ringbuffer doesn't get a new `/model` line).

- [ ] **Step 8.7: Verify in-meeting picker is disabled**

1. Create a meeting room.
2. Add a Codex sub-session.
3. Click the Codex sub's model badge.
4. Expected: nothing happens. DevTools Console shows `[model-picker] disabled inside meeting:`. The session is not killed/respawned.

- [ ] **Step 8.8: Verify renderer cleanup on respawn failure (optional, hard to trigger)**

If you can simulate a spawn failure (e.g., set `CODEX_API_KEY=invalid` for an API-backend Codex run, or rename `gemini.cmd` temporarily), trigger a respawn:
1. Click model badge → pick a different model.
2. Expected: window.alert pops up with "切模型失败".
3. After dismissing the alert, the old session tab is gone (cleaned). User can create a new one fresh.

- [ ] **Step 8.9: Cleanup**

```powershell
# Close test Hub via UI or kill the electron.exe process bound to port 9221.
$pid9221 = (Get-NetTCPConnection -LocalPort 9221 -ErrorAction SilentlyContinue).OwningProcess
if ($pid9221) { Stop-Process -Id $pid9221 -Force }
Remove-Item "C:\temp\hub-modelpicker-verify" -Recurse -Force -ErrorAction SilentlyContinue
```

- [ ] **Step 8.10: All verifications pass → mark plan complete**

If steps 8.2-8.7 all pass (8.8 is optional / soft-fail OK):
- The feature is ready for merge / production deploy via desktop shortcut.
- Run the full test suite once more for regression sanity:

```bash
cd /c/Users/lintian/claude-session-hub
node tests/unit-model-options.test.js
node tests/unit-build-spawn-cmd.test.js
node tests/unit-respawn-with-model.test.js
```

Expected: all green.

If any step 8.2-8.7 fails, file a bug under the spec and re-enter brainstorming for the regression.

---

## Self-Review

**Spec coverage:**
- §3.1 dispatch table → Tasks 1, 6 (per-CLI list + dispatch)
- §3.2 yolo invariant → Tasks 2, 3 (extract + lock + add `--model` passthrough)
- §3.3 optimistic update → Task 6 Step 6.3 (`session.currentModel = ...; updateActiveModelBadge();`)
- §4 architecture diagram → Tasks 4, 5 (helper + IPC), 7 (renderer events)
- §5 改动清单 → Mapped 1:1 across Tasks 1-7
- §6.1 MODEL_OPTIONS_BY_KIND → Task 1
- §6.2 IPC protocol (error union) → Task 4 (helper) + Task 5 (handler)
- §7 testing → Tasks 1, 2, 4 (unit), Task 8 (manual)
- §8 risks → R1 (badge stuck) deferred; R2/R3 (meeting/roundtable) covered by Task 6 in-meeting gate
- §9 implementation order → Tasks 1-8 follow the spec's recommended sequence

**Placeholder scan:** No "TBD" / "implement later" / placeholder text. All code blocks contain runnable code.

**Type consistency:**
- `tryRespawnWithModel` deps shape consistent across Task 4 test and Task 5 wiring (both use `getSessionInfo`, `getResumeMeta`, `closeSession`, `createSession`, `registerSessionForTap`, `sendToRenderer`).
- IPC error codes consistent: `'session-not-found'`, `'kind-not-respawnable'`, `'in-meeting'`, `'no-codex-sid'`, `'no-gemini-chat-id'`, `'respawn-failed'` appear in both spec §6.2 and Task 4 test/impl.
- `MODEL_OPTIONS_BY_KIND` ↔ `modelOptionsFor` ↔ `canRespawnWithResume` names consistent in Task 1 test/impl/Task 6 require.
