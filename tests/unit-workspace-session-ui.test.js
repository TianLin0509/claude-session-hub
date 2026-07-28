'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'renderer', 'workspace-controller.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const meetingModal = fs.readFileSync(path.join(root, 'renderer', 'meeting-create-modal.js'), 'utf8');
const meetingRoom = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const sessionList = fs.readFileSync(path.join(root, 'renderer', 'session-list-renderer.js'), 'utf8');

assert.doesNotMatch(html, /id="workspace-bar"/, 'sidebar must not expose a global workspace');
assert.match(html, /data-workspace-mode="scratch"/);
assert.match(html, /data-workspace-mode="existing"/);
assert.match(html, /id="new-session-submit"/);
assert.match(controller, /openNewSessionModal/);
assert.match(controller, /workspace:create-scratch/);
assert.match(controller, /workspaceDraft:\s*!!workspace\.draft/);
assert.match(controller, /workspace:pick/);
assert.match(controller, /workspace:archive-context/);
assert.match(controller, /workspace:archive-and-restart/);
assert.match(controller, /id = 'workspace-archive-modal'/);
assert.match(renderer, /WorkspaceController\.openNewSessionModal/);
assert.match(renderer, /WorkspaceController\.maybePromptSessionArchive/);
assert.match(renderer, /WorkspaceController\.maybePromptMeetingArchive/);
assert.match(renderer, /workspace:\s*m\.workspace\s*\|\|\s*null/);
assert.match(meetingModal, /data-mcm-workspace-mode="scratch"/);
assert.match(meetingModal, /data-mcm-workspace-mode="existing"/);
assert.match(meetingModal, /workspaceDraft:\s*!!workspace\.draft/);
assert.match(meetingRoom, /id="mr-workspace-chip"/);
assert.doesNotMatch(sessionList, /visible\.length\s*\+\s*researchSessions\.length/,
  'sidebar render must not reference an undefined researchSessions binding');

console.log('unit-workspace-session-ui: PASS');
