# Message to Claude: revise the old plan against the implemented working tree

Please replace the proposed plan with a continuation plan based on the work already implemented. Astra did not only research: it made and tested source changes. Do not reapply the stale plan or start the Companion over.

## Read the correct files first

The current implementation is in `C:/Users/prana/Projects/nus-desktop`, not the older `work/nus-quiet-knot/source` mirror in the jarvis workspace. Inspect the dirty working tree and preserve all existing/uncommitted work. If your workspace cannot access the real desktop repo, tell me which folder to open instead of editing the mirror.

Read completely:

1. `C:/Users/prana/Projects/nus-desktop/docs/companion-restoration.md` — implementation status, known limitations, verification and release gates.
2. `C:/Users/prana/Projects/nus-desktop/docs/companion-launch.md` — competitive lessons, evidence boundaries, six X drafts, Instagram positioning and measurement.
3. `C:/Users/prana/Downloads/jarvis-starter/jarvis/ventures/nus/COMPANION-KNOT-V2-HANDOFF.md` — the established Knot vision.

Then inspect the actual changed code, including `companion/index.js`, the renderer, `selected-assistance.js`, `companion-context.js`, the guide session, local STT and transcription queue. The Git diff includes earlier founder work too; do not assume every change came from Astra.

## Preserve what I am trying to build

I want an efficient, distinctive companion, not a simplified generic chat window. Keep the silver Knot at its corner home, the four-corner picker, purposeful unwinding toward a validated control and winding back. It should be comfortable during an ordinary hour of work, not just look cool in a clip. Do not add cursor-following, unsolicited speech or distracting constant animation.

Retain keyboard/text-first use, optional voice, real microphone feedback, full transcripts, natural speech pauses, and continuity when I ask why, need a simpler explanation, get interrupted or say something did not work. Do not silently remove or materially change a capability. Explain any necessary removal and get my approval first.

## What is already implemented

- Silent typed questions without automatic screen capture; speech replies respect the preference.
- Separate 20-second hold-to-talk and 120-second clicked hands-free modes, explicit Stop/Cancel, countdown/warning, real level display, transcript revisions/recovery and Retry.
- Priority for final transcription, cancellation and rejection of late work.
- Bounded renderer recovery that respects intentional Hide/Panic/Disable and does not restart recording.
- Existing strand retained with bounded travel, immediate readable answers, reduced-motion handling and quieter idle behavior.
- Guide clarification, pause/resume, replay checks and explicit task-completion confirmation before Keep.
- Ctrl+Shift+T selected-area assistance wired to Claude, with a crop preview, optional typing, selected-snapshot follow-ups, timeout/cancellation and local target revalidation.

I explicitly approved Claude for the screen area I deliberately select. Do not ask that same provider question again. Ctrl+Shift+T is intended for other desktop apps, not only the Claude app. Claude is the answering engine inside Nūs. Send shares the selected crop and its bounded conversation, not the full display. Do not route it to other providers or add unrelated school/desktop data under that permission. This does not authorize continuous capture or autonomous clicking/typing.

## Important unfinished work

This is implemented source, not a completed release. Selection assistance currently operates on the configured Knot display and a snapshot with a provisional 120-second lifetime. The pointer can reference only the revalidated selected control; a manually selected region is not a verified control. The existing broader multi-step guide is separate. Carefully finish their continuity if needed without silently expanding capture scope. Do not claim it already works on every app, monitor or scaling level.

Reproduce and validate the original problems in the real app: repeated Knot clicks/disappearance, brief speech pauses, transcript completeness, silent keyboard workflow, selected-area help through live Claude, wrong/stale targets, cancellation, renderer recovery and intentional hiding. Check the overlay, dashboard and onboarding. Verify real screen-sharing protection with app/version/OS/capture-mode records, on/off and after recovery; never promise invisibility everywhere.

Audit saved-memory controls, suggestion cooldown/snooze, actual latency/idle resource use, five observed first-use sessions, fresh packaged installation and an uninterrupted proof demo. Do not invent test results or pretend the automated checks establish these.

## Evidence and product positioning

Latest source suite: 256 passing tests. The isolated Electron UI fixture passes preview, optional typing, no-screen ask during a paused guide, transcript recovery, four-corner bounds and reduced-motion checks. Its images/AI are simulated, not live. The separate unsigned, unpublished test candidate is at `C:/Users/prana/Downloads/jarvis-starter/jarvis/work/nus-companion-restoration-candidate/win-unpacked`; its package checks pass and the key source files match. My installed app was not replaced.

For X, lead with the Companion/Knot completing a useful non-school interaction: visual identity, quiet usefulness and continuity. For Instagram, lead with school outcomes under the same Nūs identity. This is an experiment, not guaranteed growth. HeyClicky already has docking, and other assistants already point/highlight; do not claim pointing is exclusive or cursor-following caused its popularity. Our defensible advantage must be a demonstrated combination of quiet guidance, useful Knot motion, continuity and chosen memory. The launch document contains sources and drafts; a public shareable talking-points page is still outstanding.

First return a revised gap-only plan: what you verified is already done, what still fails or is incomplete, and the implementation/testing sequence. Carry forward the existing work and research. Once I approve that updated plan, continue with the missing pieces rather than redesigning everything or repeating the heavy lifting. Do not publish, install over my app or present mock footage as product proof without approval.
