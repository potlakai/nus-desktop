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
that must not ship.

Smoke the packaged installer with an isolated profile so the real one is never
touched:

```
set NUS_SMOKE_DATA_DIR=%TEMP%\nus-smoke
"dist\win-unpacked\Nus.exe" --smoke
```

## 3. Publish

```
git tag v0.2.2
gh release create v0.2.2 dist/Nus-Setup.exe dist/Nus-Portable.exe dist/Nus-Setup.exe.blockmap dist/latest.yml --title "Nūs Desktop v0.2.2" --notes-file docs/release-notes.md
```

`latest.yml` is what installed copies poll (`src/updater.js`); without it the
auto-update is silent. The site's download buttons use
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

## What is deliberately not automated

- Pushing to GitHub and creating the release. A release is public the moment
  it exists, so it stays a human command.
- Flipping Supabase or Stripe secrets. See `docs/billing-setup.md`.
