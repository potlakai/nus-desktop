// electron-builder configuration for the Windows and macOS releases.
//
// Windows builds locally (npm run dist). macOS cannot be built on Windows, so
// it builds on a GitHub Actions macos runner (.github/workflows/build-mac.yml,
// npm run dist:mac). Both read this one file.
//
// Signing is env-driven so the same config ships unsigned today and signed the
// day a certificate exists, with no code change. See docs/release.md.
//
//   Windows, Azure Trusted Signing (recommended, ~$10/mo):
//     AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//     NUS_SIGN_ENDPOINT   e.g. https://eus.codesigning.azure.net
//     NUS_SIGN_ACCOUNT    the Trusted Signing account name
//     NUS_SIGN_PROFILE    the certificate profile name
//
//   Windows, classic PFX / OV / EV certificate:
//     WIN_CSC_LINK (path or base64) and WIN_CSC_KEY_PASSWORD, which
//     electron-builder reads on its own; nothing to set here.
//
//   macOS, Developer ID + notarization ($99/yr Apple Developer Program):
//     CSC_LINK / CSC_KEY_PASSWORD (the Developer ID Application .p12) and
//     APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID. When all are
//     present the mac block below flips to hardened runtime + notarize.
//
// Until one of those is present Windows SmartScreen shows "Unknown publisher"
// on first run, and macOS Gatekeeper says "Apple could not verify" and needs
// one trip to System Settings > Privacy & Security > Open Anyway. The mac app
// is ad-hoc signed in afterPack so that dialog is the recoverable one instead
// of the dead-end "app is damaged" (and so arm64 launches at all).

const path = require('path');
const { execFileSync } = require('child_process');

const azure = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'NUS_SIGN_ENDPOINT', 'NUS_SIGN_ACCOUNT', 'NUS_SIGN_PROFILE']
  .every((name) => Boolean(process.env[name]));
const appleSigned = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  .every((name) => Boolean(process.env[name]));

// Ad-hoc sign the packed .app when no real identity signed it. Runs only for
// the darwin target. Idempotent: a bundle that already carries a signature
// (Developer ID or a previous ad-hoc pass) is left alone.
function adHocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execFileSync('codesign', ['-dv', appPath], { stdio: 'ignore' });
    console.log(`[electron-builder] ${path.basename(appPath)} is already signed; leaving it.`);
    return;
  } catch {}
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`[electron-builder] ad-hoc signed ${path.basename(appPath)} (no Developer ID in the environment).`);
}

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.nus.desktop',
  productName: 'Nus',
  copyright: 'Copyright 2026 Pranav Desu',
  directories: { output: 'dist', buildResources: 'build' },
  files: [
    'src/**/*',
    'renderer/**/*',
    'companion/**/*',
    'package.json',
    '!**/*.test.js',
    '!docs/**',
    '!companion/test/**',
    '!scripts/**',
    '!supabase/**',
    '!electron-builder.config.js',
  ],
  // nus-desktop:// carries the OAuth callback, the billing return, and the
  // acquisition token. Windows registers it at runtime (src/protocol.js);
  // macOS only honours CFBundleURLTypes in Info.plist, which this produces.
  protocols: [{ name: 'Nus', schemes: ['nus-desktop'] }],
  afterPack: adHocSignMac,
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'build/icon.ico',
    artifactName: 'Nus-Setup.${ext}',
    // whisper.cpp lives outside the asar so it can be spawned as a real exe.
    // The model is NOT bundled: it downloads to userData on first use. These
    // are Windows binaries, so only the Windows target carries them.
    extraResources: [
      { from: 'vendor/whisper', to: 'whisper', filter: ['**/*'] },
      // The Windows probe is a PowerShell script run with -File, which cannot
      // read from inside the asar; it ships beside the whisper binary.
      { from: 'companion/src/win', to: 'win', filter: ['*.ps1'] },
    ],
    ...(azure ? {
      azureSignOptions: {
        publisherName: 'Pranav Desu',
        endpoint: process.env.NUS_SIGN_ENDPOINT,
        codeSigningAccountName: process.env.NUS_SIGN_ACCOUNT,
        certificateProfileName: process.env.NUS_SIGN_PROFILE,
      },
    } : {}),
  },
  portable: { artifactName: 'Nus-Portable.${ext}' },
  nsis: {
    oneClick: true,
    perMachine: false,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Nus',
    uninstallDisplayName: 'Nūs',
    deleteAppDataOnUninstall: false,
  },
  mac: {
    // Two downloads with stable names, so the site can link
    // releases/latest/download/Nus-arm64.dmg and Nus-x64.dmg forever.
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    // 1024px PNG; electron-builder renders the .icns from it.
    icon: 'build/icon.png',
    category: 'public.app-category.education',
    artifactName: 'Nus-${arch}.${ext}',
    darkModeSupport: true,
    // No zip target and no latest-mac.yml on purpose: the updater is off on
    // macOS until the build is notarized (src/updater.js).
    ...(appleSigned ? {
      hardenedRuntime: true,
      gatekeeperAssess: false,
      notarize: true,
    } : {
      hardenedRuntime: false,
      gatekeeperAssess: false,
      identity: null,
    }),
    extendInfo: {
      NSMicrophoneUsageDescription: 'Nūs listens only while you hold the voice button or while the Companion is on, and transcribes on this device.',
      NSCameraUsageDescription: 'Nūs does not use the camera. macOS asks because screen sharing shares the permission group.',
      NSAudioCaptureUsageDescription: 'The Companion can hear the audio of a lecture or meeting you are in, only while you turn it on.',
    },
  },
  dmg: {
    artifactName: 'Nus-${arch}.${ext}',
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },
  publish: [{ provider: 'github', owner: 'potlakai', repo: 'nus-desktop' }],
};

if (azure) console.log('[electron-builder] Azure Trusted Signing is configured; the Windows installer will be signed.');
else console.log('[electron-builder] No Windows signing credentials in the environment; building unsigned (SmartScreen will warn).');
if (appleSigned) console.log('[electron-builder] Apple Developer ID + notarization credentials present; the mac app will be notarized.');
else console.log('[electron-builder] No Apple Developer ID in the environment; the mac app will be ad-hoc signed (Gatekeeper needs Open Anyway once).');

module.exports = config;
