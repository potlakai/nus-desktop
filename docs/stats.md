# Usage stats: where they went

This document used to describe the anonymous usage stats that Nūs Desktop sent
to a Supabase project: which features were used, on a random install id, at one
small JSON event at a time.

**Nothing is sent anywhere now.** This build is a personal one, and the
telemetry path was cut at the source rather than switched off in Settings.

## What is actually true in this build

- `src/stats.js` still exists and still works out what *would* be sent. That is
  deliberate: the description of a usage event is the privacy contract, and
  keeping it makes "what does it know about me" an answerable question instead
  of a shrug.
- The client is never given a destination. With no project URL and no keys,
  there is no request to make, so `send` is a no-op that records nothing.
- The Settings switch and the count of what has been sent still work. A switch
  that does something is better than a switch that is merely honest.
- The server half is gone with the rest of the commercial layer: the
  `supabase/` directory (schema, migrations, the `track` and `daily-metrics`
  functions), `scripts/configure-supabase.js`, `scripts/verify-supabase.js`,
  the end-to-end checkout script, and the two tests that compared the client's
  event names against the server's schema. A test that checks a file which no
  longer exists is a test that fails for the right reason and helps nobody.

## What that means for you

There is no install id, no account, no project and no endpoint. If you want to
run your own stats somewhere, `src/stats.js` is where the event shape lives and
it is a small, honest place to start. Nothing here will call it for you.

## The one thing kept on purpose

The privacy rules that used to be enforced by the server, such as never putting
coursework or typed text into a props object, are still enforced in the client
and still have tests. The rule survives the server, which is the point of
writing it down.
