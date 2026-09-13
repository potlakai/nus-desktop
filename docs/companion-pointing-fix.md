# Ctrl+Shift+T and companion mode controls — 2026-09-10

Scope: repair the reported stuck “Selecting what you pointed at” interaction,
restore immediate pointing, and make the quick-composer mode controls usable.
Preserve the existing dirty working tree and Fable's other restoration work.

## Findings

- The running `dist/quiet-knot-release-candidate/win-unpacked` archive did not
  match the current main-process source and did not contain `pointAtSelection`.
  Its archived Windows probe was also stale. Its renderer already matched.
  A source-only fix was therefore not sufficient for the user's running copy.
- Logs showed repeated window-sized accessibility hits, falling back to region
  selection. The cursor was sampled after an awaited foreground lookup.
- Shortcut registration failures were ignored. Multiple Nūs copies may compete
  for Ctrl+Shift+T; the running copy did receive the user's shortcut, so this is
  additional hardening rather than the cause of that observed selection message.
- The native quick-intent dropdown leaves the renderer's DOM while click-through
  detection relies on DOM hit testing. This is a plausible popup interaction
  failure, not a live-reproduced Windows diagnosis.

## Changes

- Preserve Fable's immediate strand to an accessibility-identified target, before
  a Claude answer. User-drawn regions are still labeled as such, not represented
  as verified controls. No automatic upload or click was added.
- Capture the original hotkey cursor position before awaiting anything. Retry
  one unusable accessibility hit at that same position, bounded to two attempts.
  Reject oversized, off-display, and invalid bounds.
- Bound selection preparation to ten seconds. On failure, invalidate late work
  and show persistent retry/typed-help instructions instead of an orphaned hint.
- Check global shortcut registration, report conflicts in settings, and retry
  registration when settings are reopened.
- Replace the visible native quick-intent popup with inline Ask / Explain / Fix /
  Guide buttons. Preserve the underlying intent values and existing behavior.
  Show what each mode shares; missing selections cannot silently become a
  different request. The general Ask path does not share a screen.
- Add a package/source byte-comparison check, including the separately executed
  Windows probe, to catch stale candidates before handoff.

## Verification

- Full source suite: 282 passing, zero failing tests.
- Isolated Electron renderer fixture: all checks passing, including each mode
  button, an actual nonempty strand canvas before an answer, recoverable
  selection failure, four-corner fit, and existing transcript/recording controls.
- Visually inspected the generated selection screenshot: all four mode buttons
  are visible, with a selected-state treatment and legible sharing instructions.
- Fresh directory package: security check passed (7,897 entries; 63 owned text
  files scanned; no forbidden/missing paths or secret findings). Byte comparison
  passed for all 67 packaged source files and `resources/win/probe.ps1`.
- After the user closed the old copy, launched the replacement with the existing
  isolated profile. Its own runtime reports Ctrl+Shift+T registered successfully;
  the Windows probe reports ready. Spoken replies remain off. The selected-area
  request path remains pinned to Claude; the general provider setting is intact.
- These are source/fixture results, not a claim of a successful live Windows
  hotkey press. The desktop-control tool failed to initialize twice. No native
  keypress or pointer action was substituted through another automation route.
- A real Ctrl+Shift+T press over a control in another desktop app, followed by
  Claude assistance and dismissal, remains the final hands-on check after the
  old candidate is quit and the verified replacement is opened.

Test build output: `jarvis/work/nus-companion-pointing-fix/win-unpacked`.
Launcher: `jarvis/work/nus-companion-pointing-fix/launch-fixed-companion.ps1`.
This uses the existing isolated `final-public-profile`; it does not install or
overwrite the old executable, and it never kills a recording. Capture protection
remains off in this test launcher, as in the previous hands-on launcher. This is
not evidence of screen-sharing exclusion or release readiness.

Run after packaging:

```powershell
node scripts/package-security-check.js <build>/win-unpacked/resources/app.asar
node scripts/verify-companion-build.cjs <build>/win-unpacked/resources/app.asar
```

This scoped fix does not certify every item in the larger companion launch plan.

## Follow-up: help at arbitrary spots (2026-09-11)

The user confirmed the previous build works on visible buttons and requested help
at other places too. Ctrl+Shift+T now keeps the precise accessibility-control
path, but an unusable/missing control produces bounded nearby-area context:

- A maximum 480 × 320 DIP preview (at most half the display in each dimension),
  clamped to the Knot display. The actual point is retained separately, so
  shifting a crop inward at a screen edge never shifts the chosen point.
- A strand to the chosen spot labeled “Your spot · not a detected control”.
  This represents the person's selection, not a model-verified action target.
- An immediate “What’s happening here?” prompt. Typing explains the issue;
  pressing Enter without typing asks Claude to briefly describe the preview
  and ask what the person needs help with, without assuming an error exists.
- The preview is local until Send. Select region can change its scope. Claude
  receives only the crop, the point's location within it, and this conversation.
  No full-screen fallback upload, autonomous action, or provider change.
- Recognized sensitive fields stop this automatic fallback; this is not a claim
  of comprehensive redaction of everything that could appear in a preview.
- The original spot is not reused as a verified action target after an answer.
  Existing target validation and expiry/cancellation rules remain in place.
- Arbitrary spots are currently supported on the display containing the Knot,
  not other monitors. An out-of-display point gets an explicit instruction.

Verification: 287 source tests passed. The isolated renderer fixture passed all
checks, including nearby-area prompt, no automatic submission, clarification on
Enter, the existing button/control path, and four-corner fit. The nearby-area
screenshot was visually inspected. Package security passed; all 67 packaged
source files and the external Windows probe match the working tree.

New test build: `jarvis/work/nus-companion-anywhere/win-unpacked`.
Launcher: `jarvis/work/nus-companion-anywhere/launch-companion.ps1`.
Uses the same isolated profile and preserves the previous working test copy.
The old copy must be quit before starting this one. The new arbitrary-spot path
still needs a hands-on test; the user's confirmation applied to button pointing
in the preceding build, not this follow-up. No request was sent to Claude during
automated testing.
