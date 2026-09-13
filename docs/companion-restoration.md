# Companion restoration and release gates

Baseline: latest desktop working tree, inspected 2026-09-10. Existing uncommitted changes belong to the founder and must be preserved. Baseline automated suite: 227 passing tests. Historical packages are comparison references, not replacement source trees.

## Behavior inventory

| Behavior | Baseline finding | Required result |
| --- | --- | --- |
| Ctrl+Shift+T | Founder-only fake pointing harness | Public contextual inspection, optional typing |
| Typed assistance | Existing composer and guide | Quiet, no automatic capture for generic questions |
| Clicked voice | Shares 20-second hold limit | Explicit stop/cancel, 120-second cap and warning |
| Hold voice | Existing configurable shortcut and key release | Preserve 20-second cap |
| Transcript | Temporary voice hint | Complete retained session transcript, recoverable failure |
| Waveform | Existing microphone level plumbing | Visible real audio levels and distinct processing states |
| Speech | Guide path bypasses reply preference | All paths respect speech off |
| Visibility | Renderer crash logged only | Recovery respects explicit hide/disable |
| Strand | Existing connected corner-pinned Knot | Bounded motion, no recurring decorative pulse, reduced motion parity |
| Memory | Explicit Keep/Skip and saved workflows | Preserve consent, inspect/delete, validate replay |
| Capture exclusion | Existing Electron protection | Actual capture-mode tests required |

## Release checks not yet verified

- Real microphone pauses at 1, 3 and 5 seconds; slow transcription and device failure.
- All four corners, multiple monitors, 100/125/150/200 percent display scaling.
- Overlay, dashboard and onboarding visual regression checks.
- Screen-sharing application/version/mode checks, protection on/off and after recovery.
- Five observed first-use sessions and ordinary-work distraction feedback.
- Measured acknowledgement, answer latency, replay latency and idle resource use.
- Packaged fresh-user installation and uninterrupted real demonstration.

Do not describe automated or fixture checks as proof of these real-world gates.

## Implementation status — 2026-09-10

Work was applied to `C:/Users/prana/Projects/nus-desktop`, the inspected current desktop working tree. The older source mirror and installed application were not replaced. Unrelated working-tree changes were preserved; the complete Git diff also contains pre-existing founder work and must not be attributed entirely to this pass.

### Implemented in source

- Quiet typed questions use the existing ask path without automatically capturing the screen. Spoken replies respect the reply preference, including guidance. Microphone input does not enable spoken replies.
- Hold-to-talk retains its 20-second limit. The clicked voice button uses a separate 120-second limit, visible countdown, final-ten-second warning, Stop and Cancel. Recording, transcription and failure have distinct UI states. The compact waveform uses captured microphone levels.
- Full final voice transcripts remain in session memory with identities, revisions and audio ranges. Local preview transcription updates one incomplete entry instead of duplicating overlapping text. Voice entries are restored after renderer recovery and associated with their answer-history entries so the full transcript replaces the truncated history copy.
- Final audio is prioritized ahead of pending previews. Queue overload is explicit and retryable, not a silent empty result. Failed final transcription retains audio in session memory for Retry; successful transcription or Cancel clears that retry buffer. No new durable audio/transcript memory is enabled.
- Stop aborts unfinished preview transcription. Cancel, Panic, disabling the companion and renderer failure cancel queued/local voice work and invalidate late results. Existing OpenAI/Gemini speech requests receive cancellation signals; cancellation cannot start a subsequent provider fallback. Supported model requests receive abort signals, and stale responses are ignored.
- Renderer recovery is bounded to three automatic attempts, respects deliberate Hide/Panic/Disable, does not restart capture, and preserves recoverable task text. Explicit Show permits another recovery attempt.
- Existing silver Knot and connected-strand rendering are retained. Outward/return motion is capped at 800/600 ms, retargeting remains 300 ms, text/actions are available before arrival, and static pointing stops its animation loop. The overlay Knot rests quietly. OS and in-app reduced-motion settings settle the same logical states with static guidance.
- Guide sessions support clarification, simpler explanations, pause/resume, fresh context after failure, and explicit refresh. Inspecting another item pauses an active walkthrough rather than advancing it. A task is not recorded as completed solely because of a click: the person confirms completion before Keep can save it.
- Bounded context assembly is shared by companion requests and guidance, including the existing desktop fallback. Semester context obeys its sharing preference and includes relevance/freshness labels. Generic questions and clarification do not add continuous screen capture.
- Existing Keep/Skip and inspect/delete/export walkthrough controls remain. Keep now explains that it saves the task and steps locally, not audio or screenshots. Saved guidance checks the current application/target and explains mismatches.
- Six companion-first X drafts, Instagram positioning, proof-video requirements and measurement guidance are in `docs/companion-launch.md`. Nothing was posted or scheduled.

