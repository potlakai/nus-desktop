# Nūs Desktop

The semester organizer that runs on your own AI, on your own machine. Import a
real syllabus, see your whole semester as a living map, and let Nūs propose the
next move. Nothing is saved without your review, and your data never leaves
your computer except the calls you configure below.

## You bring the AI (required)

Nūs has no server and no bundled model. It needs two keys, and they do
different jobs:

**1. Claude, for the desktop app.** Reading syllabi, the Ask bar, and the chat
thread all run on Anthropic's Claude, pinned to the mid-tier **Sonnet** model
so a semester of use stays affordable.
- If **Claude Code** is installed on your machine, Nūs finds it automatically
  and uses your existing subscription. Nothing to paste.
- Otherwise, get an **Anthropic API key** (console.anthropic.com) and paste it
  in **Settings → AI provider**. It is encrypted on this device with your OS
  keychain and only ever used to call Anthropic.

**2. Gemini, for the Companion overlay.** The floating Knot that watches your
screen and listens in meetings runs on its own key so live answers stay fast
and cheap. Get a free **Google Gemini** key (aistudio.google.com/apikey) and
paste it in **Settings → Companion AI key**, or in the Knot's own gear icon.
One Gemini key covers both answering and speech-to-text for listening.
(OpenAI, Anthropic, and Nvidia keys also work; with OpenAI, listening needs
Whisper access.)

The first-run walkthrough points at both cards.

## Install and run

Grab `Nus-Setup.exe` (installer) or `Nus-Portable.exe` (no install) from a
release, or run from source:

```
npm install
npm start
```

`npm test` runs the full assertion suite. `npm run smoke` boots and exits.
`npm run tour` replays the walkthrough. `npm run dist` builds the installers.

### Why Windows warns you about the download

The installer is not code signed yet, so SmartScreen shows **"Windows
protected your PC", Publisher: Unknown publisher** the first time you run
`Nus-Setup.exe`. That is the absence of a certificate, not a detection. Click
**More info**, then **Run anyway**. The build is reproducible from this repo,
every release lists the SHA-512 of its artifacts in `latest.yml`, and Windows
Defender scans it clean. Signing is wired and waiting on a certificate; see
`docs/release.md`.

### Free and Pro

Nūs Free runs a whole semester with honest caps: 3 AI syllabus imports, 10
questions a day, 1 connected account, 1 automation rule, 20 Companion minutes
a day with 7 days of history, 512 MB of storage. Pro ($9.99 a month) lifts
them. Caps are counted locally; the plan itself is tied to your Nūs account
(Supabase holds only your email and plan) and paid through Stripe Checkout.
Card details never touch this app.

## What's inside

- **Today**: your dashboard. The Ask bar takes plain requests ("push the calc
  homework to Friday", "email my professor about an extension") and proposes
  the exact change before anything is written.
- **Map**: every course, source, and open task as a draggable knowledge graph.
- **Calendar / Smart tasks / Semester**: deadlines, task breakdowns with
  review, GPA projection that never guesses missing weights.
- **Knot**: the Companion pane and a persistent chat thread that can create
  tasks, move dates, and draft emails, each with a confirm step.
- **Email**: a professor-email drafter that works with no connection at all.
  Add your sending addresses and any draft opens pre-filled in Gmail with
  **Open in Gmail** (no Gmail account connection needed). Outlook connects
  read-only for the inbox brief and your writing style; sending through
  Outlook is a separate opt-in.

## The Companion

The Knot floats on your desktop, keeps running after you close the dashboard,
and comes back from the tray. **Turn off Companion** on the Knot pane removes
it completely and releases the hotkeys until you turn it back on.

| Keys | Action |
|---|---|
| `Ctrl+Shift+Space` | Hide or show the overlay |
| `Ctrl+Shift+K` | Hide just the Knot mark, everything keeps working |
| `Ctrl+Shift+X` | Panic: stop listening and vanish |
| `Ctrl+Enter` | Assist (rebindable in Companion settings) |

Capture exclusion is presentation control, not concealment. Follow the rules
of every meeting, class, interview, or assessment you are in.

## Privacy

Local-first by design. The database lives at `%APPDATA%\Nus\data\nus.db` and
everything Nūs knows stays on this device. The only outbound calls are the AI
providers you configured, the integrations you explicitly connect, and, if you
sign in, the Supabase account check (email and plan, never content) plus Stripe
when you buy Pro. There is no cloud sync of your coursework.

## Stack

Electron, vanilla JS, sql.js (WASM SQLite). One process, two windows: the
Companion overlay ships inside the app, so there is one installer, one
settings store, one runtime.

## License

MIT. See [LICENSE](LICENSE).

The OAuth client IDs in `src/config.js` are gitignored but ship inside the
installer, deliberately: Google documents desktop OAuth clients as public
clients whose secret is not confidential, and Calendar and Outlook would not
work for anyone without them. `src/shipped-secrets.test.js` is the tripwire
that fails the build if a genuinely confidential credential ever lands in a
packaged file. Bring your own credentials by creating that file locally;
`docs/credentials-needed.md` walks through it.
