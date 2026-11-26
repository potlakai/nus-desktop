# J.A.R.V.I.S

A personal desktop assistant that runs on this machine. It reads this screen,
moves this mouse, types into these windows, opens these apps, drives this
browser, and keeps this calendar — on your own AI keys, with nothing sent to
anyone else's server.

Address him as you would a butler: say what you want done. He answers as one —
formal, brief, British — and asks before anything irreversible.

This is a personal build, cut down from the Nūs Desktop codebase. It is not
distributed, has no accounts, no billing, no telemetry and no sign-in. See
[What was removed](#what-was-removed) for exactly what was taken out and
[License](#license) for the upstream notice, which is kept.

## What he does

- **Answers, on your key.** Nine providers are wired: OpenAI, Anthropic,
  Gemini, Groq, Nvidia, OpenRouter, Ollama (local, keyless), opencode, and any
  OpenAI-compatible endpoint you point at with a base URL.
- **Reads the screen.** A screen capture goes to the model with your question,
  and the answer comes back pointing at the control you need. Password and
  card fields are refused before a capture is sent.
- **Uses the computer.** Hands is on: he plans a multi-step job, clicks, types
  and reads the result back, for up to 40 steps and two minutes a step. Every
  risky action — buy, pay, send, submit, delete, sign out, transfer, publish,
  uninstall — stops for a confirmation card first. Unattended scheduled jobs
  never auto-approve one.
- **Keeps a calendar.** Courses, assignment due dates, tasks with sub-steps, and
  automations on a schedule.
- **Works on a schedule.** A rule can ask him to do something on cron time —
  `0 9 * * 1-5` is "every weekday at nine". An unattended run may read, open and
  look, but it never approves a card on your behalf: a step that would send, pay
  or delete stops the run and tells you.
- **Remembers.** Facts you tell him live in a local database and come back when
  they are relevant.
- **Speaks.** Push-to-talk with local whisper for transcription, and a local
  Kokoro voice for replies. No audio leaves the machine.

The persona lives in `companion/src/persona.js` — name, honorific, tone and
voice rules in one place, so changing who he is means changing one file. (The
switchable Nūs / J.A.R.V.I.S appearance is still to come; today the rebrand is
in the copy and the prompts, not the palette.)

## You bring the AI

There is no bundled model and no server in the middle. Set a provider in
**Settings → AI provider**.

Cheapest paths:

- **Ollama**, fully local: `ollama pull qwen2.5vl` (a vision model, so screen
  reading works), then provider `ollama`, base `http://localhost:11434/v1`, no
  key.
- **Anthropic**, if you already have Claude Code installed: he finds it and
  uses the subscription, nothing to paste.
- **Gemini** free tier, for the overlay's live answers.

Keys are stored on this device only, encrypted with the OS keychain where one
exists. Hands needs a vision-capable model — the provider picker says which of
the nine can see a screenshot.

## Install and run

```
npm install
npm start
```

| Command | What it does |
|---|---|
| `npm test` | Full assertion suite (1026 tests) |
| `npm run smoke` | Boots and exits |
| `npm run tour` | Replays the walkthrough |
| `npm run dist` | Builds the Windows installer into `dist/` |
| `npm run setup:voice` | Downloads whisper.cpp + the base English model (~65 MB) into `vendor/` |

## Zen

He can read, click and fill in the tab you are looking at in Zen, through Zen's
own remote control. It needs Zen restarted once with a port:

```
zen --remote-debugging-port=9222
```

Then **Settings → Control Zen**. Zen is Firefox-based, so this speaks WebDriver
BiDi, not Chrome's protocol; Chrome and Edge are still driven the way they were,
by launching them and clicking the screen. Off until you turn it on. Details,
limits and the error table are in [docs/browser-zen.md](docs/browser-zen.md).

`npm run dist` produces `JARVIS-Setup.exe` and the portable build. They are not
code signed, so SmartScreen will say **"Windows protected your PC", Publisher:
Unknown publisher** the first time. Click **More info → Run anyway**. That
absence of a signature is not a detection; the build is from this repo.

## Keys

| Keys | Action |
|---|---|
| `Ctrl+Shift+T` | Point at what you need help with |
| `Ctrl+Shift+Space` | Show or hide the overlay |
| `Ctrl+Shift+X` | Panic: stop listening and vanish |
| `Ctrl+Enter` | "What should I do?" (rebindable) |

The overlay is invisible to screen shares and recorders. Follow the rules of
any meeting, class, interview or assessment you are in.

## Where things live

- Database: `%APPDATA%\JARVIS\data\nus.db` — the file name is kept from
  upstream on purpose, so an existing install's data still opens.
- Settings: same folder. Keys such as `reportToNus` and
  `shareNusContextWithProvider` also keep their original spelling for that
  reason; they are only settings names, and they no longer report anything.
- Logs: `%APPDATA%\JARVIS\logs\`.

## Privacy

Nothing leaves this machine except the calls you configure: your AI provider,
and any integration you connect yourself. There is no account, no billing, no
analytics, and no outbound telemetry — `src/stats.js` and
`companion/src/stats.js` are disabled at the source, and the toggles were
removed from the UI rather than left as switches that do nothing.

## What was removed

Cut from the upstream codebase in this fork, each verified by the test suite:

| Removed | How |
|---|---|
| Sign-in, accounts, plan checks | `src/auth.js` reports unconfigured; `src/license.js` always says personal |
| Billing, Stripe, upsell | all checkout paths and UI gone |
| Caps and paywalls | `src/limits.js` neutralised, and the gate sites no longer short-circuit |
| Anonymous usage stats | both stats modules disabled; UI toggles removed |
| The old owner's product identity | name, protocol, window titles, buyer links |

The upstream MIT `LICENSE` and copyright notices are kept in full — that is a
licence condition, and removing a product's identity is not the same as
removing its notices.

Also gone, because they pointed at the previous owner rather than at you:

| Removed | Why |
|---|---|
| `companion/src/publik/` and its sign-in window | the paid answering account, and everything behind it |
| `account.js`, `entitlement.js`, `account-link.js`, `account-offer.js` | the account, its plan and its settings sync; nothing outside their own tests used them |
| the Account card and sign-in offer in the dashboard | markup only: their IPC channels were registered by nothing |
| `updates.js`, `channel.js`, `one-click.js` | the updater read **his** GitHub releases; adopting one would have replaced this app with his |
| the upstream Supabase URLs | feedback and usage rows now stay on this computer; the URLs are empty strings |

Nothing in the tree contacts a server that is not one you configured yourself.
`companion/src/reflex/jev.js` is the one third-party call left, and it only runs
if you paste a TypeSafe key; leave the field blank and it never leaves.

## Stack

Electron, vanilla JS, sql.js (WASM SQLite). One process, two windows: the
Companion overlay ships inside the app, so there is one installer, one settings
store and one runtime.

## License

MIT, as upstream. See [LICENSE](LICENSE) — the original copyright notice is
kept.

The OAuth client IDs described in `docs/credentials-needed.md` are the
upstream's public desktop clients; `src/shipped-secrets.test.js` is the
tripwire that fails the build if a genuinely confidential credential lands in
a packaged file.
