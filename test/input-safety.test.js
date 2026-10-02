const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_PASTE_LENGTH,
  analyzePaste,
  encodeTerminalInput
} = require('../src/input-safety');

test('paste analysis distinguishes empty, multiline, and destructive commands', () => {
  assert.equal(analyzePaste('').empty, true);
  assert.deepEqual(analyzePaste('echo a\necho b').reasons, ['multiline']);
  assert.equal(analyzePaste('Remove-Item C:\\temp -Recurse').risky, true);
  assert.equal(analyzePaste('git status').risky, false);
});

test('paste input is encoded as one atomic terminal write', () => {
  assert.equal(encodeTerminalInput('Get-Date'), 'Get-Date');
  assert.equal(
    encodeTerminalInput('Get-Date', { mode: 'execute' }),
    'Get-Date\r'
  );
  assert.equal(
    encodeTerminalInput('one\ntwo', { mode: 'execute', bracketedPaste: true }),
    '\u001b[200~one\rtwo\u001b[201~\r'
  );
  assert.equal(encodeTerminalInput('one\ntwo'), null);
  assert.equal(
    encodeTerminalInput('one\ntwo', { allowMultiline: true }),
    'one\rtwo'
  );
  assert.equal(
    encodeTerminalInput('one\ntwo', {
      mode: 'execute',
      allowMultiline: true
    }),
    'one\rtwo\r'
  );
  assert.equal(
    encodeTerminalInput('one\u001b[201~\rtwo', { bracketedPaste: true }),
    null
  );
  assert.equal(
    encodeTerminalInput('one\r\ntwo', { bracketedPaste: true }),
    '\u001b[200~one\rtwo\u001b[201~'
  );
  assert.equal(encodeTerminalInput('x'.repeat(MAX_PASTE_LENGTH + 1)), null);
});