### Ctrl+Shift+T: Claude connection implemented; live validation pending

The founder explicitly approved Claude as the destination for deliberately selected screen areas on 2026-09-10. That destination blocker is resolved; do not ask the same provider-approval question again. This is a desktop shortcut, not a shortcut that only works inside the Claude application.

The shortcut resolves the foreground app/control and takes one local snapshot before focusing the composer. It previews the selected crop; Send routes only that crop, the question, selection metadata and bounded selection-conversation history to Claude. Typing is optional for Explain/Fix/Guide intents. A manually selected region is explicitly labeled as unverified. Follow-up questions use the same snapshot, without another capture. Generic Ask without screen remains separate.

The destination is pinned to Anthropic using the Companion Anthropic key, or the existing desktop Claude Code/Anthropic connection. It does not use the general provider preference and has no fallback to Gemini/OpenAI/NVIDIA. The existing desktop guidance hook has no computer-control tools. Cancellation/timeout reject late responses. The selected conversation is not inserted into another provider's ask history.

A proposed broader-context addition was rejected as exceeding selected-area authorization. It was removed. This new selection path does **not** automatically attach semester records, another active task, resume/briefing packs or other desktop context. Existing unrelated context-sharing preferences and guide flows remain separate.

The full display snapshot is local and transient, never a fallback upload. It is cleared on Send, cancellation, replacement, recovery or expiry. The selected image and its conversation remain usable for the selection's 120-second lifetime, then pixels are cleared. Text-only results remain in session display history; they are not new durable memory. Selection age, application and display bounds are checked. Preparation locks out overlapping requests; Escape cancels it. Changing a region during an answer is refused.

The strand may point only back to the selected accessibility control, after its current app, name, type and bounds are revalidated and sensitive controls rejected. A guessed coordinate or manually selected region never becomes a supposedly verified control. If Claude cannot work from that area, it can request a new selection; it does not silently expand to a full-display capture. The existing general multi-step guide is still separate: this pass does not fully merge selection assistance with saved-walkthrough progression.

Known scope limits: selection/cropping uses the configured Knot display, not arbitrary cross-monitor travel; actual display scaling must still be verified. The snapshot can become visually stale while the same window/control remains; its capture time is displayed and Ctrl+Shift+T refreshes it. The 120-second selection lifetime is a provisional design limit and needs usability testing. Live Claude, OS capture, UI Automation and packaged-app behavior have not been proven by the mock tests.

**Source implementation is not a release claim. Run the real selected-area workflow before filming or advertising it.**

### Verification evidence

