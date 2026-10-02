const assert = require('node:assert/strict');
const test = require('node:test');
const { validateSpawnRequest } = require('../src/elevated-pty-broker');

test('elevated broker accepts only bounded PTY spawn fields', () => {
  const request = validateSpawnRequest({
    sessionId: 'session-1',
    shellKind: 'pwsh',
    nonce: 'safe_nonce',
    cwd: 'C:\\work',
    cols: 120,
    rows: 30
  });
  assert.equal(request.sessionId, 'session-1');
  assert.throws(
    () => validateSpawnRequest({ ...request, cwd: '..\\escape' }),
    { code: 'ERR_INVALID_BROKER_REQUEST' }
  );
});

test('elevated broker rejects caller-controlled shell kinds', () => {
  assert.throws(
    () => validateSpawnRequest({
      sessionId: 'session-1',
      shellKind: 'custom',
      nonce: 'safe_nonce',
      cwd: 'C:\\work',
      cols: 120,
      rows: 30
    }),
    { code: 'ERR_INVALID_BROKER_REQUEST' }
  );
});

test('elevated broker accepts Windows PowerShell shell kind', () => {
  const request = validateSpawnRequest({
    sessionId: 'session-2',
    shellKind: 'powershell',
    nonce: 'safe_nonce',
    cwd: 'C:\\work',
    cols: 80,
    rows: 24
  });
  assert.equal(request.shellKind, 'powershell');
});
