# Nūs Companion — release preparation handoff to Claude

Prepared 2026-09-12. Read this first, then `docs/companion-pointing-fix.md`.
This supersedes earlier continuation notes for the latest pointing behavior,
test count, and candidate location. Older restoration notes remain background,
not evidence that this exact build passed every release gate.

## 1. What Pranav wants now

Prepare the current working companion for release. Preserve the silver Knot,
quiet keyboard-first interaction, connected strand, voice options, and your
existing restoration work. Do not restart research, replace the companion with
a generic chat UI, or remove capabilities to simplify the release.

The user explicitly confirmed Ctrl+Shift+T works on visible buttons, then asked
for help at arbitrary spots too. That follow-up is implemented and was opened
for testing. The user now wants to move toward release. This is general user
acceptance, not a recorded pass of every platform, voice, and privacy scenario.

This handoff is release preparation, not a public deployment. Complete safe
local checks and fix concrete blockers. Before publishing, show the exact
version, artifacts, verification results, limitations, and proposed release
notes, and obtain the user's final publish confirmation. Do not silently tag,
push, upload, replace live downloads, install over their app, or change services.

## 2. Authoritative working tree and build

- Source: `C:/Users/prana/Projects/nus-desktop`.
- Current local HEAD: `209358f` (v0.2.4 commit). `package.json` is currently
  `0.2.5`; the substantial restoration and latest fixes are UNCOMMITTED.
- Many essential files are UNTRACKED, including the guide folder, Windows probe,
  strand, quiet CSS, inspection helpers and new tests. Inspect `git status`
  carefully: a commit of tracked changes alone will lose critical functionality.
- Preserve existing unrelated/overlapping changes. Do not reset, restore the
  older commit, blindly stage all files, or use the old mirror as source.
- Old mirror `C:/Users/prana/Downloads/jarvis-starter/jarvis/work/nus-quiet-knot/source`
  is NOT the current source. Old `dist/quiet-knot-release-candidate` is NOT the
  latest test build.
- Latest unpacked Windows test app:
  `C:/Users/prana/Downloads/jarvis-starter/jarvis/work/nus-companion-anywhere/win-unpacked/Nus.exe`.
- Its launcher is `launch-companion.ps1` in the parent `nus-companion-anywhere`
  directory. It uses the existing isolated profile:
  `C:/Users/prana/Downloads/jarvis-starter/jarvis/work/nus-quiet-knot/final-public-profile`.
  Do not package this profile, test vault, credentials, session logs, or captures.
- Verified test `resources/app.asar` SHA-256:
  `AD4744D89724E99697A2BD5E8CBC1EFF8559F8140085766F369811C8904BB8A4`.

IMPORTANT: the test launcher sets `NUS_NO_PROTECT=1`, `NUS_NO_PROTOCOL=1`,
`NUS_FOUNDER=0`, an isolated data/vault path, and localhost debugging port 9341.
It is an unsigned directory build, not a release installer. Do NOT ship this
launcher or mistake its runtime flags for production defaults. The source
enables overlay content protection unless `NUS_NO_PROTECT` or
`JARVIS_NO_PROTECT` equals `1`. These are runtime settings, not baked into ASAR.

## 3. Latest code changes to retain

### Reliable Ctrl+Shift+T and usable mode controls

The earlier executable lacked newer main-process pointing code even though its
renderer matched source. Rebuilding from the correct tree was essential.

- `companion/src/inspection-input.js`: checks shortcut registration and reports
  conflicts; reopening settings retries registration. Samples the hotkey's
  original cursor position before asynchronous work and retries one unusable
  accessibility query at that same point. Rejects invalid/off-display/oversized
  targets. Recognized sensitive fields stop rather than becoming area fallbacks.
- `companion/index.js`: uses those helpers; bounds selection preparation to ten
  seconds, invalidates late results and surfaces persistent recovery guidance.
  Keeps Fable's immediate `pointAtSelection()` after `sendInspectionReady()`;
  a detected control gets a strand before any model answer.
- `companion/renderer/index.html`, `renderer.js`, `quiet-knot.css`: replaces the
  visible native intent dropdown with inline Ask / Explain / Fix / Guide
  buttons and selected-state styling. The old hidden select remains a value
  compatibility layer. A native popup could fall outside DOM-based click-through
  hit testing; this was a plausible UI failure, not a proven OS diagnosis.
