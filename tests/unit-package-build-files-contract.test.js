'use strict';

const assert = require('assert');
const packageJson = require('../package.json');

const files = packageJson.build && packageJson.build.files;

assert.ok(Array.isArray(files), 'package.json build.files must be an array');
assert.ok(files.includes('main.js'), 'build.files must include Electron entry main.js');
assert.ok(files.includes('main-bootstrap.js'), 'build.files must include the ownership bootstrap');
assert.ok(files.includes('main/**/*'), 'build.files must include split main-process modules');
assert.ok(files.includes('core/**/*'), 'build.files must include core modules');
assert.ok(files.includes('renderer/**/*'), 'build.files must include renderer assets');

console.log('package build files contract ok');
