'use strict';
// The region mark (renders-0115-2026-11-02, O4 option 2): besides the lasso on
// a control, a rectangle round the area the sentence names ("the compose
// area", "in the sidebar"). Used only when the sentence names an area and the
// screen read has a container round the control that is clearly bigger than
// the control and clearly smaller than the window. Otherwise null: the lasso
// alone stays the default. Pure, so it is tested on its own.

const AREA = /\b(area|panel|pane|section|sidebar|side bar|toolbar|tool bar|ribbon|list|body|editor|compose|composer|form|menu|tab bar|this part|that part|region)\b/i;
// UI Automation control types that frame other controls.
const CONTAINERS = new Set(['Pane', 'Group', 'Document', 'List', 'Tree', 'Table', 'DataGrid', 'ToolBar', 'Tab', 'Custom']);
const MAX_OF_WINDOW = .7;     // a container bigger than this share of the window is the window
const MIN_OVER_CONTROL = 2;   // and one no bigger than this many times the control is the control

const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);
const contains = (outer, inner, slack = 2) => inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;
const isRect = (r) => !!r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0;

function namesArea(instruction) { return AREA.test(String(instruction || '')); }

// -> the smallest container round the control, or null.
function regionFor(instruction, control, containers, windowRect) {
  if (!namesArea(instruction) || !isRect(control)) return null;
  const win = isRect(windowRect) ? windowRect : null;
  let best = null;
  for (const c of containers || []) {
    const r = c && c.rect;
    if (!isRect(r) || (c.type && !CONTAINERS.has(c.type))) continue;
    if (!contains(r, control)) continue;
    if (area(r) < area(control) * MIN_OVER_CONTROL) continue;
    if (win && area(r) > area(win) * MAX_OF_WINDOW) continue;
    if (!best || area(r) < area(best)) best = r;
  }
  return best ? { x: best.x, y: best.y, w: best.w, h: best.h } : null;
}

module.exports = { AREA, CONTAINERS, MAX_OF_WINDOW, MIN_OVER_CONTROL, namesArea, regionFor };
