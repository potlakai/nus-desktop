# Billing and identity setup

Everything here is account work only Pranav can do. The desktop license cache,
authenticated Checkout call, and Free/Pro caps are wired in `src/license.js`
and `src/limits.js`; they remain Free until the SQL and Edge Functions below are
deployed and a signed-in test account receives a real entitlement.

Work in **Stripe test mode** for all of it. Switching to live keys is the last
step and takes two minutes.

**Never put these in the desktop app:** the Supabase `service_role` key, the
Stripe secret key (`sk_...`), or the webhook signing secret (`whsec_...`). The
app ships as an unpacked asar and anything inside it is readable. The app gets
the Supabase URL and the **anon** key, and nothing else.

---

## Read this first: the code path is ready, but the packaged flow still needs verification

The app now registers `nus-desktop://`, handles both cold-launch and
second-instance callbacks, exchanges a PKCE code in the main process, and
persists the session through Electron `safeStorage`. This still needs one real
packaged-Windows test after the Supabase values and redirect allowlist below
are configured. A source-level test cannot prove Windows owns the protocol or
that Supabase accepts the production redirect.

---

## Part A. Supabase project

- [ ] Create a project at [supabase.com](https://supabase.com). Region: pick the
      one nearest your users, not nearest you.
- [ ] Name it something you will recognise in two years (`nus-prod`).
- [ ] Save the database password somewhere real. Supabase shows it once.
- [ ] **Settings → API**, copy:
      - Project URL → `https://<ref>.supabase.co`
      - `anon` `public` key
      - `service_role` key (for the webhook only, never the app)
- [ ] **SQL Editor → New query**, paste all of
      [`supabase/schema.sql`](../supabase/schema.sql), run it. It is idempotent,
      so re-running after an edit is fine.
- [ ] Verify it took:
      ```sql
      select table_name from information_schema.tables
      where table_schema = 'public' order by 1;
      -- expect: devices, events, profiles, subscriptions
      ```
- [ ] Confirm RLS is on everywhere. This should return four rows, all `true`:
      ```sql
      select relname, relrowsecurity from pg_class
      where relname in ('profiles','subscriptions','devices','events');
      ```

Then put the two public values into `src/config.js` (gitignored, already reads
these env vars, falls back to empty):

```
NUS_SUPABASE_URL=https://<ref>.supabase.co
NUS_SUPABASE_ANON_KEY=<anon key>
```

`isSupabaseConfigured()` starts returning true at that point, which un-greys the
Account card in Settings.

---

## Part B. Google sign-in

**This is a different OAuth client from the Google Calendar one already in
`src/config.js`.** Do not reuse it. Calendar is an installed-app client that
talks to Google directly from the desktop; this one is a **web** client that
talks to Supabase.

- [ ] [Google Cloud Console](https://console.cloud.google.com) → same project as
      Calendar is fine → **APIs & Services → Credentials → Create credentials →
      OAuth client ID**.
- [ ] Application type: **Web application**.
- [ ] Authorised redirect URI, exactly one:
      ```
      https://<ref>.supabase.co/auth/v1/callback
      ```
      **Not** `nus-desktop://auth/callback`. Google never sees that scheme.
      The hop order is: app → Supabase → Google → Supabase → `nus-desktop://`.
- [ ] Copy the client ID and client secret.
- [ ] Supabase → **Authentication → Providers → Google** → enable, paste both,
      save.
- [x] Supabase → **Authentication → URL Configuration**. Managed from
      `supabase/config.toml` `[auth]` since 2026-08-22 (`site_url`, the
      `nus-desktop://auth/callback` redirect, and the site's `pro.html` and
      `success.html`). Apply with `npx supabase config push`.

      **Warning, learned the hard way:** `config push` manages the entire auth
      section. Any `[auth.*]` value missing from `config.toml` is reset to the
      CLI default, which silently turned email confirmations off and OTP length
      to 6 on the first push. The file now pins `[auth.email]` and
      `[auth.mfa.totp]` to the project's real values. Read the diff it prints
      before confirming, every time.
- [ ] While you are here, decide on email confirmation. **Authentication →
      Providers → Email**: leave "Confirm email" **on** if you keep email/password
      as a fallback, or turn the provider off entirely and go Google-only.

Verify without the app: Supabase → **Authentication → Users** should gain a row
the first time anyone completes the flow. Then confirm the trigger fired:

```sql
select p.email, s.plan, s.status
from public.profiles p join public.subscriptions s using (user_id);
-- every user should have plan='free', status='none'
```

If a user exists but has no rows here, `handle_new_user()` did not run: re-run
the schema, then re-run the backfill block at the bottom of it.

---

## Part C. Stripe

### C1. The product

- [ ] Stripe dashboard, **make sure the Test mode toggle is on**.
- [ ] **Product catalogue → Add product**.
      - Name: `Nūs Pro`
      - Description: `Unlimited imports, questions, integrations, and Companion.`
      - Price: **$9.99 USD**, **Recurring**, **Monthly**
- [ ] Copy the **price ID** (`price_...`). You need it in C2.
- [ ] No trial. Free tier is the trial, and it never expires.

### C2. Authenticated Checkout

Nūs uses `supabase/functions/create-checkout/index.ts`, not a public Payment
Link. The function requires the signed-in user's Supabase JWT and derives both
`client_reference_id` and subscription metadata from `auth.getUser()`. A URL
parameter is editable by the buyer and must not decide which account gets Pro.

- [ ] Choose two HTTPS pages for checkout return behavior. They may be simple
      pages on the Nūs website for now:
      - `STRIPE_CHECKOUT_SUCCESS_URL`
      - `STRIPE_CHECKOUT_CANCEL_URL`
- [x] The desktop app invokes `create-checkout` with the signed-in Supabase JWT
      and opens only an HTTPS Stripe-hosted URL.
- [ ] Do not create or expose a reusable Stripe Payment Link for Pro.

### C3. Customer portal, so you never write billing UI

- [ ] **Settings → Billing → Customer portal** → **Save** the live-mode
      configuration once. The API refuses to create portal sessions until a
      default configuration exists, and "Manage subscription" in the app and on
      the site reports `portal_unavailable` until then.
- [ ] Enable **"Customers can cancel subscriptions"**, set to **at end of
      billing period** (not immediately). This is what makes "Pro until
      `current_period_end`, then Free" true.
- [ ] Enable update payment method. Leave plan switching off while there is one
      plan.
- [x] `supabase/functions/create-portal/index.ts` (deployed 2026-08-22) turns
      the signed-in user's `stripe_customer_id` into a short-lived
      `billing.stripe.com` URL. The app's Plan card and `nus-site/pro.html`
      both use it. No no-code login link is needed.
- [ ] Secret `STRIPE_PORTAL_RETURN_URL` (set to `https://potlakai.github.io/nus/pro.html`).

### C4. Webhook

- [ ] **Developers → Webhooks → Add endpoint**.
- [ ] Endpoint URL:
      ```
      https://<ref>.supabase.co/functions/v1/stripe-webhook
      ```
- [ ] Select exactly these events:
      - `checkout.session.completed`
      - `customer.subscription.created`
      - `customer.subscription.updated`
      - `customer.subscription.deleted`
      - `invoice.payment_failed`
- [ ] Copy the **signing secret** (`whsec_...`).

---

## Part D. Secrets, and where each one lives

| Secret | Lives in | Never in |
|---|---|---|
| Supabase URL | `src/config.js` (app) | — |
| Supabase `anon` key | `src/config.js` (app) | — |
| Supabase `service_role` key | Edge function env | The app, the repo |
| Stripe secret key `sk_...` | Edge function env | The app, the repo |
| Stripe webhook secret `whsec_...` | Edge function env | The app, the repo |
| Stripe price ID `price_...` | Edge function env | (harmless in app) |
| Checkout success/cancel URLs | Edge function env | — |

Set the function secrets:

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_test_xxx
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
supabase secrets set STRIPE_PRICE_ID=price_xxx
supabase secrets set STRIPE_CHECKOUT_SUCCESS_URL=https://example.com/billing/success
supabase secrets set STRIPE_CHECKOUT_CANCEL_URL=https://example.com/billing/canceled
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into edge functions
automatically. Do not set them by hand.

- [ ] **Deploy the webhook function with JWT verification off.** Stripe does not
      send a Supabase JWT, so the default setting rejects every delivery with a
      401 and the endpoint looks dead:
      ```bash
      supabase functions deploy stripe-webhook --no-verify-jwt
      ```
      The function still authenticates the request, just by verifying Stripe's
      signature against `STRIPE_WEBHOOK_SECRET` instead. That check is what
      stops anyone from POSTing themselves a Pro subscription, so it is not
      optional.
- [ ] **Deploy the authenticated Checkout function with JWT verification on.**
      `supabase/config.toml` locks this setting, so the normal command is enough:
      ```bash
      supabase functions deploy create-checkout
      ```

---

## Part E. Verify before deploying or charging

- [ ] `stripe listen --forward-to https://<ref>.supabase.co/functions/v1/stripe-webhook`
      (or use the dashboard's **Send test webhook**).
- [ ] Sign into the test account in Nūs, press Upgrade, and confirm the app calls
      `create-checkout` and opens the returned Stripe-hosted URL.
- [ ] Pay with test card `4242 4242 4242 4242`, any future expiry, any CVC.
- [ ] Confirm the row moved:
      ```sql
      select user_id, plan, status, current_period_end, cancel_at_period_end,
             stripe_customer_id
      from public.subscriptions;
      -- expect plan='pro', status='active', a period end about a month out
      ```
- [ ] Confirm the entitlement function agrees. Run this as that user (SQL editor
      runs as service role, so `auth.uid()` is null there and it returns no
      rows, which is correct). The real check is the Plan card in the packaged
      app after signing in as the test user.
- [ ] Cancel through the customer portal. Confirm `cancel_at_period_end` flips
      to `true` while `status` stays `active` and `plan` stays `pro`. The user
      keeps Pro until the period ends. That is the intended behaviour, not a bug.
- [ ] In the dashboard, advance the test clock past `current_period_end` (or
      fire `customer.subscription.deleted`) and confirm the row lands on
      `plan='free'`, `status='canceled'`.
- [ ] Check **Developers → Webhooks → your endpoint** shows 2xx for every
      delivery. Any 401 means the `--no-verify-jwt` step was missed.

---

## Part F. Going live

Do this only after the packaged sign-in, Checkout, webhook, entitlement, and
every advertised cap have passed the test-mode checklist end to end.

- [ ] Stripe: flip off test mode, recreate the product, price, and webhook
      endpoint in live mode. **Test-mode objects do not carry over.**
- [ ] `supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx` and the live
      `whsec_`.
- [ ] Stripe → **Settings → Business** → fill in the public business details
      that appear on receipts.
- [x] Rewrite [`nus-site/privacy.html`](../../nus-site/privacy.html) so local
      coursework, Supabase account/plan data, Stripe payment processing, and AI
      provider calls are described accurately. This correction is local until
      the site is deployed.
- [ ] Deploy the landing page. It already describes the caps and the $9.99 plan,
      so it must not go live before the app enforces them.

---

## What is deliberately not here

- **No content sync.** No table above holds a syllabus, a task, a chat message,
  or a Companion transcript, and none should be widened to. See the header
  comment in `supabase/schema.sql`.
- **No hosted-inference tier.** That means paying model costs per student and
  needs a cost-per-active-student model that has never been built.
- **No server-side usage counters.** Caps are counted locally in the
  `preferences` table. A determined user can reset them. At $9.99 to a student,
  hardening past honest friction costs more than it recovers.
