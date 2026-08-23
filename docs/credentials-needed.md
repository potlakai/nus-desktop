# Credentials needed for Nūs v0.2

> Create these three credentials and paste them into `src/config.js` (or the
> in-app Settings → Connections screen when shipped). Nothing sends anywhere
> until you run the app yourself.

## 1. Supabase (account creation + subscription identity)

**Why:** Google OAuth + email/password login. Local SQLite stays the source of truth; Supabase holds identity and subscription status only.

**Steps:**
1. Go to https://supabase.com → sign in → New Project.
2. Project name: `nus`. Choose a region close to you.
3. Once created: Project Settings → API → copy:
   - **Project URL** (e.g. `https://xyz.supabase.co`)
   - **anon public key** (the `sb-publishable` / `eyJhbGci...` key, NOT the service_role key)
4. Dashboard → Authentication → Providers:
   - Enable **Email** (built in, no extra config).
   - Enable **Google** → paste your Google Cloud OAuth client ID + secret (see step 2 below if you don't have one yet; the same GCP client can be reused if you add the Supabase callback URL to its authorized redirects). Supabase shows the redirect URL to whitelist in GCP.
5. Paste URL + anon key into `src/config.js`:
   ```js
   module.exports = {
     supabase: { url: 'PASTE_HERE', anonKey: 'PASTE_HERE' },
     ...
   };
   ```

**Where data goes:** only auth metadata (email and user id) plus subscription status. This build does not upload courses, tasks, imports, chats, or Companion content.

---

## 2. Google Calendar (live read + write)

**Why:** Pull your live GCal events into the Nūs calendar view; Smart Tasks can push events back to GCal.

**Steps:**
1. Go to https://console.cloud.google.com → create or pick a project (e.g. `nus-desktop`).
2. APIs & Services → Library → enable **Google Calendar API**.
3. APIs & Services → OAuth consent screen:
   - User type: **External** (or Internal if you're on a Workspace org you control).
   - App name: `Nūs`. Support email: yours. Authorized domain: none needed for desktop.
   - Add your own Google account as a Test User.
4. APIs & Services → Credentials → Create Credentials → **OAuth client ID**:
   - Application type: **Desktop app**.
   - Name: `Nūs desktop`.
   - Create → copy the **Client ID** and **Client secret**.
5. Paste into `src/config.js`:
   ```js
   googleCalendar: {
     clientId: 'PASTE_HERE.apps.googleusercontent.com',
     clientSecret: 'PASTE_HERE',
     scopes: ['https://www.googleapis.com/auth/calendar.events'],
   },
   ```
6. On first connect in Nūs, a browser window opens → you pick the Google account → consent → redirect to `http://localhost:PORT` (Nūs spins up a local server to catch the code). Token stored in Electron `safeStorage`, never in SQLite or plaintext.

---

## 3. Microsoft Outlook (email connect + send)

**Why:** Read your sent mail to learn your writing style; send professor emails you draft and approve in Nūs via your Outlook account.

**Steps:**
1. Go to https://portal.azure.com → Microsoft Entra ID (Azure AD) → App registrations → New registration.
2. Name: `Nūs desktop`. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
3. Redirect URI: platform **Mobile and desktop applications** → add `http://localhost`. (MSAL uses the loopback; the exact port is picked at runtime.)
4. Certificates & secrets → New client secret → copy the **Value** (not the Secret ID). NOTE: for a pure public-client desktop app you can skip the secret and use PKCE only; if you add a secret, store it via `safeStorage`.
5. API permissions → Add a permission → Microsoft Graph → Delegated:
   - `User.Read`
   - `Mail.Read`
   - `Mail.ReadWrite`
   - `offline_access`
6. Authentication → Advanced settings → set **Allow public client flows** = Yes.
7. Copy the **Application (client) ID** from the Overview page.
8. Paste into `src/config.js`:
   ```js
   outlook: {
     clientId: 'PASTE_HERE',
     tenant: 'common',
     scopes: ['User.Read', 'Mail.Read', 'Mail.ReadWrite', 'offline_access'],
   },
   ```

**Where data goes:** Nūs reads your last ~50 sent emails ONCE (or when you click "Refresh style") to build a local `style_profile_email.json` on your machine. The profile is a heuristic fingerprint + 3-5 few-shot exemplars. No email content leaves your machine except the one draft you explicitly click "Send via Outlook" on, which goes via Microsoft Graph directly from your account.

---

## Optional: AiME style seed

If you want to seed the email-writing style from your AiME docs (`notes/drive-import/AiME Layout/Specific Strategies/Platforms/Email/Email Product.docx` and `Email Strategy.docx`), export those .docx files as `.txt` or `.pdf` and drop them into a folder Nūs can read. The .docx binaries themselves are not directly parseable by the current text pipeline.

---

## Security notes

- All OAuth tokens live in Electron `safeStorage` (OS keychain on macOS, DPAPI on Windows, libsecret on Linux). Never in SQLite, never in plaintext files, never in the repo.
- `src/config.js` holds client IDs and (for Google) a client secret. This file is in `.gitignore` by convention. If you ever push this repo, confirm `src/config.js` is ignored.
- No email is ever sent without your explicit click on a reviewed draft. No background sending.
- No hidden content collection. Cross-device content sync is not available in this build.
