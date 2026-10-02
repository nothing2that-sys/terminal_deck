const assert = require('node:assert/strict');
const test = require('node:test');
const { buildElevatedPtyEnvironment } = require('../src/pty-environment');

test('elevated PTY environment excludes code-injection variables and user PATH', () => {
  const environment = buildElevatedPtyEnvironment(
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    { MULTI_SESSION_MANAGER_OSC_NONCE: 'nonce' },
    {
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\test',
      Path: 'D:\\attacker',
      PSModulePath: 'D:\\modules',
      NODE_OPTIONS: '--require malicious.js'
    }
  );
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.PSModulePath, undefined);
  assert.equal(environment.Path.includes('attacker'), false);
  assert.equal(environment.Path.includes('PowerShell\\7'), true);
  assert.equal(environment.MULTI_SESSION_MANAGER_OSC_NONCE, 'nonce');
});
