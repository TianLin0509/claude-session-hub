'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const root = path.resolve(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const dispatcherSrc = fs.readFileSync(path.join(root, 'main', 'groupchat', 'dispatcher.js'), 'utf8');
const loopHandlerSrc = fs.readFileSync(path.join(root, 'main', 'ipc', 'loop-handlers.js'), 'utf8');
const css = readCssWithImports(path.join(root, 'renderer', 'meeting-room.css'));

assert.ok(rendererSrc.includes("require('../core/hero-prompts.js')"), 'renderer must use the shared built-in hero catalog');
assert.ok(rendererSrc.includes("dock.id = 'mr-hero-dock'"), '方案 B must render a composer-adjacent hero dock');
assert.ok(rendererSrc.includes('data-hero-sid'), 'hero selection must be per AI sid');
assert.ok(rendererSrc.includes('data-hero-preview'), 'hero dock must expose the actual prompt preview');
assert.ok(rendererSrc.includes("meeting.scene === 'research'"), 'hero dock must stay scoped to investment-research group chat');
assert.match(rendererSrc, /heroIdBySid:\s*opts\.heroIdBySid\s*\|\|\s*\{\}/, 'normal groupchat sends must pass the per-AI hero map');
assert.match(rendererSrc, /if \(Object\.keys\(heroIdBySid\)\.length\) _clearHeroAssignments\(m\);/, 'send must consume one-shot hero assignments');
assert.ok(rendererSrc.includes('_restoreHeroAssignments(meetingData[mid] || meeting, opts.heroIdBySid)'), 'failed normal sends must restore the hero selection');

assert.ok(dispatcherSrc.includes("require('../../core/hero-prompts.js')"), 'main dispatcher must own final hero prompt injection');
assert.ok(dispatcherSrc.includes('normalizeHeroAssignments('), 'main dispatcher must reject arbitrary prompt payloads');
assert.ok(dispatcherSrc.includes('prompt: appendHeroPrompt(basePrompt, normalizedHeroIdBySid[member.sid])'), 'dispatcher must append a different hero block per target AI');
assert.ok(loopHandlerSrc.includes('heroIdBySid: args.heroIdBySid || {}'), 'loop entry must preserve the same per-AI hero mapping');

for (const selector of [
  '.mr-hero-dock',
  '.mr-hero-slots',
  '.mr-hero-slot',
  '.mr-hero-select',
  '.mr-hero-preview-btn',
]) {
  assert.ok(css.includes(selector), `missing hero dock style: ${selector}`);
}
assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'hero dock must respect reduced motion');
assert.ok(css.includes('.mr-hero-select:focus-visible'), 'hero selects must expose keyboard focus');

console.log('hero prompt UI contract: ok');
