const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractBufferText,
  extractFullBufferText,
  extractInteractiveCliText,
  formatCommandBlock,
  formatCommandBlocks,
  isInteractiveCliCommand,
  isPowerShellClearHostCommand,
  parseOsc133
} = require('../src/command-blocks');

function encodeCommand(command) {
  return Buffer.from(command, 'utf8').toString('base64');
}

function fakeLine(text, isWrapped = false) {
  return {
    isWrapped,
    length: text.length,
    translateToString: (_trimRight, start, end) => text.slice(start, end)
  };
}

test('OSC 133 parser accepts only the matching session nonce', () => {
  assert.deepEqual(parseOsc133('A;safe-nonce', 'safe-nonce'), { type: 'A' });
  assert.equal(parseOsc133('A;other-nonce', 'safe-nonce'), null);
  assert.equal(parseOsc133('Z;safe-nonce', 'safe-nonce'), null);
});

test('OSC 133 parser decodes UTF-8 command text and exit status', () => {
  assert.deepEqual(
    parseOsc133(`E;nonce;${encodeCommand('Write-Output "한글"')}`, 'nonce'),
    { type: 'E', command: 'Write-Output "한글"' }
  );
  assert.deepEqual(parseOsc133('D;nonce;1', 'nonce'), {
    type: 'D',
    exitCode: 1
  });
  assert.deepEqual(
    parseOsc133(
      `B;nonce;${encodeCommand('E:\\05. Work\\project src')}`,
      'nonce'
    ),
    { type: 'B', cwd: 'E:\\05. Work\\project src' }
  );
});

test('Claude and Codex launch commands use selection-copy fallback', () => {
  for (const command of [
    'claude',
    'claude --continue',
    'codex',
    '& codex.cmd',
    '"C:\\Tools\\claude.exe" --resume'
  ]) {
    assert.equal(isInteractiveCliCommand(command), true, command);
  }

  assert.equal(isInteractiveCliCommand('Write-Output codex'), false);
  assert.equal(isInteractiveCliCommand('Get-Command claude'), false);
});

test('PowerShell clear-host commands are recognized conservatively', () => {
  for (const command of ['cls', ' CLS ', 'clear', 'Clear-Host', 'cls;']) {
    assert.equal(isPowerShellClearHostCommand(command), true, command);
  }

  for (const command of ['cls; Get-Date', 'Write-Output cls', 'Clear-Host -WhatIf']) {
    assert.equal(isPowerShellClearHostCommand(command), false, command);
  }
});

test('buffer extraction joins wrapped rows and preserves real newlines', () => {
  const lines = [
    fakeLine('ignored>output one'),
    fakeLine(' wrapped', true),
    fakeLine('next line'),
    fakeLine('prompt>')
  ];
  const buffer = { getLine: (line) => lines[line] };

  assert.equal(
    extractBufferText(
      buffer,
      { line: 0, column: 8 },
      { line: 3, column: 0 }
    ),
    'output one wrapped\nnext line'
  );
});

test('full buffer extraction omits trailing blank viewport rows', () => {
  const lines = [
    fakeLine('first'),
    fakeLine('second'),
    fakeLine(''),
    fakeLine('')
  ];
  const buffer = {
    length: lines.length,
    getLine: (line) => lines[line]
  };
  assert.equal(extractFullBufferText(buffer), 'first\nsecond');
});

test('interactive CLI copy uses the current alternate screen', () => {
  const normalLines = [fakeLine('PowerShell history')];
  const alternateLines = [
    fakeLine('Claude response line 1'),
    fakeLine('line 2'),
    fakeLine('')
  ];
  const normal = {
    length: normalLines.length,
    getLine: (line) => normalLines[line]
  };
  const alternate = {
    length: alternateLines.length,
    getLine: (line) => alternateLines[line]
  };

  assert.equal(
    extractInteractiveCliText({
      buffer: { active: alternate, alternate, normal }
    }),
    'Claude response line 1\nline 2'
  );
});

test('interactive CLI copy uses output since launch in the normal buffer', () => {
  const lines = [
    fakeLine('PS> codex'),
    fakeLine('response one'),
    fakeLine('response two'),
    fakeLine('codex> ')
  ];
  const normal = {
    length: lines.length,
    baseY: 0,
    cursorY: 3,
    cursorX: 0,
    getLine: (line) => lines[line]
  };

  assert.equal(
    extractInteractiveCliText(
      { buffer: { active: normal, alternate: {}, normal } },
      { marker: { line: 1, isDisposed: false }, column: 0 }
    ),
    'response one\nresponse two'
  );
});

test('command block text contains the command and output', () => {
  assert.equal(
    formatCommandBlock({ command: 'Get-Date', output: 'Thursday' }),
    '> Get-Date\nThursday'
  );
});

test('multiple command blocks are combined in execution order', () => {
  assert.equal(
    formatCommandBlocks([
      { command: 'Get-Date', output: 'Thursday' },
      { command: '$value = 1', output: '' }
    ]),
    '> Get-Date\nThursday\n\n----------------\n\n> $value = 1'
  );
});
