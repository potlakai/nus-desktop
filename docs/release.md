# Releasing Nūs Desktop

The whole release is four commands once the suite is green. Signing is the
only optional step, and the build config already knows how to do it.

## 1. Verify

```
npm test
node scripts/security-check.js
```

Both must pass. The suite locks the billing contract (JWT-only Checkout,
signature-only webhook, read-only subscriptions table, no service-role key in
`src/`), the cap wiring, the upgrade sheet, and the shipped-file list.

## 2. Build

```
npm run dist
node scripts/package-security-check.js
```

`npm run dist` reads `electron-builder.config.js` and produces
`dist/Nus-Setup.exe`, `dist/Nus-Portable.exe`, `dist/Nus-Setup.exe.blockmap`,
and `dist/latest.yml`. The second command scans the packed ASAR for anything
that must not ship. The Mac dmgs come from CI, see §5.

Smoke the packaged installer with an isolated profile so the real one is never
touched:

```
set NUS_SMOKE_DATA_DIR=%TEMP%\nus-smoke
"dist\win-unpacked\Nus.exe" --smoke
```

## 3. Publish

```
git tag v0.2.5
gh release create v0.2.5 dist/Nus-Setup.exe dist/Nus-Portable.exe dist/Nus-Setup.exe.blockmap dist/latest.yml --title "Nūs Desktop v0.2.5" --notes "One paragraph on what changed for users."
```

`latest.yml` is what installed copies poll (`src/updater.js`); without it the
auto-update is silent.

Supabase pauses a free project after seven days without API traffic, and a
paused project's hostname stops resolving (sign-in, checkout, and funnel
events all fail until someone clicks Restore in the dashboard; this happened
2026-09-06). `.github/workflows/keepalive.yml` sends one anon REST request
every two days to keep it awake. It only runs once the workflow is on `main`,
so push it with the next release and trigger it once by hand:
`gh workflow run keepalive`. The site's download buttons use
`releases/latest/download/Nus-Setup.exe`, so they follow the newest release
automatically. Bump `version` in `package.json` before building; the version
string is baked into the installer, the updater feed, and the `app_version`
column on funnel events.

## 4. Code signing (when there is a certificate)

SmartScreen's "Unknown publisher" is the absence of an Authenticode signature.
Nothing else removes it. Two honest paths:

**Azure Trusted Signing** (about $10 a month, identity-validated, the cheapest
legitimate route). Create a Trusted Signing account and a certificate profile
in the Azure portal, give a service principal the "Trusted Signing Certificate
Profile Signer" role, then export:

```
set AZURE_TENANT_ID=...
set AZURE_CLIENT_ID=...
set AZURE_CLIENT_SECRET=...
set NUS_SIGN_ENDPOINT=https://eus.codesigning.azure.net
set NUS_SIGN_ACCOUNT=<trusted signing account name>
set NUS_SIGN_PROFILE=<certificate profile name>
npm run dist
```

`electron-builder.config.js` adds `win.azureSignOptions` only when all six are
present, and prints which mode it is in. electron-builder 26 signs both the
installer and the portable exe.

**A classic OV or EV certificate** (SSL.com, Certum, DigiCert; roughly $200 to
$500 a year, EV on a hardware token or cloud HSM). Export the PFX and set
`WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`; electron-builder picks them up
without any config change.

What signing does and does not do: an EV certificate clears SmartScreen
immediately. An OV certificate or Trusted Signing still shows the warning to
the first users until Microsoft's reputation for that signer builds, usually a
few weeks of downloads. Either way the "Unknown publisher" line becomes the
real publisher name, which is the part students actually read.

## 5. Mac build

A Mac app cannot be built on Windows, so `.github/workflows/build-mac.yml`
builds it on a GitHub macOS runner. It is manual-trigger only and never
touches a release: the two dmgs land as run artifacts, get tested on a real
Mac, then get attached to the release by hand.

One-time setup. `src/config.js` is gitignored, so the runner renders it with
`scripts/write-config.js` from five repository secrets (values from your local
`src/config.js`):

```
gh secret set NUS_SUPABASE_URL -R potlakai/nus-desktop
gh secret set NUS_SUPABASE_ANON_KEY -R potlakai/nus-desktop
gh secret set NUS_GCAL_CLIENT_ID -R potlakai/nus-desktop
gh secret set NUS_GCAL_CLIENT_SECRET -R potlakai/nus-desktop
gh secret set NUS_OUTLOOK_CLIENT_ID -R potlakai/nus-desktop
```

Each release, after the version bump is on `main`:

```
gh workflow run build-mac -R potlakai/nus-desktop
gh run watch -R potlakai/nus-desktop
gh run download -R potlakai/nus-desktop -n nus-mac-dmgs -D dist/mac-dmgs
```

The workflow runs the suite, builds `Nus-arm64.dmg` and `Nus-x64.dmg`, scans
the packed asar, prints the signature report, and smokes the arm64 app with
`--smoke`. Test the dmg on a Mac (Gatekeeper "Open Anyway", Google sign-in
round trip through `nus-desktop://`, an import, the Companion and `⌘⇧Space`,
quit and reopen from the Dock), then attach:

```
gh release upload v0.2.5 dist/mac-dmgs/Nus-arm64.dmg dist/mac-dmgs/Nus-x64.dmg
```

The site links `releases/latest/download/Nus-arm64.dmg` and `Nus-x64.dmg`, so
every release must carry both dmgs or the Mac buttons 404.

What the unsigned Mac build means. The app is ad-hoc signed in `afterPack`
(`electron-builder.config.js`), which is what makes Gatekeeper offer "Open
Anyway" instead of "app is damaged"; the first open still needs that trip to
System Settings. `src/updater.js` is off on macOS because electron-updater
will not apply an update to an app without a Developer ID signature. Local
voice is not bundled (`vendor/whisper` is Windows binaries).

Notarization, when there is $99 a year for the Apple Developer Program:
export the Developer ID Application certificate as a `.p12`, then set
`CSC_LINK` (base64 of the p12), `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` as repository secrets and
pass them into the build step. The config flips to hardened runtime plus
notarize on its own. Then add a `zip` target to `mac.target` so
`latest-mac.yml` is produced, upload it with the release, and delete the
darwin early-return in `src/updater.js`.

## What is deliberately not automated

- Pushing to GitHub and creating the release. A release is public the moment
  it exists, so it stays a human command. The Mac workflow follows the same
  rule: artifacts only, never a release upload.
- Flipping Supabase or Stripe secrets. See `docs/billing-setup.md`.
