'use strict';
// Preserve the session until both work already in flight and its buffered tail finish.
async function drainCapture({ pending, flush, finish }) {
  await Promise.allSettled(pending);
  await Promise.allSettled([flush('you'), flush('them')]);
  return finish();
}
module.exports = { drainCapture };