| Check | Result | Limits |
| --- | --- | --- |
| Source tests | 256 passed, 0 failed; baseline was 227 | Includes structural contracts and runtime unit tests; not 256 live desktop scenarios |
| Cancellation tests | Worker termination, pre-abort, listener cleanup, no post-cancel cloud fallback, provider signal forwarding, per-session queue cancellation pass | Provider calls use mocks; no private audio or live cloud request |
| Guide and strand tests | Pause/clarification, completion confirmation, stale response rejection, validated targets, reduced-motion callbacks and bounded travel pass | Simulated windows, controls and animation clock |
| Selected-area tests | Crop mapping at 100/125/150/200%, negative monitor origin, inward rounding, invalid bounds, Claude-only routing, bounded follow-ups, cancellation, timeout and no unrelated context pass | Simulated capture, window metadata and AI responses; not live provider or monitor tests |
| Isolated Electron renderer | Composer/repeated click, four-corner preview bounds, selected crop preview, optional typing, screen-free ask during a paused guide, full transcript restoration, settings and reduced motion pass; no recorded renderer errors | 1280×900 dummy-data fixture, not the installed overlay or real microphone |
| Visual inspection | Settings and selected-preview panels fit; preview labels have dark backing for readability over a light desktop; Knot remains at its corner | Dashboard, onboarding, other resolutions and real display scaling remain unverified |
| Syntax and whitespace | Changed main/renderer/STT files parse; `git diff --check` passes | Existing Windows line-ending warnings are not failures |
| Updated Windows candidate | Directory build succeeds; package checker passes with 7,896 entries and 62 owned text files scanned; no missing/forbidden paths, unreadable paths or flagged secrets | Unsigned, unpublished; package scanning is not a complete security audit or installation test |

Renderer evidence is under `C:/Users/prana/Downloads/jarvis-starter/jarvis/work/nus-quiet-knot/verification-2026-09-10/`: `renderer-smoke.json`, `companion-settings-fixture.png` and `companion-selection-fixture.png`. Screenshots show an isolated test window with a generated example button, not the person's desktop.

### Candidate build and remaining handoff

The older `dist/win-unpacked/resources/app.asar` failed the current package checker because required current files were missing. It was left untouched. A separate unpublished, unsigned Windows directory build is staged under `C:/Users/prana/Downloads/jarvis-starter/jarvis/work/nus-companion-restoration-candidate/win-unpacked`. It is a test candidate, not a release or fresh-install verification. Do not publish it or substitute it for the installed app without the release checks above.

Remaining work:

- Run all real-world release gates above, including capture protection enabled/disabled and after recovery. Never claim universal screen-sharing invisibility from Electron configuration alone.
- Exercise Ctrl+Shift+T end to end with live Claude, explicit selection, correct crop, optional typing, retry, expiry and cancellation. Verify the existing installed CLI/API configuration rather than assuming the mock-tested connection is authenticated.
- Integrate selection-to-walkthrough continuity deliberately if needed; never silently broaden a selected-area request to whole-screen capture or route its image/context to another provider.
- Complete visual regression checks in dashboard and onboarding, which share Knot rendering, and verify real target placement/clickability on multiple displays and scaling levels.
- Audit durable preference/memory editing end to end. This pass preserves existing settings and walkthrough management; it does not deliver a new comprehensive memory editor.
- Verify suggestion cooldown, snooze and ordinary-work distraction behavior with actual permitted plans. No new background surveillance was added.
- On cloud-only voice setups, show recording activity followed by the final transcript; the new live partial previews require local transcription. Do not imply streaming cloud partials exist.
- The desktop CLI model fallback cannot guarantee termination of an already-running external process; cancellation suppresses its late result. Provider-side work may continue even when a request is locally aborted.
- Measure actual acknowledgement/response/replay timings and idle resource use on the demo machine. The 200 ms / five-second / two-second targets are not measured claims.
- Observe five first-use sessions, record findings, fix failures, then capture real proof footage and obtain a launch date. Draft posts are not evidence of product performance or market demand.

No installed app was overwritten, no production account was exercised, and no release, social post or installer was published in this pass.

## Phase 1 live verification — 2026-09-10 (Claude)

Live reproduction on the current working tree (synthetic input over CDP and a
fake microphone against the real app, Windows UI Automation, OS windowing and
live Claude; human voice and real screen sharing still untested). Full table,
labels and evidence: `C:/Users/prana/Downloads/jarvis-starter/jarvis/work/nus-quiet-knot/verification-2026-09-10/live/PHASE1-FINDINGS.md`.
Suite: 267 passing (was 256). Fixed with regression tests:

- Knot vanishing after Ctrl+Shift+T over a maximized app: `focus()` drops the
  overlay to the bottom of the z-order and Chromium refuses HWND_TOPMOST from
  inside the app; the Windows probe now restores it externally
  (`win.topmost`), used by the guard and right after the selection focus.
