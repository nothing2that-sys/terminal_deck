function buildCommandExecutionInput(command, clearPrompt = false) {
  if (typeof command !== 'string') {
    return '';
  }

  const normalized = command.replace(/\r\n|\r|\n/gu, '\r');
  const executable = normalized.endsWith('\r')
    ? normalized
    : `${normalized}\r`;
  return `${clearPrompt ? '\x07' : ''}${executable}`;
}

function buildSetLocationCommand(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return '';
  }
  return `Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}'`;
}

function moveHistoryCursor(history, cursor, direction) {
  const entries = Array.isArray(history) ? history : [];
  const safeCursor = Number.isInteger(cursor)
    ? Math.min(Math.max(cursor, 0), entries.length)
    : entries.length;
  const nextCursor =
    direction === 'up'
      ? Math.max(0, safeCursor - 1)
      : Math.min(entries.length, safeCursor + 1);

  return {
    cursor: nextCursor,
    command:
      nextCursor < entries.length
        ? entries[nextCursor]?.command || ''
        : ''
  };
}

module.exports = {
  buildCommandExecutionInput,
  buildSetLocationCommand,
  moveHistoryCursor
};
