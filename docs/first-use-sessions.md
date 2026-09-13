# First-use sessions: script, observation sheet, results template

Purpose: five observed first-use sessions with real people, run by Pranav,
before any launch claim. This file is the script and the blank record. It
contains no results. Fill the template only with what was observed.

## Before the session

- Build: the packaged candidate in `dist/quiet-knot-release-candidate`
  (unsigned; SmartScreen will say "Unknown publisher"). Note the version
  from Settings and the file's sha256 in the record.
- Machine: a Windows PC the participant did not set up. Capture protection
  stays at the shipped default. Claude Code signed in (`claude -p "Reply OK"`).
- Prepare one real task in an app the participant already uses (File
  Explorer, a browser page, Notepad, Word, their school portal). Not the QA
  fixture. Write the task down before they arrive.
- Recording: with the participant's spoken consent, record the display with
  the Companion launched with `NUS_NO_PROTECT=1` so the Knot is visible in the
  recording. Say that the shipped build hides it from capture.
- Speech replies stay off (the default). Do not turn them on for them.

## Script (say roughly this, not more)

1. "This is a small helper that sits in the corner of the screen. It can
   explain what something on screen is, or walk you through a task step by
   step. It never clicks or types for you. You do the clicks."
2. "Try it however feels natural. I will not help unless you are stuck for a
   full minute."
3. Task A, explain: "Point at something in this app you are not sure about,
   press Ctrl+Shift+T, and ask what it is."
4. Task B, walkthrough: give the written task. "Ask it to walk you through
   this."
5. Interrupt once during Task B: ask them an unrelated question for thirty
   seconds, then "carry on."
6. At the end: "Say what you think out loud for a minute."
7. Ask the three questions below in these words.

Do not say: "AI", "it can see your screen all the time", "it is like
Copilot", or anything about competitors.

## Observation sheet (one per session)

| Field | Record |
| --- | --- |
| Date, build version, sha256 | |
| Participant (initials only, no other personal data) | |
| App and task | |
| Display size and scale | |
| Time from first Ctrl+Shift+T to first answer (from the log `[inspect]` lines) | |
| Did they find the Knot without being told where it was? | yes / no / after a hint |
| Did they use the keyboard, the mouse, or voice first? | |
| Task A: was the selected control what they meant? | yes / wrong control / had to draw a region |
| Task B: steps needed, steps the Knot got wrong, model calls (log) | |
| Interruption: did they resume the same task and step? | yes / no / restarted |
| Times they looked confused for more than 10s (timestamp each) | |
| Times they asked "why" or "simpler" | |
| Unprompted bubbles or hints during the session | count and text |
| Errors shown (copy the text) | |
| Q1: "Did you understand that it guides while you do the clicking?" | quote |
| Q2: "Did the Knot distract you from what you were doing?" | quote |
| Q3: "Would you leave it turned on?" | quote |
| Would they Keep the walkthrough when offered? | kept / skipped / not offered |

## Results template (fill after all five)

| Session | Found Knot unaided | First input | Task A right control | Task B steps (wrong) | Resumed after interruption | Q1 | Q2 | Q3 | Kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | | | | |
| 2 | | | | | | | | | |
| 3 | | | | | | | | | |
| 4 | | | | | | | | | |
| 5 | | | | | | | | | |

Failures to fix before launch: list each with the session number and the log
line. Anything not observed is "not observed", never inferred.
