'use strict';
// Test entry only: real Chromium capture fed from a WAV file + worklet + IPC + real
// Token Plan recognition. Never wired into production.
const { app } = require('electron');
const path = require('path');
const os = require('os');
const data = path.resolve(process.env.CLAUDE_HUB_DATA_DIR || '.');
if (process.env.CLAUDE_HUB_E2E !== '1' || !data.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Isolated E2E only');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${process.env.HUB_VOICE_TEST_WAV}%noloop`);
require('../../main-bootstrap');
