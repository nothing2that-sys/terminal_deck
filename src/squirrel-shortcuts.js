const path = require('node:path');

const SQUIRREL_EVENTS = new Set([
  '--squirrel-install',
  '--squirrel-updated',
  '--squirrel-uninstall',
  '--squirrel-obsolete'
]);

function getSquirrelEvent(argv = process.argv) {
  return SQUIRREL_EVENTS.has(argv[1]) ? argv[1] : null;
}

function getUpdateExecutablePath(executablePath) {
  return path.resolve(path.dirname(executablePath), '..', 'Update.exe');
}

function getShortcutCommand(eventName, executablePath, createShortcuts) {
  const executableName = path.basename(executablePath);
  const updateExecutablePath = getUpdateExecutablePath(executablePath);

  if (
    ['--squirrel-install', '--squirrel-updated'].includes(eventName)
    && createShortcuts
  ) {
    return {
      executablePath: updateExecutablePath,
      args: ['--createShortcut', executableName]
    };
  }

  if (eventName === '--squirrel-uninstall') {
    return {
      executablePath: updateExecutablePath,
      args: ['--removeShortcut', executableName]
    };
  }

  return null;
}

module.exports = {
  getShortcutCommand,
  getSquirrelEvent,
  getUpdateExecutablePath
};
