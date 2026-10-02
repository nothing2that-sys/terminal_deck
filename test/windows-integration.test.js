const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  APP_USER_MODEL_ID,
  installedLauncherPath,
  shortcutDetails,
  startMenuShortcutPath
} = require('../src/windows-integration');

const versionedExecutable = [
  'C:',
  'Users',
  'example-user',
  'AppData',
  'Local',
  'multi_session_manager',
  'app-0.8.1',
  'TerminalDeck.exe'
].join('\\');

test('installed launcher beside Update.exe is preferred for relaunch shortcuts', () => {
  const expected = [
    'C:',
    'Users',
    'example-user',
    'AppData',
    'Local',
    'multi_session_manager',
    'TerminalDeck.exe'
  ].join('\\');

  assert.equal(
    installedLauncherPath(versionedExecutable, (candidate) => candidate === expected),
    expected
  );
});

test('portable builds fall back to their current executable', () => {
  assert.equal(
    installedLauncherPath(versionedExecutable, () => false),
    versionedExecutable
  );
});

test('Terminal Deck shortcut uses the matching application identity', () => {
  const details = shortcutDetails(versionedExecutable, () => false);
  assert.equal(
    APP_USER_MODEL_ID,
    'com.squirrel.multi_session_manager.TerminalDeck'
  );
  assert.deepEqual(details, {
    target: versionedExecutable,
    cwd: path.dirname(versionedExecutable),
    description: '새 Terminal Deck 창을 엽니다.',
    icon: versionedExecutable,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID
  });
});

test('shortcut is written into the current user Start menu', () => {
  const appData = ['C:', 'Users', 'example-user', 'AppData', 'Roaming'].join('\\');
  assert.equal(
    startMenuShortcutPath(appData),
    [
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Terminal Deck contributors',
      'Terminal Deck.lnk'
    ].join('\\')
  );
});
