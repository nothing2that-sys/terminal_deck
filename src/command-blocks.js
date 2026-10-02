const MAX_COMMAND_BLOCKS = 100;

function decodeUtf8Base64(value) {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function parseOsc133(payload, expectedNonce) {
  if (typeof payload !== 'string' || typeof expectedNonce !== 'string') {
    return null;
  }

  const firstSeparator = payload.indexOf(';');
  if (firstSeparator < 0) {
    return null;
  }

  const type = payload.slice(0, firstSeparator);
  const remainder = payload.slice(firstSeparator + 1);
  const secondSeparator = remainder.indexOf(';');
  const nonce =
    secondSeparator < 0 ? remainder : remainder.slice(0, secondSeparator);
  const value =
    secondSeparator < 0 ? '' : remainder.slice(secondSeparator + 1);

  if (!['A', 'B', 'C', 'D', 'E'].includes(type) || nonce !== expectedNonce) {
    return null;
  }

  if (type === 'E') {
    const command = decodeUtf8Base64(value);
    return command === null ? null : { type, command };
  }

  if (type === 'B' && value) {
    const cwd = decodeUtf8Base64(value);
    return cwd === null ? null : { type, cwd };
  }

  if (type === 'D') {
    const exitCode = Number.parseInt(value, 10);
    return {
      type,
      exitCode: Number.isFinite(exitCode) ? exitCode : null
    };
  }

  return { type };
}

function isInteractiveCliCommand(command) {
  if (typeof command !== 'string') {
    return false;
  }

  let candidate = command.trimStart();
  if (candidate.startsWith('&')) {
    candidate = candidate.slice(1).trimStart();
  }

  const tokenMatch = candidate.match(/^(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/);
  if (!tokenMatch) {
    return false;
  }

  const token = tokenMatch[1] || tokenMatch[2] || tokenMatch[3];
  const executable = token.split(/[\\/]/).at(-1).toLowerCase();
  return /^(claude|codex)(?:\.exe|\.cmd|\.bat|\.ps1)?$/.test(executable);
}

function isPowerShellClearHostCommand(command) {
  if (typeof command !== 'string') {
    return false;
  }

  return /^\s*(?:cls|clear|clear-host)\s*;?\s*$/iu.test(command);
}

function extractBufferText(buffer, start, end) {
  if (
    !buffer
    || !Number.isInteger(start?.line)
    || !Number.isInteger(start?.column)
    || !Number.isInteger(end?.line)
    || !Number.isInteger(end?.column)
    || end.line < start.line
  ) {
    return '';
  }

  const parts = [];
  for (let lineNumber = start.line; lineNumber <= end.line; lineNumber += 1) {
    const line = buffer.getLine(lineNumber);
    if (!line) {
      continue;
    }

    const fromColumn = lineNumber === start.line ? start.column : 0;
    const toColumn =
      lineNumber === end.line ? end.column : line.length;
    parts.push(line.translateToString(true, fromColumn, toColumn));

    const nextLine = buffer.getLine(lineNumber + 1);
    if (lineNumber < end.line && !nextLine?.isWrapped) {
      parts.push('\n');
    }
  }

  return parts.join('').replace(/\n+$/u, '');
}

function extractFullBufferText(buffer) {
  if (!buffer || !Number.isInteger(buffer.length) || buffer.length === 0) {
    return '';
  }

  const lastLineNumber = buffer.length - 1;
  const lastLine = buffer.getLine(lastLineNumber);
  return extractBufferText(
    buffer,
    { line: 0, column: 0 },
    { line: lastLineNumber, column: lastLine?.length || 0 }
  );
}

function extractInteractiveCliText(terminal, capture) {
  const buffers = terminal?.buffer;
  if (!buffers?.active) {
    return '';
  }

  if (buffers.alternate && buffers.active === buffers.alternate) {
    return extractFullBufferText(buffers.alternate);
  }

  const buffer = buffers.normal || buffers.active;
  const marker = capture?.marker;
  if (
    marker
    && !marker.isDisposed
    && Number.isInteger(marker.line)
    && marker.line >= 0
    && Number.isInteger(capture.column)
    && Number.isInteger(buffer.baseY)
    && Number.isInteger(buffer.cursorY)
    && Number.isInteger(buffer.cursorX)
  ) {
    return extractBufferText(
      buffer,
      { line: marker.line, column: capture.column },
      { line: buffer.baseY + buffer.cursorY, column: buffer.cursorX }
    );
  }

  return extractFullBufferText(buffer);
}

function formatCommandBlock(block) {
  const output = block.output ? `\n${block.output}` : '';
  return `> ${block.command}${output}`;
}

function formatCommandBlocks(blocks) {
  return blocks.map(formatCommandBlock).join('\n\n----------------\n\n');
}

module.exports = {
  MAX_COMMAND_BLOCKS,
  extractBufferText,
  extractFullBufferText,
  extractInteractiveCliText,
  formatCommandBlock,
  formatCommandBlocks,
  isInteractiveCliCommand,
  isPowerShellClearHostCommand,
  parseOsc133
};
