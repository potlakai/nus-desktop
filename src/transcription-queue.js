'use strict';

// One worker. Replaceable partial work cannot delay or discard final audio.
function createTranscriptionQueue() {
  let active = false;
  let partial = null;
  const finals = [];
  async function drain() {
    if (active) return;
    const job = finals.shift() || partial;
    if (!job) return;
    if (job === partial) partial = null;
    active = true;
    try { job.resolve(await job.run()); }
    catch (error) { job.resolve({ error: String(error && error.message || error), retryable: true }); }
    finally { active = false; drain(); }
  }
  return {
    enqueue(run, { kind = 'final', sessionId } = {}) {
      return new Promise((resolve) => {
        const job = { run, resolve, sessionId };
        if (kind === 'partial') {
          if (partial) partial.resolve({ superseded: true });
          partial = job;
        } else {
          if (partial && partial.sessionId === sessionId) { partial.resolve({ superseded: true }); partial = null; }
          if (finals.length >= 4) { resolve({ error: 'transcription_queue_busy', retryable: true }); return; }
          finals.push(job);
        }
        drain();
      });
    },
    cancel(sessionId) {
      if (partial && partial.sessionId === sessionId) { partial.resolve({ cancelled: true }); partial = null; }
      for (let i = finals.length - 1; i >= 0; i--) if (finals[i].sessionId === sessionId) { finals[i].resolve({ cancelled: true }); finals.splice(i, 1); }
    },
  };
}
module.exports = { createTranscriptionQueue };
