# OAuth setup: do these two now (~20 min total)

Both are free. When done, paste the three values at the bottom of this file into
`src/config.js` (or just paste them to Claude in chat and I'll wire them).

---

## 1. Microsoft / Outlook (~8 min): works for strangers immediately

1. Go to https://portal.azure.com and sign in (any Microsoft account works; your
   personal one is fine).
2. Search bar at the top: type **App registrations** and open it.
3. Click **+ New registration**.
   - Name: `Nus Desktop`
   - Supported account types: select **"Accounts in any organizational directory
     and personal Microsoft accounts"** (the third option, the one that lets any
     student sign in).
   - Redirect URI: pick platform **"Public client/native (mobile & desktop)"**
     and enter: `http://127.0.0.1`
   - Click **Register**.

   > **If you hit `AADSTS900971: No reply address provided`**, the redirect URI
   > did not save. Go to **Authentication** → **+ Add a platform** → **Mobile and
   > desktop applications**, tick the `https://login.microsoftonline.com/common/oauth2/nativeclient`
   > box AND add a custom URI `http://127.0.0.1`, then **Configure**/Save. Add
   > `http://localhost` too; both are free and Azure ignores the port for
   > loopback addresses.
4. On the app's Overview page, copy the **Application (client) ID**. That's the
   value we need.
5. Left menu → **Authentication** → scroll to **Advanced settings** → set
   **"Allow public client flows"** to **Yes** → Save.
6. Left menu → **API permissions** → **+ Add a permission** → **Microsoft Graph**
   → **Delegated permissions** → add all of:
   - `User.Read`
   - `Mail.Read`
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `offline_access`
   Click **Add permissions**. (No admin consent needed; users consent themselves.)

Done. No secret needed: it's a public client.

---

## 2. Google / Calendar (~10 min): ships as "unverified" beta tonight

Heads up: until Google finishes verification (we submit after launch), users see
a "Google hasn't verified this app" warning and click **Advanced → Continue**.
That's normal for alphas.

1. Go to https://console.cloud.google.com and sign in.
2. Top bar project picker → **New project** → name `Nus Desktop` → Create →
   make sure it's selected.
3. Left menu → **APIs & Services** → **Library** → search **Google Calendar API**
   → open it → **Enable**.
4. **APIs & Services** → **OAuth consent screen**:
   - User type: **External** → Create.
   - App name: `Nūs`, support email: your email, developer contact: your email.
   - Save through the steps. On **Scopes** you can skip (the app requests the
     scope at runtime). On **Test users** you can skip.
   - Back on the consent screen page: click **Publish app** → confirm
     ("In production"). This is what lets anyone (not just test users) connect,
     with the unverified warning.
5. **APIs & Services** → **Credentials** → **+ Create credentials** →
   **OAuth client ID**:
   - Application type: **Desktop app**
   - Name: `Nus Desktop`
   - Create.
6. Copy the **Client ID** and **Client secret** from the popup.

---

## Paste back (to chat or into src/config.js)

- Outlook Application (client) ID: `________________`
- Google Client ID: `________________`
- Google Client secret: `________________`
