const path = require('node:path');

const APP_USER_MODEL_ID = 'com.squirrel.multi_session_manager.TerminalDeck';
const PRODUCT_NAME = 'Terminal Deck';

function installedLauncherPath(executablePath, pathExists = () => false) {
  const launcherPath = path.resolve(
    path.dirname(executablePath),
    '..',
    path.basename(executablePath)
  );

  return pathExists(launcherPath) ? launcherPath : executablePath;
}

function startMenuShortcutPath(appDataPath) {
  return path.join(
    appDataPath,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Terminal Deck contributors',
    `${PRODUCT_NAME}.lnk`
  );
}

function shortcutDetails(executablePath, pathExists) {
  const target = installedLauncherPath(executablePath, pathExists);
  return {
    target,
    cwd: path.dirname(target),
    description: '새 Terminal Deck 창을 엽니다.',
    icon: executablePath,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID
  };
}

module.exports = {
  APP_USER_MODEL_ID,
  installedLauncherPath,
  shortcutDetails,
  startMenuShortcutPath
};
