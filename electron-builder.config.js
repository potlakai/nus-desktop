// electron-builder configuration for the Windows release.
//
// Signing is env-driven so the same config ships unsigned today and signed the
// day a certificate exists, with no code change. See docs/release.md.
//
//   Azure Trusted Signing (recommended, ~$10/mo):
//     AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//     NUS_SIGN_ENDPOINT   e.g. https://eus.codesigning.azure.net
//     NUS_SIGN_ACCOUNT    the Trusted Signing account name
//     NUS_SIGN_PROFILE    the certificate profile name
//
//   Classic PFX / OV / EV certificate:
//     WIN_CSC_LINK (path or base64) and WIN_CSC_KEY_PASSWORD, which
//     electron-builder reads on its own; nothing to set here.
//
// Until one of those is present Windows SmartScreen shows "Unknown publisher"
// on first run. The publisher name inside azureSignOptions is what ends up on
// the certificate; nothing here changes SmartScreen without a signature.

const azure = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'NUS_SIGN_ENDPOINT', 'NUS_SIGN_ACCOUNT', 'NUS_SIGN_PROFILE']
  .every((name) => Boolean(process.env[name]));

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
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'build/icon.ico',
    artifactName: 'Nus-Setup.${ext}',
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
  publish: [{ provider: 'github', owner: 'potlakai', repo: 'nus-desktop' }],
};

if (azure) console.log('[electron-builder] Azure Trusted Signing is configured; the installer will be signed.');
else console.log('[electron-builder] No signing credentials in the environment; building unsigned (SmartScreen will warn).');

module.exports = config;
