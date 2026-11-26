# Releasing J.A.R.V.I.S

The release is a workflow run, a download, a launch, and a human `gh release
create`. Signing is the only optional step, and the build config knows how to
do it.

There is no server and no account, so nothing here asks for a Supabase or
Stripe credential: those were removed with the commercial layer.

## 1. Verify

```
npm test
node scripts/security-check.js
```

Both must pass before anything is built. CI runs the first one, but not on a
schedule: a release you start is the only thing that runs the suite.

## 2. Build

Two ways, and on a PC the second is the one to trust.

**Locally, with the toolchain:**

```
npm run setup:voice        # whisper binaries; once per machine, Windows only
npm run dist               # makes vendor/voice-lines, then packs
node scripts/package-security-check.js
```

`npm run dist` reads `electron-builder.config.js` and produces
`dist/JARVIS-Setup.exe`, `dist/JARVIS-Portable.exe`,
`dist/JARVIS-Setup.exe.blockmap` and `dist/latest.yml`. The scan command reads
the packed ASAR and fails on anything that must not ship.

It needs the Fable model in `vendor/voice` before it will start: the first thing
`dist` does is make the fixed lines, and that script stops without the model.
`vendor/` is gitignored, so this is true of any clean checkout.

**From CI, which is the only build that is ever launched:**

```
gh workflow run build-windows
gh run watch
gh run download -n jarvis-windows -D dist
```

`.github/workflows/build-windows.yml` runs on `windows-latest`: it renders
`src/config.js`, runs the suite, fetches the whisper binary and the voice model
against its pinned hash, builds the installer and portable exe, scans the asar,
and then **runs the packaged app with `--smoke`** before uploading the files. A
build that cannot open a window and start the Companion is not uploaded.

Smoke either build yourself with an isolated profile, so the real one is never
touched:

```
set NUS_SMOKE_DATA_DIR=%TEMP%\jarvis-smoke
"dist\win-unpacked\JARVIS.exe" --smoke
```

It prints `smoke ok` and quits. The command is the same one the workflow runs,
which is deliberate: what CI proves and what you can prove are the same thing.

## 3. Publish

Download the artifacts from the run, launch the installer on a real PC, and
then, by hand:

```
git tag v0.2.6
gh release create v0.2.6 dist/JARVIS-Setup.exe dist/JARVIS-Portable.exe \
  dist/JARVIS-Setup.exe.blockmap dist/latest.yml --title "J.A.R.V.I.S 0.2.6"
```

`latest.yml` is what installed copies poll (`src/updater.js`); without it the
auto-update is silent. The portable exe cannot self-update (no install
directory to write into) and is skipped by design.

Bump `version` in `package.json` before building. The version string is baked
into the installer and the updater feed.

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
gh secret set NUS_SUPABASE_URL -R omsenjalia/nus-desktop
gh secret set NUS_SUPABASE_ANON_KEY -R omsenjalia/nus-desktop
gh secret set NUS_GCAL_CLIENT_ID -R omsenjalia/nus-desktop
gh secret set NUS_GCAL_CLIENT_SECRET -R omsenjalia/nus-desktop
gh secret set NUS_OUTLOOK_CLIENT_ID -R omsenjalia/nus-desktop
```

Each release, after the version bump is on `main`:

```
gh workflow run build-mac -R omsenjalia/nus-desktop
gh run watch -R omsenjalia/nus-desktop
gh run download -R omsenjalia/nus-desktop -n nus-mac-dmgs -D dist/mac-dmgs
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
- Anything to do with billing or accounts. There are none in this build: the
  Supabase and Stripe setup, the checkout script and its guide were removed
  along with the commercial layer.