- Ctrl+Shift+T Send refused every time ("app changed") because the Companion
  itself was the foreground window; null foreground is no longer a change.
- Probe crash on File Explorer (null control-type name) that made every
  WinUI app return "no control".
- Same-snapshot follow-up from the Knot click and an "Ask more" action.
- "Ask without screen" no longer captures; click bursts no longer toggle;
  window-sized hits become "Select a region"; a control covered by the Nūs
  dashboard is not pointed at; clarification prompts carry the goal and
  current step; Escape on a selection keeps a paused walkthrough; an explicit
  Show rebuilds a crashed renderer; every voice stop logs its reason; the
  live preview is bounded per pass.

## Phase 2 — selection to walkthrough bridge (2026-09-10, Claude)

Implemented (269 tests passing):
- A selection answer sent with the Guide intent offers **Walk me through it**.
  Its hint says, once and inline: "Walk me through it takes a fresh screen
  picture at each step and sends it to Claude." Clicking it drops the
  selected snapshot, ends any paused walkthrough, and starts the ordinary
  multi-step guide with the question as the goal and the selection answer as
  one line of prior context (text only, `prior` in the pointing prompt).
- That walkthrough is pinned to Claude for its whole life
  (`GuideSession.start(task, source, { providerLock: 'anthropic' })`;
  `llm()` routes every model call through `llmFor('anthropic')`, the same
  `claudeClient` the selection uses). A walkthrough typed at the Knot keeps
  today's provider behaviour.
- A selection answer while a walkthrough is paused offers **Resume
  walkthrough**.
- Found live while testing: the Claude Code login had expired
  ("Failed to authenticate: OAuth session expired"), and the Companion
  reported it as "Claude could not answer". `src/ai.js` now classifies that
  as `cli_not_logged_in`, and both the selection path and the guide fallback
  say "Claude is signed out. Reconnect Claude in Nūs desktop Settings, or run
  claude in a terminal and sign in, then try again." Verified live.