- `companion/preload.js`: allowlists `inspect:failed`. Failures open a useful
  retry/typed-help message rather than leaving “Selecting…” indefinitely.
- General Ask stays screen-free. Selected-area help still routes to Claude,
  regardless of the generic provider preference. Do not silently change the
  user's provider setting, enable speech, or submit a capture without Send.

### New: arbitrary-spot help, not only buttons

- When no usable accessibility control is found, `pointContext()` produces a
  nearby crop, maximum 480 × 320 DIP and at most half the display in each
  dimension. Cropping is clamped at display edges; the actual chosen point is
  stored separately, so the strand does not drift toward the crop's center.
- Selection source is `point-context`, distinct from `accessibility` and a
  manually drawn `user-selected` region. The strand marks the user's spot with
  “Your spot · not a detected control”. It is not claiming a validated action.
- The composer asks what is happening. A typed message describes the problem;
  Enter with no text asks Claude to briefly describe the preview and ask one
  useful clarifying question, without assuming anything is broken.
- The preview remains local until Send. Select region can change its scope.
  Only the crop, the point's position within it, and this conversation are sent
  to Claude. The transient full-display capture is never a fallback payload.
- `companion/src/selected-assistance.js` supplies the source distinction and
  point fractions to Claude, preserves screenshot injection defenses, and
  refuses to turn an arbitrary spot into a model-verified action target.
- Region reselection clears the old spot marker and winds its strand back.
  Existing expiry, cancellation, stale-target validation, and walkthrough
  consent boundaries remain. No autonomous clicking or typing was added.
- Current limitation: selection is on the display containing the Knot. Other
  displays get explicit guidance; do not advertise unrestricted multi-monitor
  pointing. Recognized sensitive-field refusal is not universal redaction.

Keep existing restored waveform/transcripts, separate voice modes, silent reply
preference, visibility recovery, reduced motion, four corners, guide continuity,
saved walkthroughs and consent rules. These were not redesigned in this pass.

## 4. Evidence and verification commands

Re-run on 2026-09-12 against the current tree:

- `npm test`: 287 passed, 0 failed.
- `node scripts/security-check.js`: passed, 0 secret findings.
- Package scan: passed; 7,897 entries, 63 owned text files scanned; no forbidden
  paths, missing required files, unreadable paths, or secret findings.
- `scripts/verify-companion-build.cjs`: all 67 compared source files match the
  candidate ASAR, and `resources/win/probe.ps1` matches its source.

Earlier isolated renderer fixture: all checks passed, including real strand
canvas pixels before an answer, each mode button, no automatic nearby-area
submission, clarification on Enter, four-corner fit, reduced-motion setting,
transcript recovery, and selection failure UI. This used generated sample
content; it did NOT send a real request to Claude or use a real microphone.

Evidence directory:
`C:/Users/prana/Downloads/jarvis-starter/jarvis/work/nus-anywhere-verification`
contains `renderer-smoke.json`, `companion-nearby-fixture.png`,
`companion-selection-fixture.png`, and `companion-settings-fixture.png`.
The nearby-area layout screenshot was visually inspected.

The native desktop-control tool failed in the earlier pass. User confirmation
establishes real button pointing worked; do not relabel fixture results as full
live Windows or macOS verification. Older Fable test records are useful but
must be checked for exact version/build/profile before being reused.

Run checks individually and stop on any nonzero exit:

```powershell
Set-Location 'C:/Users/prana/Projects/nus-desktop'
npm test
node scripts/security-check.js
# After building a fresh candidate, substitute its absolute ASAR path:
node scripts/package-security-check.js '<candidate>/win-unpacked/resources/app.asar'
node scripts/verify-companion-build.cjs '<candidate>/win-unpacked/resources/app.asar'
```

The byte verifier currently requires the external WINDOWS probe; do not run it
unchanged against a Mac bundle and call that a Mac regression. It is a stale
Windows-candidate guard, not a comprehensive release attestation. Verify the
new version, artifact contents, installer and update metadata separately.

## 5. Remaining release work — bounded, not a new redesign

