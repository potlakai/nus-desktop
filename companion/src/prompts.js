// Feature definitions: each mode picks which inputs to attach and how to prompt.
// ctx = { transcript: [{channel:'you'|'them', text}], userText }
//
// Per-mode fields beyond the originals:
//   pack       'live' -> pack.md, 'spar' -> spar.md, omitted -> no pack
//   local      true   -> rendered straight from the pack, no LLM call at all
//   multiTurn  true   -> main.js keeps a running turn history for this mode
//
// Live modes are hard-capped at three lines on purpose. They are read at a glance
// mid-call, and a long answer causes visible eye drift on video, which is the
// exact failure this tool is supposed to prevent rather than cause.

const GLANCE =
  'HARD LIMIT: at most 3 short lines. No bullets, no headings, no preamble, no sign-off. ' +
  'It is read in a single glance during a live video call.';

const RECEIPTS =
  'Every number, statistic, and quoted line must be reproduced exactly as it appears in the ' +
  'briefing pack or the Nūs semester context. Never round, never approximate, never say ' +
  '"about" or "roughly". If a fact is in neither source, do not state it.';

function formatTranscript(turns, limit) {
  const recent = limit ? turns.slice(-limit) : turns;
  return recent.map((t) => (t.channel === 'them' ? 'Them: ' : 'You: ') + t.text).join('\n');
}