Not yet verified live: the bridge itself and Resume walkthrough, because
Claude Code is signed out on this machine. The driver is
`work/nus-quiet-knot/walkthrough-test.cjs` (needs `find-control.cjs "Add task"`
for the fixture's button position). Run it after `claude` signs in again.

## Phase 3 — screen-sharing exclusion, measured (2026-09-10, Claude)

Real-device captures on Windows 10.0.26200.9445, app 0.2.5, Electron 43.4.0,
display 1760x990 at scale 1 during the run. Method: capture with the
Companion shown, hide it, capture again, compare the Knot corner (3840 sampled
points). Results in `work/nus-quiet-knot/verification-2026-09-10/live/share-check.json`
with the PNG pairs beside it:

| State | GDI BitBlt | Chromium desktopCapturer |
| --- | --- | --- |
| Protection on (shipped default, both env overrides cleared) | excluded (0 changed) | excluded (0 changed) |
| Protection on, after renderer crash recovery | excluded (0 changed) | excluded (0 changed) |
| `NUS_NO_PROTECT=1` (control) | present (1352 changed) | present (1352 changed) |

Caveats: Chromium logged `DxgiDuplicatorController failed` and fell back to
GDI on this machine, so the DXGI/WGC path is not covered. Zoom, Teams
(store), Discord, OBS and Game Bar are installed but were NOT tested; the
manual table is `SHARE-CHECKLIST.md`. The Nūs dashboard window is never
protected and appears in every capture, by design. The `NUS_NO_PROTECT=0`
misparse from the earlier launcher is fixed (`=== '1'` only).

## Phases 1-3 review — 2026-09-10 (second session, Claude)

Before continuing, every Phase 1-3 claim was re-checked against the tree and
the evidence files (`work/nus-quiet-knot/verification-2026-09-10/live/PHASE1-3-REVIEW.md`).
All 13 Phase 1 fixes have their code path, regression test and evidence;
fixes 3 and 6 were re-run live and hold. Phase 2's bridge code matches the
plan except one wording: with no Claude connection the action shows a message
on click rather than a disabled button. Phase 3's share-check rows match the
table above. No code drift.

## Phase 4 — packaged candidate, measurements, memory (2026-09-10, Claude)

Claude Code was signed in again, so the Phase 2 live check ran first: the
bridge, the Claude-pinned walkthrough, "Resume walkthrough" and Escape all
behaved as designed with live Claude (`walkthrough-bridge.json`). Full table:
`work/nus-quiet-knot/verification-2026-09-10/live/PHASE4-FINDINGS.md`.
Suite 272 (two new regression tests). Two more live-found defects fixed:

- A kept walkthrough on a Chromium-rendered app (Electron, Chrome, Teams)
  missed its first step because the first UI Automation walk of such a window
  returns only the native frame; the page's controls appear once that first
  query wakes the accessibility tree. `replayStep` retries the find once after
  500ms and the miss log now says what the probe saw. Replay on the fixture:
  1.4s fresh (with the retry), 0.6s warm, no model call.
- On the packaged build, after "Walk me through it" the selection conversation
  panel stayed open over the pointed control, so a real click landed on our
  own panel. The renderer now folds the panel away when it covers a pointed
  target (`collapsePanelIfCovering`). Unit-tested and re-verified live on the
  rebuilt packaged build: the click reached the app and the walkthrough ran
  through completion, confirmation and Keep on a fresh profile.

- Evening: with Pranav's installed Nūs 0.2.3 running beside the dev build,
  Ctrl+Shift+T recognized nothing because the installed app's click-through
  Companion overlay was "the window under the cursor". The probe now skips
  WS_EX_TRANSPARENT windows in both its cursor and foreground walks
  (`ClickThrough`), which also covers Discord or GeForce style overlays.
  Re-verified live with the installed app still running.

Verified: the app-open hint, the Saved sheet, the 20-minute nudge cooldown
(`nudge-cooldown.json`), pointing accuracy and crop size equal to the UI
Automation rect at 100 percent, Knot placement in all four corners
(`display-matrix.json`; 125/150/200 percent and multiple displays untested by
Pranav's choice), dashboard, real onboarding flow and overlay Knot with
reduced motion off and on (`visual-check.json`). Measured numbers are in
`latency-idle.json`: hotkey to reading 0.18 to 0.26s, hotkey to selection
ready 0.51 to 0.69s, Claude selection answers 4.7 to 7.6s, guide steps 4.3 to
4.9s, replay 0.6 to 1.5s, plus the 30-minute idle row.

Packaged candidate: rebuilt twice from the tree (unsigned, `--publish never`),
package check clean (66 files match), security scan clean, `final-verify.sh`
all nine steps pass on the final RC (`final-verify-run3.log`). Fresh-profile
first run in a throwaway data dir on the packaged build: onboarding appears
and walks through, the Companion is present, the first Ctrl+Shift+T selected
the right control and Claude answered in 6.4s, "Walk me through it" pointed at
the exact button, and Talk on a profile with no speech provider says "Set up
voice in Nūs, or add a speech provider in Settings." The first Keep on the
packaged build was reached in the third fresh run (one real click on the
pointed button, "Did the task finish?", Keep, one saved walkthrough in the
throwaway profile). The second-account
install stays untested: Pranav declined creating a test account; the
per-user installer would overwrite his real install. `Nus-Setup.exe` was never
run. Note: the packaged build contacts the update feed on launch.

## Phase 5 — demo-honest readiness (2026-09-10, Claude)

- Observation script, sheet and blank results template for the five first-use
  sessions: `docs/first-use-sessions.md` (Pranav runs them; no results yet).
- Proof-recording recipe: `work/nus-quiet-knot/PROOF-TAKE.md` (full display,
  `NUS_NO_PROTECT=1` for that take only, labeled, unedited, Pranav drives).
  The take itself has not been recorded.
- Talking-points page built only from Phase 1-4 evidence, every claim labeled
  (verified now / fixed this pass / planned / competitor, dated source /
  untested), competitors' genuine advantages included, no "best" and no
  universal invisibility: `work/nus-quiet-knot/verification-2026-09-10/talking-points.html`
  (published as a private artifact for Pranav).
- Nothing committed, published, posted or installed over the real app.
