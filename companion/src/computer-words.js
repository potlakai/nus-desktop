'use strict';
// Which computer the model is helping on. On a Mac every request the Companion sends to a model
// carries one more line in its instructions, so the steps it gives use macOS keys and places. A tester's
// round 1 on a real Mac, 2026-11-15: "when it's giving you instructions for anything it gives windows
// instructions". On Windows nothing is added: Windows requests stay exactly as they were.

const MAC_LINE = 'This computer is a Mac running macOS, not Windows. Every step you give must be for macOS: '
  + 'name the keys Command, Option, Control and Shift (Command+C to copy, Command+V to paste, Command+Q to quit, never Ctrl+C or Alt+F4); '
  + 'say Finder, not File Explorer; the menu bar at the top of the screen and the Apple menu, not a Start menu or a taskbar; '
  + 'the Dock for open apps; System Settings, not Control Panel or Windows Settings; '
  + 'and Control-click or a two-finger click for a right-click.';

function computerLine(platform = process.platform) { return platform === 'darwin' ? MAC_LINE : ''; }

// The instructions with the computer line added at the end (after any prompt-cache prefix). Unchanged
// when there is nothing to add.
function withComputer(system, platform = process.platform) {
  const line = computerLine(platform);
  if (!line) return system;
  return system ? String(system) + '\n\n' + line : line;
}

// stream/complete params with the line added to `system`; the same object back on Windows.
function paramsWithComputer(params, platform = process.platform) {
  if (!computerLine(platform) || !params) return params;
  return { ...params, system: withComputer(params.system, platform) };
}

module.exports = { MAC_LINE, computerLine, withComputer, paramsWithComputer };
