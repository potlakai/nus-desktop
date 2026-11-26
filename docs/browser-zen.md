# Controlling Zen

J.A.R.V.I.S can read the page you are looking at in Zen, click it, fill it in and
press keys, through Zen's own remote control. It is off until you turn it on.

## Why a flag is needed

Zen is Firefox under the skin, so it does not speak the Chrome DevTools
Protocol that drives Chrome and Edge. It speaks **WebDriver BiDi**, and it only
listens when it was started with a remote-control port:

```
zen --remote-debugging-port=9222
```

The flag cannot be added to a browser that is already running. The first time,
you have to quit Zen and open it again. Session restore brings your tabs back.

On Windows and macOS, the simplest way to keep it is to edit the launcher:
add `--remote-debugging-port=9222` to the shortcut or the `.desktop` entry you
start Zen from.

## Turning it on

**Dashboard → Settings → Control Zen.** Set the port to the one you started Zen
with (9222 unless you changed it). The two settings are `controlBrowser` and
`browserPort`; both live in the same settings file as everything else, on this
computer.

Turning it off closes the connection immediately. The remote-control port is
Zen's own, so quitting Zen also ends the session.

## What it can do

| Action | What it does |
|---|---|
| `browser_read` | The text of the tab in front, with its title and address (bounded, and it says when it was cut) |
| `browser_open` | Opens an address in Zen |
| `browser_click` | A real pointer press at a CSS selector |
| `browser_type` | Fills a field the way a page's own framework sees it, optionally submitting |
| `browser_press` | One named key |

Hands is told about these only when the switch is on. With it off, the model is
not offered the tools at all, so it cannot waste a step discovering they are
missing.

## What still stops for a card

The same consent gate as the mouse, not a second one. `hands/consent.js` decides:

- a click whose label reads like buy, pay, order, send, submit, delete, sign out,
  transfer, publish, uninstall — **card**
- `browser_type` with `submit: true` — **card**, because it sends what was typed
- `browser_press` with a key combination that submits or deletes — **card**
- `browser_read`, `browser_open`, a safe click — no card

Scheduled tasks never auto-approve a card. That rule is in the autonomy policy,
not in this module.

## Limits worth knowing

- **One session per browser.** WebDriver BiDi allows a single controller. If
  another tool is attached to Zen, this says so instead of fighting it.
- **Your real profile.** The tab this drives is logged in as you. That is the
  point, and it is also why every risky action stops for a card.
- **`about:` pages are skipped.** Reading a browser's own settings page tells a
  model nothing about your task.
- **Selectors, not pixels.** A click names an element. If the selector matches
  nothing the action fails and says so; the model is told to re-read the page
  rather than guess a second selector.

## If it does not connect

The error says which of these happened:

| Message says | What to do |
|---|---|
| "Zen is not listening for remote control" | Quit Zen, reopen it with the flag |
| "Another program is already driving Zen" | Close the other controller, or use a second port and profile |
| "Zen did not answer in time" | Check for a dialog in the browser window |
| "The page did not have what the action named" | The selector was wrong; read the page again |

Tests: `companion/test/browser-zen.test.js` (the protocol, with a scripted
socket) and `companion/test/browser-actions.test.js` (the wiring, the reports and
the consent cards).
