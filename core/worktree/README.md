# core/worktree

Backend module for the Worktree Panel feature.

## Public API

- `index.getPanelData({ activeSessionId, allSessions, force }) → Promise<panelData>`

## Cache

`git-probe.probeRepo` caches results per absolute cwd for 30 seconds.
Pass `{ force: true }` to bypass.

## Boundaries

- No dependency on Hub session state. Caller passes `allSessions` shape `{sessionId, cwd, sessionLabel}`.
- Only `child_process` + `fs` + `path` standard libs.
- Removing `core/worktree/` and the `worktree:*` IPC handlers in `main.js` fully reverts the backend.