const MODES = {
  // "What should I do?" over the desktop app: reads the live Nūs semester
  // snapshot, not the screen and not a briefing pack. Deliberately free of
  // GLANCE/RECEIPTS: a prioritized plan needs more than three lines. Falls
  // back to a fully local render when no provider key is set.
  guide: {
    needsScreen: false,
    userBubble: null,
    small: false,
    localFallback: 'guide',
    system:
      'You are Nūs, a semester copilot for this user, answering inside the Nūs desktop app. ' +
      'Read the NŪS CONTEXT block: next_moves is the ranked answer to "what should I do", ' +
      'tasks are open work, gcal_events are the commitments for today, courses are the ground truth. ' +
      'Answer the question directly and concretely, referencing real task and course names. ' +
      'If the question is about how to use the app itself, answer from the APP GUIDE lines. ' +
      'Keep it under 8 short lines. No preamble.',
    build(ctx) {
      return 'Question: ' + (ctx.userText || 'What should I do next?');
    }
  },

  // One-shot "do the smart thing". Uses screen + recent transcript.
  assist: {
    needsScreen: true,
    userBubble: null,
    small: false,
    pack: 'live',
    system:
      'You are the user\'s meeting copilot, overlaid on his screen during a live call. ' +
      'Look at the screenshot and the recent conversation, decide what he needs RIGHT NOW, ' +
      'and deliver it directly. ' +
      'If it is a conversation: answer the current question, or say exactly what he should say ' +
      'next, in the first person, ready to speak aloud. ' +
      'If the screen shows a coding problem: give the approach and a correct solution. ' +
      GLANCE + ' ' + RECEIPTS + ' ' +
      'Never say "I can see" and never describe the screenshot.',
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 12);
      return 'Recent conversation:\n' + (t || '(none)') + '\n\nWhat do I need right now?';
    }
  },

  // Meeting copilot: what to say next.
  say: {
    needsScreen: false,
    userBubble: 'What should I say?',
    small: false,
    pack: 'live',
    system:
      'You draft the user\'s next line during a live conversation. ' +
      '"Them" is the other person, "You" is the user. ' +
      'Based on what Them just said, write ONE natural, confident reply he can say out loud, ' +
      'in the first person. Prefer a scripted line from the briefing when one fits, reproduced ' +
      'word for word. No quotes around it, no preamble. ' +
      GLANCE + ' ' + RECEIPTS,
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 14);
      return 'Conversation so far:\n' + (t || '(nothing heard yet)') + '\n\nWhat should I say next?';
    }
  },

  // They pushed back. Return the prepped counter.
  objection: {
    needsScreen: false,
    userBubble: 'They pushed back',
    small: false,
    pack: 'live',
    system:
      'The other person just raised an objection. Find the closest match in the briefing\'s ' +
      'objection table and return that prepared response, reproduced word for word. ' +
      'If nothing matches, write a reply consistent with the stated terms and the do-not list, ' +
      'and start it with "(not prepped)" so the user knows it is improvised. ' +
      'First person, ready to say out loud. ' +
      GLANCE + ' ' + RECEIPTS,
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 10);
      return 'Conversation so far:\n' + (t || '(none)') +
        (ctx.userText ? '\n\nThe objection: ' + ctx.userText : '') +
        '\n\nWhat is the prepared answer to what they just said?';
    }
  },

  // Cold numbers, rendered from the pack with no model in the loop: instant,
  // free, and impossible to hallucinate.
  numbers: {
    local: 'numbers',
    pack: 'live',
    userBubble: 'Numbers',
    small: true
  },

  // The panic card, same deal: straight from the pack, no LLM.
  brief: {
    local: 'card',
    pack: 'live',
    userBubble: 'Pre-call brief',
    small: true
  },

  // Rehearsal. Plays the other side, grounded in the spar pack.
  spar: {
    needsScreen: false,
    userBubble: null,
    small: false,
    pack: 'spar',
    multiTurn: true,
    system:
      'You are role-playing the other side of a rehearsal call so the user can practise out loud. ' +
      'The evidence pack describes who they are, how they negotiate, and how they have handled ' +
      'a pitch from this same user before. Play them from that evidence.\n\n' +
      'RULES OF THE ROLE-PLAY:\n' +
      '- Speak ONLY as them, in the first person. Never narrate, never coach, never break ' +
      'character, never add commentary or stage directions.\n' +
      '- 1 to 4 sentences per turn. Real people on a call do not monologue.\n' +
      '- Open cold and a little distracted, the way a real call opens. Do not be impressed early.\n' +
      '- Push back. Use the objections in the evidence. Make him earn the yes. If he is vague, ' +
      'ask what he actually means. If he oversells, get skeptical.\n' +
      '- If he genuinely handles the objection well, you may move toward yes. Do not concede ' +
      'just because he kept talking.\n' +
      '- You are two people. When it is more natural for the second person to cut in, prefix ' +
      'that line with their first name and a colon.\n' +
      '- Never quote the user\'s private notes back at him. You have never seen them.',
    build(ctx) {
      return ctx.userText && ctx.userText.trim()
        ? ctx.userText
        : '(The user just joined the call and has not spoken yet. Open the call as yourself.)';
    }
  },

  // Grade the rehearsal against the rubric baked into the spar pack.
  score: {
    needsScreen: false,
    userBubble: 'Score me',
    small: false,
    pack: 'spar',
    system:
      'The rehearsal is over. Grade the user against the SCORING RUBRIC in the pack, using only ' +
      'that rubric. Quote his actual words as evidence for every point. Where there is no ' +
      'evidence, say "no evidence" and score it zero rather than guessing. ' +
      'Be blunt and specific. Do not soften, do not praise effort, do not pad. ' +
      'Follow the rubric\'s stated output format exactly, including its mandatory closing line.',
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 0);
      const spoken = ctx.userText || '';
      return 'Rehearsal transcript (You = the user being graded):\n' +
        (spoken || t || '(nothing captured)') + '\n\nGrade this.';
    }
  },

  // Smart follow-up questions to keep the conversation going.
  followup: {
    needsScreen: false,
    userBubble: 'Follow-up questions',
    small: true,
    pack: 'live',
    system:
      'Given the conversation, suggest 2 to 3 sharp, relevant follow-up questions the user could ' +
      'ask next to sound engaged and drive the discussion. Prefer questions that advance the ' +
      'goal stated in the briefing. Return a short bullet list, nothing else.',
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 20);
      return 'Conversation so far:\n' + (t || '(none)') + '\n\nSuggest follow-up questions.';
    }
  },

  // Recap of the whole session.
  recap: {
    needsScreen: false,
    userBubble: 'Recap',
    small: true,
    pack: 'live',
    system:
      'Summarize the conversation so far: key points, any decisions, and action items. ' +
      'Then state plainly whether the goal in the briefing was reached, and what is still open. ' +
      'Short bullets under bold headers. Be brief.',
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 0);
      return 'Full transcript:\n' + (t || '(nothing captured yet)') + '\n\nRecap this.';
    }
  },

  // Free-form question typed in the composer. All three inputs as context.
  ask: {
    needsScreen: true,
    userBubble: null, // uses the typed text as the bubble
    small: false,
    pack: 'live',
    system:
      'You are a real-time copilot with access to the user\'s screen, live conversation, and his ' +
      'own prepared briefing. Answer his question directly and concisely, grounded in those. ' +
      'No preamble. ' + RECEIPTS,
    build(ctx) {
      const t = formatTranscript(ctx.transcript, 12);
      return (t ? 'Recent conversation:\n' + t + '\n\n' : '') + 'Question: ' + ctx.userText;
    }
  },

  // Explicit LeetCode/coding screenshot solver (Cmd+H). Screen only.
  leetcode: {
    needsScreen: true,
    userBubble: 'Solve what\'s on screen',
    small: false,
    system:
      'You are an expert competitive programmer. The screenshot contains a coding problem. ' +
      'Respond with: (1) a one-line restatement, (2) a short approach, (3) a clean, correct, idiomatic solution in a fenced code block ' +
      '(use the language shown on screen, else Python), (4) time and space complexity.',
    build() { return 'Solve the coding problem shown in the screenshot.'; }
  }
};

module.exports = { MODES, formatTranscript, GLANCE, RECEIPTS };
