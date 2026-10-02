const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getShortcutCommand,
  getSquirrelEvent,
  getUpdateExecutablePath
} = require('../src/squirrel-shortcuts');

const installedExecutable = [
  'C:',
  'Users',
  'example-user',
  'AppData',
  'Local',
  'multi_session_manager',
  'app-0.6.0',
  'TerminalDeck.exe'
].join('\\');

test('only supported Squirrel lifecycle arguments are detected', () => {
  assert.equal(
    getSquirrelEvent(['TerminalDeck.exe', '--squirrel-install']),
    '--squirrel-install'
  );
  assert.equal(getSquirrelEvent(['TerminalDeck.exe']), null);
});

test('Squirrel Update.exe is resolved from the installed app directory', () => {
  assert.equal(
    getUpdateExecutablePath(installedExecutable),
    [
      'C:',
      'Users',
      'example-user',
      'AppData',
      'Local',
      'multi_session_manager',
      'Update.exe'
    ].join('\\')
  );
});

test('install creates shortcuts only when the user agrees', () => {
  assert.deepEqual(
    getShortcutCommand('--squirrel-install', installedExecutable, true),
    {
      executablePath: [
        'C:',
        'Users',
        'example-user',
        'AppData',
        'Local',
        'multi_session_manager',
        'Update.exe'
      ].join('\\'),
      args: ['--createShortcut', 'TerminalDeck.exe']
    }
  );
  assert.equal(
    getShortcutCommand('--squirrel-install', installedExecutable, false),
    null
  );
});

test('uninstall removes shortcuts regardless of the install choice', () => {
  assert.deepEqual(
    getShortcutCommand('--squirrel-uninstall', installedExecutable, false),
    {
      executablePath: [
        'C:',
        'Users',
        'example-user',
        'AppData',
        'Local',
        'multi_session_manager',
        'Update.exe'
      ].join('\\'),
      args: ['--removeShortcut', 'TerminalDeck.exe']
    }
  );
});

test('updates recreate shortcuts only when the saved preference is yes', () => {
  assert.deepEqual(
    getShortcutCommand('--squirrel-updated', installedExecutable, true),
    {
      executablePath: [
        'C:',
        'Users',
        'example-user',
        'AppData',
        'Local',
        'multi_session_manager',
        'Update.exe'
      ].join('\\'),
      args: ['--createShortcut', 'TerminalDeck.exe']
    }
  );
  assert.equal(
    getShortcutCommand('--squirrel-updated', installedExecutable, false),
    null
  );
});
