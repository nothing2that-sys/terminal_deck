const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCommandExecutionInput,
  buildSetLocationCommand,
  moveHistoryCursor
} = require('../src/command-history');

test('favorite commands execute multiline input with a final Enter', () => {
  assert.equal(
    buildCommandExecutionInput('git pull\nnpm run build', true),
    '\x07git pull\rnpm run build\r'
  );
});

test('initial directory command uses a quoted PowerShell literal', () => {
  assert.equal(
    buildSetLocationCommand("D:\\Example's Work\\project"),
    "Set-Location -LiteralPath 'D:\\Example''s Work\\project'"
  );
  assert.equal(buildSetLocationCommand(''), '');
});

test('history navigation stays within one tab history', () => {
  const history = [
    { command: 'first' },
    { command: 'second' }
  ];

  assert.deepEqual(moveHistoryCursor(history, 2, 'up'), {
    cursor: 1,
    command: 'second'
  });
  assert.deepEqual(moveHistoryCursor(history, 1, 'up'), {
    cursor: 0,
    command: 'first'
  });
  assert.deepEqual(moveHistoryCursor(history, 1, 'down'), {
    cursor: 2,
    command: ''
  });
});