1. **Confirm version and freeze the actual tree.** Check current remote tags and
   releases before choosing the next version; do not blindly reuse the v0.2.5
   commands in `docs/release.md`. Keep package and lockfile versions consistent.
   Review intentional changes and include essential untracked implementation
   files in the eventual release commit. Do not publish someone else's unrelated
   work or secrets. Record the exact source revision/tree and artifact hashes.

2. **Build real Windows artifacts.** Use `electron-builder.config.js`, a new
   output directory, and explicit `--publish never` during preparation. Do not
   rebuild over a running candidate. The previous test used `--dir` and
   `signAndEditExecutable=false`; do not carry that override into the release
   as a shortcut. Verify actual signing/publisher status and normal icon/version
   resources; do not promise warning-free installs merely because signing runs.
   Expected Windows assets are `Nus-Setup.exe`, `Nus-Portable.exe`,
   `Nus-Setup.exe.blockmap`, and `latest.yml`. Check their versions, filenames,
   hashes and updater metadata agree, and run both ASAR checks on the new build.

3. **Test the actual distribution path.** Use a fresh throwaway profile as well
   as an existing-profile upgrade scenario; preserve the user's real data.
   Coordinate any installer run because it can change shortcuts/protocols and
   launch the app. Check startup, tray, shortcut ownership, Claude connection,
   settings persistence, quit/reopen, and recovery. The directory test build's
   missing `app-update.yml` warning is not acceptable evidence of a working
   installer updater. Test updater metadata for the real NSIS package.

4. **Short live regression pass.** On the fresh packaged build, try a button,
   text/image/blank area, screen edges, Enter-without-typing clarification,
   typed issue, region adjustment, mode switches, cancel/retry, and repeated
   dismissal. Confirm Claude really answers the intended crop and is honest
   when context is insufficient. Verify no unwanted speech or capture; pause
   one/three/five seconds during hands-free input, then check the full transcript
   and Stop/Cancel. Confirm hold-to-talk is unchanged. Exercise Knot recovery
   without overriding intentional Hide/Panic or starting the mic. Record pass,
   fail, or untested instead of treating the test count as coverage of all this.

5. **Screen-sharing check under production defaults.** In the release-test
   process clear BOTH no-protection environment overrides; do not use the old
   launcher, founder mode, or exposed debugging port. Verify actual exclusion
   with intended capture applications/modes, including after overlay recovery.
   Record OS/app versions and exact modes. The dashboard and overlay have
   different behavior. Do not claim “invisible everywhere”, infer exclusion
   from `setContentProtection` alone, or advertise this as assessment concealment.

6. **Platform and launch scope.** The new precise control path uses the Windows
   probe. Do not infer macOS parity from these Windows tests. If releasing Mac
   too, use the existing Mac workflow from the intended revision, inspect and
   smoke its artifacts on a real Mac, and check that current download links
   have matching arm64/x64 assets. Do not upload old Mac binaries as the new
   version. If Windows-only, make that explicit and coordinate download-page
   claims. Verify current signing and capture limitations from primary docs
   rather than copying old prose in `docs/release.md` as newly verified fact.

7. **Release decision.** Report any remaining blockers and distinguish them
   from polish. The larger plan's five observed first-use sessions, real demo
   capture, and full display/capture-app matrix are not certified by this pass.
   If deferring planned checks for a limited beta, ask the user to explicitly
   accept that scope and document the limitations. Do not quietly declare the
   whole original plan complete. Once the agreed checks pass, present artifacts,
   draft notes and rollback approach, and request final publish approval.

## 6. Suggested user-facing notes (verify on the final build)

- Point at a control or a spot on the Knot's display with Ctrl+Shift+T to get
  help without speaking or switching into a separate chat.
- For an arbitrary spot, preview the nearby area, describe the issue, or ask
  Claude to help clarify it. Only the preview is shared when you send.
- Switch clearly between Ask, Explain, Fix and Guide.
- Improved selection recovery and clearer shortcut-conflict messages.

Avoid “works in every app/on every monitor”, “automatically fixes your screen”,
“invisible in all recordings”, competitor superiority, or zero-bug claims.

## Completion report expected from Claude

Provide the exact release version/revision, artifact locations/hashes/signing,
fresh test results, any untested or failed checks, supported platforms and known
limits, draft release notes, and the next approval needed. Preserve the working
companion throughout; fix demonstrated blockers rather than broadening scope.
