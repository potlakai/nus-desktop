// Auto-update against the GitHub releases feed.
//
// v0.1.0 shipped with no updater, which meant every install was frozen forever:
// no way to deliver a bug fix, a limit change, or a security patch to anyone who
// had already downloaded it. This is the seam that makes every later release
// actually reach people, so it has to land before any traffic does.
//
// Only the NSIS install can self-update. The portable .exe has no install
// directory to write into, so it is skipped by design and those users
// re-download. Dev runs are skipped too: an unpackaged app has no feed to check.

const { app } = require('electron');

function initAutoUpdate({ onError } = {}) {
  if (!app.isPackaged) return { started: false, reason: 'not_packaged' };
  // electron-builder sets this only for the portable target.
  if (process.env.PORTABLE_EXECUTABLE_DIR) return { started: false, reason: 'portable' };

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    console.error('[nus] electron-updater unavailable', error && error.message);
    return { started: false, reason: 'module_missing' };
  }

  autoUpdater.autoDownload = true;

  // An update check must never be able to take the app down with it. No network,
  // a rate-limited GitHub, a half-written feed: all land here and are swallowed.
  const fail = (error) => {
    console.error('[nus] update check failed', (error && error.message) || error);
    if (onError) { try { onError(error); } catch {} }
  };
  autoUpdater.on('error', fail);

  // Downloads in the background and shows an OS notification when a build is
  // staged; it installs on the next quit. Nothing interrupts a live session.
  Promise.resolve(autoUpdater.checkForUpdatesAndNotify()).catch(fail);

  return { started: true };
}

module.exports = { initAutoUpdate };
