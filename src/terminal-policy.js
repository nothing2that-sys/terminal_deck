function getTerminalShortcutAction(event, hasSelection) {
  const isCtrlShortcut = event.ctrlKey && !event.altKey && !event.metaKey;

  if (!isCtrlShortcut) {
    return 'terminal';
  }

  if (event.code === 'KeyC') {
    if (event.shiftKey || hasSelection) {
      return 'copy';
    }

    return 'terminal';
  }

  if (event.code === 'KeyV') {
    return 'paste';
  }

  return 'terminal';
}

function normalizeTerminalSize(value) {
  if (!value || !Number.isInteger(value.cols) || !Number.isInteger(value.rows)) {
    return null;
  }

  if (value.cols < 2 || value.cols > 1000 || value.rows < 1 || value.rows > 1000) {
    return null;
  }

  return { cols: value.cols, rows: value.rows };
}

module.exports = {
  getTerminalShortcutAction,
  normalizeTerminalSize
};
