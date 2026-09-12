'use strict';
// Test entry only: real Chromium capture + worklet + IPC + WebSocket, deterministic
// ASR peer. Never wired into production and never claims real recognition accuracy.
const { app } = require('electron');
const path = require('path');
const os = require('os');
const data = path.resolve(process.env.CLAUDE_HUB_DATA_DIR || '.');
if (process.env.CLAUDE_HUB_E2E !== '1' || !data.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Isolated E2E only');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const WS = require('ws');
const voice = require('../../core/voice-input');
const Original = voice.VoiceStream;
voice.VoiceStream = class extends Original {
  constructor(options) {
    super({ ...options, socketFactory: () => new WS(`ws://127.0.0.1:${Number(process.env.HUB_VOICE_TEST_PORT)}`) });
  }
};
require('../../main-bootstrap');
