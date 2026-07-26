'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = readCssWithImports(path.join(root, 'renderer', 'styles.css'));

assert(index.includes('<script src="task-presets.js"></script>'), 'task preset module must load in the renderer');
assert(index.indexOf('task-presets.js') < index.indexOf('renderer.js'), 'task presets must load before normal-session UI mounts');
assert(renderer.includes("presetToolbar.className = 'fi-preset-toolbar'"), 'normal session must render a preset row above the composer');
assert(renderer.includes("presetPreview.className = 'fi-preset-preview'"), 'selected constraint must stay visibly separate from the user text');
assert(renderer.includes("presetPreviewText.contentEditable = 'true'"), 'selected constraint must be editable before send');
assert(renderer.includes('floatingInputPresetDrafts.delete(sessionId)'), 'preset selection must be reversible without rewriting user text');
assert(renderer.includes('presetApi.composePrompt(userText, selectedPreset.id, selectedPreset.constraint)'), 'normal send path must compose the selected preset only at send time');
assert(renderer.includes("presetKind.endsWith('-resume')"), 'resumed sessions (claude-resume / codex-resume / kimi-resume) must also see the preset row');
assert(css.includes('.fi-preset-toolbar'), 'preset row must be styled');
assert(css.includes('.fi-preset-chip[aria-pressed="true"]'), 'selected preset must have a non-ambiguous state');
assert(css.includes('.fi-composer-row'), 'existing input and action buttons must remain in one composer row');

console.log('session task presets UI contract ok');
