# Continuation handoff (2026-09-10, second session, evening)

Supersedes `claude-continuation-2026-09-10.md` for state; that file still holds
the driver list and the hard rules, which are unchanged. Read this, then the
plan `C:\Users\prana\.claude\plans\continue-the-n-s-companion-validated-dragonfly.md`,
then the findings files named below. Do not restart research or redesign.

## State

- Code: `C:\Users\prana\Projects\nus-desktop`, uncommitted, suite **272**.
- Findings, in order: `work\nus-quiet-knot\verification-2026-09-10\live\`
  `PHASE1-FINDINGS.md`, `PHASE1-3-REVIEW.md`, `PHASE4-FINDINGS.md`,
  `PHASE5-STATUS.md`; records `latency-idle.json`, `display-matrix.json`,
  `share-check.json`, `visual-check.json`, `nudge-cooldown.json`,
  `fresh-profile-first-run.json`, `walkthrough-bridge.json`, `replay-run*.json`,
  `corner-check.json`, `idle-samples.jsonl`, `idle-watch.json`.
- RC: `dist\quiet-knot-release-candidate` rebuilt from the final tree
  (`build3.log`), `final-verify.sh` all nine steps pass
  (`final-verify-run3.log`). Unsigned, unpublished, never installed.
- Claude Code signed in at the time of writing (`claude -p "Reply OK"`).

## What changed in the code today (each with a test)

1. `companion/src/guide/session.js`: `replayStep` retries `uia.find` once
   after `REPLAY_FIND_RETRY_MS` (500ms) because Chromium windows answer the
   first UI Automation query with only their native frame; the miss log now
   carries the reason (`replay miss on step 1: find score 0, searched 4 in
   "Nus QA Notes" hwnd ...`). Tests in `guide-session.test.js`.
2. `companion/renderer/renderer.js`: `collapsePanelIfCovering(bbox)` on every
   `guide:target`, because the selection conversation panel covered the
   pointed control on the packaged build. Test in `knot-ui.test.js`.
3. `companion/src/win/probe.ps1`: `ClickThrough(h)`; `TopWindowAt` and
   `Get-Foreground` skip WS_EX_TRANSPARENT windows. Found when Pranav's
   installed Nūs 0.2.3 ran beside the dev build and its click-through overlay
   swallowed every Ctrl+Shift+T. Test in `probe.test.js`. Suite 273. The RC
   was rebuilt once more afterwards (`build4.log`).

## Exactly where to pick up

1. Done (evening): the live re-check of fix 2 on the packaged build passed
   end to end (`fresh-profile-first-run.json` run 3: no cover, real click,
   completion, Keep, one saved walkthrough). Recipe if it needs repeating:
   `cleanup-qa.ps1`, `launch-fresh.ps1` (throwaway profile, CDP 9342, fake
   mic), `PORT=9342 node first-run.cjs` with stdout redirected to a file.
   The driver presses the hotkey only after `find-control.cjs` (now with the
   Chromium retry) sees the fixture, and clicks only after the probe confirms
   the button is under the point. Delete the throwaway dir afterwards.
2. Optional dry run of the proof recorder (10s, synthetic) per `PROOF-TAKE.md`.
3. Everything else is Pranav's: see `PHASE5-STATUS.md`.

## Drivers added today (QA folder)

`replay-only.cjs`, `find-test.cjs`, `find-test2.cjs`, `corner-check.cjs`,
`visual-check.cjs`, `nudge-cooldown.cjs`, `idle-sample.ps1`, `idle-watch.cjs`,
`click-at.ps1` (real OS click; avoid while Pranav is at the machine),
`launch-fresh.ps1`, `first-run.cjs`, `unwind-demo.js` (now picks the Guide
intent). `git-baseline-2026-09-10b.txt` is the `git status` at the start of
the session (65 paths).

## Cautions learned today

- Never press the chord or click when Pranav may be using the PC; check the
  foreground first. The Windows session also locked itself once mid-run.
- Bash heredocs in this environment strip one level of backslashes; write
  regex-bearing files with the Write tool.
- The packaged build must be closed before rebuilding into the same dist dir.
- `final-verify.sh` leaves the RC running and holds the shell; run it in the
  background and read `final-verify-run*.log`.
