'use strict';
// Test entry: install deterministic message producers after Electron is ready
// to expose its APIs, then run the unchanged application bootstrap.
const path = require('node:path');
require('electron').app.setAppPath(path.resolve(__dirname, '../..'));
require('./dev-workbench-fixture-preload');
require('../../main-bootstrap');
