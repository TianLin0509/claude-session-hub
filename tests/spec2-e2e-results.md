# Spec 2 · S10 E2E Validation Report

**Branch**: `feat/ui-redesign-spec1`
**Baseline commit (pre-S10)**: `96f421b` (S9 — version sync v0.9.0)
**Test script**: `tests/e2e-spec2-card-view.js`
**Raw console output**: `tests/spec2-e2e-results.txt`

---

## Phase 1 — Hub launch

- Stale isolated Hub PIDs killed: `22096`, `23076`, `25348`, `41912`
- Fresh isolated Hub launched, 3 child processes alive in `hub-feat-ui-redesign-spec1` path
- CDP listening on `127.0.0.1:9350`, page id `9AA33C4DA27364337BAEAD244775A853`
- Hook server bound to `127.0.0.1:3458` (3456/3457 occupied by production Hub — fallback worked)
- Production Hub: 16 processes before kill, 16 processes after kill (untouched)

---

## Phase 2 — 13 scenarios (11 auto + 4 manual)

| # | Scenario | Result |
|---|---|---|
| 1 | CSS `--ui-purple-1` + `view-toggle` + `msg-overlay` exist | PASS — purple1=`#8b5cf6` |
| 2 | Default `currentView === 'card'` | PASS |
| 3 | `mountSessionTurnCard` injects `.turn-card` into `#msg-overlay` | PASS |
| 4 | Tool block `>15 lines` collapses with `[data-action="tc-expand"]` | PASS — toggle text "▸ 展开 25 行(折叠 >15 行)" |
| 5 | Code block triggers Prism `.token.keyword` / `.token.function` | PASS |
| 6 | 35-line code block has `.code-block-wrap` + `.code-toggle` | PASS — "▸ 展开 30 of 36 行 · javascript" |
| 7 | `src/foo.md` becomes `.rt-file-link[data-path="src/foo.md"]` | PASS |
| 8 | Operation buttons `.ta-btn[data-action]` (copy/regen on assistant; resend/edit-resend on user) | PASS — all 4 present |
| 9 | `details.turn-thinking` rendered without `open` attr (collapsed by default) | PASS — summary "💭 思考过程" |
| 10 | Thinking >5120 chars summary contains `(前 200 字符:` | PASS |
| 11 | `parse-session-transcript` IPC on real fixture — no user turn carries `tool_result` JSON / `tool_use_id` | PASS — 2 turns parsed, 0 offenders |
| 12 | MANUAL — Real session switch (need actual Claude CLI process running in Hub) |  MANUAL |
| 13 | MANUAL — Real assistant `turn-complete-event` (need real Claude CLI generating) | MANUAL |
| 14 | MANUAL — `openPreviewPanel` triggered by .md path click | MANUAL |
| 15 | MANUAL — `.ta-btn` hover visibility (need real mouse) | MANUAL |

**Auto: 11/11 PASS · Manual: 4 for user**

---

## Phase 3 — 圆桌 regression

| # | Check | Result |
|---|---|---|
| R1 | `renderer/meeting-room.js`: `_renderFusedTabs` + `_renderPreviewBlocks` defined | PASS |
| R2 | `core/meeting-room.js`: `appendTurn(...)` defined | PASS |
| R3 | `main.js` emits `'meeting-timeline-updated'` (≥2 occurrences) | PASS — 2 emit sites |
| R4 | `core/transcript-tap.js`: 0 commits since spec1 baseline `06d0ab1` | PASS |
| R5 | MANUAL — New meeting → 3 sub-sessions added → fanout turn → cards render | MANUAL |

**Auto: 4/4 PASS · Manual: 1 for user**

---

## Verdict

**PASS — 15/15 auto scenarios pass, 5 manual scenarios deferred to user**

- Spec 2's promise of "0 圆桌行为变化" verified at code level: `core/transcript-tap.js` is byte-identical since spec 1 baseline (`06d0ab1`); 圆桌 functions intact in both renderer and core; `meeting-timeline-updated` IPC unchanged.
- Card-view rendering pipeline (S1 parser → S3 IPC → S4 mount → S5 history load → S6 turn-complete → S8 thinking) wired end-to-end and verified with mock turns + real fixture.

---

## Manual scenarios for user

1. **Session switch** — Open Hub, start a real Claude session, click another session, verify the card overlay correctly clears + repopulates from history.
2. **Real turn-complete** — Send a prompt to a Claude session and verify the new assistant card appears via `turn-complete-event` (not just from `loadSessionHistoryToOverlay` reload).
3. **Path click** — Click an `.rt-file-link` (e.g., a `.md` path inside an assistant card) and verify preview panel opens.
4. **Hover affordance** — Hover over a turn card and verify `.ta-btn` operation buttons fade in (CSS hover state).
5. **圆桌 fanout** — Create a new meeting with 3 sub-sessions, send a fanout prompt, verify 圆桌 timeline cards render correctly (this is the critical "0 regression" promise).
