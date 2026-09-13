# Continuation handoff for the next Claude session (2026-09-10, late)

Read this first, then the plan file, then the findings. Do not restart the
research and do not redesign. Everything below was measured or built in this
session on the real working tree.

## Where things live

- Code (uncommitted, the only source of truth):
  `C:\Users\prana\Projects\nus-desktop`. The old jarvis mirror
  `work\nus-quiet-knot\source` and `sync.cjs` are RETIRED. Edit the repo.
- Plan of record (approved by Pranav, phases 1-5 with his amendments):
  `C:\Users\prana\.claude\plans\ok-so-i-ran-staged-quasar.md`.
- Test/QA workspace and evidence:
  `C:\Users\prana\Downloads\jarvis-starter\jarvis\work\nus-quiet-knot\`
  - `verification-2026-09-10\live\PHASE1-FINDINGS.md` (labels: real-device /
    synthetic / untested), `share-check.json`, `SHARE-CHECKLIST.md`,
    `memory-nudges.json`, `nudge-check.json`, `knot-crash.json`,
    `guide-continuity.json`, `inspect-*.json`, `voice-*.json`, PNGs.
  - Drivers: `launch-dev-play.ps1` (dev tree, isolated profile
    `final-public-profile`, `NUS_NO_PROTECT=1`, CDP 9341, main inspector
    9229), `launch-dev-protected.ps1` (both protection overrides cleared),
    `launch-dev-fakemic.ps1` (synthetic mic `speech-pauses.wav`),
    `cleanup-qa.ps1` (closes everything it started), `cdp-input.cjs`,
    `main-eval.cjs`, `zorder.ps1`, `press-chord.ps1`, `hold-chord.ps1`,
    `find-control.cjs "Add task"` (prints a control's screen centre),
    `fixture-win.cjs` (maximized Electron test page "Nus QA Notes"),
    `inspect-test.cjs X Y "" explain`, `walkthrough-test.cjs X Y`,
    `guide-continuity.cjs`, `paused-esc.cjs`, `crash-tail.cjs`,
    `talk-test.cjs talk 45`, `click-probe.cjs`, `region-test.cjs`,
    `share-check.cjs on|off`, `capture-fixture.cjs`, `region-diff.ps1`,
    `memory-nudges.cjs`, `nudge-test.cjs`, `probe-point.cjs`.
- Astra's docs: `docs\companion-restoration.md` (has Phase 1, 2, 3 sections
  appended by Claude), `docs\companion-launch.md`, `docs\claude-companion-handoff.md`.
- Jarvis vault handoff: `ventures\nus\COMPANION-KNOT-V2-HANDOFF.md`.
- Suite: `npm test` in nus-desktop = **270 passing** (started the day at 256).
- Rebuilt installer (unsigned, unpublished): `dist\quiet-knot-release-candidate`
  (verified 66 files match, package scan clean, installer sha256 starts
  `00174daaf980`). NOT smoke-tested yet (dev app was using port 9341).

## Hard rules from Pranav (unchanged)

Preserve all uncommitted work; never install over his real app, never
publish, no commits, no Windows account creation/removal without his word.
Claude is the answering engine for explicitly selected screen areas only; no
whole-screen upload, no other provider for that image, no continuous
capture, the Knot never clicks or types. Keep keyboard-first use, optional
voice, full transcripts, natural pauses, continuity, the silver corner Knot
and the four-corner picker. Label every result real-device / synthetic /
untested. No em dashes in copy. Speech off by default.

## Blocker right now

**Claude Code is signed out on this machine** (`claude -p` says "Failed to
authenticate: OAuth session expired and could not be refreshed"). Every
desktop-Claude answer (guide steps, selection answers, the new walkthrough
bridge) fails until Pranav runs `claude` in a terminal and signs in. The
Companion now says so in plain words (fixed this session). Ask him first.

## What was done this session (all in the repo, each with a regression test)

Phase 1 (live reproduction, 13 fixes): probe-based topmost restore
(`win.topmost` op in `companion/src/win/probe.ps1`, `restoreTopmost()` in
`companion/index.js`; `win.focus()` over a maximized app strips topmost and
only an external SetWindowPos restores it); Ctrl+Shift+T Send refused with
"app changed" because our own focus made the foreground null (null now means
"us", only a different app refuses; same in pointer revalidation); probe
crash on File Explorer (null control-type name in `Type-Name`); same-snapshot
follow-up ("Ask more" + Knot click); "Ask without screen" no longer captures
(`screen:false`, `wantScreen` in `runFeature`); click bursts no longer
toggle; window-sized UIA hits become "Select a region"; control covered by
our dashboard not pointed at; follow-up prompts carry goal + current step;
"did not work" keeps the real last step as hint; Escape on a selection keeps
a paused walkthrough (`showPaused()`, `lastInspectionClearedAt`); explicit
Show rebuilds a crashed renderer; `[ptt] stop: <reason>` logging; bounded
live-preview passes (`partialWindow` in `src/guide/voice.js`).

Phase 2 (built, unit-tested, NOT live-verified because Claude is signed out):
selection answer with Guide intent offers "Walk me through it" (inline
sentence: fresh screen picture per step, still Claude), starts
`GuideSession.start(task,'typed',{providerLock:'anthropic', prior})`, every
model call routed through `llm()` -> `llmFor('anthropic')` = the same
`claudeClient`; "Resume walkthrough" offered when a walkthrough is paused;
`startWalkthroughFromSelection()` drops the snapshot first. Also: expired
login classified as `cli_not_logged_in` in `src/ai.js`,
`describeClaudeError()` in `companion/src/selected-assistance.js` used by the
selection path and the guide fallback ("Claude is signed out. Reconnect
Claude in Nūs desktop Settings, or run claude in a terminal and sign in").
Live driver: `walkthrough-test.cjs $(node find-control.cjs "Add task")` with
the fixture in front.

Phase 3 (measured): with protection on (shipped default) the overlay was
excluded from GDI BitBlt and from Chromium desktopCapturer captures, also
after a renderer crash recovery; with `NUS_NO_PROTECT=1` it was present.
Chromium fell back to GDI on this machine (`DxgiDuplicatorController
failed`), so DXGI/WGC is untested. Zoom, Teams (store), Discord, OBS, Game
Bar are installed but untested: Pranav fills `SHARE-CHECKLIST.md`. Display
was 1760x990 at scale 1 during the run (was 1920x1080 earlier in the day).

Phase 4 (in progress): installer rebuilt and verified; plan nudge verified
live (task due today -> "... is due today." bubble at the first 15s tick,
Not now -> 45s silence, task deleted); app-open hint verified ("Nus QA
Notes: 1 saved", no thread); Saved sheet list / preview export / forget
verified. Replay of a kept walkthrough MISSED step 1 because typing at the
Knot gave the Companion focus so the probe saw no app in front: fixed with
a once-a-second foreground memory in main (`lastForeground`, dep
`lastForeground()` for the guide, `FOREGROUND_MEMORY_MS = 15000` in
session.js, test added, suite 270) but the fix is NOT yet re-verified live.

## Exactly where to pick up

1. Ask Pranav to sign in (`claude`), then confirm with `claude -p "Reply OK"`.
2. Reseed the kept walkthrough into the test profile (one entry
   `electron::help-me-add-a-task`, control "Add task" Button, app process
   `electron`, title "Nus QA Notes"; see the node one-liner at the end of the
   previous session or copy the shape from
   `companion/src/guide/walkthroughs.js` `record()`), close everything
   (`cleanup-qa.ps1`), launch `launch-dev-play.ps1`, wait 16s, launch the
   fixture (`fixture-win.cjs` via electron.exe), then
   `node memory-nudges.cjs` and expect steps 1-3 to pass (step 4 is
   cooldown-suppressed after the hint; that is by design, use
   `nudge-test.cjs` on a fresh app for nudges). Check the log for
   `[guide] replay:` followed by a `guide:target` with kicker "from last
   time" and NO model line; record replay latency.
3. With Claude signed in: `walkthrough-test.cjs` (Phase 2 live), then
   `inspect-test.cjs` on File Explorer's Sort button (`find-control.cjs`
   after activating "docs - File Explorer") to re-confirm selection answers.
4. Packaged smoke on the rebuilt RC: close the dev app, run
   `launch-play.ps1` (packaged, isolated profile) and
   `PACKAGED_PORT=9341 node packaged-smoke.cjs`, plus `final-verify.sh`
   steps that do not need Claude. Fresh-profile first run of the packaged
   build (onboarding, first Ctrl+Shift+T, first voice, first Keep) in a
   throwaway data dir; the second-Windows-account install stays "untested"
   unless Pranav approves creating the account.
5. Measurements into `latency-idle.json`: acknowledgement (chord keyup to
   `guide:state reading`, roughly 0.6 to 0.9s in today's runs), selection
   answer (5 to 7s live earlier), replay latency, and a 30-minute idle run
   (CPU/GPU/RAM of the Nus/electron processes every 30s, zero unprompted
   bubbles or hints). Display matrix: run what the machine allows, mark the
   rest untested. Dashboard and onboarding screenshots with reduced motion
   on and off.
6. Phase 5: observation script for five first-use sessions (Pranav runs
   them), full-display proof recording (Knot + app + his actions in one
   frame, `NUS_NO_PROTECT=1` for that take only, labeled), and the
   shareable evidence-labeled talking-points page (artifact) built only from
   these results, competitors' genuine advantages included, no "best", no
   universal invisibility.
7. Keep appending to `docs/companion-restoration.md`, update
   `PHASE1-FINDINGS.md`-style files per phase, and the memory notes
   (`electron-topmost-windows.md`, `nus-knot-companion-v2.md`).

Known limitations to keep stating: UI Automation picks the wrong element on
web-rendered layouts (Electron fixture: "Today" heading under a floated
button); Claude's own answers contain em dashes; human voice never tested;
`device-ended` voice stops not reproduced.
