'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');

assert.ok(source.includes("meeting.scene === 'research'"), 'spirit commands must stay scoped to research rooms');
assert.ok(source.includes("value: '@英灵'"), 'missing generic spirit summon mention');
assert.ok(source.includes("value: '@英灵 巴菲特'"), 'missing Buffett mention');
assert.ok(source.includes("value: '@英灵 利弗莫尔'"), 'missing Livermore mention');
assert.ok(source.includes('统一 Lens Packet'), 'mention hint must communicate the provider-orthogonal contract');

console.log('  OK research mention picker exposes scoped spirit summon commands');
